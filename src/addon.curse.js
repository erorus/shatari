const axios = require('axios');
const cp = require('child_process');
const dateFormat = require('dateformat');
const fs = require('fs');
const FormData = require('form-data');
const net = require('net');
const Path = require('path');
const process = require('process');
const StreamZip = require('node-stream-zip');

// Cloudflare is blocking axios on their API endpoints.. brilliant.
const CURSEFORGE_USER_AGENT = 'Mozilla';
// Their version type for WoW Retail.
const CURSE_GAME_VERSION_TYPE = 517;

const MAX_FORM_LENGTH = 100 * 1024 * 1024;
const ZIP_PATH = Path.resolve(__dirname, '..', 'addon', 'live', 'OribosExchange.zip');

async function main() {
    try {
        fs.statSync(ZIP_PATH);
    } catch (e) {
        console.log(e);
        process.exit(1);
    }

    const versions = await getLatestGameVersionIDs();
    if (!versions.length) {
        console.log("Could not find any valid curseforge versions!");
        process.exit(1);
    }

    const addonVersion = await getAddonVersion();

    let metaData = {
        changelog: 'Automatic data update for ' + dateFormat(new Date(), 'dddd, mmmm dS, yyyy'),
        gameVersions: versions,
        releaseType: 'release',
    };

    const form = new FormData({maxDataSize: MAX_FORM_LENGTH});
    form.append('file', fs.createReadStream(ZIP_PATH), {
        header: [
            '--' + form.getBoundary(),
            'Content-Disposition: form-data; name="file", filename="OribosExchange.' + addonVersion + '.zip"',
            'Content-Type: application/zip',
            'Content-Transfer-Encoding: binary',
            '', ''
        ].join('\r\n'),
    });
    form.append('metadata', JSON.stringify(metaData), {
        header: [
            '--' + form.getBoundary(),
            'Content-Disposition: form-data; name="metadata"',
            'Content-Type: application/json;charset=UTF-8',
            '', ''
        ].join('\r\n'),
    });

    const url = 'https://wow.curseforge.com/api/projects/' + process.env.CURSEFORGE_PROJECT_ID + '/upload-file';
    const headers = form.getHeaders();
    headers['X-Api-Token'] = process.env.CURSEFORGE_API_TOKEN;
    headers['User-Agent'] = CURSEFORGE_USER_AGENT;
    const response = await axios.post(url, form, {
        headers: headers,
        maxBodyLength: MAX_FORM_LENGTH,
    });

    if (response && response.data) {
        console.log("Uploaded as file ID " + response.data.id);
    } else {
        console.log(response);
        process.exit(1);
    }
}

/**
 * Returns the full version string of the addon from the TOC file inside the zip.
 *
 * @return {Promise<string|null>}
 */
async function getAddonVersion() {
    return new Promise(resolve => {
        const zip = new StreamZip({
            file: ZIP_PATH,
            storeEntries: true,
        });

        zip.on('ready', () => {
            let data;
            try {
                data = zip.entryDataSync('OribosExchange/OribosExchange.toc');
            } catch (e) {
                console.log("Could not extract TOC file!");
                console.log(e);
                data = null;
            }
            zip.close();

            if (!data) {
                resolve(null);
            }

            const match = data.toString().match(/\n##\s*Version:\s*([^\n\r]+)/);
            if (!match) {
                console.log("Could not find version line in TOC!");
                resolve(null);
            }

            resolve(match[1]);
        });
    });
}

/**
 * Returns an array of valid Curse version IDs for the current game version.
 *
 * @return {Promise<string[]>}
 */
async function getLatestGameVersionIDs() {
    const versionsUrl = 'https://wow.curseforge.com/api/game/versions?token=' + process.env.CURSEFORGE_API_TOKEN;
    let versionsResponse;
    try {
        versionsResponse = await axios.get(versionsUrl, {headers: {'User-Agent': CURSEFORGE_USER_AGENT}});
    } catch (e) {
        versionsResponse = null;
        console.log(e);
    }
    if (!versionsResponse || versionsResponse.status !== 200) {
        console.log("Invalid response getting curseforge game versions!");
        return [];
    }

    const versions = versionsResponse.data;
    versions.sort((a, b) => versionCompare(a.name || '', b.name || ''));

    const ngdpVersion = await getNGDPVersion();
    if (ngdpVersion) {
        const result = [];
        versions.forEach(versionObject => {
            if (versionObject.gameVersionTypeID !== CURSE_GAME_VERSION_TYPE) {
                return;
            }

            const partCount = versionObject.name.split('.').length;
            const partialNGDP = ngdpVersion.split('.').slice(0, partCount).join('.');
            if (versionCompare(partialNGDP, versionObject.name) <= 0) {
                result.push(versionObject.id);
            }
        });
        if (result.length) {
            return result;
        }
    }

    for (let x = versions.length - 1; x >= 0; x--) {
        if (versions[x].gameVersionTypeID === CURSE_GAME_VERSION_TYPE) {
            return [versions[x].id];
        }
    }

    return [];
}

/**
 * Returns the current game version w.x.y.zzzzz or null on error
 *
 * @return {Promise<string|null>}
 */
async function getNGDPVersion() {
    return new Promise(resolve => {
        let response = '';

        const client = net.createConnection({
            host: 'ribbit.everynothing.net',
            port: 1119
        }, () => {
            client.write('v1/products/wow/versions\n');
        });

        client.on('data', (data) => {
            response += data.toString();
        });
        client.on('end', () => {
            const match = response.match(/\n(eu\|[^\r\n]+)/);
            const parts = (match && match[1] || '').split('|');

            resolve(parts[5] || null);
        });
        client.on('error', () => {
            resolve(null);
        });
    });
}

/**
 * Compares two x.y.z versions.
 *
 * @param {string} a
 * @param {string} b
 * @return {number}
 */
function versionCompare(a, b) {
    const aParts = a.split('.');
    const bParts = b.split('.');
    const partCount = Math.max(aParts.length, bParts.length);

    let result = 0;
    for (let x = 0; x < partCount; x++) {
        result = result || ((aParts[x] || 0) - (bParts[x] || 0));
    }

    return result;
}

main().catch(function (e) {
    console.error("Unhandled exception:");
    console.error(e);

    process.exit(2);
});
