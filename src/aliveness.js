const process = require("process");
const axios = require("axios");

module.exports = function (maxIntervalParam) {
    const maxInterval = maxIntervalParam;
    let lastCheckIn = Date.now();
    let timer = setInterval(timerCheck, 10000);
    let pingbackTimer;
    let retryTimeout;

    this.close = function () {
        clearInterval(timer);
        clearInterval(pingbackTimer);
        clearTimeout(retryTimeout);
    }

    this.checkIn = function () {
        lastCheckIn = Date.now();
    };

    this.setPingback = url => {
        clearInterval(pingbackTimer);
        if (url) {
            let failures = 0;
            const pingback = () => {
                try {
                    axios({url, timeout: 10000});
                    failures = 0;
                } catch (e) {
                    if (++failures > 3) {
                        console.error(`Unable to load ${url} after ${failures} failures.`);
                    } else {
                        console.warn(`Failed to load ${url}. Will retry shortly.`);
                        retryTimeout = setTimeout(pingback, 10000);
                    }
                }
            };
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
