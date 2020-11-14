const BNet = require('./battlenet');
const dateFormat = require('dateformat');
const RealmState = require('./realmState');
const ItemState = require('./itemState');

const api = new BNet();

const MS_SEC = 1000;
const MS_MINUTE = 60 * MS_SEC;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;

const MAX_HISTORY = 14 * MS_DAY;

async function main() {
    await processConnectedRealm(52);
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
 * Prints a message to the log.
 *
 * @param {string} message
 * @param {number} [realm]
 */
function logMsg(message, realm) {
    const date = dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss');
    if (realm) {
        message = "Realm " + realm + " " + message;
    }

    console.log(date + ' ' + message);
}

/**
 * Returns the timestamp of the next time a snapshot is expected, given an ascending array of snapshot timestamps.
 *
 * @param {number[]} snapshots
 * @return {number}
 */
function nextExpectedSnapshot(snapshots) {
    const now = Date.now();

    let result = now + MS_HOUR;

    if (snapshots.length >= 2) {
        let minInterval;
        for (let x = 1; x < snapshots.length; x++) {
            let interval = snapshots[x] - snapshots[x - 1];
            minInterval = minInterval ? Math.min(minInterval, interval) : interval;
        }
        result = snapshots[snapshots.length - 1] + minInterval;
    }

    if (result < now) {
        result = now + 5 * MS_MINUTE;
    }

    return result;
}

/**
 * Checks for a new auction house snapshot for the given connected realm, and parses it if available.
 *
 * @param {number} connectedRealmId
 * @return {Promise<void>}
 */
async function processConnectedRealm(connectedRealmId) {
    const region = api.REGION_US; // TODO

    logMsg("Starting", connectedRealmId);

    const realmState = await RealmState.get(connectedRealmId);
    if (realmState.hasOwnProperty('locked')) {
        const now = Date.now();
        logMsg("Locked since " + Math.round((now - realmState.locked) / MS_MINUTE) + " minutes ago.", connectedRealmId);
        if (realmState.locked > (now - 2 * MS_HOUR)) {
            //return;
        }
        logMsg("Ignoring lock.", connectedRealmId);
    }
    realmState.locked = Date.now();
    await RealmState.put(connectedRealmId, realmState);

    let headers = {};
    let lastSnapshot;
    if ((realmState.snapshots || []).length) {
        lastSnapshot = realmState.snapshots[realmState.snapshots.length - 1];
        headers['if-modified-since'] = getHttpDate(new Date(lastSnapshot));
    }

    //const response = await api.fetch(region, '/data/wow/connected-realm/' + connectedRealmId + '/auctions', {}, headers);

    const response = {
        status: 200,
        headers: {'last-modified': 'Sat, 14 Nov 2020 20:09:41 GMT'},
        data: JSON.parse(require('fs').readFileSync(require('path').resolve(__dirname, '..', 'auctions.json'))),
    };

    if (response.status === 200) {
        const thisSnapshot = (new Date(response.headers['last-modified'])).valueOf();

        logMsg("Processing " + response.data.auctions.length + " auctions", connectedRealmId);
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
    }

    delete realmState.locked;
    await RealmState.put(connectedRealmId, realmState);

    // TODO: schedule next snapshot

    logMsg("Finished", connectedRealmId);
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

        while (running.length >= 8) {
            let firstFinishedId = await Promise.race(running);
            let found = false;
            for (let p, x = 0; p = running[x]; x++) {
                if (p.itemId === firstFinishedId) {
                    running.splice(x, 1);
                    found = true;
                    break;
                }
            }
            if (!found) {
                throw "Could not find " + firstFinishedId + " in running array!";
            }
        }

        let itemId = parseInt(itemIdKey);
        let promise = updateItemJson(connectedRealmId, itemId, thisSnapshot, stats[itemId]);
        promise.itemId = itemId;
        running.push(promise);
    }
    await Promise.all(running);

    return stats;
}

/**
 * Updates the individual item JSON for the given realm+item and the given stats.
 *
 * @param {number} connectedRealmId
 * @param {number} itemId
 * @param {number} thisSnapshot
 * @param {object} stats
 * @return {number} itemId
 */
async function updateItemJson(connectedRealmId, itemId, thisSnapshot, stats) {
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

    return itemId;
}

main().catch(console.error);

