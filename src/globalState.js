const Lock = require('./lock');
const fs = require('fs').promises;
const Path = require('path');
const {gzip, ungzip} = require('node-gzip');

const DATA_DIR = Path.resolve(__dirname, '..', 'data');

module.exports = new function () {
    const MS_SEC = 1000;
    const VERSION = 1;

    // ------ //
    // PUBLIC //
    // ------ //

    /**
     * Reads from disk and returns the global state object for all realms.
     *
     * @return {object}
     */
    this.get = async function () {
        const path = getPath();
        let compressed;
        try {
            compressed = await fs.readFile(path);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return {};
            }

            throw error;
        }

        let buf = await ungzip(compressed);
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
        result.snapshots = {};
        for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
            let realmId = buf.readUInt16LE(advance(2));
            result.snapshots[realmId] = buf.readUInt32LE(advance(4)) * MS_SEC;
        }

        if (cursorPosition !== buf.length) {
            throw "Read " + cursorPosition + " bytes of buffer with length " + buf.length;
        }

        return result;
    }

    /**
     * Place an exclusive lock on the file.
     *
     * @return {Promise}
     */
    this.lock = () => Lock.acquire('global');

    /**
     * Writes to disk the given state for the all connected realms.
     *
     * @param {object} state
     */
    this.put = async function (state) {
        const path = getPath();

        // Start off with version number in front.
        let bufferSize = 1;
        // 2 bytes for snapshot list length, then the snapshot list keyed by realm id
        bufferSize += 2 + (2 + 4) * Object.keys(state.snapshots || {}).length;

        const buf = Buffer.allocUnsafe(bufferSize);
        let cursorPosition = 0;
        let advance = function (size) {
            let res = cursorPosition;
            cursorPosition += size;

            return res;
        };

        // Version
        buf.writeUInt8(VERSION, advance(1));

        // List of snapshots
        const snapshots = state.snapshots || {};
        buf.writeUInt16LE(Object.keys(snapshots).length, advance(2));
        for (let realmId in snapshots) {
            if (snapshots.hasOwnProperty(realmId)) {
                buf.writeUInt16LE(parseInt(realmId), advance(2));
                buf.writeUInt32LE(snapshots[realmId] / MS_SEC, advance(4));
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
    this.unlock = () => Lock.release('global');

    // ------- //
    // PRIVATE //
    // ------- //

    /**
     * Returns the filesystem path to the global state file.
     *
     * @return {string}
     */
    function getPath() {
        return Path.resolve(DATA_DIR, 'global', 'state.bin');
    }
};
