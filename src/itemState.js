const fs = require('fs').promises;
const Path = require('path');
const {gzip, ungzip} = require('node-gzip');

const Constants = require('./constants');
const ItemKeySerialize = require('./itemKeySerialize');

const DATA_DIR = Constants.DATA_DIR;

module.exports = new function () {
    const COPPER_SILVER = 100;
    const MS_SEC = 1000;
    const VERSION = 3;

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
            console.log("Realm " + connectedRealmId + " Error unzipping item " + itemKey);
            console.log(e);

            return {};
        }

        let cursorPosition = 0;
        let advance = function (size) {
            let res = cursorPosition;
            cursorPosition += size;

            return res;
        };

        const version = buf.readUInt8(advance(1));
        let noSpecifics = false;
        switch (version) {
            case 1:
                noSpecifics = true;
                // no break
            case 2:
                // No difference to us.
                // no break
            case VERSION:
                // No op.
                break;
            default:
                throw "Unsupported version: " + version;
        }

        const result = {};
        result.snapshot = buf.readUInt32LE(advance(4)) * MS_SEC;
        result.price = buf.readUInt32LE(advance(4)) * COPPER_SILVER;
        result.quantity = buf.readUInt32LE(advance(4));

        /* skip reading auctions, we don't need them
        result.auctions = [];
        for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
            result.auctions.push([
                buf.readUInt32LE(advance(4)) * COPPER_SILVER,
                buf.readUInt32LE(advance(4)),
            ]);
        }
        */
        let aucRecCount = buf.readUInt16LE(advance(2));
        cursorPosition += aucRecCount * (4 + 4);

        // result.specifics = [];
        if (!noSpecifics) {
            /* skip reading specifics, we don't need them
            for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
                let specData = [
                    buf.readUInt32LE(advance(4)) * COPPER_SILVER,
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
                cursorPosition += 4 + 1;
                let remainingBonuses = buf.readUInt8(advance(1));
                cursorPosition += remainingBonuses * 2;
            }
        }

        result.snapshots = [];
        for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
            result.snapshots.push([
                buf.readUInt32LE(advance(4)) * MS_SEC,
                buf.readUInt32LE(advance(4)) * COPPER_SILVER,
                buf.readUInt32LE(advance(4)),
            ]);
        }

        if (cursorPosition !== buf.length) {
            throw "Read " + cursorPosition + " bytes of buffer with length " + buf.length;
        }

        return result;
    }

    /**
     * Writes to disk the given state for the given connected realm's item.
     *
     * @param {number} connectedRealmId
     * @param {string} itemKey
     * @param {object} state
     */
    this.put = async function (connectedRealmId, itemKey, state) {
        const path = getPath(connectedRealmId, itemKey);

        // Start off with version number in front.
        let bufferSize = 1;
        // 4 bytes each for snapshot timestamp, price, quantity
        bufferSize += 4 * 3;
        // 2 bytes for auction list length, then the auction list of 4 bytes each price/quantity
        bufferSize += 2 + (4 + 4) * (state.auctions || []).length;
        // 2 bytes for snapshot list length, then lists of snapshot+silvers+quantity
        bufferSize += 2 + (4 + 4 + 4) * (state.snapshots || []).length;

        // 2 bytes for specifics list length
        bufferSize += 2;
        (state.specifics || []).forEach(spec => {
            // 4 bytes for price, 1 byte for looted level, 1 byte for bonus list length, then 2 bytes per bonus
            bufferSize += 4 + 1 + 1 + 2 * spec[2].length;
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
        buf.writeUInt32LE((state.snapshot || 0) / MS_SEC, advance(4));
        buf.writeUInt32LE((state.price || 0) / COPPER_SILVER, advance(4));
        buf.writeUInt32LE(state.quantity || 0, advance(4));

        // Current auctions list
        buf.writeUInt16LE((state.auctions || []).length, advance(2));
        (state.auctions || []).forEach((auction) => {
            buf.writeUInt32LE(auction[0] / COPPER_SILVER, advance(4));
            buf.writeUInt32LE(auction[1], advance(4));
        });

        // Specifics list
        buf.writeUInt16LE((state.specifics || []).length, advance(2));
        (state.specifics || []).forEach(spec => {
            buf.writeUInt32LE(spec[0] / COPPER_SILVER, advance(4));
            buf.writeUInt8(spec[1], advance(1));
            buf.writeUInt8(spec[2].length, advance(1));
            spec[2].forEach(bonus => {
                buf.writeUInt16LE(bonus, advance(2));
            });
        });

        // Snapshot list
        buf.writeUInt16LE((state.snapshots || []).length, advance(2));
        (state.snapshots || []).forEach((snapshot) => {
            buf.writeUInt32LE(snapshot[0] / MS_SEC, advance(4));
            buf.writeUInt32LE(snapshot[1] / COPPER_SILVER, advance(4));
            buf.writeUInt32LE(snapshot[2], advance(4));
        });

        if (cursorPosition !== bufferSize) {
            throw "Wrote " + cursorPosition + " bytes into a buffer of size " + bufferSize;
        }

        const compressed = await gzip(buf);

        try {
            await fs.writeFile(path, compressed);
        } catch (error) {
            if (error.code === 'ENOENT') {
                const parent = Path.dirname(path);

                await fs.mkdir(parent, {recursive: true});
                await fs.writeFile(path, compressed);

                return;
            }

            throw error;
        }
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
        const itemId = ItemKeySerialize.parse(itemKey).itemId;

        return Path.resolve(DATA_DIR, '' + connectedRealmId, '' + (itemId & 0xFF), '' + itemKey + '.bin');
    }
};
