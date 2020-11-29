const process = require('process');
const cp = require('child_process');
const fs = require('fs').promises;
const Path = require('path');

const Aliveness = require('./aliveness');
const BNet = require('./battlenet');
const dateFormat = require('dateformat');
const Runner = require('./runner');
const RunOnce = require('./runOnce');
const RealmState = require('./realmState');
const GlobalState = require('./globalState');
const Constants = require('./constants');

const api = new BNet();

const CONCURRENT_REALM_LIMIT = 4;

const MAX_ALIVENESS_DELAY = 10 * Constants.MS_MINUTE;
const MAX_RUN_TIME = 6 * Constants.MS_HOUR;
const MAX_SNAPSHOT_INTERVAL = 2 * Constants.MS_HOUR;
const SNAPSHOTS_FOR_INTERVAL = 20;

let aliveness;
let realmList = {};
let itemList = {};

const realmQueue = {
    pending: [],
    running: [],
    timers: {},
};

async function main() {
    // Run this only once.
    let runOnce = new RunOnce('shatari');
    try {
        await runOnce.start();
    } catch (e) {
        if (e === 'Already running') {
            return;
        }

        throw e;
    }

    // Set end time and timeouts
    const endTime = Date.now() + MAX_RUN_TIME;
    const lastTimeout = setTimeout(() => {
        logMsg("Over time limit");
        process.exit();
    }, MAX_RUN_TIME + 5 * Constants.MS_MINUTE);
    aliveness = new Aliveness(MAX_ALIVENESS_DELAY);

    const clearRealmTimers = () => {
        for (let k in realmQueue.timers) {
            if (realmQueue.timers.hasOwnProperty(k)) {
                clearTimeout(realmQueue.timers[k]);
                delete realmQueue.timers[k];
            }
        }
        realmQueue.pending = [];
    };

    let abortLoop = false;
    process.on('SIGINT', () => {
        logMsg("Received SIGINT");
        abortLoop = true;
        clearRealmTimers();
    });
    process.on('SIGTERM', () => {
        logMsg("Received SIGTERM");
        abortLoop = true;
        clearRealmTimers();
    });
    process.on('beforeExit', () => {
        logMsg("Empty event loop, exiting..");
    });

    // Get item list
    {
        let listPath = Path.resolve(__dirname, '..', 'items.json');
        let listJson = await fs.readFile(listPath);
        itemList = JSON.parse(listJson);
    }

    // Get realm list
    realmList = await fetchRealmList();
    //realmList = {54: 'us'};
    const realmIds = Object.keys(realmList).map(id => parseInt(id));
    if (!realmIds.length) {
        logMsg("No realms in list?!");
        process.exit(2);
    }

    // Init realm timers.
    const initRealmCheck = async function (realmId) {
        setPendingTimer(realmId, await RealmState.get(realmId));
    };
    logMsg("Initializing realm timers.");
    let initPromises = [];
    realmIds.forEach(realmId => initPromises.push(initRealmCheck(realmId)));
    await Promise.all(initPromises);
    initPromises = undefined;
    logQueueStatus();

    // Main loop.
    while (!abortLoop && Date.now() < endTime) {
        await checkPendingRealms();
        if (!abortLoop) {
            await (new Promise(resolve => setTimeout(resolve, 3 * Constants.MS_SEC)));
        }
    }

    // Clean up timers to exit.
    clearRealmTimers();

    aliveness.close();
    runOnce.finish();
    clearTimeout(lastTimeout);
}

/**
 * Prints a message to the log.
 *
 * @param {string} message
 * @param {number} [realm]
 */
function logMsg(message, realm) {
    const date = dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss');
    if (realm) {
        message = (realmList[realm] || 'unknown').toUpperCase() + " realm " + realm + " " + message;
    }

    console.log(date + ' ' + message);
}

//             //
// Realm Queue //
//             //

/**
 * Run periodically to move realms out of the realm queue to process them.
 */
