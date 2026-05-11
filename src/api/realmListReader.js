const fs = require('fs').promises;
const Path = require('path');

const realmLookup = {};
const regionLookup = {};
const idLookup = {};

module.exports = new function () {
    this.getConnectedId = (region, realmSlug) => realmLookup[region]?.[realmSlug];
    this.getRegionByConnectedId = connectedId => regionLookup[connectedId];
    this.getRealmSlugsByConnectedId = connectedId => idLookup[connectedId] ?? [];
}

async function readRealms() {
    const realmList = JSON.parse(await fs.readFile(
        Path.resolve(__dirname, '..', '..', 'realms', 'realm-list.json'),
        {encoding: 'utf8'},
    ));

    const newIdLookup = {};

    Object.values(realmList).forEach(realm => {
        const regionMap = realmLookup[realm.region] ??= {};
        regionMap[realm.slug] = realm.connectedId;

        (newIdLookup[realm.connectedId] ??= []).push(realm.slug);
        regionLookup[realm.connectedId] = realm.region;
    });
    Object.values(newIdLookup).forEach(slugList => slugList.sort((a, b) => a.localeCompare(b)));
    Object.assign(idLookup, newIdLookup);

    setTimeout(readRealms, 1000 * 60 * 60).unref();
}

readRealms();
