const BNet = require('./battlenet');
const dateFormat = require('dateformat');
const RealmState = require('./realmState');
const ItemState = require('./itemState');
const GlobalState = require('./globalState');
const GlobalItemState = require('./globalItemState');

const api = new BNet();

const MS_SEC = 1000;
const MS_MINUTE = 60 * MS_SEC;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;

const MAX_HISTORY = 14 * MS_DAY;

const CONCURRENT_REALM_LIMIT = 4;
const CONCURRENT_ITEM_LIMIT = 8;

let realmList = {};

const realmQueue = {
    pending: [],
    running: [],
    timers: {},
};

async function main() {
    realmList = await fetchRealmList();

    const realmIds = Object.keys(realmList).map(id => parseInt(id));
    if (!realmIds.length) {
        logMsg("No realms in list?!");

        return;
    }

    const initRealmCheck = async function (realmId) {
        setPendingTimer(realmId, await RealmState.get(realmId));
    };

    logMsg("Initializing realm timers.");
    let initPromises = [];
    realmIds.forEach(realmId => initPromises.push(initRealmCheck(realmId)));
    await Promise.all(initPromises);
    initPromises = undefined;
    logQueueStatus();

    while (true) {
        await checkPendingRealms();
        await (new Promise(resolve => setTimeout(resolve, 5 * MS_SEC)));
    }
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

/**
 * Given an array of promises, wait for one to finish, then remove it from the array.
 *
 * @param {Promise[]} running
 */
async function waitForRunner(running) {
    let toThrow;
    let foundResolved = false;

    try {
        await Promise.race(running);
    } catch (e) {
        toThrow = e;
    }

    for (let p, x = 0; p = running[x]; x++) {
        if (p.resolved) {
            running.splice(x, 1);

            foundResolved = true;
            break;
        }
    }

    if (toThrow) {
        throw toThrow;
    } else if (!foundResolved) {
        throw "Could not find any resolved in running array!";
    }
}

/**
 * Wraps a promise later used by waitForRunner()
 *
 * @param {Promise} runner
 * @return {Promise}
 */
function wrapRunner(runner) {
    let finallyPromise = runner.finally(() => finallyPromise.resolved = true);

    return finallyPromise;
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
            realmQueue.running.push(wrapRunner(processConnectedRealm(realmId)));
        }
    };

    fillRunning();

    const processedOne = !!realmQueue.running.length;

    // Process running queue.
    while (realmQueue.running.length) {
        logQueueStatus();

        try {
            await waitForRunner(realmQueue.running, 'realmId');
        } catch (e) {
            logMsg("Error while processing some realm...");
            console.log(e);
        }

        fillRunning();
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
    let minInterval = 0;
    for (let x = 1; x < snapshots.length; x++) {
        let interval = snapshots[x] - snapshots[x - 1];
        minInterval = minInterval ? Math.min(minInterval, interval) : interval;
    }
    const nextSnapshot = realmState.snapshot + minInterval;

    // Don't let us check more frequently than every 5 minutes.
    const fallback = realmState.lastCheck + 5 * MS_MINUTE;

    if (nextSnapshot < now) {
        // We're overdue.
        return Math.max(fallback, now);
    }

    const early = nextSnapshot - 2 * MS_MINUTE;
    if (early > now) {
        // It's far in the future. Guess 2 minutes early, to look for a smaller interval.
        return Math.max(fallback, early);
    }

    // It's soon.
    return nextSnapshot + 10 * MS_SEC;
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
        logMsg("Locked since " + Math.round((now - realmState.locked) / MS_MINUTE) + " minutes ago.", connectedRealmId);
        if (realmState.locked > (now - 2 * MS_HOUR)) {
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

        logMsg("Processing " + response.data.auctions.length + " auctions from " + Math.round((Date.now() - thisSnapshot) / MS_SEC) + " seconds ago", connectedRealmId);
        const items = await processConnectedRealmAuctions(connectedRealmId, thisSnapshot, response.data);

        realmState.snapshot = thisSnapshot;
        realmState.summary = realmState.summary || {};
        for (let itemId in items) {
            if (!items.hasOwnProperty(itemId)) {
                continue;
            }

            realmState.summary[itemId] = [thisSnapshot, items[itemId].p, items[itemId].q];
        }

        const tooOld = thisSnapshot - MAX_HISTORY;
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

    logMsg("Finished after " + ((Date.now() - startTime) / MS_SEC) + " seconds", connectedRealmId);
}

/**
 * Given auction data and a realm ID, update our files for that realm.
 *
 * @param {number} connectedRealmId
 * @param {number} thisSnapshot
 * @param {object} data  The parsed JSON response from the API
 * @return {object} All the item stats from the snapshot, keyed by item ID.
 */
async function processConnectedRealmAuctions(connectedRealmId, thisSnapshot, data) {
    const stats = {};
    data.auctions.forEach(function (auction) {
        if (!auction.hasOwnProperty('unit_price')) {
            return;
        }

        const item = stats[auction.item.id] = stats[auction.item.id] || {
            p: 0,
            q: 0,
            auc: {},
        };
        const price = auction.unit_price;

        if (!item.p || item.p > price) {
            item.p = price;
        }
        item.q += auction.quantity;
        item.auc[price] = (item.auc[price] || 0) + auction.quantity;
    });

    logMsg("Processing " + Object.keys(stats).length + " items", connectedRealmId);

    let running = [];
    for (let itemIdKey in stats) {
        if (!stats.hasOwnProperty(itemIdKey)) {
            continue;
        }

        while (running.length >= CONCURRENT_ITEM_LIMIT) {
            await waitForRunner(running, 'itemId');
        }

        let itemId = parseInt(itemIdKey);
        running.push(wrapRunner(updateRealmItem(connectedRealmId, itemId, thisSnapshot, stats[itemId])));
        running.push(wrapRunner(updateGlobalItem(connectedRealmId, itemId, thisSnapshot, stats[itemId])));
    }
    await Promise.all(running);

    return stats;
}

/**
 * Updates the individual realm's item state file for the given realm+item and the given stats.
 *
 * @param {number} connectedRealmId
 * @param {number} itemId
 * @param {number} thisSnapshot
 * @param {object} stats
 */
async function updateRealmItem(connectedRealmId, itemId, thisSnapshot, stats) {
    const tooOld = thisSnapshot - MAX_HISTORY;

    const itemState = await ItemState.get(connectedRealmId, itemId);

    itemState.auctions = [];
    for (let price in stats.auc) {
        if (!stats.auc.hasOwnProperty(price)) {
            continue;
        }
        itemState.auctions.push([parseInt(price), stats.auc[price]]);
    }
    itemState.auctions.sort(function (a, b) {
        return a.p - b.p;
    });

    itemState.snapshots = itemState.snapshots || [];
    for (let snapshot, x = 0; snapshot = itemState.snapshots[x]; x++) {
        if (snapshot[0] < tooOld || snapshot[0] === thisSnapshot) {
            itemState.snapshots.splice(x--, 1);
        }
    }
    itemState.snapshots.push([thisSnapshot, stats.p, stats.q]);
    itemState.snapshots.sort(function (a, b) {
        return a[0] - b[0];
    });

    itemState.price = stats.p;
    itemState.quantity = stats.q;
    itemState.snapshot = thisSnapshot;

    await ItemState.put(connectedRealmId, itemId, itemState);
}

/**
 * Updates the global item state file for the given realm+item and the given stats.
 *
 * @param {number} connectedRealmId
 * @param {number} itemId
 * @param {number} thisSnapshot
 * @param {object} stats
 */
async function updateGlobalItem(connectedRealmId, itemId, thisSnapshot, stats) {
    await GlobalItemState.lock(itemId);
    let globalItemState = await GlobalItemState.get(itemId);
    globalItemState.current = globalItemState.current || {};
    globalItemState.current[connectedRealmId] = [thisSnapshot, stats.p, stats.q];
    await GlobalItemState.put(itemId, globalItemState);
    GlobalItemState.unlock(itemId);
}

main().catch(console.error);

