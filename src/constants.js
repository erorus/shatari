const Path = require('path');

module.exports = new function () {
    this.MS_SEC = 1000;
    this.MS_MINUTE = 60 * this.MS_SEC;
    this.MS_HOUR = 60 * this.MS_MINUTE;
    this.MS_DAY = 24 * this.MS_HOUR;

    this.MAX_HISTORY = 14 * this.MS_DAY;

    this.DATA_DIR = Path.resolve(__dirname, '..', 'data');

    this.CLASS_WEAPON = 2;
    this.CLASS_ARMOR = 4;
    this.CLASS_BATTLE_PET = 17;
    this.CLASSES_EQUIPMENT = [this.CLASS_WEAPON, this.CLASS_ARMOR];
    this.CLASSES_WITH_SPECIFICS = [this.CLASS_WEAPON, this.CLASS_ARMOR, this.CLASS_BATTLE_PET];

    this.MODIFIER_BATTLE_PET_QUALITY = 2; // This totally isn't what modifier 2 means, but I want to store quality and they don't have a mod for that.
    this.MODIFIER_BATTLE_PET_SPECIES = 3;
    this.MODIFIER_BATTLE_PET_BREED = 4;
    this.MODIFIER_BATTLE_PET_LEVEL = 5;
    this.MODIFIER_BATTLE_PET_CREATUREDISPLAYID = 6;
    this.MODIFIER_TIMEWALKER_LEVEL = 9;

    this.ITEM_PET_CAGE = 82800;
}
