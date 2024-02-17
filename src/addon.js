const axios = require('axios');
const process = require('process');
const fs = require('fs').promises;
const syncFs = require('fs');
const Path = require('path');

const dateFormat = require('dateformat');
const BNet = require('./battlenet');
const RunOnce = require('./runOnce');
const luaQuote = require('./luaQuote');

const RealmState = require('./realmState');
const Constants = require('./constants');
const ItemKeySerialize = require('./itemKeySerialize');
const ItemState = require('./itemState');
const CommodityRealm = require('./commodityRealm');

const api = new BNet();
const regions = [api.REGION_US, api.REGION_EU, api.REGION_TW, api.REGION_KR];
const MIN_EXPANSION_ITEM_VARIATIONS = 10;
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

    let listPath = Path.resolve(__dirname, '..', 'realms', 'realm-list.json');
    realmList = JSON.parse(await fs.readFile(listPath));
    logMsg('' + Object.keys(realmList).length + ' realms in list.');

    listPath = Path.resolve(__dirname, '..', 'items.all.json');
    itemList = JSON.parse(await fs.readFile(listPath));
    logMsg('' + Object.keys(itemList).length + ' items in list.');

    let promises = [];
    promises.push(generateBonusToNameId());
    promises.push(generateSpeciesStats());
    promises.push(generateToc());
    await Promise.all(promises);
    for (let region, regionIndex = 0; region = regions[regionIndex]; regionIndex++) {
        await processRegion(region);
    }

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
        connectedRealm.secondary.sort((a, b) => a.slug.localeCompare(b.slug));
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
        logMsg("Scanning " + region + " connected realm " + connectedRealm.id + " (" + connectedRealm.canonical.slug + ")");

        for (let itemKeyString in realmState.summary) {
            if (!realmState.summary.hasOwnProperty(itemKeyString)) {
                continue;
            }
            let itemKey = ItemKeySerialize.parse(itemKeyString);
            if (itemKey.itemId === Constants.ITEM_PET_CAGE) {
                // We only include full battle pet strings, not those without breeds.
                if (itemKey.itemSuffix) {
                    knownItemKeys[itemKeyString] = true;
                }
            } else {
                let item = itemList[itemKey.itemId];
                if (!item) {
                    logMsg("Could not identify item " + itemKey.itemId + " (" + itemKeyString + ")");
                    continue;
                }
                if (item.stack > 1) {
                    // This is a commodity item.
                    continue;
                }
                // Is this a known old item?
                if (item.expansion < MIN_EXPANSION_ITEM_VARIATIONS) {
                    // Old items never use variations in the addon. Only include this if there is no item level.
                    if (!itemKey.itemLevel) {
                        knownItemKeys[itemKeyString] = true;
                    }
                } else {
                    // This is a newer item. Does it even use variations?
                    if (Constants.CLASSES_EQUIPMENT.includes(item['class'])) {
                        // It does. Only include this if there is an item level.
                        if (itemKey.itemLevel) {
                            knownItemKeys[itemKeyString] = true;
                        }
                    } else {
                        // It doesn't use variations. Include it as-is.
                        knownItemKeys[itemKeyString] = true;
                    }
                }
            }
        }
    }

    let usedConnectedIds = Object.keys(usedRealmStates);
    usedConnectedIds.sort((a, b) => parseInt(a) - parseInt(b));
    let realmCount = usedConnectedIds.length;

    let commodityRealmId = CommodityRealm.getRealmForRegion(region);
    if (!commodityRealmId) {
        logMsg(`Could not determine commodity realm for region ${region}!`);
    } else {
        let realmState = await RealmState.get(commodityRealmId);
        usedRealmStates[commodityRealmId] = realmState;
        logMsg(`Scanning ${region} commodity realm ${commodityRealmId}`);
        Object.keys(realmState.summary).forEach(itemKeyString => {
            let itemKey = ItemKeySerialize.parse(itemKeyString);
            if (itemKey.itemId === Constants.ITEM_PET_CAGE) {
                return;
            }

            let item = itemList[itemKey.itemId];
            if (!item) {
                logMsg(`Could not identify item ${itemKey.itemId} (${itemKeyString})`);
                return;
            }
            if (item.stack <= 1) {
                logMsg(`Skipping non-commodity item ${itemKey.itemId} (${itemKeyString}) (${item.stack} stack) in commodity realm.`);
                return;
            }
            knownItemKeys[itemKeyString] = true;
        });
    }

    knownItemKeys = Object.keys(knownItemKeys);
    knownItemKeys.sort((a, b) => {
        let aKey = ItemKeySerialize.parse(a);
        let bKey = ItemKeySerialize.parse(b);

        return (aKey.itemId - bKey.itemId) || (aKey.itemLevel - bKey.itemLevel) || (aKey.itemSuffix - bKey.itemSuffix);
    });
    logMsg(`Found ${knownItemKeys.length} distinct item keys in region ${region}`);

    let guidLua = [];
    for (let realmIndex = 0; realmIndex < realmCount; realmIndex++) {
        let connectedRealm = connectedRealms[usedConnectedIds[realmIndex]];
        guidLua.push(`[${connectedRealm.canonical.id}]=${realmIndex}`);
        connectedRealm.secondary.forEach(realm => guidLua.push(`[${realm.id}]=${realmIndex}`));
    }
    guidLua = guidLua.join(',');

    let luaPath = Path.resolve(__dirname, '..', 'addon', 'dynamic', 'data.' + region + '.lua');
    let luaStream = syncFs.createWriteStream(luaPath);
    await luaStream.write(Buffer.from([0xEF, 0xBB, 0xBF]));
    await luaStream.write(`
local addonName, addonTable = ...
addonTable.dataLoads = addonTable.dataLoads or {}

local realmIndex
local dataFuncs = {}

local loc_substr = string.sub
local scc = strconcat

local function crop(priceSize, b)
    local headerSize = 1 + priceSize
    local recordSize = 1 + priceSize

    local offset = 1 + headerSize + recordSize * realmIndex

    return loc_substr(b, 1, headerSize)..loc_substr(b, offset, offset + recordSize - 1)
end
`);
    let luaLines = 0;
    let dataFuncIndex = 0;

    let nextLog = Date.now() + 5 * Constants.MS_SEC;
    for (let itemKeyString, itemKeyIndex = 0; itemKeyString = knownItemKeys[itemKeyIndex]; itemKeyIndex++) {
        let itemKey = ItemKeySerialize.parse(itemKeyString);
        let item = itemList[itemKey.itemId];
        if (!item) {
            return;
        }
        let isCommodity = item.stack > 1;
        let itemRealmCount = isCommodity ? 1 : realmCount;

        let regionPrices = [];
        let realmDays = new Uint8Array(itemRealmCount);
        let realmPrices = new Uint32Array(itemRealmCount);

        let processItemInRealm = async function (connectedId, realmIndex) {
            let summaryData = usedRealmStates[connectedId].summary[itemKeyString];
            let days;

            if (item.vendorBuy) {
                days = 252;
            } else if (!summaryData) {
                days = 0;
            } else {
                days = Math.min(251, Math.floor(Math.max(0, now - summaryData[0]) / Constants.MS_DAY));
            }
            realmDays[realmIndex] = days;

            if (!summaryData) {
                return;
            }

            let itemState = await ItemState.get(connectedId, itemKeyString);
            if (!itemState || !itemState.snapshots) {
                return;
            }

            let priceList = getPriceList(usedRealmStates[connectedId], itemState);
            if (!priceList.length) {
                return;
            }

            let median = getMedian(priceList);
            realmPrices[realmIndex] = median;
            regionPrices.push(median);
        }
        if (isCommodity) {
            await processItemInRealm(commodityRealmId, 0);
        } else {
            let promises = [];
            for (let connectedId, connectedIndex = 0; connectedId = usedConnectedIds[connectedIndex]; connectedIndex++) {
                promises.push(processItemInRealm(connectedId, connectedIndex));
            }
            await Promise.all(promises);
        }

        // Scan all the prices to find the minimum required number of bytes.
        let priceSize = 1;
        for (let priceIndex = 0; (priceSize < 4) && (priceIndex < itemRealmCount); priceIndex++) {
            while (realmPrices[priceIndex] >= (1 << (priceSize * 8))) {
                if (++priceSize >= 4) {
                    break;
                }
            }
        }

        let buf;
        if (isCommodity) {
            // price size, region price, region days
            let lineBufferSize = 1 + priceSize + 1;
            buf = Buffer.allocUnsafe(lineBufferSize);
            buf.writeUInt8(priceSize, 0);
            buf.writeUIntBE(realmPrices[0], 1, priceSize);
            buf.writeUInt8(realmDays[0], 1 + priceSize);
        } else {
            // price size, region median, realm 0 days, realm 0 price, realm 1 days, realm 1 price, ...
            let lineBufferSize = 1 + priceSize * (itemRealmCount + 1) + 1 * itemRealmCount;
            buf = Buffer.allocUnsafe(lineBufferSize);
            buf.writeUInt8(priceSize, 0);
            buf.writeUIntBE(getMedian(regionPrices), 1, priceSize);
            let offset = 1 + priceSize;
            for (let index = 0; index < itemRealmCount; index++) {
                buf.writeUInt8(realmDays[index], offset++);
                buf.writeUIntBE(realmPrices[index], offset, priceSize);
                offset += priceSize;
            }
        }

        if (luaLines === 0) {
            dataFuncIndex++;
            await luaStream.write(`dataFuncs[${dataFuncIndex}] = function()\nlocal md = addonTable.marketData\n`);
        }

        if (isCommodity) {
            await luaStream.write(Buffer.concat([
                Buffer.from(`md['${itemKeyString}']=`),
                luaQuote(buf),
                Buffer.from('\n'),
            ]));
        } else {
            await luaStream.write(Buffer.concat([
                Buffer.from(`md['${itemKeyString}']=crop(${priceSize},`),
                luaQuote(buf),
                Buffer.from(')\n'),
            ]));
        }

        if (++luaLines >= 2000) {
            await luaStream.write('end\n');
            luaLines = 0;
        }

        if (nextLog <= Date.now()) {
            logMsg(`${region} Processed ` + (itemKeyIndex + 1) + " of " + knownItemKeys.length + " or " + Math.round((itemKeyIndex + 1) / knownItemKeys.length * 100) + "%. (Last was " + itemKeyString + ")");
            nextLog = Date.now() + 5 * Constants.MS_SEC;
        }
    }
    if (luaLines > 0) {
        await luaStream.write('end\n');
    }

    await luaStream.write(`
local dataLoad = function(realmId)
    local realmGuids = {${guidLua}}
    realmIndex = realmGuids[realmId]

    if realmIndex == nil then
        wipe(dataFuncs)
        return false
    end

    addonTable.marketData = {}
    addonTable.realmIndex = realmIndex
    addonTable.dataAge = ${Math.floor(now / Constants.MS_SEC)}
    addonTable.region = "${region.toUpperCase()}"

    for i=1,#dataFuncs,1 do
        dataFuncs[i]()
        dataFuncs[i]=nil
    end

    wipe(dataFuncs)
    return true
end

table.insert(addonTable.dataLoads, dataLoad)
`);

    luaStream.end();
    logMsg("Finished with region " + region);
}

