const process = require("process");

module.exports = function (maxIntervalParam) {
    const maxInterval = maxIntervalParam;
    let lastCheckIn = Date.now();
    let timer = setInterval(timerCheck, 10000);

    this.close = function () {
        clearInterval(timer);
    }

    this.checkIn = function () {
        lastCheckIn = Date.now();
    };

    function timerCheck() {
        if (lastCheckIn + maxInterval < Date.now()) {
            console.error("Last aliveness check in was " + ((Date.now() - lastCheckIn) / 1000) + " seconds ago");
            process.exit(2);
        }
    }
}
