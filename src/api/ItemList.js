const Path = require('path');
const ItemKeySerialize = require("../itemKeySerialize");
const Constants = require("../constants");
const ShatariWriter = require("../shatariWriter");
const {gzip} = require("node-gzip");
const RealmListReader = require("./realmListReader");

module.exports = class ItemList {
    #items = {};
    #pets = {};
    #snapshot = undefined;

    constructor(snapshot) {
        this.#snapshot = snapshot;
    }

    add(itemKeyString, itemData) {
        const itemKey = ItemKeySerialize.parse(itemKeyString);

        let target;
        if (itemKey.itemId === Constants.ITEM_PET_CAGE) {
            const species = itemKey.itemLevel;
            const breed = itemKey.itemSuffix;
            target = this.#pets[species] ??= {
                species,
                ...itemData,
            };

            if (breed) {
                target.breed ??= {};
                target = target.breed[breed] ??= {
                    breed,
                    ...itemData,
                };
            }
        } else {
            target = this.#items[itemKey.itemId] ??= {
                item: itemKey.itemId,
                ...itemData,
            };
            if (itemKey.itemLevel) {
                target.level ??= {};
                target = target.level[itemKey.itemLevel] ??= {
                    level: itemKey.itemLevel,
                    ...itemData,
                };
                if (itemKey.itemSuffix) {
                    target.suffix ??= {};
                    target = target.suffix[itemKey.itemSuffix] ??= {
                        suffix: itemKey.itemSuffix,
                        ...itemData,
                    };
                }
            }
        }
        Object.assign(target, itemData);
    }

    save(stateType, fileName, isCommodities) {
        const waitFor = [];

        let region;
        let realms;
        if (stateType === 'region') {
            region = fileName;
        } else if (stateType === 'realm') {
            region = RealmListReader.getRegionByConnectedId(fileName);
            realms = RealmListReader.getRealmSlugsByConnectedId(fileName);
        }

        const saveOne = (itemType, size, data) => {
            const filePath = Path.resolve(Constants.API_DIR, stateType, itemType, size, `${fileName}.json`);

            const request = {};
            if (region) request.region = region;
            if (realms) request.realms = realms;
            request.list = itemType;
            request.detail = size;

            const result = {
                lastUpdated: new Date(),
            };
            if (this.#snapshot) {
                result.snapshot = new Date(this.#snapshot);
            }
            result[itemType] = data;

            const json = JSON.stringify({request, result});
            waitFor.push(ShatariWriter(filePath, json));
            waitFor.push((async () => {
                await ShatariWriter(`${filePath}.gz`, await gzip(json));
            })());
        };

        if (isCommodities) {
            saveOne('commodities', 'full', this.#items);
        } else {
            saveOne('items', 'full', this.#items);
            saveOne('pets', 'full', this.#pets);
        }

        Object.values(this.#items).forEach(entry => {delete entry.level});
        Object.values(this.#pets).forEach(entry => {delete entry.breed});

        if (isCommodities) {
            saveOne('commodities', 'base', this.#items);
        } else {
            saveOne('items', 'base', this.#items);
            saveOne('pets', 'base', this.#pets);
        }

        return waitFor;
    }
}