async function fetchInterfaceVersion() {
    let response;
    try {
        response = await axios.get('https://raw.githubusercontent.com/DeadlyBossMods/DBM-Retail/master/DBM-WorldEvents/DBM-WorldEvents.toc');
    } catch (e) {
        response = null;
        logMsg("Could not fetch interface version..");
        console.log(e);
    }
    if (!response || response.status !== 200) {
        return null;
    }

    const match = response.data.match(/^##\s*Interface:\s*(\d+)/i);
    if (match) {
        return match[1];
    }

    return null;
}

async function generateBonusToNameId() {
    const BONUSES_PATH = Path.resolve(__dirname, '..', 'bonuses.json');
    const bonusData = JSON.parse(await fs.readFile(BONUSES_PATH));

    let namesLua = [];
    for (let bonusId in bonusData.names) {
        if (!bonusData.names.hasOwnProperty(bonusId)) {
            continue;
        }

        namesLua.push(`[${bonusId}]={${bonusData.names[bonusId].join(',')}}`);
    }
    namesLua = namesLua.join(',');

    const luaPath = Path.resolve(__dirname, '..', 'addon', 'dynamic', 'bonusToName.lua');
    let luaStream = syncFs.createWriteStream(luaPath);
    await luaStream.write(Buffer.from([0xEF, 0xBB, 0xBF]));
    await luaStream.write(`
local addonName, addonTable = ...

local namesByBonus = {${namesLua}}

local function getNameId(item)
    local _, link = GetItemInfo(item)
    if not link then
        return nil
    end

    local itemString = string.match(link, "item[%-?%d:]+")
    local itemStringParts = { strsplit(":", itemString) }

    local numBonuses = tonumber(itemStringParts[14],10) or 0

    if numBonuses == 0 then
        return nil
    end

    local name, namePrio

    for y = 1,numBonuses,1 do
        local bonus = tonumber(itemStringParts[14+y], 10) or 0
        local nameInfo = namesByBonus[bonus]
        if nameInfo then
            if name == nil or namePrio > nameInfo > nameInfo[1] then
                namePrio = nameInfo[1]
                name = nameInfo[2]
            end
        end
    end

    return name
end

addonTable.getNameId = getNameId
`);
    luaStream.end();
}

async function generateSpeciesStats() {
    const SPECIES_PATH = Path.resolve(__dirname, '..', 'battlepets.json');
    const petData = JSON.parse(await fs.readFile(SPECIES_PATH));

    let statsLua = ['[0]={8,8,8}'];
    for (let speciesId in petData) {
        if (!petData.hasOwnProperty(speciesId)) {
            continue;
        }

        statsLua.push(`[${speciesId}]={${petData[speciesId].stamina},${petData[speciesId].power},${petData[speciesId].speed}}`);
    }
    statsLua = statsLua.join(',');

    const luaPath = Path.resolve(__dirname, '..', 'addon', 'dynamic', 'speciesStats.lua');
    let luaStream = syncFs.createWriteStream(luaPath);
    await luaStream.write(Buffer.from([0xEF, 0xBB, 0xBF]));
    await luaStream.write(`
local addonName, addonTable = ...

addonTable.speciesStats = {${statsLua}}
`);
    luaStream.end();
}

async function generateToc() {
    let addonInterface = (await fetchInterfaceVersion()) || '100100';
    let notes = dateFormat(new Date(now), 'dddd, mmmm dS, yyyy');
    let yyyymmdd = dateFormat(new Date(now), 'yyyymmdd');
    let dataFiles = [];
    regions.forEach(region => dataFiles.push(`dynamic\\data.${region}.lua`));
    dataFiles = dataFiles.join("\n");

    let toc = `## Interface: ${addonInterface}
## Title: Oribos Exchange
## Notes: ${notes}
## OptionalDeps: Auctionator, AuctionLite, LibExtraTip
## SavedVariablesPerCharacter: OETooltipsHidden, OETooltipsSettings
## Version: 1.1.${yyyymmdd}
## IconTexture: 3536196

libs\\LibExtraTip\\Load.xml

dynamic\\bonusToName.lua
dynamic\\speciesStats.lua
${dataFiles}

OribosExchange.lua
`;

    const TOC_PATH = Path.resolve(__dirname, '..', 'addon', 'OribosExchange.toc');
    let luaStream = syncFs.createWriteStream(TOC_PATH);
    await luaStream.write(toc);
    luaStream.end();
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

function getMedian(values) {
    values.sort((a, b) => a - b);
    let median = values[Math.floor(values.length / 2)];
    if (values.length % 2 === 0) {
        median += values[values.length / 2 - 1];
        median = Math.round(median / 2);
    }

    return median;
}

main().catch(function (e) {
    console.error("Unhandled exception:");
    console.error(e);

    process.exit(2);
});
