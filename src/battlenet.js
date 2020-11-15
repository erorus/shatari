const https = require('https');
const axios = require('axios');

const httpsAgent = new https.Agent({keepAlive: true});

module.exports = function () {
    // ********************* //
    // ***** CONSTANTS ***** //
    // ********************* //

    this.REGION_US = 'us';
    this.REGION_EU = 'eu';

    // ********************* //
    // ***** VARIABLES ***** //
    // ********************* //

    let clientCredentials;

    // ********************* //
    // ***** FUNCTIONS ***** //
    // ********************* //

    // ------ //
    // PUBLIC //
    // ------ //

    /**
     * Make an API call to the given path. Returns the axios response.
     *
     * @param {string} region
     * @param {string} path
     * @param {object} [params]
     * @param {object} [headers]
     * @return {AxiosResponse}
     */
    this.fetch = async function (region, path, params, headers) {
        let token = await getClientCredentials();

        if (path.substr(0, 1) !== '/') {
            path = '/' + path;
        }

        params = params || {};
        params.namespace = params.namespace || ('dynamic-' + region);
        params.locale = params.locale || 'en_US';

        headers = headers || {};
        const defaultHeaders = {
            accept: 'application/json',
            'accept-encoding': 'gzip',
            authorization: 'Bearer ' + token,
        };
        for (let k in defaultHeaders) {
            if (defaultHeaders.hasOwnProperty(k) && !headers.hasOwnProperty(k)) {
                headers[k] = defaultHeaders[k];
            }
        }

        return axios({
            headers: headers,
            httpsAgent: httpsAgent,
            params: params,
            url: 'https://' + region + '.api.blizzard.com' + path,
            validateStatus: (status) => status < 400,
        });
    };

    // ------- //
    // PRIVATE //
    // ------- //

    /**
     * Returns the client credentials token.
     *
     * @return {string}
     */
    async function getClientCredentials() {
        if (clientCredentials && clientCredentials.expires > Date.now()) {
            return clientCredentials.token;
        }

        const response = await axios({
            auth: {
                username: process.env.BATTLE_NET_KEY,
                password: process.env.BATTLE_NET_SECRET,
            },
            data: 'grant_type=client_credentials',
            headers: {
                accept: 'application/json',
            },
            method: 'POST',
            url: 'https://us.battle.net/oauth/token',
        });

        clientCredentials = {
            expires: Date.now() + response.data.expires_in * 1000,
            token: response.data.access_token,
        };

        return clientCredentials.token;
    }
};
