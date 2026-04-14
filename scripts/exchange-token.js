require('dotenv').config();
const config = require('./config');

// Get code from command line argument
const code = process.argv[2];

if (!code) {
    console.log('Usage: node exchange-token.js "YOUR_AUTH_CODE"');
    console.log('\nPaste the full code from the URL (the part after code=)');
    process.exit(1);
}

console.log('Client ID:', config.ebay.clientId);
console.log('RuName:', config.ebay.ruName);
console.log('Code length:', code.length);

const credentials = Buffer.from(config.ebay.clientId + ':' + config.ebay.clientSecret).toString('base64');

fetch('https://api.sandbox.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + credentials
    },
    body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: config.ebay.ruName
    })
})
.then(r => r.json())
.then(data => {
    console.log('\nResponse:', JSON.stringify(data, null, 2));

    if (data.access_token) {
        const accountId = 'acc_' + Date.now().toString(36);
        const tokens = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: Date.now() + (data.expires_in * 1000),
            token_type: data.token_type
        };

        config.saveAccount(accountId, {
            name: 'testuser_stkfrg',
            tokens,
            addedAt: new Date().toISOString()
        });

        console.log('\n✓ Account saved successfully!');
        console.log('Account ID:', accountId);
        console.log('\nYou can now use the eBay features in STOCKFORGE!');
    } else {
        console.log('\n✗ Failed to get token');
        if (data.error_description) {
            console.log('Error:', data.error_description);
        }
    }
})
.catch(e => console.error('Error:', e));
