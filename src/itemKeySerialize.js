module.exports = new function () {
    /**
     * Turns an item key string into an item key object.
     *
     * @param {string} itemKeyString
     * @return {ItemKey}
     */
    this.parse = function (itemKeyString) {
        const parts = itemKeyString.split('-');

        return {
            itemId: parseInt(parts[0] || 0),
            itemLevel: parseInt(parts[1] || 0),
            itemSuffix: parseInt(parts[2] || 0),
        };
    }

    /**
     * Serialize an item key into a short string.
     *
     * @param {ItemKey} itemKey
     * @return {string}
     */
    this.stringify = function (itemKey) {
        let result = '' + itemKey.itemId;
        if (itemKey.itemLevel) {
            result += '-' + itemKey.itemLevel;
            if (itemKey.itemSuffix) {
                result += '-' + itemKey.itemSuffix;
            }
        }

        return result;
    };
};
