const fs = require('fs').promises;
const Path = require('path');
const {gzip, ungzip} = require('node-gzip');

const Constants = require('./constants');
const ItemKeySerialize = require('./itemKeySerialize');
const ShatariWriter = require('./shatariWriter');
const {getRegionForRealm} = require("./commodityRealm");

const API_DIR = Constants.API_DIR;
const DATA_DIR = Constants.DATA_DIR;

module.exports = new function () {
    const COPPER_SILVER = 100;
    const MS_SEC = 1000;
    const VERSION = 4;

    // ------ //
    // PUBLIC //
    // ------ //

    /**
     * Reads from disk and returns the local state object for the given connected realm.
     *
     * @param {number} connectedRealmId
     * @return {object}
     */
    this.get = async function (connectedRealmId) {
        const path = getPath(connectedRealmId);
        let compressed;
        try {
            compressed = await fs.readFile(path);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return {};
            }

            throw error;
        }

        let buf;
        try {
            buf = await ungzip(compressed);
        } catch (e) {
            console.log("Realm " + connectedRealmId + " Error unzipping realm state");
            console.log(e);

            return {};
        }

        let cursorPosition = 0;
        let advance = function (size) {
            let res = cursorPosition;
            cursorPosition += size;

            return res;
        };

        let hasBonusStatItems = true;
        const version = buf.readUInt8(advance(1));
        switch (version) {
            case 3:
                hasBonusStatItems = false;
                break;
            case VERSION:
                // no op
                break;
            default:
                throw "Unsupported version: " + version;
        }

        const result = {};
        result.snapshot = buf.readUInt32LE(advance(4)) * MS_SEC;
        result.lastCheck = buf.readUInt32LE(advance(4)) * MS_SEC;
        result.snapshots = [];
        for (let remaining = buf.readUInt16LE(advance(2)); remaining > 0; remaining--) {
            result.snapshots.push(buf.readUInt32LE(advance(4)) * MS_SEC);
        }
        result.summary = {};
        for (let remaining = buf.readUInt32LE(advance(4)); remaining > 0; remaining--) {
            let itemKey = {
                itemId: buf.readUInt32LE(advance(4)),
                itemLevel: buf.readUInt16LE(advance(2)),
                itemSuffix: buf.readUInt16LE(advance(2)),
            };
            let itemKeyString = ItemKeySerialize.stringify(itemKey);
            let snapshot = buf.readUInt32LE(advance(4)) * MS_SEC;
            let price = buf.readUInt32LE(advance(4)) * COPPER_SILVER;
            let quantity = buf.readUInt32LE(advance(4));
            result.summary[itemKeyString] = [snapshot, price, quantity];
        }
        result.bonusStatItems = {};
        if (hasBonusStatItems) {
            for (let statCount = buf.readUInt8(advance(1)); statCount > 0; statCount--) {
                const statId = buf.readUInt8(advance(1));
                result.bonusStatItems[statId] = [];
                for (let keyCount = buf.readUInt16LE(advance(2)); keyCount > 0; keyCount--) {
                    const itemKey = {
                        itemId: buf.readUInt32LE(advance(4)),
                        itemLevel: buf.readUInt16LE(advance(2)),
                        itemSuffix: buf.readUInt16LE(advance(2)),
                    };
                    result.bonusStatItems[statId].push(ItemKeySerialize.stringify(itemKey));
                }
            }
        }

        if (cursorPosition !== buf.length) {
            throw "Read " + cursorPosition + " bytes of buffer with length " + buf.length;
        }

        return result;
    }

    /**
     * Writes to disk the given state for the given connected realm.
     *
     * @param {number} connectedRealmId
     * @param {object} state
     * @param {boolean} updateApiData
     */
    this.put = async function (connectedRealmId, state, updateApiData) {
        const waitFor = [];
        if (updateApiData) {
            waitFor.push(...putApiData(connectedRealmId, state));
        }

        // Start off with version number in front.
        let bufferSize = 1;
        // 4 bytes for snapshot timestamp
        bufferSize += 4;
        // 4 bytes for last check timestamp
        bufferSize += 4;
        // 2 bytes for snapshot list length, then the snapshot list
        bufferSize += 2 + 4 * (state.snapshots || []).length;
        // 4 bytes for summary list length, then lists of id+level+suffix+snapshot+silvers+quantity
        bufferSize += 4 + (4 + 2 + 2 + 4 + 4 + 4) * Object.keys(state.summary || {}).length;
        // 1 byte for the bonus stat count, then 1 byte for the bonus stat id and 2 bytes for the item count
        bufferSize += 1 + (1 + 2) * Object.keys(state.bonusStatItems || {}).length;
        // The length of each bonus stat item list, comprised of id+level+suffix.
        Object.values(state.bonusStatItems || {}).forEach(itemList => bufferSize += itemList.length * (4 + 2 + 2));

        const buf = Buffer.allocUnsafe(bufferSize);
        const freeBuf = Buffer.allocUnsafe(bufferSize);
        let cursorPosition = 0;
        let advance = function (size) {
            let res = cursorPosition;
            cursorPosition += size;

            return res;
        };

        // Version
        buf.writeUInt8(VERSION, advance(1));

        // Snapshot
        buf.writeUInt32LE((state.snapshot || 0) / MS_SEC, advance(4));

        // Last Check
        buf.writeUInt32LE((state.lastCheck || 0) / MS_SEC, advance(4));

        // List of snapshots
        buf.writeUInt16LE((state.snapshots || []).length, advance(2));
        (state.snapshots || []).forEach((snapshot) => buf.writeUInt32LE(snapshot / MS_SEC, advance(4)));

        // Summary list
        let summary = state.summary || {};
        buf.writeUInt32LE(Object.keys(summary).length, advance(4));
        buf.copy(freeBuf, 0, 0, cursorPosition);
        for (let itemKeyString in summary) {
            if (!summary.hasOwnProperty(itemKeyString)) {
                continue;
            }
            const itemKey = ItemKeySerialize.parse(itemKeyString);
            let recordPos = cursorPosition;

            buf.writeUInt32LE(itemKey.itemId, advance(4));
            buf.writeUInt16LE(itemKey.itemLevel, advance(2));
            buf.writeUInt16LE(itemKey.itemSuffix, advance(2));
            buf.writeUInt32LE(summary[itemKeyString][0] / MS_SEC, advance(4));
            buf.writeUInt32LE(summary[itemKeyString][1] / COPPER_SILVER, advance(4));
            buf.writeUInt32LE(summary[itemKeyString][2], advance(4));

            if (isRestricted(itemKey)) {
                buf.copy(freeBuf, recordPos, recordPos, recordPos + 8); recordPos += 8;
                freeBuf.writeUInt32LE(0, recordPos); recordPos += 4; // timestamp
                freeBuf.writeUInt32LE(0, recordPos); recordPos += 4; // price
                freeBuf.writeUInt32LE(0, recordPos); recordPos += 4; // quantity
            } else {
                buf.copy(freeBuf, recordPos, recordPos, cursorPosition);
            }
        }

        // Bonus stat items
        let bonusStatPos = cursorPosition;
        let bonusStatItems = state.bonusStatItems || {};
        buf.writeUInt8(Object.keys(bonusStatItems).length, advance(1));
        for (let bonusStatString in bonusStatItems) {
            if (!bonusStatItems.hasOwnProperty(bonusStatString)) {
                continue;
            }
            buf.writeUInt8(parseInt(bonusStatString), advance(1));
            buf.writeUInt16LE(bonusStatItems[bonusStatString].length, advance(2));
            bonusStatItems[bonusStatString].forEach(itemKeyString => {
                let itemKey = ItemKeySerialize.parse(itemKeyString);

                buf.writeUInt32LE(itemKey.itemId, advance(4));
                buf.writeUInt16LE(itemKey.itemLevel, advance(2));
                buf.writeUInt16LE(itemKey.itemSuffix, advance(2));
            });
        }
        buf.copy(freeBuf, bonusStatPos, bonusStatPos);

        if (cursorPosition !== bufferSize) {
            throw "Wrote " + cursorPosition + " bytes into a buffer of size " + bufferSize;
        }

        const [comp, freeComp] = await Promise.all([gzip(buf), gzip(freeBuf)]);
        waitFor.push(
            ShatariWriter(getPath(connectedRealmId), comp),
            ShatariWriter(getPath(connectedRealmId, true), freeComp),
        );
        await Promise.all(waitFor);
    }

    // ------- //
    // PRIVATE //
    // ------- //

    /**
     * Returns the filesystem path to the connected realm's state file.
     *
     * @param {number} connectedRealmId
     * @param {boolean} freeVersion
     * @return {string}
     */
    function getPath(connectedRealmId, freeVersion = false) {
        const freePart = freeVersion ? '.free' : '';

        return Path.resolve(DATA_DIR, '' + connectedRealmId, `state${freePart}.bin`);
    }

    /**
     * Returns whether the given item key would be restricted for free users.
     *
     * @param {ItemKey} itemKey
     * @return {boolean}
     */
    function isRestricted(itemKey) {
        return !!(itemKey.itemSuffix || (itemKey.itemLevel && itemKey.itemId !== Constants.ITEM_PET_CAGE));
    }

    /**
     * Writes the JSON API files for the realm data.
     *
     * @param {number} connectedRealmId
     * @param {object} state
     * @return {Promise[]}
     */
    function putApiData(connectedRealmId, state) {
        const commodityRegion = getRegionForRealm(connectedRealmId);
        if (commodityRegion) {
            return putCommodityApiData(commodityRegion, state);
        }

        const waitFor = [];

        return waitFor;
    }

    /**
     * Writes the JSON API files for the commodity realm data.
     *
     * @param {string} region
     * @param {object} state
     * @return {Promise[]}
     */
    function putCommodityApiData(region, state) {
        const waitFor = [];

        const data = {};

        Object.entries(state.summary || {}).forEach(([itemKeyString, record]) => {
            const itemData = {
                price: record[1],
                quantity: record[2],
                lastSeen: record[0] / MS_SEC,
            }

            const itemKey = ItemKeySerialize.parse(itemKeyString);
            let target = data[itemKey.itemId] ??= {
                item: itemKey.itemId,
                ...itemData,
            };
            if (itemKey.itemLevel) {
                target.level ??= {};
                target = target.level[itemKey.itemLevel] ??= {
                    level: itemKey.level,
                    ...itemData,
                };
                if (itemKey.itemSuffix) {
                    target.suffix ??= {};
                    target = target.suffix[itemKey.itemSuffix] ??= {
                        suffix: itemKey.suffix,
                        ...itemData,
                    };
                }
            }

            Object.assign(target, itemData);
        });

        const save = (size, data) => {
            const filePath = Path.resolve(API_DIR, 'region', 'commodities', size, `${region}.json`);
            const json = JSON.stringify(data);
            waitFor.push(ShatariWriter(filePath, json));
            waitFor.push((async () => {
                await ShatariWriter(`${filePath}.gz`, await gzip(json));
            })());
        };

        save('full', data);
        Object.values(data).forEach(entry => {delete entry.level});
        save('base', data);

        return waitFor;
    }
};
