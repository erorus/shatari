const BNet = require('./battlenet');

const api = new BNet();
const REGION_MAP = {
    [api.REGION_US]: 0x7F00,
    [api.REGION_EU]: 0x7F01,
    [api.REGION_TW]: 0x7F02,
    [api.REGION_KR]: 0x7F03,
};

/**
 * Functions for handling commodity pseudo-realms.
 */
module.exports = new function () {
    const self = this;

    /**
     * Returns the commodity realm ID used by the given region.
     *
     * @param {string} region
     * @returns {number|undefined}
     */
    this.getRealmForRegion = function (region) {
        return REGION_MAP[region];
    };

    /**
     * Returns a list of commodity realm IDs.
     *
     * @returns {number[]}
     */
    this.getRealmIds = function () {
        return Object.values(REGION_MAP);
    }

    /**
     * Returns the region used by the given commodity realm.
     *
     * @param {number} realm
     * @returns {string|undefined}
     */
    this.getRegionForRealm = function (realm) {
        return Object.keys(REGION_MAP).find(key => REGION_MAP[key] === realm);
    }

    /**
     * Returns the Blizzard API endpoint for the given realm, commodities or otherwise.
     *
     * @param {number} realm
     * @returns {string}
     */
    this.getApiPath = function (realm) {
        return self.isCommodityRealm(realm) ?
            '/data/wow/auctions/commodities' :
            `/data/wow/connected-realm/${realm}/auctions`;
    };

    /**
     * Returns true when the given realm ID is used by a commodities realm.
     *
     * @param {number} realm
     * @returns {boolean}
     */
    this.isCommodityRealm = function (realm) {
        return Object.values(REGION_MAP).includes(realm);
    };
};
