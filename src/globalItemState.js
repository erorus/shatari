const Lock = require('./lock');
const fs = require('fs').promises;
const Path = require('path');
const {gzip, ungzip} = require('node-gzip');

const DATA_DIR = Path.resolve(__dirname, '..', 'data');

module.exports = new function () {
    const COPPER_SILVER = 100;
    const MS_SEC = 1000;
    const VERSION = 1;

    // ------ //
    // PUBLIC //
    // ------ //

    /**
     * Reads from disk and returns the item's state object for all realms.
     *
     * @param {number} itemId
     * @return {object}
     */
    this.get = async function (itemId) {
        const path = getPath(itemId);
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
            console.log("Error unzipping global item " + itemId);
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
        if (version !== VERSION) {
            throw "Unsupported version: " + version;
        }

        const result = {};
        result.current = {};
        for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
            let realmId = buf.readUInt16LE(advance(2));
            result.current[realmId] = [
                buf.readUInt32LE(advance(4)) * MS_SEC,
                buf.readUInt32LE(advance(4)) * COPPER_SILVER,
                buf.readUInt32LE(advance(4)),
            ];
        }

        if (cursorPosition !== buf.length) {
            throw "Read " + cursorPosition + " bytes of buffer with length " + buf.length;
        }

        return result;
    }

    /**
     * Place an exclusive lock on the file for the given item.
     *
     * @param {number} itemId
     * @return {Promise}
     */
    this.lock = (itemId) => Lock.acquire(itemId);

    /**
     * Writes to disk the given state for the item on all connected realms.
     *
     * @param {number} itemId
     * @param {object} state
     */
    this.put = async function (itemId, state) {
        const path = getPath(itemId);

        // Start off with version number in front.
        let bufferSize = 1;
        // 2 bytes for current list length, then the current list (snapshot, price, quantity) keyed by realm id
        bufferSize += 2 + (2 + 4 + 4 + 4) * Object.keys(state.current || {}).length;

        const buf = Buffer.allocUnsafe(bufferSize);
        let cursorPosition = 0;
        let advance = function (size) {
            let res = cursorPosition;
            cursorPosition += size;

            return res;
        };

        // Version
        buf.writeUInt8(VERSION, advance(1));

        // Current prices
        const current = state.current || {};
        buf.writeUInt16LE(Object.keys(current).length, advance(2));
        for (let realmId in current) {
            if (current.hasOwnProperty(realmId)) {
                buf.writeUInt16LE(parseInt(realmId), advance(2));
                buf.writeUInt32LE(current[realmId][0] / MS_SEC, advance(4));
                buf.writeUInt32LE(current[realmId][1] / COPPER_SILVER, advance(4));
                buf.writeUInt32LE(current[realmId][2], advance(4));
            }
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

    /**
     * Remove an exclusive lock on the file.
     */
    this.unlock = (itemId) => Lock.release(itemId);

    // ------- //
    // PRIVATE //
    // ------- //

    /**
     * Returns the filesystem path to the global item's state file.
     *
     * @param {number} itemId
     * @return {string}
     */
    function getPath(itemId) {
        return Path.resolve(DATA_DIR, 'global', '' + (itemId & 0xFF), '' + itemId + '.bin');
    }
};
