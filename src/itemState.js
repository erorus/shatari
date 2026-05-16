const fs = require('fs').promises;
const Path = require('path');
const {gzip, ungzip} = require('node-gzip');

const Constants = require('./constants');
const ItemKeySerialize = require('./itemKeySerialize');

const DATA_DIR = Constants.DATA_DIR;

module.exports = new function () {
    const VERSION = 5;

    // ------ //
    // PUBLIC //
    // ------ //

    /**
     * Reads from disk and returns the local state object for the given connected realm's item.
     *
     * @param {number} connectedRealmId
     * @param {string} itemKey
     * @return {object}
     */
    this.get = async function (connectedRealmId, itemKey) {
        const path = getPath(connectedRealmId, itemKey);
        let compressed;
        try {
            compressed = await fs.readFile(path);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return {};
            }

            throw error;
        }

        let buf;
        try {
            buf = await ungzip(compressed);
        } catch (e) {
            console.log(`Realm ${connectedRealmId} Error unzipping item ${itemKey}`);
            console.log(e);

            return {};
        }

        return readBuf(buf);
    }

    /**
     * Reads from disk and returns the local state object for the given connected realm's item, and the file handle
     * for later writes.
     *
     * @param {number} connectedRealmId
     * @param {string} itemKey
     * @return {Promise<{itemState: object, fileHandle: object}>}
     */
    this.getWithHandle = async function (connectedRealmId, itemKey) {
        const path = getPath(connectedRealmId, itemKey);
        let compressed;
        let fileHandle;

        try {
            fileHandle = await fs.open(path, 'r+');
            compressed = await fileHandle.readFile();
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }

            try {
                fileHandle = await fs.open(path, 'w');
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    throw error;
                }

                await fs.mkdir(Path.dirname(path), {recursive: true});
                fileHandle = await fs.open(path, 'w');
            }

            return {itemState: {}, fileHandle};
        }

        let buf;
        try {
            buf = await ungzip(compressed);
        } catch (e) {
            console.log(`Realm ${connectedRealmId} Error unzipping item ${itemKey}`);
            console.log(e);

            return {itemState: {}, fileHandle};
        }

        return {itemState: readBuf(buf), fileHandle};
    }

    /**
     * Reads the uncompressed item state buffer data, returning an item state object.
     *
     * @param {Buffer} buf
     * @return {object}
     */
    function readBuf(buf) {
        let cursorPosition = 0;
        let advance = function (size) {
            let res = cursorPosition;
            cursorPosition += size;

            return res;
        };

        const version = buf.readUInt8(advance(1));
        let fullModifiers = true;
        let dailyHistory = true;
        switch (version) {
            case 3:
                fullModifiers = false;
                // no break
            case 4:
                dailyHistory = false;
                // no break
            case VERSION:
                // No op.
                break;
            default:
                throw "Unsupported version: " + version;
        }

        const result = {};
        result.snapshot = buf.readUInt32LE(advance(4)) * Constants.MS_SEC;
        result.price = buf.readUInt32LE(advance(4)) * Constants.COPPER_SILVER;
        result.quantity = buf.readUInt32LE(advance(4));

        /* skip reading auctions, we don't need them
        result.auctions = [];
        for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
            result.auctions.push([
                buf.readUInt32LE(advance(4)) * Constants.COPPER_SILVER,
                buf.readUInt32LE(advance(4)),
            ]);
        }
        */
        let aucRecCount = buf.readUInt16LE(advance(2));
        cursorPosition += aucRecCount * (4 + 4);

        /* skip reading specifics, we don't need them
        result.specifics = [];
        for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
            let specData = [
                buf.readUInt32LE(advance(4)) * Constants.COPPER_SILVER,
                buf.readUInt8(advance(1)),
                []
            ];
            for (let remainingBonuses = buf.readUInt8(advance(1)); remainingBonuses > 0; remainingBonuses--) {
                specData[2].push(buf.readUInt16LE(advance(2)))
            }
            result.specifics.push(specData);
        }
        */
        for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
            cursorPosition += 4;
            if (fullModifiers) {
                let modifierCount = buf.readUint8(advance(1));
                cursorPosition += modifierCount * 6;
            } else {
                cursorPosition += 1;
            }
            let bonusCount = buf.readUInt8(advance(1));
            cursorPosition += bonusCount * 2;
        }

        result.snapshots = [];
        for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
            result.snapshots.push([
                buf.readUInt32LE(advance(4)) * Constants.MS_SEC,
                buf.readUInt32LE(advance(4)) * Constants.COPPER_SILVER,
                buf.readUInt32LE(advance(4)),
            ]);
        }

        result.daily = [];
        if (dailyHistory) {
            for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
                result.daily.push([
                    buf.readUInt16LE(advance(2)) * Constants.MS_DAY,
                    buf.readUInt32LE(advance(4)) * Constants.COPPER_SILVER,
                    buf.readUInt32LE(advance(4)),
                ]);
            }
        }

        if (cursorPosition !== buf.length) {
            throw "Read " + cursorPosition + " bytes of buffer with length " + buf.length;
        }

        return result;
    }

    /**
     * Writes the given state to the given open file handle.
     *
     * @param {object} fileHandle
     * @param {object} state
     */
    this.put = async function (fileHandle, state) {
        // Start off with version number in front.
        let bufferSize = 1;
        // 4 bytes each for snapshot timestamp, price, quantity
        bufferSize += 4 * 3;
        // 2 bytes for auction list length, then the auction list of 4 bytes each price/quantity
        bufferSize += 2 + (4 + 4) * (state.auctions || []).length;
        // 2 bytes for snapshot list length, then lists of snapshot+silvers+quantity
        bufferSize += 2 + (4 + 4 + 4) * (state.snapshots || []).length;
        // 2 bytes for daily list length, then lists of day+silvers+quantity
        bufferSize += 2 + (2 + 4 + 4) * (state.daily || []).length;

        // 2 bytes for specifics list length
        bufferSize += 2;
        (state.specifics || []).forEach(spec => {
            // 4 bytes for price,
            bufferSize += 4;
            // 1 byte for modifier list length, 6 bytes per modifier
            bufferSize += 1 + 6 * spec[1].length;
            // 1 byte for bonus list length, then 2 bytes per bonus
            bufferSize += 1 + 2 * spec[2].length;
        });

        const buf = Buffer.allocUnsafe(bufferSize);
        let cursorPosition = 0;
        let advance = function (size) {
            let res = cursorPosition;
            cursorPosition += size;

            return res;
        };

        // Version
        buf.writeUInt8(VERSION, advance(1));

        // Current stats
        buf.writeUInt32LE((state.snapshot || 0) / Constants.MS_SEC, advance(4));
        buf.writeUInt32LE((state.price || 0) / Constants.COPPER_SILVER, advance(4));
        buf.writeUInt32LE(state.quantity || 0, advance(4));

        // Current auctions list
        buf.writeUInt16LE((state.auctions || []).length, advance(2));
        (state.auctions || []).forEach((auction) => {
            buf.writeUInt32LE(auction[0] / Constants.COPPER_SILVER, advance(4));
            buf.writeUInt32LE(auction[1], advance(4));
        });

        // Specifics list
        buf.writeUInt16LE((state.specifics || []).length, advance(2));
        (state.specifics || []).forEach(spec => {
            buf.writeUInt32LE(spec[0] / Constants.COPPER_SILVER, advance(4));
            buf.writeUInt8(spec[1].length, advance(1));
            spec[1].forEach(modifier => {
                buf.writeUInt16LE(modifier[0], advance(2));
                buf.writeUInt32LE(modifier[1], advance(4));
            });
            buf.writeUInt8(spec[2].length, advance(1));
            spec[2].forEach(bonus => {
                buf.writeUInt16LE(bonus, advance(2));
            });
        });

        // Snapshot list
        buf.writeUInt16LE((state.snapshots || []).length, advance(2));
        (state.snapshots || []).forEach((snapshot) => {
            buf.writeUInt32LE(snapshot[0] / Constants.MS_SEC, advance(4));
            buf.writeUInt32LE(snapshot[1] / Constants.COPPER_SILVER, advance(4));
            buf.writeUInt32LE(snapshot[2], advance(4));
        });

        // Daily list
        buf.writeUInt16LE((state.daily || []).length, advance(2));
        (state.daily || []).forEach((snapshot) => {
            buf.writeUInt32LE(snapshot[0] / Constants.MS_DAY, advance(2));
            buf.writeUInt32LE(snapshot[1] / Constants.COPPER_SILVER, advance(4));
            buf.writeUInt32LE(snapshot[2], advance(4));
        });

        if (cursorPosition !== bufferSize) {
            throw "Wrote " + cursorPosition + " bytes into a buffer of size " + bufferSize;
        }

        const compressed = await gzip(buf);

        await fileHandle.write(compressed, 0, compressed.length, 0);
        await fileHandle.truncate(compressed.length);
        await fileHandle.close();
    }

    // ------- //
    // PRIVATE //
    // ------- //

    /**
     * Returns the filesystem path to the connected realm's item's state file.
     *
     * @param {number} connectedRealmId
     * @param {string} itemKey
     * @return {string}
     */
    function getPath(connectedRealmId, itemKey) {
        const parsed = ItemKeySerialize.parse(itemKey);
        const itemId = parsed.itemId;

        if (itemId === Constants.ITEM_PET_CAGE) {
            return Path.resolve(DATA_DIR, '' + connectedRealmId, 'pet', '' + (parsed.itemLevel & 0xFF), '' + itemKey + '.bin');
        }

        return Path.resolve(DATA_DIR, '' + connectedRealmId, '' + (itemId & 0xFF), '' + itemKey + '.bin');
    }
};
