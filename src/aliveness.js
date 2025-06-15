const process = require("process");
const axios = require("axios");

module.exports = function (maxIntervalParam) {
    const maxInterval = maxIntervalParam;
    let lastCheckIn = Date.now();
    let timer = setInterval(timerCheck, 10000);
    let pingbackTimer;
    let retryTimeout;

    let realmPingbackUrl;
    let realmPingbackSent = 0;

    this.close = function () {
        clearInterval(timer);
        clearInterval(pingbackTimer);
        clearTimeout(retryTimeout);
    }

    /**
     * Registers that we've completed some section of code and are still alive.
     *
     * @param {boolean} [processedRealm] True when we've finished processing a realm and should GET the RealmPingback.
     */
    this.checkIn = async (processedRealm = false) => {
        lastCheckIn = Date.now();

        if (processedRealm && realmPingbackUrl && (realmPingbackSent + maxInterval < Date.now())) {
            realmPingbackSent = Date.now();
            try {
                await axios({url: realmPingbackUrl, timeout: 10000});
            } catch (e) {
                realmPingbackSent -= 10000;
                console.warn(`Realm check-in failed to load ${realmPingbackUrl}. Will allow next checkin shortly.`);
            }
        }
    };

    /**
     * Sets/clears the URL we GET regularly to notify a service that we're still alive. These pingbacks happen
     * independently of any checkIn() calls.
     *
     * @param {string} url
     */
    this.setPingback = url => {
        clearInterval(pingbackTimer);
        if (url) {
            let failures = 0;
            const pingback = async () => {
                try {
                    await axios({url, timeout: 10000});
                    failures = 0;
                } catch (e) {
                    if (++failures > 3) {
                        console.error(`Aliveness unable to load ${url} after ${failures} failures.`);
                    } else {
                        console.warn(`Aliveness failed to load ${url}. Will retry shortly.`);
                        retryTimeout = setTimeout(pingback, 10000);
                    }
                }
            };
            pingback();
            pingbackTimer = setInterval(pingback, maxInterval);
        }
    };

    /**
     * Sets/clears the URL we GET when a checkIn() indicates that we've completed processing a realm.
     *
     * @param {string|undefined} url
     */
    this.setRealmPingback = url => {
        realmPingbackUrl = url;
    };

    function timerCheck() {
        if (lastCheckIn + maxInterval < Date.now()) {
            console.error("Last aliveness check in was " + ((Date.now() - lastCheckIn) / 1000) + " seconds ago");
            process.exit(2);
        }
    }
}
