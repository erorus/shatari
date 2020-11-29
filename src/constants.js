module.exports = new function () {
    this.MS_SEC = 1000;
    this.MS_MINUTE = 60 * this.MS_SEC;
    this.MS_HOUR = 60 * this.MS_MINUTE;
    this.MS_DAY = 24 * this.MS_HOUR;

    this.MAX_HISTORY = 14 * this.MS_DAY;
}
