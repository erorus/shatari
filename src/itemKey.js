const fs = require('fs');
const Path = require('path');
const Constants = require('./constants');

const BONUSES_PATH = Path.resolve(__dirname, '..', 'bonuses.json');
const ITEMS_PATH = Path.resolve(__dirname, '..', 'items.all.json');

module.exports = new function () {
    const bonusData = JSON.parse(fs.readFileSync(BONUSES_PATH));
    const itemData = JSON.parse(fs.readFileSync(ITEMS_PATH));

    /**
     * @typedef {object} Modifier
     * @property {number} type
     * @property {number} value
     */

    /**
     * @typedef {object} AuctionItem
     * @property {number} id
     * @property {array<number>} [bonus_lists]
     * @property {array<Modifier>} [modifiers]
     */

    /**
     * @typedef {object} ItemKey
     * @property {number} itemId
     * @property {number} itemLevel
     * @property {number} itemSuffix
     */


    /**
     * Given an auction's item object, return its "item key" to uniquely identify the item.
     *
     * @param {AuctionItem} auctionItem An auction line's item object verbatim from the API.
     * @return {ItemKey}
     */
    this.get = function (auctionItem) {
        const result = {
            itemId: auctionItem.id,
            itemLevel: 0,
            itemSuffix: 0,
        };

        const item = itemData[auctionItem.id] || {};
        if (item['class'] === Constants.CLASS_BATTLE_PET) {
            result.itemLevel = auctionItem.pet_species_id || 0;
            result.itemSuffix = (((auctionItem.pet_breed_id || 3) - 3) % 10) + 3;
        }
        if (!Constants.CLASSES_EQUIPMENT.includes(item['class'])) {
            return result;
        }

        result.itemLevel = getItemLevel(item, auctionItem);

        if (auctionItem.bonus_lists) {
            auctionItem.bonus_lists
                .map(bonus => bonusData.names[bonus])
                .filter(row => row)
                .sort((a, b) => b[0] - a[0])
                .some(([prio, name]) => {
                    result.itemSuffix = name;

                    return true;
                });
        }

        return result;
    };

    /**
     * Given an auction's item object, return the IDs of the tracked bonus tertiary stats which it has.
     *
     * @param {AuctionItem} auctionItem
     * @return {number[]}
     */
    this.getBonusStats = function (auctionItem) {
        if (!auctionItem.bonus_lists) {
            return [];
        }

        const statBonuses = bonusData.statBonuses || {};

        return Object.keys(statBonuses)
            .filter(statKey => statBonuses[statKey].some(bonusId => auctionItem.bonus_lists.includes(bonusId)))
            .map(statKey => parseInt(statKey));
    };

    /**
     *
     * @param {number|array<number[]>} curveId
     * @param {number} x
     * @return {number}
     */
    function getCurvePoint(curveId, x) {
        let curve = (typeof curveId === 'number') ? bonusData.curvePoints[curveId] : curveId;
        if (!curve) {
            return 0;
        }

        if (x <= curve[0][0]) {
            return curve[0][1];
        }

        for (let i = 1; i < curve.length; i++) {
            let step = i;
            let prev = i - 1;
            if (x < curve[step][0]) {
                let pct = (x - curve[prev][0]) / (curve[step][0] - curve[prev][0]);
                let scale = curve[step][1] - curve[prev][1];

                return curve[prev][1] + (pct * scale);
            }
        }

        return curve[curve.length - 1][1];
    }

    /**
     * Returns the final item level of the item in the given auction.
     *
     * @param {object}      item
     * @param {AuctionItem} auctionItem
     * @return {number}
     */
    function getItemLevel(item, auctionItem) {
        let result = item.itemLevel;
        let era = item.squishEra ?? 0;

        let eraAdjust = {};

        if (auctionItem.bonus_lists) {
            let bonuses = auctionItem.bonus_lists;

            const exists = row => row;
            const byPrio = (a, b) => b[0] - a[0];

            let playerLevelTemp = Constants.PLAYER_LEVEL_CAP;
            auctionItem.modifiers?.forEach(function (modifier) {
                if (modifier.type === Constants.MODIFIER_TIMEWALKER_LEVEL) {
                    playerLevelTemp = modifier.value;
                }
            });
            const playerLevel = playerLevelTemp;

            // Legacy Set, type 42
            bonuses
                .map(bonus => bonusData.levelData.legacySet[bonus])
                .filter(exists)
                .sort(byPrio)
                .some(([prio, level]) => {
                    result = level;

                    return true;
                });

            // Content Tuning, type 13
            bonuses
                .map(bonus => bonusData.levelData.contentTuning[bonus])
                .filter(exists)
                .sort(byPrio)
                .some(([prio, curve, playerMax]) => {
                    result = Math.round(getCurvePoint(curve, Math.min(playerLevel, playerMax || playerLevel)));

                    return true;
                });

            // Legacy Adjust, type 1
            bonuses
                .map(bonus => bonusData.levelData.legacyAdjust[bonus])
                .filter(exists)
                .forEach(amount => {
                    result += amount;
                });

            // Item Scaling Config, type 49
            bonuses
                .map(bonus => bonusData.levelData.itemScalingSet[bonus])
                .filter(exists)
                .sort(byPrio)
                .some(([prio, level, curve, offset, setEra]) => {
                    result = (curve ? Math.round(getCurvePoint(curve, level || result)) : level) + offset;
                    era = setEra;

                    return true;
                });

            // Era Curve, type 48
            bonuses
                .map(bonus => bonusData.levelData.eraCurveSet[bonus])
                .filter(exists)
                .forEach(([curve, level, setEra]) => {
                    result = Math.round(getCurvePoint(curve, level || result));
                    era = setEra;
                });

            // Item Scaling Config by Drop Level, type 51
            bonuses
                .map(bonus => bonusData.levelData.itemScalingSetByPlayer[bonus])
                .filter(exists)
                .sort(byPrio)
                .some(([prio, level, curve, offset, setEra]) => {
                    result = (curve ? Math.round(getCurvePoint(curve, level || playerLevel)) : level) + offset;
                    era = setEra;

                    return true;
                });

            // Era Adjust, type 52
            // This whole bonus is weird. It seems to be used only on profession tools/accessories and makes no sense.
            bonuses
                .map(bonus => bonusData.levelData.eraAdjust[bonus])
                .filter(exists)
                .forEach(([amount, fallbackAmount, checkEra]) => {
                    // All of this is shaky speculation.
                    if (checkEra > era) {
                        eraAdjust[checkEra] ??= 0;
                        eraAdjust[checkEra] += amount;
                        if (era === 0) {
                            eraAdjust[2] ??= 0
                            eraAdjust[2] += 4; // Kludge. This makes our results match in-game, but I don't know why.
                        }
                    } else {
                        result += fallbackAmount;
                    }
                });

            // Adjust, type 53
            bonuses
                .map(bonus => bonusData.levelData.adjust[bonus])
                .filter(exists)
                .sort(byPrio)
                .some(([prio, amount]) => {
                    result += amount;

                    return true;
                });
        }

        for (let eraData, x = 0; eraData = bonusData.squishEras[x]; x++) {
            if (eraData.id > era && eraData.curve.length) {
                result = Math.round(getCurvePoint(eraData.curve, result));
            }

            result += eraAdjust[eraData.id] ?? 0;

            if (eraData.target) {
                break;
            }
        }

        return Math.max(1, result);
    }
}
