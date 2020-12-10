const fs = require('fs').promises;
const Path = require('path');
const {gzip, ungzip} = require('node-gzip');

const Constants = require('./constants');

const DATA_DIR = Constants.DATA_DIR;

module.exports = new function () {
    const COPPER_SILVER = 100;
    const MS_SEC = 1000;
    const VERSION = 1;

    // ------ //
    // PUBLIC //
    // ------ //

    /**
     * Reads from disk and returns the local state object for the given region's token.
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
            console.log("Token region " + region + " error unzipping");
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
        result.snapshot = buf.readUInt32LE(advance(4)) * MS_SEC;
        result.price = buf.readUInt32LE(advance(4)) * COPPER_SILVER;
        result.snapshots = [];
        for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
            result.snapshots.push([
                buf.readUInt32LE(advance(4)) * MS_SEC,
                buf.readUInt32LE(advance(4)) * COPPER_SILVER,
            ]);
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
        // 4 bytes each for snapshot timestamp, price
        bufferSize += 4 + 4;
        // 2 bytes for snapshot list length, then lists of snapshot + silvers
        bufferSize += 2 + (4 + 4) * (state.snapshots || []).length;

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

        // Snapshot list
        buf.writeUInt16LE((state.snapshots || []).length, advance(2));
        (state.snapshots || []).forEach((snapshot) => {
            buf.writeUInt32LE(snapshot[0] / MS_SEC, advance(4));
            buf.writeUInt32LE(snapshot[1] / COPPER_SILVER, advance(4));
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
     * Returns the filesystem path to the region's token state file.
     *
     * @param {string} region
     * @return {string}
     */
    function getPath(region) {
        return Path.resolve(DATA_DIR, 'global', 'token-' + region + '.bin');
    }
};
