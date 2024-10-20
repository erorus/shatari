const fs = require('fs').promises;
const Path = require('path');
const writeFileAtomic = require('write-file-atomic');

/**
 * Atomically writes/overwrites the file at $path with $data. Creates parent directories as necessary.
 *
 * @param {string}        path
 * @param {string|Buffer} data
 * @param {boolean}       atomic False to allow non-atomic writes (for performance)
 */
module.exports = async (path, data, atomic = true) => {
    const writer = atomic ? writeFileAtomic : fs.writeFile;
    const options = atomic ? {chown: false, fsync: false} : undefined;
    try {
        await writer(path, data, options);
    } catch (error) {
        if (error.code === 'ENOENT') {
            const parent = Path.dirname(path);

            await fs.mkdir(parent, {recursive: true});
            await writer(path, data, options);
        } else {
            throw error;
        }
    }
};
