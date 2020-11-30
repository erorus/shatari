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
     * Reads from disk and returns the local state object for the given connected realm.
     *
     * @param {number} connectedRealmId
     * @return {object}
     */
    this.get = async function (connectedRealmId) {
        const path = getPath(connectedRealmId);
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
            console.log("Realm " + connectedRealmId + " Error unzipping realm state");
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
        let simpleItemKey = false;
        let shortSummaryCount = false;

        switch (version) {
            case 1:
                simpleItemKey = true;
                // no break
            case 2:
                shortSummaryCount = true;
                // no break
            case VERSION:
                // no op
                break;
            default:
                throw "Unsupported version: " + version;
        }

        const result = {};
        result.snapshot = buf.readUInt32LE(advance(4)) * MS_SEC;
        result.lastCheck = buf.readUInt32LE(advance(4)) * MS_SEC;
        result.snapshots = [];
        for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
            result.snapshots.push(buf.readUInt32LE(advance(4)) * MS_SEC);
        }
        result.summary = {};
        let remaining = shortSummaryCount ? buf.readUInt16LE(advance(2)) : buf.readUInt32LE(advance(4));
        for (; remaining > 0; remaining--) {
            let itemKey = {
                itemId: buf.readUInt32LE(advance(4)),
                itemLevel: 0,
                itemSuffix: 0,
            };
            if (!simpleItemKey) {
                itemKey.itemLevel = buf.readUInt16LE(advance(2));
                itemKey.itemSuffix = buf.readUInt16LE(advance(2));
            }
            let itemKeyString = ItemKeySerialize.stringify(itemKey);
            let snapshot = buf.readUInt32LE(advance(4)) * MS_SEC;
            let price = buf.readUInt32LE(advance(4)) * COPPER_SILVER;
            let quantity = buf.readUInt32LE(advance(4));
            result.summary[itemKeyString] = [snapshot, price, quantity];
        }

        if (cursorPosition !== buf.length) {
            throw "Read " + cursorPosition + " bytes of buffer with length " + buf.length;
        }

        return result;
    }

    /**
     * Writes to disk the given state for the given connected realm.
     *
     * @param {number} connectedRealmId
     * @param {object} state
     */
    this.put = async function (connectedRealmId, state) {
        const path = getPath(connectedRealmId);

        // Start off with version number in front.
        let bufferSize = 1;
        // 4 bytes for snapshot timestamp
        bufferSize += 4;
        // 4 bytes for last check timestamp
        bufferSize += 4;
        // 2 bytes for snapshot list length, then the snapshot list
        bufferSize += 2 + 4 * (state.snapshots || []).length;
        // 2 bytes for summary list length, then lists of id+level+suffix+snapshot+silvers+quantity
        bufferSize += 4 + (4 + 2 + 2 + 4 + 4 + 4) * Object.keys(state.summary || {}).length;

        const buf = Buffer.allocUnsafe(bufferSize);
        let cursorPosition = 0;
        let advance = function (size) {
            let res = cursorPosition;
            cursorPosition += size;

            return res;
        };

        // Version
        buf.writeUInt8(VERSION, advance(1));

        // Snapshot
        buf.writeUInt32LE((state.snapshot || 0) / MS_SEC, advance(4));

        // Last Check
        buf.writeUInt32LE((state.lastCheck || 0) / MS_SEC, advance(4));

        // List of snapshots
        buf.writeUInt16LE((state.snapshots || []).length, advance(2));
        (state.snapshots || []).forEach((snapshot) => buf.writeUInt32LE(snapshot / MS_SEC, advance(4)));

        // Summary list
        let summary = state.summary || {};
        buf.writeUInt32LE(Object.keys(summary).length, advance(4));
        for (let itemKeyString in summary) {
            if (!summary.hasOwnProperty(itemKeyString)) {
                continue;
            }
            let itemKey = ItemKeySerialize.parse(itemKeyString);

            buf.writeUInt32LE(itemKey.itemId, advance(4));
            buf.writeUInt16LE(itemKey.itemLevel, advance(2));
            buf.writeUInt16LE(itemKey.itemSuffix, advance(2));
            buf.writeUInt32LE(summary[itemKeyString][0] / MS_SEC, advance(4));
            buf.writeUInt32LE(summary[itemKeyString][1] / COPPER_SILVER, advance(4));
            buf.writeUInt32LE(summary[itemKeyString][2], advance(4));
        }

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
     * Returns the filesystem path to the connected realm's state file.
     *
     * @param {number} connectedRealmId
     * @return {string}
     */
    function getPath(connectedRealmId) {
        return Path.resolve(DATA_DIR, '' + connectedRealmId, 'state.bin');
    }
};
