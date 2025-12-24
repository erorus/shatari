const process = require('process');
const dateFormat = require('dateformat');

const Aliveness = require('./aliveness');
const Constants = require('./constants');
const ItemKey = require('./itemKey');
const ItemKeySerialize = require('./itemKeySerialize');
const ItemState = require('./itemState');
const Runner = require('./runner');
const RealmState = require("./realmState");

const CONCURRENT_ITEM_LIMIT = 8;

let aliveness;
let region;
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
        message = (region || 'unknown').toUpperCase() + " realm " + realm + " " + message;
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
        const bonusStatItems = {};

        const summaryLastSeen = {};
        const itemKeysToUpdate = new Set();
        {
            const realmState = await RealmState.get(connectedRealmId);
            realmState.summary ??= {};
            for (let itemKeyString in realmState.summary) {
                const [snapshot, price, quantity] = realmState.summary[itemKeyString];
                summaryLastSeen[itemKeyString] = snapshot;
                if (quantity > 0) {
                    itemKeysToUpdate.add(itemKeyString);
                }
            }
        }

        const petKeysToModifiers = {
            pet_quality_id: Constants.MODIFIER_BATTLE_PET_QUALITY,
            pet_breed_id: Constants.MODIFIER_BATTLE_PET_BREED,
            pet_level: Constants.MODIFIER_BATTLE_PET_LEVEL,
            pet_species_id: Constants.MODIFIER_BATTLE_PET_SPECIES,
        };

        (data.auctions || []).forEach(function (auction) {
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

            // Simple (transmog mode) stats, in the auc array.
            {
                const itemKey = itemData['class'] === Constants.CLASS_BATTLE_PET ?
                    ItemKeySerialize.stringify({itemId: itemId, itemSuffix: 0, itemLevel: auction.item.pet_species_id || 0}) :
                    ItemKeySerialize.stringify({itemId: itemId, itemSuffix: 0, itemLevel: 0});
                if (!stats[itemKey]) {
                    stats[itemKey] = {
                        p: 0,
                        q: 0,
                        auc: {},
                    };
                }
                itemKeysToUpdate.add(itemKey);

                const item = stats[itemKey];
                if (!item.p || item.p > price) {
                    item.p = price;
                }
                item.q += quantity;

                item.auc[price] = (item.auc[price] || 0) + quantity;
            }

            // Specifics for equipment and battle pets.
            if (Constants.CLASSES_WITH_SPECIFICS.includes(itemData['class'])) {
                const itemKeyFull = ItemKeySerialize.stringify(ItemKey.get(auction.item));
                if (!stats[itemKeyFull]) {
                    stats[itemKeyFull] = {
                        p: 0,
                        q: 0,
                        specifics: [],
                    };
                }
                itemKeysToUpdate.add(itemKeyFull);

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
                const foundModifiers = {};
                (auction.item.modifiers || []).forEach(modifier => {
                    foundModifiers[modifier.type] = true;
                    spec[1].push([modifier.type, modifier.value]);
                });
                if (itemData['class'] === Constants.CLASS_BATTLE_PET) {
                    // Blizzard pulls out some pet attributes from the modifiers, but we push them back in.
                    for (let petKeyName in petKeysToModifiers) {
                        if (
                            petKeysToModifiers.hasOwnProperty(petKeyName) &&
                            !foundModifiers[petKeysToModifiers[petKeyName]] &&
                            auction.item.hasOwnProperty(petKeyName)
                        ) {
                            spec[1].push([petKeysToModifiers[petKeyName], auction.item[petKeyName]]);
                        }
                    }
                }
                item.specifics.push(spec);

                ItemKey.getBonusStats(auction.item)
                    .forEach(statId => bonusStatItems[statId] = (bonusStatItems[statId] || new Set()).add(itemKeyFull));
            }
        });

        aliveness.checkIn();

        logMsg("found " + itemKeysToUpdate.size + " items to update", connectedRealmId);

        let running = [];
        for (const itemKey of itemKeysToUpdate) {
            while (running.length >= CONCURRENT_ITEM_LIMIT) {
                await Runner.waitForOne(running);
            }

            aliveness.checkIn();

            stats[itemKey] ??= {};
            running.push(Runner.wrap(updateRealmItem(
                connectedRealmId,
                itemKey,
                thisSnapshot,
                summaryLastSeen[itemKey] ?? thisSnapshot,
                stats[itemKey],
            )));
        }
        await Promise.all(running);

        const results = {
            stats: stats,
            bonusStatItems: {},
        };
        Object.keys(bonusStatItems)
            .forEach(statKey => results.bonusStatItems[statKey] = Array.from(bonusStatItems[statKey].values()));

        return results;
    }

    /**
     * Updates the individual realm's item state file for the given realm+item and the given stats.
     *
     * @param {number} connectedRealmId
     * @param {string} itemKey
     * @param {number} thisSnapshot
     * @param {number} lastSeenSnapshot
     * @param {object} stats
     */
    async function updateRealmItem(connectedRealmId, itemKey, thisSnapshot, lastSeenSnapshot, stats) {
        const itemState = await ItemState.get(connectedRealmId, itemKey);

        itemState.auctions = [];
        const auc = stats.auc || {};
        for (let price in auc) {
            if (!auc.hasOwnProperty(price)) {
                continue;
            }
            itemState.auctions.push([parseInt(price), auc[price]]);
        }

        itemState.specifics = stats.specifics || [];

        itemState.price = stats.p = stats.p || itemState.price;
        itemState.quantity = stats.q = stats.q || 0;
        itemState.snapshot = stats.q > 0 ? thisSnapshot : lastSeenSnapshot;

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

        itemState.daily = itemState.daily || [];
        let todayTimestamp = Math.floor(itemState.snapshot / Constants.MS_DAY) * Constants.MS_DAY;
        let todayState = [todayTimestamp, itemState.price, itemState.quantity];
        let foundToday = false;
        let needsSort = false;
        for (let index = itemState.daily.length - 1; index >= 0; index--) {
            let dayState = itemState.daily[index];
            if (dayState[0] === todayTimestamp) {
                foundToday = true;
                if (dayState[2] <= todayState[2]) {
                    // The quantity we recorded for today is less than or equal to the current quantity. Replace it.
                    itemState.daily[index] = todayState;
                }
                break;
            }
            if (dayState[0] > todayTimestamp) {
                // We found a day after today when scanning from the end of the list. If we need to add a row for today,
                // we will need to re-sort the list.
                needsSort = true;
            }
            if (dayState[0] < todayTimestamp - 7 * Constants.MS_DAY) {
                // Assume data older than a week ago is in order and doesn't contain today.
                break;
            }
        }
        if (!foundToday) {
            itemState.daily.push(todayState);
            if (needsSort) {
                itemState.daily.sort((a, b) => a[0] - b[0]);
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
                region = m.data.region;
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

