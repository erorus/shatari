const fs = require('fs').promises;
const Path = require('path');

/**
 * Atomically writes/overwrites the file at $path with $data.
 *
 * @param {string}        path
 * @param {string|Buffer} data
 */
const atomicWrite = async (path, data) => {
    const tempPath = `${path}.atomicWrite`;
    await fs.writeFile(tempPath, data);
    await fs.rename(tempPath, path);
};

/**
 * Writes/overwrites the file at $path with $data. Creates parent directories as necessary.
 *
 * @param {string}        path
 * @param {string|Buffer} data
 * @param {boolean}       atomic False to allow non-atomic writes (for performance)
 */
module.exports = async (path, data, atomic = true) => {
    const writer = atomic ? atomicWrite : fs.writeFile;
    try {
        await writer(path, data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            const parent = Path.dirname(path);

            await fs.mkdir(parent, {recursive: true});
            await writer(path, data);
        } else {
            throw error;
        }
    }
};
