const process = require('process');
const fs = require('fs').promises;
const Path = require('path');

const dateFormat = require('dateformat');
const BNet = require('./battlenet');
const RunOnce = require('./runOnce');

const api = new BNet();
const regions = [api.REGION_US, api.REGION_EU];

async function main() {
    // Run this only once.
    let runOnce = new RunOnce('realm-list');
    try {
        await runOnce.start();
    } catch (e) {
        if (e === 'Already running') {
            return;
        }

        throw e;
    }

    let listPath = Path.resolve(__dirname, '..', 'realm-list.json');
    let oldList = {};
    try {
        oldList = JSON.parse(await fs.readFile(listPath));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    logMsg('' + Object.keys(oldList).length + ' realms in existing list.');

    // Get realm list
    let realmList = await fetchRealmList();
    for (let id in realmList) {
        if (!realmList.hasOwnProperty(id)) {
            continue;
        }
        oldList[id] = realmList[id];
    }

    logMsg('' + Object.keys(realmList).length + ' realms in current list.');

    await fs.writeFile(listPath, JSON.stringify(realmList));

    runOnce.finish();
}

/**
 * Prints a message to the log.
 *
 * @param {string} message
 */
function logMsg(message) {
    const date = dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss');

    console.log(date + ' ' + message);
}

/**
 * Fetches and returns a full realm list from the API.
 *
 * @return {object}
 */
async function fetchRealmList() {
    const result = {};

    const realmPromises = [];
    const seenConnections = {};

    for (let region, x = 0; region = regions[x]; x++) {
        logMsg("Fetching " + region + " realm list");
        const response = await api.fetch(region, '/data/wow/connected-realm/index');
        logMsg("Found " + response.data.connected_realms.length + " connected realms in " + region + ".");

        response.data.connected_realms.forEach(connectedRealmRec => {
            const connectedRealmId = connectedRealmRec.href.match(/wow\/connected-realm\/(\d+)/)[1];

            realmPromises.push(api.fetch(region, '/data/wow/connected-realm/' + connectedRealmId).then(response => {
                seenConnections[connectedRealmId] = response.data.realms.length;
                logMsg("Loaded " + region + " connected realm " + connectedRealmId + " with " + response.data.realms.length + " realms.");

                response.data.realms.forEach(realmRec => {
                    const realmResult = {
                        region: region,
                        name: realmRec.name,
                        slug: realmRec.slug,
                        id: realmRec.id,
                        connectedId: parseInt(connectedRealmId),
                    };

                    if (!result.hasOwnProperty(realmResult.id)) {
                        result[realmResult.id] = realmResult;

                        return;
                    }

                    if (response.data.realms.length > seenConnections[result[realmResult.id].connectedId]) {
                        logMsg("Changing connection for realm " + realmResult.slug + " (ID " + realmResult.id + ") from " +
                            result[realmResult.id].connectedId + " (count " + seenConnections[result[realmResult.id].connectedId] +
                            ") to " + realmResult.connectedId + " (count " + response.data.realms.length + ")"
                        );

                        result[realmResult.id] = realmResult;
                    } else {
                        logMsg("Keeping connection for realm " + realmResult.slug + " (ID " + realmResult.id + ") at " +
                            result[realmResult.id].connectedId + " (count " + seenConnections[result[realmResult.id].connectedId] +
                            ") and ignoring " + realmResult.connectedId + " (count " + response.data.realms.length + ")");
                    }
                });
            }));
        });
    }

    await Promise.all(realmPromises);

    return result;
}

main().catch(function (e) {
    console.error("Unhandled exception:");
    console.error(e);

    process.exit(2);
});