async function checkPendingRealms() {
    // Fill running queue from pending queue.
    const fillRunning = function () {
        while (realmQueue.running.length < CONCURRENT_REALM_LIMIT) {
            if (!realmQueue.pending.length) {
                break;
            }

            let realmId = realmQueue.pending.shift();
            realmQueue.running.push(Runner.wrap(processConnectedRealm(realmId)));
        }
    };

    fillRunning();

    const processedOne = !!realmQueue.running.length;
    aliveness.checkIn();

    // Process running queue.
    while (realmQueue.running.length) {
        logQueueStatus();

        try {
            await Runner.waitForOne(realmQueue.running);
        } catch (e) {
            logMsg("Error while processing some realm...");
            console.log(e);
        }

        fillRunning();
        aliveness.checkIn();
    }

    if (processedOne) {
        logQueueStatus();
    }

    // Nothing running, nothing pending.
}

/**
 * Log the status of the realm queue.
 */
function logQueueStatus() {
    logMsg('' +
        realmQueue.pending.length + ' realms pending, ' +
        realmQueue.running.length + ' realms running, ' +
        Object.keys(realmQueue.timers).length + ' realm timers waiting.'
    );
}

/**
 * Returns the timestamp of the next time we should check for a snapshot, given a realm state.
 *
 * @param {object} realmState
 * @return {number}
 */
function nextCheckTimestamp(realmState) {
    const now = Date.now();

    if (!realmState.lastCheck) {
        // We never checked this realm before.
        return now;
    }

    const snapshots = realmState.snapshots || [];
    let minInterval = MAX_SNAPSHOT_INTERVAL;
    for (let x = Math.max(1, snapshots.length - SNAPSHOTS_FOR_INTERVAL); x < snapshots.length; x++) {
        minInterval = Math.min(minInterval, snapshots[x] - snapshots[x - 1]);
    }
    const nextSnapshot = (realmState.snapshot || realmState.lastCheck) + minInterval;

    // Don't let us check more frequently than every 5 minutes.
    const fallback = realmState.lastCheck + 5 * Constants.MS_MINUTE;

    if (nextSnapshot < now) {
        // We're overdue.
        return Math.max(fallback, now);
    }

    const early = nextSnapshot - 2 * Constants.MS_MINUTE;
    if (early > now) {
        // It's far in the future. Guess 2 minutes early, to look for a smaller interval.
        return Math.max(fallback, early);
    }

    // It's soon.
    return nextSnapshot + 10 * Constants.MS_SEC;
}

/**
 * Set a timer to put the realm into the pending list at a later time, given its realm state.
 *
 * @param {number} connectedRealmId
 * @param {object} realmState
 */
function setPendingTimer(connectedRealmId, realmState) {
    if (realmQueue.timers[connectedRealmId]) {
        clearTimeout(realmQueue.timers[connectedRealmId]);
    }
    delete realmQueue.timers[connectedRealmId];

    const now = Date.now();
    const nextCheck = nextCheckTimestamp(realmState);
    if (nextCheck < now) {
        realmQueue.pending.push(connectedRealmId);

        return;
    }

    logMsg("Next check at " + dateFormat(new Date(nextCheck), 'yyyy-mm-dd HH:MM:ss'), connectedRealmId);

    realmQueue.timers[connectedRealmId] = setTimeout(() => {
        delete realmQueue.timers[connectedRealmId];
        realmQueue.pending.push(connectedRealmId);
    }, nextCheck - now);
}

//                  //
// Realm Processing //
//                  //

/**
 * Fetches and returns a full realm list from the API.
 *
 * @return {object}
 */
async function fetchRealmList() {
    const regions = [api.REGION_US, api.REGION_EU];
    const result = {};

    for (let region, x = 0; region = regions[x]; x++) {
        logMsg("Fetching " + region + " realm list");
        const response = await api.fetch(region, '/data/wow/connected-realm/index');
        response.data.connected_realms.forEach(realmRec => {
            const realmId = realmRec.href.match(/wow\/connected-realm\/(\d+)/)[1];

            result[realmId] = region;
        });
    }

    return result;
}

/**
 * Returns the RFC 2822 date string of the given date, for use in HTTP headers.
 *
 * @param {Date} date
 * @return {string}
 */
function getHttpDate(date) {
    return dateFormat(date, 'UTC:ddd, dd mmm yyyy HH:MM:ss') + ' GMT';
}

/**
 * Checks for a new auction house snapshot for the given connected realm, and parses it if available.
 *
 * @param {number} connectedRealmId
 */
