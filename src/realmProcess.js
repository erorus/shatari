const Path = require('path');
const fs = require('fs').promises;
const process = require('process');
const dateFormat = require('dateformat');

const Aliveness = require('./aliveness');
const Constants = require('./constants');
const ItemKey = require('./itemKey');
const ItemKeySerialize = require('./itemKeySerialize');
const ItemState = require('./itemState');
const Runner = require('./runner');

const CLASS_WEAPON = 2;
const CLASS_ARMOR = 4;
const CLASSES_EQUIPMENT = [CLASS_WEAPON, CLASS_ARMOR];

const DATA_DIR = Constants.DATA_DIR;

const CONCURRENT_ITEM_LIMIT = 8;

let aliveness;
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

const realmProcess = new function () {
    let tooOld;

    /**
     * Given auction data and a realm ID, update our files for that realm.
     *
     * @param {number} connectedRealmId
     * @param {number} thisSnapshot
     * @param {object} data  The parsed JSON response from the API
     * @return {object} All the item stats from the snapshot, keyed by item key.
     */
    this.processConnectedRealmAuctions = async function (connectedRealmId, thisSnapshot, data) {
        tooOld = thisSnapshot - Constants.MAX_HISTORY;

        const stats = {};

        const priorAuctions = await getPriorAuctionList(connectedRealmId);
        const currentAuctions = {};

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

            const auctionKey = [auction.id, quantity].join('-');
            let auctionListItemKey;

            {
                const itemKey = ItemKeySerialize.stringify({itemId: itemId, itemSuffix: 0, itemLevel: 0});
                auctionListItemKey = itemKey;
                if (!stats[itemKey]) {
                    stats[itemKey] = {
                        p: 0,
                        q: 0,
                        auc: {},
                    };
                }

                const item = stats[itemKey];
                if (!item.p || item.p > price) {
                    item.p = price;
                }
                item.q += quantity;

                item.auc[price] = (item.auc[price] || 0) + quantity;
            }

            if (CLASSES_EQUIPMENT.includes(itemData['class'])) {
                const itemKeyFull = ItemKeySerialize.stringify(ItemKey.get(auction.item));
                auctionListItemKey = itemKeyFull;
                if (!stats[itemKeyFull]) {
                    stats[itemKeyFull] = {
                        p: 0,
                        q: 0,
                        specifics: [],
                    };
                }

                const item = stats[itemKeyFull];
                if (!item.p || item.p > price) {
                    item.p = price;
                }
                item.q += quantity;

                const spec = [
                    price,
                    [],
                    auction.item.bonus_lists || [],
                ];
                (auction.item.modifiers || []).forEach(modifier => {
                    spec[1].push([modifier.type, modifier.value]);
                });
                item.specifics.push(spec);
            }

            currentAuctions[auctionKey] = auctionListItemKey;
        });

        aliveness.checkIn();

        const itemKeysToUpdate = {};
        const notInBoth = function (a, b) {
            for (let auctionKey in a) {
                if (a.hasOwnProperty(auctionKey) && !b.hasOwnProperty(auctionKey)) {
                    let itemKeyString = a[auctionKey];
                    itemKeysToUpdate[itemKeyString] = true;

                    // Include transmog mode.
                    let parsed = ItemKeySerialize.parse(itemKeyString);
                    if (parsed.itemSuffix || parsed.itemLevel) {
                        itemKeyString = ItemKeySerialize.stringify({
                            itemId: parsed.itemId,
                            itemSuffix: 0,
                            itemLevel: 0,
                        });
                        itemKeysToUpdate[itemKeyString] = true;
                    }
                }
            }
        };
        notInBoth(priorAuctions, currentAuctions);
        notInBoth(currentAuctions, priorAuctions);

        aliveness.checkIn();

        logMsg("found " + Object.keys(itemKeysToUpdate).length + " items to update", connectedRealmId);

        /*
        logMsg(
            "processing " + data.auctions.length + " auctions and saving " + Object.keys(stats).length +
            " items from " + dateFormat(new Date(thisSnapshot), 'UTC:HH:MM:ss') + '.',
            connectedRealmId
        );
        */

        let running = [];
        running.push(Runner.wrap(putPriorAuctionList(connectedRealmId, currentAuctions)));
        for (let itemKey in itemKeysToUpdate) {
            if (!itemKeysToUpdate.hasOwnProperty(itemKey)) {
                continue;
            }

            while (running.length >= CONCURRENT_ITEM_LIMIT) {
                await Runner.waitForOne(running);
            }

            aliveness.checkIn();

            running.push(Runner.wrap(updateRealmItem(connectedRealmId, itemKey, thisSnapshot, stats[itemKey] || {})));
        }
        await Promise.all(running);

        //logMsg("returning " + Object.keys(stats).length + " results", connectedRealmId);

        return stats;
    }

    /**
     * @param {number} connectedRealmId
     * @return {Promise<object>}
     */
    async function getPriorAuctionList(connectedRealmId) {
        const path = Path.resolve(DATA_DIR, '' + connectedRealmId, 'auctionItems.json');

        let data;
        try {
            data = await fs.readFile(path);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return [];
            }

            throw error;
        }

        return JSON.parse(data);
    }

    /**
     * @param {number} connectedRealmId
     * @param {object} list
     * @return {Promise<void>}
     */
    async function putPriorAuctionList(connectedRealmId, list) {
        const path = Path.resolve(DATA_DIR, '' + connectedRealmId, 'auctionItems.json');

        const json = JSON.stringify(list);

        try {
            await fs.writeFile(path, json);
        } catch (error) {
            if (error.code === 'ENOENT') {
                const parent = Path.dirname(path);

                await fs.mkdir(parent, {recursive: true});
                await fs.writeFile(path, json);

                return;
            }

            throw error;
        }
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
        const itemState = await ItemState.get(connectedRealmId, itemKey);

        itemState.auctions = [];
        stats.auc = stats.auc || {};
        for (let price in stats.auc) {
            if (!stats.auc.hasOwnProperty(price)) {
                continue;
            }
            itemState.auctions.push([parseInt(price), stats.auc[price]]);
        }

        itemState.specifics = stats.specifics || [];

        itemState.price = stats.p || itemState.price;
        itemState.quantity = stats.q || 0;
        itemState.snapshot = thisSnapshot;

        itemState.snapshots = itemState.snapshots || [];
        itemState.snapshots.push([itemState.snapshot, itemState.price, itemState.quantity]);

        let foundFirstTooOld = false;
        for (let index = itemState.snapshots.length - 1; index >= 0; index--) {
            let snapshot = itemState.snapshots[index];
            if (snapshot[0] < tooOld) {
                if (!foundFirstTooOld) {
                    foundFirstTooOld = true;
                } else {
                    itemState.snapshots.splice(index, 1);
                }
            }
        }

        await ItemState.put(connectedRealmId, itemKey, itemState);
    }
};

async function main () {
    aliveness = new Aliveness(60 * 1000);

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
                        aliveness.close();
                        process.exit();
                    });
                } catch (err) {
                    logMsg("Error while processing auctions", m.data.connectedRealmId);
                    console.log(err);

                    process.send({
                        action: 'error'
                    }, undefined, undefined, () => {
                        aliveness.close();
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

