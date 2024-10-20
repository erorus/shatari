const fs = require('fs').promises;
const Path = require('path');
const writeFileAtomic = require('write-file-atomic');

/**
 * Atomically writes/overwrites the file at $path with $data. Creates parent directories as necessary.
 *
 * @param {string}        path
 * @param {string|Buffer} data
 */
module.exports = async (path, data) => {
    const options = {chown: false, fsync: false};
    try {
        await writeFileAtomic(path, data, options);
    } catch (error) {
        if (error.code === 'ENOENT') {
            const parent = Path.dirname(path);

            await fs.mkdir(parent, {recursive: true});
            await writeFileAtomic(path, data, options);
        } else {
            throw error;
        }
    }
};
