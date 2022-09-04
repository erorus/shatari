const fs = require('fs').promises;
const Path = require('path');
const {gzip, ungzip} = require('node-gzip');

const Constants = require('./constants');
const ItemKeySerialize = require("./itemKeySerialize");

const DATA_DIR = Constants.DATA_DIR;

module.exports = new function () {
    const VERSION = 1;

    // ------ //
    // PUBLIC //
    // ------ //

    /**
     * Reads from disk and returns the local state object for the given region's deals.
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
            console.log("Deals region " + region + " error unzipping");
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
        switch (version) {
            case VERSION:
                // No op.
                break;
            default:
                throw "Unsupported version: " + version;
        }

        const result = {};

        result.items = {};
        for (let remaining = buf.readUInt32LE(advance(4)); remaining > 0; remaining--) {
            let itemKey = {
                itemId: buf.readUInt32LE(advance(4)),
                itemLevel: buf.readUInt16LE(advance(2)),
                itemSuffix: buf.readUInt16LE(advance(2)),
            };
            let itemKeyString = ItemKeySerialize.stringify(itemKey);
            let median = buf.readUInt32LE(advance(4)) * Constants.COPPER_SILVER;
            let dealPrice = buf.readUInt32LE(advance(4)) * Constants.COPPER_SILVER;
            result.items[itemKeyString] = [median, dealPrice];
        }

        if (cursorPosition !== buf.length) {
            throw "Read " + cursorPosition + " bytes of buffer with length " + buf.length;
        }

        return result;
    }

    /**
     * Writes to disk the given state for the given region's token.
     *
     * @param {string} region
     * @param {object} state
     */
    this.put = async function (region, state) {
        const path = getPath(region);

        // Start off with version number in front.
        let bufferSize = 1;
        // 4 bytes for items list length, then lists of id+level+suffix+median+deal
        bufferSize += 4 + (4 + 2 + 2 + 4 + 4) * Object.keys(state.items || {}).length;

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
        let items = state.items || {};
        buf.writeUInt32LE(Object.keys(items).length, advance(4));
        for (let itemKeyString in items) {
            if (!items.hasOwnProperty(itemKeyString)) {
                continue;
            }
            let itemKey = ItemKeySerialize.parse(itemKeyString);

            buf.writeUInt32LE(itemKey.itemId, advance(4));
            buf.writeUInt16LE(itemKey.itemLevel, advance(2));
            buf.writeUInt16LE(itemKey.itemSuffix, advance(2));
            buf.writeUInt32LE(items[itemKeyString][0] / Constants.COPPER_SILVER, advance(4));
            buf.writeUInt32LE(items[itemKeyString][1] / Constants.COPPER_SILVER, advance(4));
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
     * Returns the filesystem path to the region's token state file.
     *
     * @param {string} region
     * @return {string}
     */
    function getPath(region) {
        return Path.resolve(DATA_DIR, 'global', 'deals-' + region + '.bin');
    }
};
