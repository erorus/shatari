const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

module.exports = function (name) {
    let server;

    this.start = function () {
        const sockPath = path.join(os.tmpdir(), name + '.sock');

        return new Promise((resolve, reject) => {
            const client = net.connect({path: sockPath}, () => {
                client.write('attempt', () => {
                    client.destroy();
                    reject('Already running');
                });
            });

            client.on('error', (err) => {
                try {
                    fs.unlinkSync(sockPath);
                } catch (e) {
                    if (e.code !== 'ENOENT') {
                        throw e;
                    }
                }

                // We're the only thing running. Create our own server to listen for other processes.

                server = net.createServer((connection) => {
                    // Do nothing when receiving a connection.
                });
                server.listen(sockPath);
                server.on('error', (err) => {
                    reject(err);
                });

                resolve();
            });
        });
    }

    this.finish = function () {
        server.close();
    };
};
