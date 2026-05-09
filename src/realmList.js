const process = require('process');
const fs = require('fs').promises;
const Path = require('path');

const dateFormat = require('dateformat');
const BNet = require('./battlenet');
const RunOnce = require('./runOnce');
const ShatariWriter = require('./shatariWriter');

const api = new BNet();
const regions = [api.REGION_US, api.REGION_EU, api.REGION_TW, api.REGION_KR];
const Constants = require('./constants');

async function main() {
    // Run this only once.
    let runOnce = new RunOnce('realm-list');
    try {
        await runOnce.start();
    } catch (e) {
        if (e === 'Already running') {
            return;
        }

        throw e;
    }

    let listPath = Path.resolve(__dirname, '..', 'realms', 'realm-list.json');
    let oldList = {};
    let oldJson = undefined;
    try {
        oldJson = await fs.readFile(listPath, {encoding: 'utf8'});
        oldList = JSON.parse(oldJson);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    logMsg('' + Object.keys(oldList).length + ' realms in existing list.');

    // Get realm list
    let realmList = await fetchRealmList();
    for (let id in realmList.ids) {
        if (!realmList.ids.hasOwnProperty(id)) {
            continue;
        }
        oldList[id] = realmList.ids[id];
    }

    logMsg('' + Object.keys(realmList.ids).length + ' realms in current list.');

    let writes = [];
    {
        const ordered = {};
        Object.keys(realmList.ids)
            .sort((a, b) => parseInt(a) - parseInt(b))
            .forEach(key => ordered[key] = realmList.ids[key]);

        const newJson = JSON.stringify(ordered);
        if (oldJson === newJson) {
            logMsg('No changes: no writes to main list.');
        } else {
            logMsg('Updates found: writing new main list.');
            writes.push(ShatariWriter(listPath, newJson));
        }
    }

    for (let locale in realmList.names) {
        if (!realmList.names.hasOwnProperty(locale)) {
            continue;
        }
        const path = Path.resolve(__dirname, '..', 'realms', `realm-names.${locale}.json`);

        const ordered = {};
        Object.keys(realmList.names[locale])
            .sort((a, b) => parseInt(a) - parseInt(b))
            .forEach(key => ordered[key] = realmList.names[locale][key]);

        const newJson = JSON.stringify(ordered);
        let oldJson = undefined;
        try {
            oldJson = await fs.readFile(path, {encoding: 'utf8'});
        } catch (error) {
            logMsg(`Failed to load old realm-names.${locale}.json`);
        }
        if (oldJson === newJson) {
            logMsg(`No changes: no writes to ${locale} list.`);
        } else {
            logMsg(`Updates found: writing new ${locale} list.`);
            writes.push(ShatariWriter(path, newJson));
        }
    }

    {
        const allRealms = Object.values(realmList.ids)
            .sort((a, b) => (regions.indexOf(a.region) - regions.indexOf(b.region)) || a.slug.localeCompare(b.slug))
            .map(realm => {
                const nameObject = realmList.names.enus[realm.id] ?? {name: realm.slug};
                const result = {
                    region: realm.region,
                    slug: realm.slug,
                    name: nameObject.name,
                };
                if (nameObject.nativeName) {
                    result.nativeName = nameObject.nativeName;
                }

                return result;
            });

        const newJson = JSON.stringify({
            request: {
                list: 'realms',
            },
            result: {
                lastUpdated: (new Date()).toISOString().substring(0, 19) + 'Z',
                realms: allRealms,
            },
        });

        const path = Path.resolve(__dirname, '..', 'realms', 'realm-list.api.json');
        let oldJson = undefined;
        let oldRealmsJson = undefined;
        try {
            oldJson = await fs.readFile(path, {encoding: 'utf8'});
            oldRealmsJson = JSON.stringify(JSON.parse(oldJson)?.result?.realms);
        } catch (error) {
            logMsg('Failed to load old realm-list.api.json');
        }

        if (oldRealmsJson === JSON.stringify(allRealms)) {
            logMsg('No changes: no writes to api list.');
        } else {
            logMsg('Updates found: writing new api list.');
            writes.push(ShatariWriter(path, newJson));
        }
    }

    await Promise.all(writes);

    runOnce.finish();
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

/**
 * Fetches and returns a full realm list from the API.
 *
 * @return {object}
 */
async function fetchRealmList() {
    // Convert "enus" into "en-US"
    const bcp47 = locale => api.localeBuild(locale).replace(/_/g, '-');

    const result = {
        ids: {},
        names: {},
    };

    const POPULATION = {
        NEW: 1,
        RECOMMENDED: 2,
        LOW: 3,
        MEDIUM: 4,
        HIGH: 5,
        FULL: 6,
        LOCKED: 7,
    };

    const realmPromises = [];
    const seenConnections = {};

    for (let region, x = 0; region = regions[x]; x++) {
        logMsg("Fetching " + region + " realm list");
        const response = await api.fetch(region, '/data/wow/connected-realm/index');
        logMsg("Found " + response.data.connected_realms.length + " connected realms in " + region + ".");

        response.data.connected_realms.forEach(connectedRealmRec => {
            const connectedRealmId = connectedRealmRec.href.match(/wow\/connected-realm\/(\d+)/)[1];

            realmPromises.push(api.fetch(region, '/data/wow/connected-realm/' + connectedRealmId, {locale: null}).then(response => {
                seenConnections[connectedRealmId] = response.data.realms.length;
                logMsg("Loaded " + region + " connected realm " + connectedRealmId + " with " + response.data.realms.length + " realms.");

                response.data.realms.forEach(realmRec => {
                    const realmResult = {
                        region: region,
                        slug: realmRec.slug,
                        population: POPULATION[response.data.population?.type] ?? 0,
                        id: realmRec.id,
                        connectedId: parseInt(connectedRealmId),
                    };

                    // Blizz uses "enUS" for the realm locale format, but "en_US" everywhere else, ugh.
                    const realmLocale = api.localeParse(realmRec.locale ?? 'xxxx');
                    const nativeName = realmRec.name[api.localeBuild(realmLocale)];
                    // We have to compare the lowercase since I don't want "Der abyssische Rat (Der Abyssische Rat)"
                    const nativeNameLower = nativeName?.toLocaleLowerCase(bcp47(realmLocale));

                    Constants.LOCALES.forEach(locale => {
                        const nameRec = {
                            name: realmRec.name[api.localeBuild(locale)],
                            category: realmRec.category[api.localeBuild(locale)],
                        };
                        if (nativeName != null && !nameRec.name.toLocaleLowerCase(bcp47(locale)).startsWith(nativeNameLower)) {
                            nameRec.nativeName = nativeName;
                        }
                        result.names[locale] ??= {};
                        result.names[locale][realmRec.id] = nameRec;
                    });

                    if (!result.ids.hasOwnProperty(realmResult.id)) {
                        result.ids[realmResult.id] = realmResult;

                        return;
                    }

                    if (response.data.realms.length > seenConnections[result.ids[realmResult.id].connectedId]) {
                        logMsg("Changing connection for realm " + realmResult.slug + " (ID " + realmResult.id + ") from " +
                            result.ids[realmResult.id].connectedId + " (count " + seenConnections[result.ids[realmResult.id].connectedId] +
                            ") to " + realmResult.connectedId + " (count " + response.data.realms.length + ")"
                        );

                        result.ids[realmResult.id] = realmResult;
                    } else {
                        logMsg("Keeping connection for realm " + realmResult.slug + " (ID " + realmResult.id + ") at " +
                            result.ids[realmResult.id].connectedId + " (count " + seenConnections[result.ids[realmResult.id].connectedId] +
                            ") and ignoring " + realmResult.connectedId + " (count " + response.data.realms.length + ")");
                    }
                });
            }));
        });
    }

    await Promise.all(realmPromises);

    return result;
}

main().catch(function (e) {
    console.error("Unhandled exception:");
    console.error(e);

    process.exit(2);
});
