const process = require('process');
const fs = require('fs').promises;
const Path = require('path');

const dateFormat = require('dateformat');
const BNet = require('./battlenet');
const RunOnce = require('./runOnce');

const RealmState = require('./realmState');
const Constants = require('./constants');
const ItemKeySerialize = require('./itemKeySerialize');
const ItemState = require('./itemState');

const api = new BNet();
const regions = [api.REGION_US];
const MIN_EXPANSION_ITEM_VARIATIONS = 9;
const MEDIAN_PRICE_PERIOD = 4 * Constants.MS_DAY;

let realmList;
let itemList;
let now = Date.now();

async function main() {
    // Run this only once.
    let runOnce = new RunOnce('addon');
    try {
        await runOnce.start();
    } catch (e) {
        if (e === 'Already running') {
            return;
        }

        throw e;
    }

    let listPath = Path.resolve(__dirname, '..', 'realm-list.json');
    realmList = JSON.parse(await fs.readFile(listPath));
    logMsg('' + Object.keys(realmList).length + ' realms in list.');

    listPath = Path.resolve(__dirname, '..', 'items.json');
    itemList = JSON.parse(await fs.readFile(listPath));
    logMsg('' + Object.keys(itemList).length + ' items in list.');

    let promises = [];
    regions.forEach(region => promises.push(processRegion(region)));
    await Promise.all(promises);

    runOnce.finish();
}

function getConnectedRealmsForRegion(region) {
    let result = {};
    for (let realmId in realmList) {
        if (!realmList.hasOwnProperty(realmId)) {
            continue;
        }

        let realm = realmList[realmId];
        if (realm.region !== region) {
            continue;
        }

        if (!result.hasOwnProperty(realm.connectedId)) {
            result[realm.connectedId] = {
                region: realm.region,
                id: realm.connectedId,
                secondary: [],
            };
        }
        if (realm.id === realm.connectedId) {
            result[realm.connectedId].canonical = realm;
        } else {
            result[realm.connectedId].secondary.push(realm);
        }
    }

    for (let connectedId in result) {
        if (!result.hasOwnProperty(connectedId)) {
            continue;
        }

        let connectedRealm = result[connectedId];
        connectedRealm.secondary.sort((a, b) => a.name.localeCompare(b.name));
        if (!connectedRealm.canonical) {
            connectedRealm.canonical = connectedRealm.secondary.shift();
        }
    }

    return result;
}

