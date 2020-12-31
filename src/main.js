const process = require('process');
const cp = require('child_process');
const fs = require('fs').promises;
const Path = require('path');
const OS = require('os');

const Aliveness = require('./aliveness');
const BNet = require('./battlenet');
const dateFormat = require('dateformat');
const Runner = require('./runner');
const RunOnce = require('./runOnce');
const RealmState = require('./realmState');
const TokenState = require('./tokenState');
const GlobalState = require('./globalState');
const Constants = require('./constants');

const api = new BNet();
const regions = [api.REGION_US, api.REGION_EU, api.REGION_TW, api.REGION_KR];

const CONCURRENT_REALM_LIMIT = 4;

const MAX_ALIVENESS_DELAY = 10 * Constants.MS_MINUTE;
const MAX_RUN_TIME = 6 * Constants.MS_HOUR;
const MAX_SNAPSHOT_INTERVAL = 2 * Constants.MS_HOUR;
const SNAPSHOTS_FOR_INTERVAL = 20;
const TOKEN_INTERVAL = 20 * Constants.MS_MINUTE + 10 * Constants.MS_SEC;

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
    const initTokenCheck = async function (region) {
        setPendingTokenTimer(region, await TokenState.get(region));
    };
    logMsg("Initializing realm timers.");
    let initPromises = [];
    realmIds.forEach(realmId => initPromises.push(initRealmCheck(realmId)));
    regions.forEach(region => initPromises.push(initTokenCheck(region)));
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

//            //
// WoW Tokens //
//            //

/**
 * Check for updates for the given region's WoW Token price.
 *
 * @param {string} region
 * @return {Promise<void>}
 */
async function checkToken(region) {
    logMsg(region + " token: Checking price.");
    const tokenState = await TokenState.get(region);
    let response;
    try {
        response = await api.fetch(region, '/data/wow/token/index');
    } catch (e) {
        response = {status: 500};
        logMsg("Error during token data fetch");
        console.log(e);
    }

    if (response.status === 200) {
        const now = Date.now();
        const thisSnapshot = response.data.last_updated_timestamp;
        const price = response.data.price;

        if (thisSnapshot > (tokenState.snapshot || 0)) {
            logMsg(region + " token: Found new snapshot from " + ((now - thisSnapshot) / Constants.MS_SEC) +
                " seconds ago: " + (price / 10000).toLocaleString() + "g.");
            tokenState.snapshot = thisSnapshot;
            tokenState.price = price;

            const tooOld = thisSnapshot - Constants.MAX_HISTORY;
            tokenState.snapshots = tokenState.snapshots || [];
            for (let snapshot, x = 0; snapshot = tokenState.snapshots[x]; x++) {
                if (snapshot < tooOld || snapshot === thisSnapshot) {
                    tokenState.snapshots.splice(x--, 1);
                }
            }
            tokenState.snapshots.push([tokenState.snapshot, tokenState.price]);
            tokenState.snapshots.sort(function (a, b) {
                return a - b;
            });

            await TokenState.put(region, tokenState);
        } else {
            logMsg(region + " token: Found old/current snapshot from " + ((now - thisSnapshot) / Constants.MS_SEC) + " seconds ago.");
        }
    }

    setPendingTokenTimer(region, tokenState);
}

/**
 * Set a timer to check the region's token price.
 *
 * @param {string} region
 * @param {Object} tokenState
 */
function setPendingTokenTimer(region, tokenState) {
    const timerKey = 'wowtoken-' + region;
    if (realmQueue.timers[timerKey]) {
        clearTimeout(realmQueue.timers[timerKey]);
    }
    delete realmQueue.timers[timerKey];

    const now = Date.now();
    let delay = 5 * Constants.MS_MINUTE;

    if (tokenState.snapshot) {
        const nextExpected = tokenState.snapshot + TOKEN_INTERVAL;
        if (nextExpected > now) {
            delay = nextExpected - now;
        }
    }

    logMsg(region + " token: Next check at " + dateFormat(new Date(now + delay), 'yyyy-mm-dd HH:MM:ss'));

    realmQueue.timers[timerKey] = setTimeout(() => {
        delete realmQueue.timers[timerKey];
        checkToken(region);
    }, delay);
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

    pauseAddon(realmQueue.running.length > 0);
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
 * Pauses/unpauses addon data generation. If the addon is not currently being generated, nothing happens.
 *
 * @param {boolean} pause
 */
async function pauseAddon(pause) {
    const sockPath = Path.join(OS.tmpdir(), 'addon.sock');
    try {
        await fs.stat(sockPath);
    } catch (e) {
        if (e.code !== 'ENOENT') {
            logMsg("Could not stat " + sockPath);
            console.log(e);
        }

        // Sock file doesn't exist, so it's not running.
        return;
    }

    try {
        let stdout = await cp.exec('lsof -F p "' + sockPath + '"');
    } catch (e) {
        logMsg("Could not determine pid using " + sockPath);
        console.log(e);

        return;
    }

    let match = stdout.match(/p(\d+)/);
    if (!match) {
        logMsg("lsof did not return a pid on " + sockPath + ": " + stdout);

        return;
    }

    let pid = parseInt(match[1]);
    process.kill(pid, pause ? 'SIGSTOP' : 'SIGCONT');
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
    let downloadTime = 0;
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
        downloadTime = Date.now() - realmState.lastCheck;
        logMsg("Downloaded auctions in " + (downloadTime / Constants.MS_SEC) + " seconds", connectedRealmId);

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
        globalState.snapshotLists = globalState.snapshotLists || {};
        globalState.snapshotLists[connectedRealmId] = realmState.snapshots;
        await GlobalState.put(globalState);
        GlobalState.unlock();
    }

    delete realmState.locked;
    await RealmState.put(connectedRealmId, realmState);

    setPendingTimer(connectedRealmId, realmState);

    let totalElapsed = (Date.now() - startTime);
    logMsg("Finished after " + (totalElapsed / Constants.MS_SEC) + " seconds" +
        (downloadTime ? ' (' + ((totalElapsed - downloadTime) / Constants.MS_SEC) + " seconds without download)" : ''),
        connectedRealmId
    );
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
