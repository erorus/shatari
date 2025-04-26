const fs = require('fs').promises;
const Path = require('path');
const {gzip, ungzip} = require('node-gzip');

const Constants = require('./constants');
const ItemKeySerialize = require("./itemKeySerialize");
const ShatariWriter = require('./shatariWriter');

const DATA_DIR = Constants.DATA_DIR;

module.exports = new function () {
    const VERSION = 2;

    // ------ //
    // PUBLIC //
    // ------ //

    /**
     * Reads from disk and returns the local state object for the given region's items.
     *
     * @param {string} region
     * @return {object}
     */
    this.get = async function (region) {
        const path = getPath(region);
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
            console.log("Region " + region + " error unzipping");
            console.log(e);

            return {};
        }

        let cursorPosition = 0;
        let advance = function (size) {
            let res = cursorPosition;
            cursorPosition += size;

            return res;
        };

        let hasArbitrage = true;

        const version = buf.readUInt8(advance(1));
        switch (version) {
            case 1:
                hasArbitrage = false;
                break;

            case VERSION:
                // No op.
                break;

            default:
                throw "Unsupported version: " + version;
        }

        const result = {};

        result.items = {};
        {
            let prevItemId = 0;
            for (let remaining = buf.readUInt32LE(advance(4)); remaining > 0; remaining--) {
                let itemKey = {
                    itemId: prevItemId + buf.readUInt16LE(advance(2)),
                    itemLevel: buf.readUInt16LE(advance(2)),
                    itemSuffix: buf.readUInt16LE(advance(2)),
                };
                let itemKeyString = ItemKeySerialize.stringify(itemKey);
                let median = buf.readUInt32LE(advance(4)) * Constants.COPPER_SILVER;
                result.items[itemKeyString] = median;
                prevItemId = itemKey.itemId;
            }
        }

        result.arbitrage = {};
        if (hasArbitrage) {
            let prevItemId = 0;
            for (let remaining = buf.readUInt32LE(advance(4)); remaining > 0; remaining--) {
                let itemKey = {
                    itemId: prevItemId + buf.readUInt16LE(advance(2)),
                    itemLevel: buf.readUInt16LE(advance(2)),
                    itemSuffix: buf.readUInt16LE(advance(2)),
                };
                let itemKeyString = ItemKeySerialize.stringify(itemKey);
                let realms = buf.readUInt8(advance(1));
                let min = buf.readUInt32LE(advance(4)) * Constants.COPPER_SILVER;
                result.arbitrage[itemKeyString] = {realms, min};
                prevItemId = itemKey.itemId;
            }
        }

        if (cursorPosition !== buf.length) {
            throw "Read " + cursorPosition + " bytes of buffer with length " + buf.length;
        }

        return result;
    }

    /**
     * Writes to disk the given state for the given region's items.
     *
     * @param {string} region
     * @param {object} state
     */
    this.put = async function (region, state) {
        const path = getPath(region);

        // Start off with version number in front.
        let bufferSize = 1;
        // 4 bytes for items list length, then lists of id+level+suffix+median
        bufferSize += 4 + (2 + 2 + 2 + 4) * Object.keys(state.items || {}).length;
        // 4 bytes for arbitrage list length, then lists of id+level+suffix+realms+min
        bufferSize += 4 + (2 + 2 + 2 + 1 + 4) * Object.keys(state.arbitrage || {}).length;

        const buf = Buffer.allocUnsafe(bufferSize);
        let cursorPosition = 0;
        let advance = function (size) {
            let res = cursorPosition;
            cursorPosition += size;

            return res;
        };

        // Version
        buf.writeUInt8(VERSION, advance(1));

        // Items list
        {
            let items = state.items || {};
            let keyStrings = Object.keys(items);
            buf.writeUInt32LE(keyStrings.length, advance(4));
            keyStrings.sort((a, b) => ItemKeySerialize.parse(a).itemId - ItemKeySerialize.parse(b).itemId);
            let prevItemId = 0;
            keyStrings.forEach(itemKeyString => {
                let itemKey = ItemKeySerialize.parse(itemKeyString);

                buf.writeUInt16LE(itemKey.itemId - prevItemId, advance(2));
                buf.writeUInt16LE(itemKey.itemLevel, advance(2));
                buf.writeUInt16LE(itemKey.itemSuffix, advance(2));
                buf.writeUInt32LE(items[itemKeyString] / Constants.COPPER_SILVER, advance(4));

                prevItemId = itemKey.itemId;
            });
        }

        // Arbitrage list
        {
            let arbitrage = state.arbitrage || {};
            let keyStrings = Object.keys(arbitrage);
            buf.writeUInt32LE(keyStrings.length, advance(4));
            keyStrings.sort((a, b) => ItemKeySerialize.parse(a).itemId - ItemKeySerialize.parse(b).itemId);
            let prevItemId = 0;
            keyStrings.forEach(itemKeyString => {
                let itemKey = ItemKeySerialize.parse(itemKeyString);

                buf.writeUInt16LE(itemKey.itemId - prevItemId, advance(2));
                buf.writeUInt16LE(itemKey.itemLevel, advance(2));
                buf.writeUInt16LE(itemKey.itemSuffix, advance(2));
                buf.writeUInt8(arbitrage[itemKeyString].realms, advance(1));
                buf.writeUInt32LE(arbitrage[itemKeyString].min / Constants.COPPER_SILVER, advance(4));

                prevItemId = itemKey.itemId;
            });
        }

        if (cursorPosition !== bufferSize) {
            throw "Wrote " + cursorPosition + " bytes into a buffer of size " + bufferSize;
        }

        const compressed = await gzip(buf);

        await ShatariWriter(path, compressed);
    }

    // ------- //
    // PRIVATE //
    // ------- //

    /**
     * Returns the filesystem path to the region's state file.
     *
     * @param {string} region
     * @return {string}
     */
    function getPath(region) {
        return Path.resolve(DATA_DIR, 'global', 'region-' + region + '.bin');
    }
};
