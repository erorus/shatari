const fs = require('fs').promises;
const Path = require('path');

const DATA_DIR = Path.resolve(__dirname, '..', 'data');

module.exports = new function () {
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
        let data;
        try {
            data = await fs.readFile(path, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return {};
            }

            throw error;
        }

        return JSON.parse(data);
    }

    /**
     * Writes to disk the given state for the given connected realm.
     *
     * @param {number} connectedRealmId
     * @param {object} state
     */
    this.put = async function (connectedRealmId, state) {
        const path = getPath(connectedRealmId);
        const data = JSON.stringify(state);

        try {
            await fs.writeFile(path, data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                const parent = Path.dirname(path);

                await fs.mkdir(parent, {recursive: true});
                await fs.writeFile(path, data);

                return;
            }

            throw error;
        }
    }

    // ------- //
    // PRIVATE //
    // ------- //

    /**
     * Returns the filesystem path to the connected realm's state json file.
     *
     * @param {number} connectedRealmId
     * @return {string}
     */
    function getPath(connectedRealmId) {
        return Path.resolve(DATA_DIR, '' + connectedRealmId, 'state.json');
    }
};
