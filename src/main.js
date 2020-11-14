const BNet = require('./battlenet');
const dateFormat = require('dateformat');
const RealmState = require('./realmState');

const api = new BNet();

const MS_SEC = 1000;
const MS_MINUTE = 60 * MS_SEC;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;

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

    const realmState = await RealmState.get(connectedRealmId);

    let headers = {};
    let lastSnapshot;
    if ((realmState.snapshots || []).length) {
        lastSnapshot = realmState.snapshots[realmState.snapshots.length - 1];
        headers['if-modified-since'] = getHttpDate(new Date(lastSnapshot));
    }

    const response = await api.fetch(region, '/data/wow/connected-realm/' + connectedRealmId + '/auctions', {}, headers);
    if (response.status === 304) {
        // TODO: schedule next snapshot
        return;
    }

    const auctions = result.data.auctions;

    const stats = {};
    auctions.forEach(function (auction) {
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

    console.log(stats);
}

main().catch(console.error);