async function processConnectedRealm(connectedRealmId) {
    const region = realmList[connectedRealmId];
    if (!region) {
        throw "Could not find region for realm " + connectedRealmId;
    }

    const startTime = Date.now();
    logMsg("Starting", connectedRealmId);

    const realmState = await RealmState.get(connectedRealmId);
    if (realmState.hasOwnProperty('locked')) {
        const now = Date.now();
        logMsg("Locked since " + Math.round((now - realmState.locked) / Constants.MS_MINUTE) + " minutes ago.", connectedRealmId);
        if (realmState.locked > (now - 2 * Constants.MS_HOUR)) {
            return;
        }
        logMsg("Ignoring lock.", connectedRealmId);
    }
    realmState.locked = Date.now();
    await RealmState.put(connectedRealmId, realmState);

    let headers = {};
    let lastSnapshot = realmState.snapshot;
    if (lastSnapshot) {
        headers['if-modified-since'] = getHttpDate(new Date(lastSnapshot));
    }

    realmState.lastCheck = Date.now();
    let response;
    try {
        response = await api.fetch(region, '/data/wow/connected-realm/' + connectedRealmId + '/auctions', {}, headers);
    } catch (e) {
        response = {status: 500};
        logMsg("Error during data fetch", connectedRealmId);
        console.log(e);
    }

    if (response.status === 200) {
        const thisSnapshot = (new Date(response.headers['last-modified'])).valueOf();

        let items;
        try {
            items = await processConnectedRealmAuctions(connectedRealmId, thisSnapshot, response.data);
        } catch (error) {
            delete realmState.locked;
            await RealmState.put(connectedRealmId, realmState);

            setPendingTimer(connectedRealmId, realmState);

            throw error;
        }

        realmState.snapshot = thisSnapshot;
        realmState.summary = realmState.summary || {};
        for (let itemKey in items) {
            if (!items.hasOwnProperty(itemKey)) {
                continue;
            }

            realmState.summary[itemKey] = [thisSnapshot, items[itemKey].p, items[itemKey].q];
        }

        const tooOld = thisSnapshot - Constants.MAX_HISTORY;
        realmState.snapshots = realmState.snapshots || [];
        for (let snapshot, x = 0; snapshot = realmState.snapshots[x]; x++) {
            if (snapshot < tooOld || snapshot === thisSnapshot) {
                realmState.snapshots.splice(x--, 1);
            }
        }
        realmState.snapshots.push(thisSnapshot);
        realmState.snapshots.sort(function (a, b) {
            return a - b;
        });

        await GlobalState.lock();
        const globalState = await GlobalState.get();
        globalState.snapshots = globalState.snapshots || {};
        globalState.snapshots[connectedRealmId] = thisSnapshot;
        await GlobalState.put(globalState);
        GlobalState.unlock();
    }

    delete realmState.locked;
    await RealmState.put(connectedRealmId, realmState);

    setPendingTimer(connectedRealmId, realmState);

    logMsg("Finished after " + ((Date.now() - startTime) / Constants.MS_SEC) + " seconds", connectedRealmId);
}

/**
 * Given auction data and a realm ID, update our files for that realm.
 *
 * @param {number} connectedRealmId
 * @param {number} thisSnapshot
 * @param {object} data  The parsed JSON response from the API
 * @return {Promise<object>} All the item stats from the snapshot, keyed by item key.
 */
function processConnectedRealmAuctions(connectedRealmId, thisSnapshot, data) {
    logMsg("Sending " + (data.auctions || []).length + " auctions from " +
        dateFormat(new Date(thisSnapshot), 'UTC:HH:MM:ss') + " to child", connectedRealmId);

    return new Promise((resolve, reject) => {
        const child = cp.fork(`${__dirname}/realmProcess.js`);

        child.on('message', m => {
            if (m.action === 'finish') {
                logMsg("Received " + Object.keys(m.data).length + " items back from child", connectedRealmId);
                resolve(m.data);
            } else if (m.action === 'error') {
                logMsg("Child reported some error", connectedRealmId);
                reject();
            } else {
                logMsg("Unknown message!", connectedRealmId);
                console.log(m);
                reject();
            }
        });

        child.on('error', err => {
            logMsg("Error spawning child", connectedRealmId);
            reject(err);
        });

        child.send({
            action: 'start',
            data: {
                realmList: realmList,
                itemList: itemList,
                connectedRealmId: connectedRealmId,
                thisSnapshot: thisSnapshot,
                data: data,
            }
        });
    });
}

main().catch(function (e) {
    console.error("Unhandled exception:");
    console.error(e);

    process.exit(2);
});
