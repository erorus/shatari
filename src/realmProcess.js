const process = require('process');
const dateFormat = require('dateformat');

const Aliveness = require('./aliveness');
const ItemKey = require('./itemKey');
const ItemKeySerialize = require('./itemKeySerialize');
const ItemState = require('./itemState');
const GlobalItemState = require('./globalItemState');

const CLASS_WEAPON = 2;
const CLASS_ARMOR = 4;
const CLASSES_EQUIPMENT = [CLASS_WEAPON, CLASS_ARMOR];

const MODIFIER_TYPE_LOOTED_LEVEL = 9;

const MS_SEC = 1000;
const MS_MINUTE = 60 * MS_SEC;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;

const MAX_HISTORY = 14 * MS_DAY;

const CONCURRENT_ITEM_LIMIT = 8;

let alive;
let realmList = {};
let itemList = {};

/**
 * Prints a message to the log.
 *
 * @param {string} message
 * @param {number} [realm]
 */
function logMsg(message, realm) {
    const date = dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss');
    message = "Child " + message;
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

const realmProcess = new function () {
    /**
     * Given auction data and a realm ID, update our files for that realm.
     *
     * @param {number} connectedRealmId
     * @param {number} thisSnapshot
     * @param {object} data  The parsed JSON response from the API
     * @return {object} All the item stats from the snapshot, keyed by item key.
     */
    this.processConnectedRealmAuctions = async function (connectedRealmId, thisSnapshot, data) {
        const stats = {};
        data.auctions.forEach(function (auction) {
            const itemId = auction.item.id;
            const itemData = itemList[itemId];
            if (!itemData) {
                return;
            }

            const price = auction.unit_price || auction.buyout || auction.bid;
            const quantity = auction.quantity;

            if (!price || !quantity) {
                return;
            }

            const itemKey = ItemKeySerialize.stringify(ItemKey.get(auction.item));

            if (!stats[itemKey]) {
                stats[itemKey] = {
                    p: 0,
                    q: 0,
                };
                if (CLASSES_EQUIPMENT.includes(itemData['class'])) {
                    stats[itemKey].specifics = [];
                } else {
                    stats[itemKey].auc = {};
                }
            }

            const item = stats[itemKey];

            if (!item.p || item.p > price) {
                item.p = price;
            }
            item.q += quantity;

            if (item.auc) {
                item.auc[price] = (item.auc[price] || 0) + quantity;
            }
            if (item.specifics) {
                const spec = [
                    price,
                    0,
                    auction.item.bonus_lists || [],
                ];
                if (auction.item.modifiers) {
                    auction.item.modifiers.forEach(modifier => {
                        if (modifier.type === MODIFIER_TYPE_LOOTED_LEVEL) {
                            spec[1] = modifier.value;
                        }
                    });
                }
                item.specifics.push(spec);
            }
        });

        alive.checkIn();
        logMsg(
            "processing " + data.auctions.length + " auctions and saving " + Object.keys(stats).length +
            " items from " + dateFormat(new Date(thisSnapshot), 'UTC:HH:MM:ss') + '.',
            connectedRealmId
        );

        let running = [];
        for (let itemKey in stats) {
            if (!stats.hasOwnProperty(itemKey)) {
                continue;
            }

            while (running.length >= CONCURRENT_ITEM_LIMIT) {
                await waitForRunner(running);
            }

            alive.checkIn();

            running.push(wrapRunner(updateRealmItem(connectedRealmId, itemKey, thisSnapshot, stats[itemKey])));
            running.push(wrapRunner(updateGlobalItem(connectedRealmId, itemKey, thisSnapshot, stats[itemKey])));
        }
        await Promise.all(running);

        logMsg("returning " + Object.keys(stats).length + " results", connectedRealmId);

        return stats;
    }

    /**
     * Updates the individual realm's item state file for the given realm+item and the given stats.
     *
     * @param {number} connectedRealmId
     * @param {string} itemKey
     * @param {number} thisSnapshot
     * @param {object} stats
     */
    async function updateRealmItem(connectedRealmId, itemKey, thisSnapshot, stats) {
        const tooOld = thisSnapshot - MAX_HISTORY;

        const itemState = await ItemState.get(connectedRealmId, itemKey);

        itemState.auctions = [];
        for (let price in stats.auc) {
            if (!stats.auc.hasOwnProperty(price)) {
                continue;
            }
            itemState.auctions.push([parseInt(price), stats.auc[price]]);
        }

        itemState.specifics = stats.specifics;

        itemState.snapshots = itemState.snapshots || [];
        let snapshot;
        while ((snapshot = itemState.snapshots[0]) && snapshot[0] < tooOld) {
            itemState.snapshots.splice(0, 1);
        }
        itemState.snapshots.push([thisSnapshot, stats.p, stats.q]);

        itemState.price = stats.p;
        itemState.quantity = stats.q;
        itemState.snapshot = thisSnapshot;

        await ItemState.put(connectedRealmId, itemKey, itemState);
    }

    /**
     * Updates the global item state file for the given realm+item and the given stats.
     *
     * @param {number} connectedRealmId
     * @param {string} itemKey
     * @param {number} thisSnapshot
     * @param {object} stats
     */
    async function updateGlobalItem(connectedRealmId, itemKey, thisSnapshot, stats) {
        await GlobalItemState.lock(itemKey);
        let globalItemState = await GlobalItemState.get(itemKey);
        globalItemState.current = globalItemState.current || {};
        globalItemState.current[connectedRealmId] = [thisSnapshot, stats.p, stats.q];
        await GlobalItemState.put(itemKey, globalItemState);
        await GlobalItemState.unlock(itemKey);
    }
};

async function main () {
    alive = new Aliveness(60 * 1000);

    process.on('message', async (m) => {
        switch (m.action) {
            case 'start':
                realmList = m.data.realmList;
                itemList = m.data.itemList;

                let result;
                try {
                    result = await realmProcess.processConnectedRealmAuctions(
                        m.data.connectedRealmId,
                        m.data.thisSnapshot,
                        m.data.data
                    );

                    process.send({
                        action: 'finish',
                        data: result,
                    }, undefined, undefined, () => {
                        alive.close();
                        process.exit();
                    });
                } catch (err) {
                    logMsg("Error while processing auctions", m.data.connectedRealmId);
                    console.log(err);

                    process.send({
                        action: 'error'
                    }, undefined, undefined, () => {
                        alive.close();
                        process.exit();
                    });
                }

                break;
            default:
                logMsg("received unknown message!");
                console.log(m);
                break;
        }
    });

    process.on('SIGINT', () => {
        logMsg("received SIGINT, ignoring");
    });
    process.on('SIGTERM', () => {
        logMsg("received SIGTERM, ignoring");
    });
    process.on('beforeExit', () => {
        logMsg("empty event loop, exiting..");
    });
}

main().catch(function (e) {
    console.error("Unhandled exception:");
    console.error(e);

    process.exit(2);
});

