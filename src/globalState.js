const Lock = require('./lock');
const fs = require('fs').promises;
const Path = require('path');
const {gzip, ungzip} = require('node-gzip');

const Constants = require('./constants');
const ShatariWriter = require('./shatariWriter');

const DATA_DIR = Constants.DATA_DIR;

module.exports = new function () {
    const MS_SEC = 1000;
    const VERSION = 2;

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

        let buf;
        try {
            buf = await ungzip(compressed);
        } catch (e) {
            console.log("Error unzipping global state");
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
        let withSnapshotLists = true;
        switch (version) {
            case 1:
                withSnapshotLists = false;
                // no break
            case VERSION:
                // no op
                break;
            default:
                throw "Unsupported version: " + version;
        }

        const result = {
            snapshots: {},
            snapshotLists: {},
        };
        for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
            let realmId = buf.readUInt16LE(advance(2));
            result.snapshots[realmId] = buf.readUInt32LE(advance(4)) * MS_SEC;
        }
        if (withSnapshotLists) {
            for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
                let realmId = buf.readUInt16LE(advance(2));
                result.snapshotLists[realmId] = [];
                for (let realmRemaining = buf.readUInt16LE(advance(2)); realmRemaining > 0; realmRemaining--) {
                    result.snapshotLists[realmId].push(buf.readUInt32LE(advance(4)) * MS_SEC);
                }
            }
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
        // 2 bytes for the snapshotLists list length, and 2 bytes for each realm id in there, plus 2 per sublist length
        state.snapshotLists = state.snapshotLists || {};
        bufferSize += 2 + (2 + 2) * Object.keys(state.snapshotLists).length;
        // 4 bytes for each timestamp in each snapshot list.
        for (let realmId in state.snapshotLists) {
            if (state.snapshotLists.hasOwnProperty(realmId)) {
                bufferSize += 4 * state.snapshotLists[realmId].length;
            }
        }

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

        const snapshotLists = state.snapshotLists;
        buf.writeUInt16LE(Object.keys(snapshotLists).length, advance(2));
        for (let realmId in snapshotLists) {
            if (!snapshotLists.hasOwnProperty(realmId)) {
                continue;
            }
            let snapshotList = snapshotLists[realmId];
            buf.writeUInt16LE(parseInt(realmId), advance(2));
            buf.writeUInt16LE(snapshotList.length, advance(2));
            snapshotList.forEach(timestamp => {
                buf.writeUInt32LE(timestamp / MS_SEC, advance(4));
            });
        }

        if (cursorPosition !== bufferSize) {
            throw "Wrote " + cursorPosition + " bytes into a buffer of size " + bufferSize;
        }

        const compressed = await gzip(buf);

        await ShatariWriter(path, compressed);
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
