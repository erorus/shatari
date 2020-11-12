const BNet = require('./battlenet');

async function main() {
    const api = new BNet();

    const auctions = (await api.fetch(api.REGION_US, '/data/wow/connected-realm/52/auctions')).auctions;

    const stats = {};
    auctions.forEach(function (auction) {
        if (!auction.hasOwnProperty('unit_price')) {
            return;
        }

        const item = stats[auction.item.id] = stats[auction.item.id] || {
            p: 0,
            q: 0,
            auc: {},
        };
        const price = auction.unit_price;

        if (!item.p || item.p > price) {
            item.p = price;
        }
        item.q += auction.quantity;
        item.auc[price] = (item.auc[price] || 0) + auction.quantity;
    });

    console.log(stats);
}

main().catch(console.error);