async function processRegion(region) {
    let connectedRealms = getConnectedRealmsForRegion(region);
    let knownItemKeys = {};
    let usedRealmStates = {};

    for (let connectedId in connectedRealms) {
        if (!connectedRealms.hasOwnProperty(connectedId)) {
            continue;
        }
        let connectedRealm = connectedRealms[connectedId];
        if (connectedRealm.region !== region) {
            continue;
        }

        let realmState = await RealmState.get(connectedRealm.id);
        if (!realmState.snapshots) {
            continue;
        }
        while (realmState.snapshots[0] < (now - MEDIAN_PRICE_PERIOD)) {
            realmState.snapshots.shift();
        }
        if (!realmState.snapshots.length) {
            continue;
        }

        usedRealmStates[connectedRealm.id] = realmState;
        logMsg("Scanning " + region + " connected realm " + connectedRealm.id + " (" + connectedRealm.canonical.name + ")");

        for (let itemKeyString in realmState.summary) {
            let itemKey = ItemKeySerialize.parse(itemKeyString);
            if (itemKey.itemId === Constants.ITEM_PET_CAGE) {
                if (itemKey.itemSuffix) {
                    knownItemKeys[itemKeyString] = true;
                }
            } else {
                let item = itemList[itemKey.itemId];
                if (item && !!itemKey.itemLevel === (item.expansion >= MIN_EXPANSION_ITEM_VARIATIONS)) {
                    knownItemKeys[itemKeyString] = true;
                }
            }
        }
    }

    knownItemKeys = Object.keys(knownItemKeys);
    knownItemKeys.sort((a, b) => {
        let aKey = ItemKeySerialize.parse(a);
        let bKey = ItemKeySerialize.parse(b);

        return (aKey.itemId - bKey.itemId) || (aKey.itemLevel - bKey.itemLevel) || (aKey.itemSuffix - bKey.itemSuffix);
    });
    logMsg("Found " + knownItemKeys.length + " distinct item keys in region " + region);

    let usedConnectedIds = Object.keys(usedRealmStates);
    usedConnectedIds.sort((a, b) => parseInt(a) - parseInt(b));

    let lineBufferSize = 4 + usedConnectedIds.length * (1 + 4);
    for (let itemKeyString, itemKeyIndex = 0; itemKeyString = knownItemKeys[itemKeyIndex]; itemKeyIndex++) {
        let itemKey = ItemKeySerialize.parse(itemKeyString);
        let item = itemList[itemKey.itemId];
        if (!item) {
            return;
        }

        // Interleaved list of days,price;days,price;days,price;...
        let buf = Buffer.allocUnsafe(lineBufferSize);
        let cursorPosition = 4;
        let advance = function (size) {
            let res = cursorPosition;
            cursorPosition += size;

            return res;
        };

        let priceSum = 0;
        let priceCount = 0;

        let processItemInRealm = async function (connectedId) {
            let summaryData = usedRealmStates[connectedId].summary[itemKeyString];
            let days;

            if (item.vendorBuy) {
                days = 252;
            } else if (!summaryData) {
                days = 0;
            } else {
                days = Math.min(250, Math.floor(Math.max(0, now - summaryData.snapshot) / Constants.MS_DAY));
            }
            buf.writeUInt8(days, advance(1));

            if (!summaryData) {
                buf.writeUInt32LE(0, advance(4));

                return;
            }

            let itemState = await ItemState.get(connectedId, itemKeyString);
            if (!itemState || !itemState.snapshots) {
                buf.writeUInt32LE(0, advance(4));

                return;
            }

            let priceList = getPriceList(usedRealmStates[connectedId], itemState);
            if (!priceList.length) {
                buf.writeUInt32LE(0, advance(4));

                return;
            }

            priceList.sort((a, b) => a - b);
            let median = priceList[Math.floor(priceList.length / 2)];
            if (priceList.length % 2 === 0) {
                median += priceList[priceList.length / 2 - 1];
                median = Math.round(median / 2);
            }

            buf.writeUInt32LE(median, advance(4));

            priceSum += median;
            priceCount++;
        }
        for (let connectedId, connectedIndex = 0; connectedId = usedConnectedIds[connectedIndex]; connectedIndex++) {
            await processItemInRealm(connectedId);
        }

        buf.writeUInt32LE(priceSum / priceCount, 0);

        // TODO: write buf to lua somehow
    }

    logMsg("Finished with region " + region);
}

function getPriceList(realmState, itemState) {
    let tooOld = now - MEDIAN_PRICE_PERIOD;
    let result = [];

    let deltas = {};
    let prevDelta;
    itemState.snapshots.forEach(snapshotArray => {
        let snapshot = snapshotArray[0];
        let price = snapshotArray[1] / Constants.COPPER_SILVER;
        let quantity = snapshotArray[2];

        deltas[snapshot] = {snapshot: snapshot, price: price, quantity: quantity};
        // Workaround for when data collection didn't carry over the price when quantity became zero.
        if (deltas[snapshot].quantity === 0 && prevDelta && deltas[snapshot].price === 0) {
            deltas[snapshot].price = prevDelta.price;
        }
        if (!prevDelta || (snapshot < tooOld)) {
            prevDelta = deltas[snapshot];
        }
    });

    if (!prevDelta) {
        return result;
    }

    realmState.snapshots.forEach(timestamp => {
        if (deltas[timestamp]) {
            // Something changed at this timestamp, and we have new stats.
            prevDelta = deltas[timestamp];
            result.push(deltas[timestamp].price);
        } else if (prevDelta.snapshot < timestamp) {
            // There were no changes recorded at this snapshot, assume it's the same as the prev snapshot.
            result.push(prevDelta.price);
        } else {
            // prevDelta.snapshot > timestamp, which means our first record of this item came after now.
        }
    });

    return result;
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

main().catch(function (e) {
    console.error("Unhandled exception:");
    console.error(e);

    process.exit(2);
});
