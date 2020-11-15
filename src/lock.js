const EventEmitter = require('events');

module.exports = new function () {
    const locks = {};

    this.acquire = function (name) {
        return new Promise(resolve => {
            if (!locks[name]) {
                locks[name] = {
                    locked: false,
                };
            }
            if (!locks[name].locked) {
                locks[name].locked = true;

                return resolve();
            }

            if (!locks[name].ee) {
                locks[name].ee = new EventEmitter();
            }

            const tryAcquire = () => {
                if (!locks[name].locked) {
                    locks[name].locked = true;
                    locks[name].ee.removeListener('release', tryAcquire);

                    return resolve();
                }
            };

            locks[name].ee.on('release', tryAcquire);
        });
    };

    this.release = function (name) {
        locks[name].locked = false;
        if (locks[name].ee && locks[name].ee.listenerCount('release')) {
            setImmediate(() => locks[name].ee.emit('release'));
        } else {
            delete locks[name];
        }
    };
};
