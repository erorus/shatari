const fs = require('fs');
const Path = require('path');
const Constants = require('./constants');

const BONUSES_PATH = Path.resolve(__dirname, '..', 'bonuses.json');
const ITEMS_PATH = Path.resolve(__dirname, '..', 'items.json');

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

        result.itemLevel = item.itemLevel;

        let curve, curvePrio;
        let name, namePrio;
        let levelAdjust = 0;

        if (auctionItem.bonus_lists) {
            auctionItem.bonus_lists.forEach(function (bonus) {
                levelAdjust += bonusData.levels[bonus] || 0;

                let params = bonusData.curves[bonus];
                if (params && (!curve || curvePrio > params[0])) {
                    curvePrio = params[0];
                    curve = params[1];
                }

                params = bonusData.names[bonus];
                if (params && (!name || namePrio > params[0])) {
                    namePrio = params[0];
                    name = params[1];
                }
            });
        }

        if (curve) {
            let playerLevel = 60;
            auctionItem.modifiers.forEach(function (modifier) {
                if (modifier.type === Constants.MODIFIER_TIMEWALKER_LEVEL) {
                    playerLevel = modifier.value;
                }
            });

            result.itemLevel = Math.round(getCurvePoint(curve, playerLevel));
        } else if (levelAdjust) {
            result.itemLevel = item.itemLevel + levelAdjust;
        }

        if (name) {
            result.itemSuffix = name;
        }

        return result;
    }

    function getCurvePoint(curveId, x) {
        let curve = bonusData.curvePoints[curveId];
        if (!curve) {
            return 0;
        }

        let keys = Object.keys(curve);
        keys.map(value => parseInt(value)).sort(function (a, b) {
            return a - b;
        });

        if (x <= curve[keys[0]][0]) {
            return curve[keys[0]][1];
        }

        for (let i = 1; i < keys.length; i++) {
            let step = keys[i];
            let prev = keys[i - 1];
            if (x < curve[step][0]) {
                let pct = (x - curve[prev][0]) / (curve[step][0] - curve[prev][0]);
                let scale = curve[step][1] - curve[prev][1];

                return curve[prev][1] + (pct * scale);
            }
        }

        return curve[keys[keys.length - 1]][1];
    }
}
