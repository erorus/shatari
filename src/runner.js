module.exports = new function () {
    /**
     * Given an array of wrapped promises, wait for one to finish, then remove it from the array.
     *
     * @param {Promise[]} running
     */
    this.waitForOne = async function (running) {
        let toThrow;
        let foundResolved = false;

        try {
            await Promise.race(running);
        } catch (e) {
            toThrow = e;
        }

        for (let p, x = 0; p = running[x]; x++) {
            if (p.resolved) {
                running.splice(x, 1);

                foundResolved = true;
                break;
            }
        }

        if (toThrow) {
            throw toThrow;
        } else if (!foundResolved) {
            throw "Could not find any resolved in running array!";
        }
    }

    /**
     * Wraps a promise later used by waitForOne()
     *
     * @param {Promise} runner
     * @return {Promise}
     */
    this.wrap = function (runner) {
        let finallyPromise = runner.finally(() => finallyPromise.resolved = true);

        return finallyPromise;
    }
}
