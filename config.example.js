// eBay API Configuration
// Copy this file to config.js and fill in your credentials

module.exports = {
    ebay: {
        // Get these from https://developer.ebay.com/my/keys
        clientId: 'YOUR_CLIENT_ID_HERE',
        clientSecret: 'YOUR_CLIENT_SECRET_HERE',

        // RuName (Redirect URL Name) - get from User Tokens page
        ruName: 'YOUR_RUNAME_HERE',

        // Environment: 'sandbox' for testing, 'production' for live
        environment: 'sandbox',

        // OAuth scopes needed for inventory management
        scopes: [
            'https://api.ebay.com/oauth/api_scope',
            'https://api.ebay.com/oauth/api_scope/sell.inventory',
            'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
            'https://api.ebay.com/oauth/api_scope/sell.account',
            'https://api.ebay.com/oauth/api_scope/sell.account.readonly'
        ]
    },

    server: {
        port: 3000,
        // This should match your RuName redirect URL
        callbackUrl: 'http://localhost:3000/api/ebay/callback'
    }
};
