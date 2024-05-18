const process = require("process");
const axios = require("axios");

module.exports = function (maxIntervalParam) {
    const maxInterval = maxIntervalParam;
    let lastCheckIn = Date.now();
    let timer = setInterval(timerCheck, 10000);
    let pingbackTimer;

    this.close = function () {
        clearInterval(timer);
        clearInterval(pingbackTimer);
    }

    this.checkIn = function () {
        lastCheckIn = Date.now();
    };

    this.setPingback = url => {
        clearInterval(pingbackTimer);
        if (url) {
            const pingback = () => axios({url});
            pingback();
            pingbackTimer = setInterval(pingback, maxInterval);
        }
    };

    function timerCheck() {
        if (lastCheckIn + maxInterval < Date.now()) {
            console.error("Last aliveness check in was " + ((Date.now() - lastCheckIn) / 1000) + " seconds ago");
            process.exit(2);
        }
    }
}
