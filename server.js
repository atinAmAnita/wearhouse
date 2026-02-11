require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const bwipjs = require('bwip-js');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// DATABASE MODE CONFIGURATION
// ============================================
// Default: Use MongoDB (live database) for both local and production
// Set USE_LOCAL_DB=true in .env to use local JSON files instead
const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true';
const DB_MODE = USE_LOCAL_DB ? 'local' : 'mongodb';

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// LOCAL JSON STORAGE (only used when USE_LOCAL_DB=true)
// ============================================
const JSON_DATA_FILE = path.join(__dirname, 'inventory.json');
let localInventory = { items: {}, metadata: { version: "2.0" } };
let localAccounts = {};

function loadLocalData() {
    if (!USE_LOCAL_DB) return;
    try {
        if (fs.existsSync(JSON_DATA_FILE)) {
            localInventory = JSON.parse(fs.readFileSync(JSON_DATA_FILE, 'utf8'));
            console.log(`Loaded ${Object.keys(localInventory.items).length} items from local JSON`);
        }
        const accountsFile = path.join(__dirname, '.ebay-accounts.json');
        if (fs.existsSync(accountsFile)) {
            localAccounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
        }
    } catch (err) {
        console.error('Error loading local data:', err.message);
    }
}

function saveLocalData() {
    if (!USE_LOCAL_DB) return;
    try {
        localInventory.metadata.lastModified = new Date().toISOString();
        localInventory.metadata.totalItems = Object.keys(localInventory.items).length;
        fs.writeFileSync(JSON_DATA_FILE, JSON.stringify(localInventory, null, 2));
    } catch (err) {
        console.error('Error saving local data:', err.message);
    }
}

function saveLocalAccounts() {
    if (!USE_LOCAL_DB) return;
    try {
        const accountsFile = path.join(__dirname, '.ebay-accounts.json');
        fs.writeFileSync(accountsFile, JSON.stringify(localAccounts, null, 2));
    } catch (err) {
        console.error('Error saving accounts:', err.message);
    }
}

// ============================================
// UNIFIED DATA ACCESS LAYER
// ============================================
const data = {
    // Returns current database mode
    getMode() {
        return DB_MODE;
    },

    async getAllItems() {
        if (!USE_LOCAL_DB) {
            const items = await db.inventory.getAll();
            return items.map(formatItem);
        }
        return Object.values(localInventory.items).map(formatItem);
    },

    async getItem(sku) {
        if (!USE_LOCAL_DB) {
            return db.inventory.getItem(sku);
        }
        return localInventory.items[sku] || null;
    },

    async getItemByCode(itemCode) {
        if (!USE_LOCAL_DB) {
            return db.inventory.getByItemCode(itemCode);
        }
        return Object.values(localInventory.items).find(i => i.itemCode === itemCode) || null;
    },

    async getItemByLocation(fullLocation) {
        if (!USE_LOCAL_DB) {
            return db.inventory.getByLocation(fullLocation);
        }
        return Object.values(localInventory.items).find(i => i.fullLocation === fullLocation) || null;
    },

    async createItem(itemData) {
        if (!USE_LOCAL_DB) {
            return db.inventory.create(itemData);
        }
        localInventory.items[itemData.sku] = itemData;
        saveLocalData();
        return itemData;
    },

    async updateItem(sku, updates) {
        if (!USE_LOCAL_DB) {
            return db.inventory.update(sku, updates);
        }
        if (localInventory.items[sku]) {
            Object.assign(localInventory.items[sku], updates, { lastModified: new Date().toISOString() });
            saveLocalData();
            return localInventory.items[sku];
        }
        return null;
    },

    async addHistory(sku, entry) {
        if (!USE_LOCAL_DB) {
            return db.inventory.addHistory(sku, entry);
        }
        if (localInventory.items[sku]) {
            localInventory.items[sku].history.push(entry);
            saveLocalData();
        }
    },

    async deleteItem(sku) {
        if (!USE_LOCAL_DB) {
            return db.inventory.delete(sku);
        }
        const item = localInventory.items[sku];
        delete localInventory.items[sku];
        saveLocalData();
        return item;
    },

    async getAllItemCodes() {
        if (!USE_LOCAL_DB) {
            return db.inventory.getAllItemCodes();
        }
        return Object.values(localInventory.items).map(i => i.itemCode);
    },

    async getAllLocations() {
        if (!USE_LOCAL_DB) {
            return db.inventory.getAllLocations();
        }
        return Object.values(localInventory.items).map(i => i.drawerNumber + i.positionNumber);
    },

    // eBay Accounts
    async getAllAccounts() {
        if (!USE_LOCAL_DB) {
            const accounts = await db.ebayAccounts.getAll();
            return accounts.map(a => ({
                id: a.accountId,
                name: a.name,
                hasValidToken: a.tokens?.access_token && (!a.tokens?.expires_at || Date.now() < a.tokens.expires_at),
                lastSync: a.lastSync
            }));
        }
        return Object.entries(localAccounts).map(([id, acc]) => ({
            id,
            name: acc.name,
            hasValidToken: acc.tokens?.access_token && (!acc.tokens?.expires_at || Date.now() < acc.tokens.expires_at),
            lastSync: acc.lastSync
        }));
    },

    async getAccount(accountId) {
        if (!USE_LOCAL_DB) {
            return db.ebayAccounts.get(accountId);
        }
        return localAccounts[accountId] || null;
    },

    async saveAccount(accountId, accountData) {
        if (!USE_LOCAL_DB) {
            return db.ebayAccounts.save(accountId, accountData);
        }
        localAccounts[accountId] = { ...localAccounts[accountId], ...accountData };
        saveLocalAccounts();
        return localAccounts[accountId];
    },

    async removeAccount(accountId) {
        if (!USE_LOCAL_DB) {
            return db.ebayAccounts.delete(accountId);
        }
        const removed = !!localAccounts[accountId];
        delete localAccounts[accountId];
        saveLocalAccounts();
        return removed;
    }
};

// Format item for API response
function formatItem(item) {
    return {
        SKU: item.sku,
        ItemCode: item.itemCode,
        DrawerNumber: item.drawerNumber,
        PositionNumber: item.positionNumber,
        FullLocation: item.fullLocation,
        Price: item.price || 0,
        Quantity: item.currentQty,
        Description: item.description,
        DateAdded: item.dateAdded,
        LastModified: item.lastModified
    };
}

// Generate barcode as base64 image
async function generateBarcode(text) {
    try {
        const png = await bwipjs.toBuffer({
            bcid: 'code128',
            text: text,
            scale: 3,
            height: 10,
            includetext: true,
            textxalign: 'center',
        });
        return 'data:image/png;base64,' + png.toString('base64');
    } catch (err) {
        console.error('Barcode generation error:', err);
        return null;
    }
}

// ============================================
// CONFIG (Environment-based)
// ============================================
const config = {
    ebay: {
        clientId: process.env.EBAY_CLIENT_ID?.trim(),
        clientSecret: process.env.EBAY_CLIENT_SECRET?.trim(),
        ruName: process.env.EBAY_RUNAME?.trim(),
        environment: (process.env.EBAY_ENVIRONMENT || 'sandbox').trim(),
        scopes: [
            'https://api.ebay.com/oauth/api_scope',
            'https://api.ebay.com/oauth/api_scope/sell.inventory',
            'https://api.ebay.com/oauth/api_scope/sell.account'
        ]
    },
    adminPassword: (process.env.ADMIN_PASSWORD || 'admin123').trim(),
    isEbayConfigured() {
        return !!(this.ebay.clientId && this.ebay.clientSecret && this.ebay.ruName);
    }
};

// ============================================
// EBAY API (Simplified for Vercel)
// ============================================
const EBAY_ENDPOINTS = {
    sandbox: { auth: 'https://auth.sandbox.ebay.com', api: 'https://api.sandbox.ebay.com' },
    production: { auth: 'https://auth.ebay.com', api: 'https://api.ebay.com' }
};

const ebayAPI = {
    endpoints: EBAY_ENDPOINTS[config.ebay.environment],
    pendingAuth: null,

    async isAccountAuthenticated(accountId) {
        const account = await data.getAccount(accountId);
        if (!account?.tokens?.access_token) return false;
        if (account.tokens.expires_at && Date.now() >= account.tokens.expires_at) return false;
        return true;
    },

    getAuthUrl(accountName) {
        const accountId = 'acc_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        this.pendingAuth = { accountId, accountName };
        const scopes = encodeURIComponent(config.ebay.scopes.join(' '));
        const state = encodeURIComponent(JSON.stringify({ accountId, accountName }));
        return `${this.endpoints.auth}/oauth2/authorize?client_id=${config.ebay.clientId}&redirect_uri=${encodeURIComponent(config.ebay.ruName)}&response_type=code&scope=${scopes}&state=${state}`;
    },

    // Reconnect with existing account ID (for token refresh)
    getReconnectUrl(accountId, accountName) {
        this.pendingAuth = { accountId, accountName };
        const scopes = encodeURIComponent(config.ebay.scopes.join(' '));
        const state = encodeURIComponent(JSON.stringify({ accountId, accountName }));
        return `${this.endpoints.auth}/oauth2/authorize?client_id=${config.ebay.clientId}&redirect_uri=${encodeURIComponent(config.ebay.ruName)}&response_type=code&scope=${scopes}&state=${state}`;
    },

    async exchangeCodeForToken(authCode, state) {
        let accountId, accountName;
        try {
            const stateData = JSON.parse(decodeURIComponent(state));
            accountId = stateData.accountId;
            accountName = stateData.accountName;
        } catch {
            if (this.pendingAuth) {
                accountId = this.pendingAuth.accountId;
                accountName = this.pendingAuth.accountName;
            } else {
                throw new Error('Invalid auth state');
            }
        }

        const credentials = Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString('base64');
        const response = await fetch(`${this.endpoints.api}/identity/v1/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` },
            body: new URLSearchParams({ grant_type: 'authorization_code', code: authCode, redirect_uri: config.ebay.ruName })
        });

        if (!response.ok) throw new Error(`Token exchange failed: ${await response.text()}`);
        const tokenData = await response.json();

        await data.saveAccount(accountId, {
            name: accountName,
            tokens: {
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token,
                expires_at: Date.now() + (tokenData.expires_in * 1000),
                token_type: tokenData.token_type
            },
            addedAt: new Date().toISOString()
        });

        this.pendingAuth = null;
        return { accountId, accountName };
    },

    async refreshAccessToken(accountId) {
        const account = await data.getAccount(accountId);
        if (!account?.tokens?.refresh_token) throw new Error('No refresh token');

        const credentials = Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString('base64');
        const response = await fetch(`${this.endpoints.api}/identity/v1/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: account.tokens.refresh_token, scope: config.ebay.scopes.join(' ') })
        });

        if (!response.ok) throw new Error(`Token refresh failed: ${await response.text()}`);
        const tokenData = await response.json();

        const tokens = { ...account.tokens, access_token: tokenData.access_token, expires_at: Date.now() + (tokenData.expires_in * 1000) };
        await data.saveAccount(accountId, { tokens });
        return tokens;
    },

    async apiRequest(accountId, method, path, body = null) {
        let account = await data.getAccount(accountId);
        if (!account) throw new Error('Account not found');

        if (!(await this.isAccountAuthenticated(accountId))) {
            if (account.tokens?.refresh_token) {
                await this.refreshAccessToken(accountId);
                account = await data.getAccount(accountId);
            } else {
                throw new Error('Account not authenticated');
            }
        }

        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${account.tokens.access_token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Accept-Language': 'en-US',
                'Content-Language': 'en-US'
            }
        };
        if (body) options.body = JSON.stringify(body);

        const response = await fetch(`${this.endpoints.api}${path}`, options);
        if (response.status === 204) return { success: true };
        const responseData = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(responseData.errors?.[0]?.message || `API error: ${response.status}`);
        return responseData;
    },

    async getInventoryItems(accountId) { return this.apiRequest(accountId, 'GET', '/sell/inventory/v1/inventory_item?limit=100'); },
    async createOrUpdateInventoryItem(accountId, sku, itemData) { return this.apiRequest(accountId, 'PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, itemData); },
    async getCategorySuggestions(accountId, query) { return this.apiRequest(accountId, 'GET', `/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(query)}`); },
    async getItemAspectsForCategory(accountId, categoryId) { return this.apiRequest(accountId, 'GET', `/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${categoryId}`); },

    // Offer and Listing APIs
    async getOffers(accountId, sku) { return this.apiRequest(accountId, 'GET', `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`); },
    async createOffer(accountId, offerData) { return this.apiRequest(accountId, 'POST', '/sell/inventory/v1/offer', offerData); },
    async publishOffer(accountId, offerId) { return this.apiRequest(accountId, 'POST', `/sell/inventory/v1/offer/${offerId}/publish`); },
    async deleteOffer(accountId, offerId) { return this.apiRequest(accountId, 'DELETE', `/sell/inventory/v1/offer/${offerId}`); },

    // Business Policies (needed for offers)
    async getFulfillmentPolicies(accountId, marketplaceId = 'EBAY_US') { return this.apiRequest(accountId, 'GET', `/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`); },
    async getPaymentPolicies(accountId, marketplaceId = 'EBAY_US') { return this.apiRequest(accountId, 'GET', `/sell/account/v1/payment_policy?marketplace_id=${marketplaceId}`); },
    async getReturnPolicies(accountId, marketplaceId = 'EBAY_US') { return this.apiRequest(accountId, 'GET', `/sell/account/v1/return_policy?marketplace_id=${marketplaceId}`); },

    // Purchase History (Trading API - XML based)
    async getPurchaseHistory(accountId, days = 30) {
        let account = await data.getAccount(accountId);
        if (!account) throw new Error('Account not found');

        // Refresh token if needed (same logic as apiRequest)
        if (!(await this.isAccountAuthenticated(accountId))) {
            if (account.tokens?.refresh_token) {
                await this.refreshAccessToken(accountId);
                account = await data.getAccount(accountId);
            } else {
                throw new Error('Account not authenticated');
            }
        }

        const token = account.tokens.access_token;
        const tradingEndpoint = config.ebay.environment === 'production'
            ? 'https://api.ebay.com/ws/api.dll'
            : 'https://api.sandbox.ebay.com/ws/api.dll';

        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - days);

        const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${token}</eBayAuthToken>
    </RequesterCredentials>
    <BuyingSummary>
        <Include>true</Include>
    </BuyingSummary>
    <WonList>
        <Include>true</Include>
        <DurationInDays>60</DurationInDays>
        <Sort>EndTime</Sort>
        <Pagination>
            <EntriesPerPage>100</EntriesPerPage>
            <PageNumber>1</PageNumber>
        </Pagination>
    </WonList>
    <ErrorLanguage>en_US</ErrorLanguage>
    <WarningLevel>High</WarningLevel>
</GetMyeBayBuyingRequest>`;

        const response = await fetch(tradingEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'X-EBAY-API-CALL-NAME': 'GetMyeBayBuying',
                'X-EBAY-API-IAF-TOKEN': token
            },
            body: xmlRequest
        });

        const xmlText = await response.text();

        // Parse XML response to extract items
        const purchases = [];
        const itemMatches = xmlText.matchAll(/<Item>([\s\S]*?)<\/Item>/g);

        for (const match of itemMatches) {
            const itemXml = match[1];
            const getTag = (tag) => {
                const m = itemXml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
                return m ? m[1] : '';
            };

            purchases.push({
                itemId: getTag('ItemID'),
                title: getTag('Title'),
                price: getTag('CurrentPrice') || getTag('ConvertedCurrentPrice'),
                currency: itemXml.match(/currencyID="([^"]+)"/)?.[1] || 'USD',
                quantity: getTag('QuantityPurchased') || '1',
                endTime: getTag('EndTime'),
                seller: getTag('UserID'),
                listingStatus: getTag('ListingStatus')
            });
        }

        // Extract any errors
        const errorMatch = xmlText.match(/<ShortMessage>([^<]*)<\/ShortMessage>/);
        const error = errorMatch ? errorMatch[1] : null;

        // Extract buying summary
        const getGlobalTag = (tag) => {
            const m = xmlText.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
            return m ? m[1] : null;
        };

        const summary = {
            totalWon: getGlobalTag('WonCount'),
            totalBidding: getGlobalTag('BiddingCount'),
            totalWatching: getGlobalTag('WatchingCount')
        };

        return { purchases, summary, error, note: 'eBay API only returns purchases from last 60 days' };
    },

    // Get eBay User Info (test connection)
    async getUserInfo(accountId) {
        let account = await data.getAccount(accountId);
        if (!account) throw new Error('Account not found');

        if (!(await this.isAccountAuthenticated(accountId))) {
            if (account.tokens?.refresh_token) {
                await this.refreshAccessToken(accountId);
                account = await data.getAccount(accountId);
            } else {
                throw new Error('Account not authenticated');
            }
        }

        const token = account.tokens.access_token;
        const tradingEndpoint = config.ebay.environment === 'production'
            ? 'https://api.ebay.com/ws/api.dll'
            : 'https://api.sandbox.ebay.com/ws/api.dll';

        const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${token}</eBayAuthToken>
    </RequesterCredentials>
    <ErrorLanguage>en_US</ErrorLanguage>
</GetUserRequest>`;

        const response = await fetch(tradingEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'X-EBAY-API-CALL-NAME': 'GetUser',
                'X-EBAY-API-IAF-TOKEN': token
            },
            body: xmlRequest
        });

        const xmlText = await response.text();

        const getTag = (tag) => {
            const m = xmlText.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
            return m ? m[1] : null;
        };

        const errorMatch = xmlText.match(/<ShortMessage>([^<]*)<\/ShortMessage>/);

        return {
            success: !errorMatch,
            error: errorMatch ? errorMatch[1] : null,
            user: {
                userId: getTag('UserID'),
                email: getTag('Email'),
                feedbackScore: getTag('FeedbackScore'),
                registrationDate: getTag('RegistrationDate'),
                sellerLevel: getTag('SellerLevel'),
                storeName: getTag('StoreName'),
                storeUrl: getTag('StoreURL')
            }
        };
    },

    // Get Watch List
    async getWatchList(accountId) {
        let account = await data.getAccount(accountId);
        if (!account) throw new Error('Account not found');

        if (!(await this.isAccountAuthenticated(accountId))) {
            if (account.tokens?.refresh_token) {
                await this.refreshAccessToken(accountId);
                account = await data.getAccount(accountId);
            } else {
                throw new Error('Account not authenticated');
            }
        }

        const token = account.tokens.access_token;
        const tradingEndpoint = config.ebay.environment === 'production'
            ? 'https://api.ebay.com/ws/api.dll'
            : 'https://api.sandbox.ebay.com/ws/api.dll';

        const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${token}</eBayAuthToken>
    </RequesterCredentials>
    <WatchList>
        <Include>true</Include>
        <Pagination>
            <EntriesPerPage>50</EntriesPerPage>
            <PageNumber>1</PageNumber>
        </Pagination>
    </WatchList>
    <ErrorLanguage>en_US</ErrorLanguage>
</GetMyeBayBuyingRequest>`;

        const response = await fetch(tradingEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'X-EBAY-API-CALL-NAME': 'GetMyeBayBuying',
                'X-EBAY-API-IAF-TOKEN': token
            },
            body: xmlRequest
        });

        const xmlText = await response.text();

        const items = [];
        const itemMatches = xmlText.matchAll(/<Item>([\s\S]*?)<\/Item>/g);

        for (const match of itemMatches) {
            const itemXml = match[1];
            const getTag = (tag) => {
                const m = itemXml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
                return m ? m[1] : '';
            };

            items.push({
                itemId: getTag('ItemID'),
                title: getTag('Title'),
                price: getTag('CurrentPrice'),
                currency: itemXml.match(/currencyID="([^"]+)"/)?.[1] || 'USD',
                endTime: getTag('EndTime'),
                bidCount: getTag('BidCount') || '0'
            });
        }

        const errorMatch = xmlText.match(/<ShortMessage>([^<]*)<\/ShortMessage>/);

        return {
            items,
            count: items.length,
            error: errorMatch ? errorMatch[1] : null
        };
    },

    // Get Active Listings (what user is selling)
    async getActiveListings(accountId) {
        let account = await data.getAccount(accountId);
        if (!account) throw new Error('Account not found');

        if (!(await this.isAccountAuthenticated(accountId))) {
            if (account.tokens?.refresh_token) {
                await this.refreshAccessToken(accountId);
                account = await data.getAccount(accountId);
            } else {
                throw new Error('Account not authenticated');
            }
        }

        const token = account.tokens.access_token;
        const tradingEndpoint = config.ebay.environment === 'production'
            ? 'https://api.ebay.com/ws/api.dll'
            : 'https://api.sandbox.ebay.com/ws/api.dll';

        const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${token}</eBayAuthToken>
    </RequesterCredentials>
    <DetailLevel>ReturnAll</DetailLevel>
    <ActiveList>
        <Include>true</Include>
        <ListingType>FixedPriceItem</ListingType>
        <Pagination>
            <EntriesPerPage>200</EntriesPerPage>
            <PageNumber>1</PageNumber>
        </Pagination>
        <Sort>TimeLeft</Sort>
    </ActiveList>
    <SellingSummary>
        <Include>true</Include>
    </SellingSummary>
    <ErrorLanguage>en_US</ErrorLanguage>
    <WarningLevel>High</WarningLevel>
</GetMyeBaySellingRequest>`;

        const response = await fetch(tradingEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
                'X-EBAY-API-IAF-TOKEN': token
            },
            body: xmlRequest
        });

        const xmlText = await response.text();

        const items = [];

        // Extract ItemArray section first (items are in ActiveList > ItemArray > Item)
        const itemArrayMatch = xmlText.match(/<ItemArray>([\s\S]*?)<\/ItemArray>/);
        const itemArrayXml = itemArrayMatch ? itemArrayMatch[1] : xmlText;

        const itemMatches = itemArrayXml.matchAll(/<Item>([\s\S]*?)<\/Item>/g);

        for (const match of itemMatches) {
            const itemXml = match[1];
            const getTag = (tag) => {
                const m = itemXml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
                return m ? m[1] : '';
            };

            // For fixed-price items, price can be in StartPrice, BuyItNowPrice, or CurrentPrice
            const price = getTag('StartPrice') || getTag('BuyItNowPrice') || getTag('CurrentPrice') || '0';

            items.push({
                itemId: getTag('ItemID'),
                sku: getTag('SKU') || getTag('ItemID'),
                title: getTag('Title'),
                price: price,
                currency: itemXml.match(/currencyID="([^"]+)"/)?.[1] || 'USD',
                quantity: getTag('QuantityAvailable') || getTag('Quantity') || '1',
                quantitySold: getTag('QuantitySold') || '0',
                listingType: getTag('ListingType'),
                startTime: getTag('StartTime'),
                endTime: getTag('EndTime'),
                viewCount: getTag('HitCount') || '0'
            });
        }

        // Get total count
        const totalMatch = xmlText.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/);
        const totalEntries = totalMatch ? parseInt(totalMatch[1]) : items.length;

        const errorMatch = xmlText.match(/<ShortMessage>([^<]*)<\/ShortMessage>/);

        return {
            items,
            count: items.length,
            totalEntries,
            error: errorMatch ? errorMatch[1] : null
        };
    },

    async syncItemToEbay(accountId, warehouseItem) {
        const aspects = { 'Warehouse Location': [warehouseItem.FullLocation] };
        if (warehouseItem.ItemSpecifics) {
            Object.entries(warehouseItem.ItemSpecifics).forEach(([key, value]) => {
                if (value) aspects[key] = [value];
            });
        }

        const itemData = {
            availability: { shipToLocationAvailability: { quantity: warehouseItem.Quantity } },
            condition: warehouseItem.Condition || 'NEW',
            product: { title: warehouseItem.Description || `Item ${warehouseItem.SKU}`, description: warehouseItem.Description || '', aspects }
        };

        const result = await this.createOrUpdateInventoryItem(accountId, warehouseItem.SKU, itemData);
        await data.saveAccount(accountId, { lastSync: new Date().toISOString() });
        return result;
    },

    // Create and publish a listing (offer) for an inventory item
    async createAndPublishListing(accountId, warehouseItem, policies) {
        const sku = warehouseItem.SKU;
        const marketplaceId = 'EBAY_US';

        // Check if offer already exists
        try {
            const existingOffers = await this.getOffers(accountId, sku);
            if (existingOffers.offers?.length > 0) {
                // Offer exists - it's already listed or we can update it
                const offer = existingOffers.offers[0];
                return { offerId: offer.offerId, status: offer.status, listingId: offer.listing?.listingId, existing: true };
            }
        } catch (err) {
            // No offers exist, continue to create
        }

        // Create offer
        const offerData = {
            sku: sku,
            marketplaceId: marketplaceId,
            format: 'FIXED_PRICE',
            listingDescription: warehouseItem.Description || `Item ${sku}`,
            availableQuantity: warehouseItem.Quantity,
            pricingSummary: {
                price: {
                    value: String(warehouseItem.Price || '9.99'),
                    currency: 'USD'
                }
            },
            listingPolicies: {
                fulfillmentPolicyId: policies.fulfillmentPolicyId,
                paymentPolicyId: policies.paymentPolicyId,
                returnPolicyId: policies.returnPolicyId
            },
            categoryId: warehouseItem.CategoryId || '175673' // Default: Other category
        };

        const offer = await this.createOffer(accountId, offerData);

        // Publish the offer to create actual listing
        const published = await this.publishOffer(accountId, offer.offerId);

        return { offerId: offer.offerId, listingId: published.listingId, status: 'PUBLISHED' };
    },

    // Get or use default business policies
    async getBusinessPolicies(accountId) {
        const marketplaceId = 'EBAY_US';
        let fulfillmentPolicyId, paymentPolicyId, returnPolicyId;

        try {
            const fulfillment = await this.getFulfillmentPolicies(accountId, marketplaceId);
            fulfillmentPolicyId = fulfillment.fulfillmentPolicies?.[0]?.fulfillmentPolicyId;
        } catch (e) { console.log('No fulfillment policies:', e.message); }

        try {
            const payment = await this.getPaymentPolicies(accountId, marketplaceId);
            paymentPolicyId = payment.paymentPolicies?.[0]?.paymentPolicyId;
        } catch (e) { console.log('No payment policies:', e.message); }

        try {
            const returns = await this.getReturnPolicies(accountId, marketplaceId);
            returnPolicyId = returns.returnPolicies?.[0]?.returnPolicyId;
        } catch (e) { console.log('No return policies:', e.message); }

        if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
            throw new Error('Missing business policies. Please create fulfillment, payment, and return policies in eBay Seller Hub first.');
        }

        return { fulfillmentPolicyId, paymentPolicyId, returnPolicyId };
    },

    // ============================================
    // SYNC HELPER FUNCTIONS
    // ============================================

    // Capture a snapshot of eBay item state
    captureEbaySnapshot(ebayItem) {
        return {
            quantity: parseInt(ebayItem.quantity) || 0,
            price: parseFloat(ebayItem.price) || 0,
            title: ebayItem.title || '',
            description: ebayItem.description || '',
            condition: ebayItem.condition || '',
            takenAt: new Date()
        };
    },

    // Capture a snapshot from local item (for after pushing to eBay)
    captureLocalSnapshot(localItem) {
        return {
            quantity: localItem.currentQty || 0,
            price: localItem.price || 0,
            title: localItem.description || '',
            description: localItem.description || '',
            condition: localItem.condition || '',
            takenAt: new Date()
        };
    },

    // Detect changes between current eBay state and stored snapshot
    detectEbayChanges(currentEbay, snapshot) {
        const changes = [];
        if (!snapshot) return [{ field: 'all', reason: 'no_snapshot' }];

        const currentQty = parseInt(currentEbay.quantity) || 0;
        const currentPrice = parseFloat(currentEbay.price) || 0;
        const currentTitle = currentEbay.title || '';

        if (currentQty !== snapshot.quantity) {
            changes.push({ field: 'quantity', old: snapshot.quantity, new: currentQty });
        }
        if (currentPrice !== snapshot.price) {
            changes.push({ field: 'price', old: snapshot.price, new: currentPrice });
        }
        if (currentTitle !== snapshot.title) {
            changes.push({ field: 'title', old: snapshot.title, new: currentTitle });
        }

        return changes;
    },

    // Create a local inventory item from eBay data
    createLocalItemFromEbay(ebayItem) {
        // Generate SKU from eBay item ID if no SKU
        const sku = ebayItem.sku || ebayItem.itemId;

        // Generate item code from first 4 chars of SKU
        const itemCode = sku.substring(0, 4).padStart(4, '0');

        return {
            sku: sku,
            itemCode: itemCode,
            drawerNumber: '000',  // Default - user can update later
            positionNumber: '00',
            fullLocation: '000-00',
            price: parseFloat(ebayItem.price) || 0,
            currentQty: parseInt(ebayItem.quantity) || 0,
            description: ebayItem.title || `eBay Item ${sku}`,
            condition: ebayItem.condition || null,
            categoryId: ebayItem.categoryId || null,
            categoryName: ebayItem.categoryName || null,
            itemSpecifics: {},
            dateAdded: new Date(),
            lastModified: new Date(),
            lastSyncedQty: parseInt(ebayItem.quantity) || 0,
            ebaySync: {
                snapshot: this.captureEbaySnapshot(ebayItem),
                lastSyncTime: new Date(),
                ebayItemId: ebayItem.itemId || null,
                status: 'synced'
            },
            history: [{
                date: new Date(),
                action: 'EBAY_IMPORT',
                qty: parseInt(ebayItem.quantity) || 0,
                newTotal: parseInt(ebayItem.quantity) || 0,
                note: `Imported from eBay listing ${ebayItem.itemId || sku}`
            }]
        };
    },

    // ============================================
    // PULL FROM EBAY (eBay → Local)
    // ============================================
    async pullFromEbay(accountId) {
        const results = {
            created: [],
            updated: [],
            skipped: [],
            errors: []
        };

        // Fetch active listings from eBay (Trading API)
        const ebayData = await this.getActiveListings(accountId);
        if (ebayData.error) {
            throw new Error(ebayData.error);
        }

        const ebayItems = ebayData.items || [];

        for (const ebayItem of ebayItems) {
            try {
                const sku = ebayItem.sku || ebayItem.itemId;
                const localItem = await data.getItem(sku);

                if (!localItem) {
                    // Item exists on eBay but not locally - CREATE
                    const newItem = this.createLocalItemFromEbay(ebayItem);
                    await data.createItem(newItem);
                    results.created.push({ sku, title: ebayItem.title, source: 'ebay' });
                } else {
                    // Item exists both places - check for changes
                    const snapshot = localItem.ebaySync?.snapshot;
                    const lastSyncTime = localItem.ebaySync?.lastSyncTime;
                    const localModified = localItem.lastModified;

                    const ebayChanges = this.detectEbayChanges(ebayItem, snapshot);

                    if (ebayChanges.length === 0) {
                        results.skipped.push({ sku, reason: 'No eBay changes' });
                        continue;
                    }

                    // Check each changed field
                    const updates = {};
                    const changedFields = [];

                    for (const change of ebayChanges) {
                        if (change.field === 'all') {
                            // No snapshot - accept all eBay values
                            updates.price = parseFloat(ebayItem.price) || localItem.price;
                            updates.description = ebayItem.title || localItem.description;
                            changedFields.push('price', 'title');
                            continue;
                        }

                        const localValue = change.field === 'quantity' ? localItem.currentQty :
                                          change.field === 'price' ? localItem.price :
                                          change.field === 'title' ? localItem.description : null;
                        const snapshotValue = snapshot?.[change.field];
                        const localChangedSinceSync = localValue !== snapshotValue;

                        if (!localChangedSinceSync) {
                            // Local hasn't changed this field - accept eBay value
                            if (change.field === 'quantity') {
                                // Handle quantity specially - detect sales
                                const oldQty = snapshot?.quantity ?? localItem.lastSyncedQty ?? localItem.currentQty;
                                const newQty = change.new;
                                if (newQty < oldQty) {
                                    const sold = oldQty - newQty;
                                    updates.currentQty = Math.max(0, localItem.currentQty - sold);
                                    await data.addHistory(sku, {
                                        date: new Date(),
                                        action: 'EBAY_SALE',
                                        qty: -sold,
                                        newTotal: updates.currentQty,
                                        note: `${sold} sold on eBay (detected during pull)`
                                    });
                                }
                            } else if (change.field === 'price') {
                                updates.price = change.new;
                            } else if (change.field === 'title') {
                                updates.description = change.new;
                            }
                            changedFields.push(change.field);
                        } else {
                            // Both changed - compare timestamps (newest wins)
                            const localIsNewer = localModified > (lastSyncTime || new Date(0));
                            if (!localIsNewer) {
                                // eBay wins
                                if (change.field === 'price') updates.price = change.new;
                                if (change.field === 'title') updates.description = change.new;
                                changedFields.push(change.field);
                            }
                            // If local is newer, we skip (keep local value)
                        }
                    }

                    if (Object.keys(updates).length > 0) {
                        // Update local item
                        updates.ebaySync = {
                            snapshot: this.captureEbaySnapshot(ebayItem),
                            lastSyncTime: new Date(),
                            ebayItemId: ebayItem.itemId,
                            status: 'synced'
                        };
                        updates.lastSyncedQty = parseInt(ebayItem.quantity) || localItem.currentQty;

                        await data.updateItem(sku, updates);
                        results.updated.push({ sku, fields: changedFields });
                    } else {
                        results.skipped.push({ sku, reason: 'Local changes are newer' });
                    }
                }
            } catch (err) {
                results.errors.push({ sku: ebayItem.sku || ebayItem.itemId, error: err.message });
            }
        }

        return results;
    },

    // ============================================
    // PUSH TO EBAY (Local → eBay)
    // ============================================
    async pushToEbay(accountId) {
        const results = {
            pushed: [],
            skipped: [],
            created: [],
            errors: []
        };

        // Get all local items
        const localItems = await data.getAllItems();

        // Fetch current eBay inventory for comparison
        let ebayInventory = {};
        try {
            const ebayData = await this.getActiveListings(accountId);
            if (ebayData.items) {
                ebayData.items.forEach(item => {
                    const sku = item.sku || item.itemId;
                    ebayInventory[sku] = item;
                });
            }
        } catch (err) {
            console.log('Could not fetch eBay inventory:', err.message);
        }

        for (const item of localItems) {
            try {
                const sku = item.sku;
                const fullItem = await data.getItem(sku);
                if (!fullItem) continue;

                const ebayItem = ebayInventory[sku];
                const snapshot = fullItem.ebaySync?.snapshot;

                if (!ebayItem) {
                    // Item not on eBay - create it
                    await this.syncItemToEbay(accountId, {
                        SKU: fullItem.sku,
                        Price: fullItem.price || 0,
                        Quantity: fullItem.currentQty,
                        Description: fullItem.description,
                        FullLocation: fullItem.fullLocation,
                        Condition: fullItem.condition || 'NEW',
                        ItemSpecifics: fullItem.itemSpecifics || {}
                    });

                    // Update sync tracking
                    await data.updateItem(sku, {
                        lastSyncedQty: fullItem.currentQty,
                        ebaySync: {
                            snapshot: this.captureLocalSnapshot(fullItem),
                            lastSyncTime: new Date(),
                            status: 'synced'
                        }
                    });

                    results.created.push({ sku, title: fullItem.description });
                    continue;
                }

                // Item exists on eBay - check if eBay changed since our snapshot
                const ebayChanges = this.detectEbayChanges(ebayItem, snapshot);
                const lastSyncTime = fullItem.ebaySync?.lastSyncTime;
                const localModified = fullItem.lastModified;

                // Check if we should push
                let shouldPush = true;
                const skippedReasons = [];

                for (const change of ebayChanges) {
                    if (change.field === 'all') continue; // No snapshot, proceed with push

                    // eBay has changes we haven't seen
                    const localValue = change.field === 'quantity' ? fullItem.currentQty :
                                      change.field === 'price' ? fullItem.price : null;
                    const snapshotValue = snapshot?.[change.field];
                    const localChangedSinceSync = localValue !== snapshotValue;

                    if (!localChangedSinceSync && localValue !== change.new) {
                        // Local didn't change this field, but eBay did - don't overwrite
                        skippedReasons.push(`eBay has newer ${change.field}`);
                    } else if (localChangedSinceSync && localValue !== change.new) {
                        // Both changed - compare timestamps
                        const localIsNewer = localModified > (lastSyncTime || new Date(0));
                        if (!localIsNewer) {
                            skippedReasons.push(`eBay ${change.field} is newer`);
                        }
                    }
                }

                if (skippedReasons.length > 0 && skippedReasons.length >= ebayChanges.length) {
                    results.skipped.push({ sku, reason: skippedReasons.join(', ') });
                    continue;
                }

                // Safe to push
                await this.syncItemToEbay(accountId, {
                    SKU: fullItem.sku,
                    Price: fullItem.price || 0,
                    Quantity: fullItem.currentQty,
                    Description: fullItem.description,
                    FullLocation: fullItem.fullLocation,
                    Condition: fullItem.condition || 'NEW',
                    ItemSpecifics: fullItem.itemSpecifics || {}
                });

                // Update sync tracking
                await data.updateItem(sku, {
                    lastSyncedQty: fullItem.currentQty,
                    ebaySync: {
                        snapshot: this.captureLocalSnapshot(fullItem),
                        lastSyncTime: new Date(),
                        status: 'synced'
                    }
                });

                results.pushed.push({ sku, title: fullItem.description });

            } catch (err) {
                results.errors.push({ sku: item.sku, error: err.message });
            }
        }

        return results;
    },

    // ============================================
    // SMART SYNC (Two-Way with Sales Detection)
    // ============================================
    async smartSyncAll(accountId) {
        const results = {
            imported: [],      // Created locally from eBay
            exported: [],      // Created on eBay from local
            updated: [],       // Updated (either direction)
            sales: [],         // eBay sales detected
            errors: []
        };

        // 1. Fetch eBay active listings (Trading API)
        let ebayInventory = {};
        try {
            const ebayData = await this.getActiveListings(accountId);
            if (ebayData.items) {
                ebayData.items.forEach(item => {
                    const sku = item.sku || item.itemId;
                    ebayInventory[sku] = item;
                });
            }
        } catch (err) {
            console.log('Could not fetch eBay listings:', err.message);
        }

        // 2. Get all local items
        const localItems = await data.getAllItems();
        const localMap = {};
        localItems.forEach(item => { localMap[item.sku] = item; });

        const processedSkus = new Set();

        // 3. Process items that exist on BOTH sides
        for (const [sku, ebayItem] of Object.entries(ebayInventory)) {
            const localItem = localMap[sku];
            if (!localItem) continue; // Will handle eBay-only items later

            processedSkus.add(sku);

            try {
                const fullItem = await data.getItem(sku);
                if (!fullItem) continue;

                const snapshot = fullItem.ebaySync?.snapshot;
                const lastSyncTime = fullItem.ebaySync?.lastSyncTime;
                const snapshotQty = snapshot?.quantity ?? fullItem.lastSyncedQty ?? fullItem.currentQty;
                const ebayQty = parseInt(ebayItem.quantity) || 0;
                const localQty = fullItem.currentQty;

                let finalQty = localQty;
                let salesDetected = 0;

                // Detect eBay sales (quantity decreased on eBay)
                if (ebayQty < snapshotQty) {
                    salesDetected = snapshotQty - ebayQty;
                    finalQty = Math.max(0, localQty - salesDetected);

                    await data.addHistory(sku, {
                        date: new Date(),
                        action: 'EBAY_SALE',
                        qty: -salesDetected,
                        newTotal: finalQty,
                        note: `${salesDetected} sold on eBay (detected during sync)`
                    });

                    results.sales.push({ sku, sold: salesDetected, newQty: finalQty });
                }

                // Sync to eBay with reconciled quantity
                await this.syncItemToEbay(accountId, {
                    SKU: fullItem.sku,
                    Price: fullItem.price || 0,
                    Quantity: finalQty,
                    Description: fullItem.description,
                    FullLocation: fullItem.fullLocation,
                    Condition: fullItem.condition || 'NEW',
                    ItemSpecifics: fullItem.itemSpecifics || {}
                });

                // Update local with new snapshot
                await data.updateItem(sku, {
                    currentQty: finalQty,
                    lastSyncedQty: finalQty,
                    ebaySync: {
                        snapshot: this.captureLocalSnapshot({ ...fullItem, currentQty: finalQty }),
                        lastSyncTime: new Date(),
                        ebayItemId: ebayItem.itemId,
                        status: 'synced'
                    }
                });

                results.updated.push({ sku, qty: finalQty, salesDetected });

            } catch (err) {
                results.errors.push({ sku, error: err.message });
            }
        }

        // 4. Handle eBay-only items (import to local)
        for (const [sku, ebayItem] of Object.entries(ebayInventory)) {
            if (processedSkus.has(sku)) continue;

            try {
                const newItem = this.createLocalItemFromEbay(ebayItem);
                await data.createItem(newItem);
                results.imported.push({ sku, title: ebayItem.title });
            } catch (err) {
                results.errors.push({ sku, error: `Import failed: ${err.message}` });
            }
        }

        // 5. Handle local-only items (export to eBay)
        for (const item of localItems) {
            if (processedSkus.has(item.sku)) continue;
            if (ebayInventory[item.sku]) continue; // Already processed

            try {
                const fullItem = await data.getItem(item.sku);
                if (!fullItem) continue;

                await this.syncItemToEbay(accountId, {
                    SKU: fullItem.sku,
                    Price: fullItem.price || 0,
                    Quantity: fullItem.currentQty,
                    Description: fullItem.description,
                    FullLocation: fullItem.fullLocation,
                    Condition: fullItem.condition || 'NEW',
                    ItemSpecifics: fullItem.itemSpecifics || {}
                });

                await data.updateItem(fullItem.sku, {
                    lastSyncedQty: fullItem.currentQty,
                    ebaySync: {
                        snapshot: this.captureLocalSnapshot(fullItem),
                        lastSyncTime: new Date(),
                        status: 'synced'
                    }
                });

                results.exported.push({ sku: fullItem.sku, title: fullItem.description });

            } catch (err) {
                results.errors.push({ sku: item.sku, error: `Export failed: ${err.message}` });
            }
        }

        return results;
    },

    async getStatus() {
        return {
            configured: config.isEbayConfigured(),
            environment: config.ebay.environment,
            accounts: await data.getAllAccounts()
        };
    }
};

// ============================================
// API Routes
// ============================================

app.get('/api/inventory', async (req, res) => {
    try {
        let items = await data.getAllItems();
        const filter = req.query.filter;

        if (filter === 'needs-sku') {
            // Items that need a proper warehouse SKU:
            // - SKU is not exactly 9 digits
            // - SKU contains non-numeric characters
            // - Location is 000-00 (default from eBay import)
            items = items.filter(item => {
                const sku = item.SKU || '';
                const isValid9Digits = /^\d{9}$/.test(sku);
                const hasDefaultLocation = item.FullLocation === '000-00';
                return !isValid9Digits || hasDefaultLocation;
            });
        } else if (filter === 'ebay-imports') {
            // Items imported from eBay
            items = items.filter(item => {
                // Check raw item for ebaySync (need to get full item)
                return item.FullLocation === '000-00' || (item.SKU && item.SKU.length > 9);
            });
        }

        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/inventory/:sku/history', async (req, res) => {
    try {
        const item = await data.getItem(req.params.sku);
        if (!item) return res.status(404).json({ error: 'Item not found' });
        res.json({ sku: item.sku, currentQty: item.currentQty, history: item.history });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/check-item/:itemId', async (req, res) => {
    try {
        const item = await data.getItemByCode(req.params.itemId);
        if (item) {
            res.json({ exists: true, item: { SKU: item.sku, ItemCode: item.itemCode, DrawerNumber: item.drawerNumber, PositionNumber: item.positionNumber, FullLocation: item.fullLocation, Price: item.price || 0, Quantity: item.currentQty, Description: item.description } });
        } else {
            res.json({ exists: false, item: null });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/next-item-id', async (req, res) => {
    try {
        const usedIds = new Set(await data.getAllItemCodes());
        for (let i = 1; i <= 9999; i++) {
            const id = String(i).padStart(4, '0');
            if (!usedIds.has(id)) return res.json({ nextId: id });
        }
        res.status(400).json({ error: 'No available Item IDs' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/next-location', async (req, res) => {
    try {
        const usedLocations = new Set(await data.getAllLocations());
        for (let drawer = 1; drawer <= 999; drawer++) {
            for (let position = 1; position <= 99; position++) {
                const location = String(drawer).padStart(3, '0') + String(position).padStart(2, '0');
                if (!usedLocations.has(location)) {
                    return res.json({ nextLocation: location, drawer: String(drawer).padStart(3, '0'), position: String(position).padStart(2, '0') });
                }
            }
        }
        res.status(400).json({ error: 'No available locations' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/inventory', async (req, res) => {
    try {
        const { itemId, drawer, position, price = 0, quantity = 1, description = '' } = req.body;
        if (!itemId || !drawer || !position) return res.status(400).json({ error: 'Item ID, drawer, and position are required' });
        if (!/^\d{4}$/.test(itemId)) return res.status(400).json({ error: 'Item ID must be exactly 4 digits' });

        const drawerStr = String(drawer).padStart(3, '0');
        const positionStr = String(position).padStart(2, '0');
        const fullLocation = `${drawerStr}-${positionStr}`;
        const sku = `${itemId}${drawerStr}${positionStr}`;
        const qtyToAdd = parseInt(quantity);

        const existingByItemId = await data.getItemByCode(itemId);
        if (existingByItemId) {
            const newQty = existingByItemId.currentQty + qtyToAdd;
            const updates = { currentQty: newQty };
            if (description) updates.description = description;
            if (price > 0) updates.price = parseFloat(price);
            await data.updateItem(existingByItemId.sku, updates);
            await data.addHistory(existingByItemId.sku, { date: new Date(), action: 'ADD', qty: qtyToAdd, newTotal: newQty, note: `Added ${qtyToAdd} units` });
            const barcode = await generateBarcode(existingByItemId.sku);
            return res.json({ message: `Quantity added to existing item (now ${newQty})`, item: { SKU: existingByItemId.sku, ItemCode: existingByItemId.itemCode, DrawerNumber: existingByItemId.drawerNumber, PositionNumber: existingByItemId.positionNumber, FullLocation: existingByItemId.fullLocation, Price: updates.price || existingByItemId.price || 0, Quantity: newQty, Description: updates.description || existingByItemId.description }, barcode });
        }

        const existingByLocation = await data.getItemByLocation(fullLocation);
        if (existingByLocation) return res.status(400).json({ error: `Location ${fullLocation} already has item ${existingByLocation.itemCode}` });

        const now = new Date();
        const newItem = { sku, itemCode: itemId, drawerNumber: drawerStr, positionNumber: positionStr, fullLocation, price: parseFloat(price) || 0, currentQty: qtyToAdd, description, dateAdded: now, lastModified: now, history: [{ date: now, action: 'CREATE', qty: qtyToAdd, newTotal: qtyToAdd, note: 'Item created' }] };
        await data.createItem(newItem);
        const barcode = await generateBarcode(sku);
        res.json({ message: 'New item added', item: { SKU: sku, ItemCode: itemId, DrawerNumber: drawerStr, PositionNumber: positionStr, FullLocation: fullLocation, Price: newItem.price, Quantity: qtyToAdd, Description: description, DateAdded: now }, barcode });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/inventory/:sku', async (req, res) => {
    try {
        const { sku } = req.params;
        const { quantity, price, description } = req.body;
        const item = await data.getItem(sku);
        if (!item) return res.status(404).json({ error: 'Item not found' });

        const updates = {};
        if (quantity !== undefined) {
            const newQty = parseInt(quantity);
            const diff = newQty - item.currentQty;
            updates.currentQty = newQty;
            await data.addHistory(sku, { date: new Date(), action: diff >= 0 ? 'ADJUST_UP' : 'ADJUST_DOWN', qty: diff, newTotal: newQty, note: `Quantity adjusted from ${item.currentQty} to ${newQty}` });
        }
        if (price !== undefined) updates.price = parseFloat(price);
        if (description !== undefined) updates.description = description;

        const updated = await data.updateItem(sku, updates);
        res.json({ message: 'Item updated', item: formatItem(updated) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/inventory/:sku', async (req, res) => {
    try {
        const item = await data.getItem(req.params.sku);
        if (!item) return res.status(404).json({ error: 'Item not found' });
        await data.deleteItem(req.params.sku);
        res.json({ message: 'Item deleted', item: { SKU: item.sku, ItemCode: item.itemCode, FullLocation: item.fullLocation, Quantity: item.currentQty } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/lookup/:sku', async (req, res) => {
    try {
        const item = await data.getItem(req.params.sku);
        if (!item) return res.status(404).json({ error: 'Item not found' });
        const barcode = await generateBarcode(item.sku);
        res.json({ item: { SKU: item.sku, ItemCode: item.itemCode, DrawerNumber: item.drawerNumber, PositionNumber: item.positionNumber, FullLocation: item.fullLocation, Price: item.price || 0, Quantity: item.currentQty, Description: item.description, DateAdded: item.dateAdded, LastModified: item.lastModified, ebaySync: item.ebaySync || null }, barcode });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/check-location/:drawer/:position', async (req, res) => {
    try {
        const fullLocation = `${String(req.params.drawer).padStart(3, '0')}-${String(req.params.position).padStart(2, '0')}`;
        const item = await data.getItemByLocation(fullLocation);
        if (item) {
            res.json({ exists: true, item: { SKU: item.sku, ItemCode: item.itemCode, FullLocation: item.fullLocation, Quantity: item.currentQty } });
        } else {
            res.json({ exists: false, item: null });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/barcode/:sku', async (req, res) => {
    res.json({ barcode: await generateBarcode(req.params.sku) });
});

// Advanced settings
app.get('/api/inventory/:sku/advanced', async (req, res) => {
    try {
        const item = await data.getItem(req.params.sku);
        if (!item) return res.status(404).json({ error: 'Item not found' });
        res.json({ SKU: item.sku, CategoryId: item.categoryId || null, CategoryName: item.categoryName || null, Condition: item.condition || null, ItemSpecifics: item.itemSpecifics || {} });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/inventory/:sku/advanced', async (req, res) => {
    try {
        const item = await data.getItem(req.params.sku);
        if (!item) return res.status(404).json({ error: 'Item not found' });
        const { categoryId, categoryName, condition, itemSpecifics } = req.body;
        const updates = {};
        if (categoryId !== undefined) { updates.categoryId = categoryId; updates.categoryName = categoryName || ''; }
        if (condition !== undefined) updates.condition = condition;
        if (itemSpecifics !== undefined) updates.itemSpecifics = itemSpecifics;
        await data.updateItem(req.params.sku, updates);
        res.json({ message: 'Advanced settings updated', item: { SKU: item.sku, CategoryId: updates.categoryId, CategoryName: updates.categoryName, Condition: updates.condition, ItemSpecifics: updates.itemSpecifics } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Change SKU endpoint - creates new item with new SKU, copies all data, deletes old
app.post('/api/inventory/:sku/change-sku', async (req, res) => {
    try {
        const oldSku = req.params.sku;
        const { newSku, description } = req.body;

        // Validate new SKU format (must be 9 digits)
        if (!newSku || !/^\d{9}$/.test(newSku)) {
            return res.status(400).json({ error: 'New SKU must be exactly 9 digits' });
        }

        // Get the old item
        const oldItem = await data.getItem(oldSku);
        if (!oldItem) {
            return res.status(404).json({ error: 'Item not found' });
        }

        // Check if new SKU already exists
        const existingItem = await data.getItem(newSku);
        if (existingItem) {
            return res.status(400).json({ error: 'An item with this SKU already exists' });
        }

        // Parse new SKU components
        const newItemCode = newSku.substring(0, 4);
        const newLocation = newSku.substring(4);
        const newDrawer = newLocation.substring(0, 3);
        const newPosition = newLocation.substring(3);
        const newFullLocation = `${newDrawer}-${newPosition}`;

        // Create new item with new SKU, copying all data
        const newItem = {
            sku: newSku,
            itemCode: newItemCode,
            drawerNumber: newDrawer,
            positionNumber: newPosition,
            fullLocation: newFullLocation,
            price: oldItem.price,
            currentQty: oldItem.currentQty,
            description: description !== undefined ? description : oldItem.description,
            categoryId: oldItem.categoryId,
            categoryName: oldItem.categoryName,
            condition: oldItem.condition,
            itemSpecifics: oldItem.itemSpecifics || {},
            dateAdded: oldItem.dateAdded,
            lastModified: new Date(),
            lastSyncedQty: oldItem.lastSyncedQty,
            ebaySync: oldItem.ebaySync || {},  // Preserve eBay sync data (ebayItemId stays linked)
            history: [
                ...(oldItem.history || []),
                {
                    date: new Date(),
                    action: 'SKU_CHANGE',
                    qty: 0,
                    newTotal: oldItem.currentQty,
                    note: `SKU changed from ${oldSku} to ${newSku}`
                }
            ]
        };

        // Create the new item
        await data.createItem(newItem);

        // Delete the old item
        await data.deleteItem(oldSku);

        // Generate barcode for new SKU
        const barcode = await generateBarcode(newSku);

        res.json({
            message: 'SKU changed successfully',
            oldSku,
            newSku,
            item: formatItem(newItem),
            barcode
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export routes
app.get('/api/export/ebay', async (req, res) => {
    const items = await data.getAllItems();
    const ebayData = items.map(item => ({ 'Action': 'Revise', 'ItemID': '', 'CustomLabel': item.SKU, 'Quantity': item.Quantity, 'Title': item.Description || '', 'Location': item.FullLocation }));
    const worksheet = XLSX.utils.json_to_sheet(ebayData);
    const csv = XLSX.utils.sheet_to_csv(worksheet);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=ebay_inventory.csv');
    res.send(csv);
});

// Debug: Pull listings directly from eBay and export to Excel
app.get('/api/debug/ebay-export/:accountId', async (req, res) => {
    try {
        if (!(await ebayAPI.isAccountAuthenticated(req.params.accountId))) {
            return res.status(401).json({ error: 'eBay account not connected or token expired' });
        }

        // Pull inventory directly from eBay
        const ebayData = await ebayAPI.getInventoryItems(req.params.accountId);

        if (!ebayData.inventoryItems || ebayData.inventoryItems.length === 0) {
            return res.status(404).json({ error: 'No items found on eBay' });
        }

        // Format for Excel
        const excelData = ebayData.inventoryItems.map(item => ({
            'SKU': item.sku,
            'Title': item.product?.title || '',
            'Quantity': item.availability?.shipToLocationAvailability?.quantity || 0,
            'Condition': item.condition || '',
            'Description': item.product?.description || '',
            'Warehouse Location': item.product?.aspects?.['Warehouse Location']?.[0] || ''
        }));

        // Create Excel workbook
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(excelData);

        // Set column widths
        worksheet['!cols'] = [
            { wch: 15 }, // SKU
            { wch: 40 }, // Title
            { wch: 10 }, // Quantity
            { wch: 12 }, // Condition
            { wch: 50 }, // Description
            { wch: 20 }  // Location
        ];

        XLSX.utils.book_append_sheet(workbook, worksheet, 'eBay Inventory');

        // Generate buffer
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=ebay_inventory_${new Date().toISOString().split('T')[0]}.xlsx`);
        res.send(buffer);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Full database export (JSON with all nested data)
app.get('/api/export/full', async (req, res) => {
    try {
        const items = process.env.MONGODB_URI
            ? await db.inventory.getAll()
            : Object.values(localInventory.items);

        const accounts = process.env.MONGODB_URI
            ? await db.ebayAccounts.getAll()
            : Object.values(localAccounts);

        // Remove sensitive token data from accounts export
        const safeAccounts = accounts.map(acc => ({
            accountId: acc.accountId,
            name: acc.name,
            addedAt: acc.addedAt,
            lastSync: acc.lastSync
        }));

        const exportData = {
            version: "3.0",
            exportDate: new Date().toISOString(),
            itemCount: items.length,
            inventory: items,
            ebayAccounts: safeAccounts
        };

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=stockforge_backup_${new Date().toISOString().split('T')[0]}.json`);
        res.send(JSON.stringify(exportData, null, 2));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Full database import (JSON)
app.post('/api/import/full', async (req, res) => {
    try {
        const { inventory, version } = req.body;

        if (!inventory || !Array.isArray(inventory)) {
            return res.status(400).json({ error: 'Invalid backup file format' });
        }

        let imported = 0;
        let updated = 0;
        let errors = [];

        for (const item of inventory) {
            try {
                const sku = item.sku || item.SKU;
                if (!sku) {
                    errors.push({ item: 'unknown', error: 'Missing SKU' });
                    continue;
                }

                const existing = await data.getItem(sku);

                const itemData = {
                    sku: sku,
                    itemCode: item.itemCode || item.ItemCode || sku.substring(0, 4),
                    drawerNumber: item.drawerNumber || item.DrawerNumber || '',
                    positionNumber: item.positionNumber || item.PositionNumber || '',
                    fullLocation: item.fullLocation || item.FullLocation || '',
                    price: item.price || item.Price || 0,
                    currentQty: item.currentQty || item.Quantity || 0,
                    description: item.description || item.Description || '',
                    categoryId: item.categoryId || null,
                    categoryName: item.categoryName || null,
                    condition: item.condition || null,
                    itemSpecifics: item.itemSpecifics || {},
                    dateAdded: item.dateAdded ? new Date(item.dateAdded) : new Date(),
                    lastModified: new Date(),
                    history: item.history || []
                };

                if (existing) {
                    await data.updateItem(sku, itemData);
                    updated++;
                } else {
                    await data.createItem(itemData);
                    imported++;
                }
            } catch (err) {
                errors.push({ item: item.sku || 'unknown', error: err.message });
            }
        }

        res.json({
            message: `Import complete: ${imported} new, ${updated} updated, ${errors.length} errors`,
            imported,
            updated,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// eBay API routes
app.get('/api/ebay/status', async (req, res) => { res.json(await ebayAPI.getStatus()); });
app.get('/api/ebay/accounts', async (req, res) => { res.json(await data.getAllAccounts()); });

app.get('/api/ebay/callback', async (req, res) => {
    const { code, error, state } = req.query;
    if (error) return res.redirect('/admin?ebay_error=' + encodeURIComponent(error));
    if (!code) return res.redirect('/admin?ebay_error=no_code');
    try {
        const result = await ebayAPI.exchangeCodeForToken(code, state);
        res.redirect('/admin?ebay_connected=' + encodeURIComponent(result.accountName));
    } catch (err) {
        res.redirect('/admin?ebay_error=' + encodeURIComponent(err.message));
    }
});

app.get('/api/ebay/inventory/:accountId', async (req, res) => {
    try { res.json(await ebayAPI.getInventoryItems(req.params.accountId)); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ebay/purchases/:accountId', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const result = await ebayAPI.getPurchaseHistory(req.params.accountId, days);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ebay/user/:accountId', async (req, res) => {
    try {
        const result = await ebayAPI.getUserInfo(req.params.accountId);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ebay/watchlist/:accountId', async (req, res) => {
    try {
        const result = await ebayAPI.getWatchList(req.params.accountId);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Active listings using Trading API (GetMyeBaySelling)
app.get('/api/ebay/listings/:accountId', async (req, res) => {
    try {
        const result = await ebayAPI.getActiveListings(req.params.accountId);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ebay/sync/:accountId/:sku', async (req, res) => {
    try {
        const item = await data.getItem(req.params.sku);
        if (!item) return res.status(404).json({ error: 'Item not found' });
        const result = await ebayAPI.syncItemToEbay(req.params.accountId, { SKU: item.sku, Price: item.price || 0, Quantity: item.currentQty, Description: item.description, FullLocation: item.fullLocation, Condition: item.condition || 'NEW', ItemSpecifics: item.itemSpecifics || {} });
        await data.addHistory(req.params.sku, { date: new Date(), action: 'EBAY_SYNC', qty: 0, newTotal: item.currentQty, note: `Synced to eBay` });
        res.json({ message: 'Item synced to eBay', result });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pull from eBay to local inventory
app.post('/api/ebay/pull/:accountId', async (req, res) => {
    try {
        if (!(await ebayAPI.isAccountAuthenticated(req.params.accountId))) {
            return res.status(401).json({ error: 'eBay account not connected' });
        }

        const results = await ebayAPI.pullFromEbay(req.params.accountId);

        const message = `Pulled from eBay: ${results.created.length} imported, ${results.updated.length} updated, ${results.skipped.length} skipped`;

        res.json({
            message,
            summary: {
                created: results.created.length,
                updated: results.updated.length,
                skipped: results.skipped.length,
                errors: results.errors.length
            },
            details: results
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Push from local inventory to eBay
app.post('/api/ebay/push/:accountId', async (req, res) => {
    try {
        if (!(await ebayAPI.isAccountAuthenticated(req.params.accountId))) {
            return res.status(401).json({ error: 'eBay account not connected' });
        }

        const results = await ebayAPI.pushToEbay(req.params.accountId);

        const message = `Pushed to eBay: ${results.created.length} created, ${results.pushed.length} updated, ${results.skipped.length} skipped`;

        res.json({
            message,
            summary: {
                created: results.created.length,
                pushed: results.pushed.length,
                skipped: results.skipped.length,
                errors: results.errors.length
            },
            details: results
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Smart two-way sync
app.post('/api/ebay/sync-all/:accountId', async (req, res) => {
    try {
        if (!(await ebayAPI.isAccountAuthenticated(req.params.accountId))) {
            return res.status(401).json({ error: 'eBay account not connected' });
        }

        const results = await ebayAPI.smartSyncAll(req.params.accountId);

        let message = `Sync complete: `;
        const parts = [];
        if (results.imported.length > 0) parts.push(`${results.imported.length} imported from eBay`);
        if (results.exported.length > 0) parts.push(`${results.exported.length} exported to eBay`);
        if (results.updated.length > 0) parts.push(`${results.updated.length} updated`);
        if (results.sales.length > 0) {
            const totalSold = results.sales.reduce((sum, s) => sum + s.sold, 0);
            parts.push(`${totalSold} eBay sales detected`);
        }
        if (results.errors.length > 0) parts.push(`${results.errors.length} errors`);
        message += parts.length > 0 ? parts.join(', ') : 'No changes';

        res.json({
            message,
            summary: {
                imported: results.imported.length,
                exported: results.exported.length,
                updated: results.updated.length,
                sales: results.sales.length,
                errors: results.errors.length
            },
            details: results
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ebay/categories/search/:accountId', async (req, res) => {
    if (!req.query.q) return res.status(400).json({ error: 'Search query required' });
    try { res.json(await ebayAPI.getCategorySuggestions(req.params.accountId, req.query.q)); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ebay/categories/:categoryId/aspects/:accountId', async (req, res) => {
    try { res.json(await ebayAPI.getItemAspectsForCategory(req.params.accountId, req.params.categoryId)); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// Get business policies (needed for creating listings)
app.get('/api/ebay/policies/:accountId', async (req, res) => {
    try {
        const policies = await ebayAPI.getBusinessPolicies(req.params.accountId);
        res.json(policies);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Publish a single item as listing
app.post('/api/ebay/publish/:accountId/:sku', async (req, res) => {
    try {
        const item = await data.getItem(req.params.sku);
        if (!item) return res.status(404).json({ error: 'Item not found' });

        // First sync the inventory item
        await ebayAPI.syncItemToEbay(req.params.accountId, {
            SKU: item.sku, Price: item.price || 0, Quantity: item.currentQty,
            Description: item.description, FullLocation: item.fullLocation,
            Condition: item.condition || 'NEW', ItemSpecifics: item.itemSpecifics || {}
        });

        // Get business policies
        const policies = await ebayAPI.getBusinessPolicies(req.params.accountId);

        // Create and publish offer
        const result = await ebayAPI.createAndPublishListing(req.params.accountId, {
            SKU: item.sku, Price: item.price || 9.99, Quantity: item.currentQty,
            Description: item.description, CategoryId: item.categoryId
        }, policies);

        await data.addHistory(req.params.sku, { date: new Date(), action: 'EBAY_PUBLISH', qty: 0, newTotal: item.currentQty, note: `Published to eBay (Listing: ${result.listingId})` });
        res.json({ message: 'Item published to eBay', result });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Publish all items as listings
app.post('/api/ebay/publish-all/:accountId', async (req, res) => {
    try {
        if (!(await ebayAPI.isAccountAuthenticated(req.params.accountId))) {
            return res.status(401).json({ error: 'eBay account not connected' });
        }

        // Get business policies first
        let policies;
        try {
            policies = await ebayAPI.getBusinessPolicies(req.params.accountId);
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }

        const results = { published: [], failed: [] };
        const items = await data.getAllItems();

        for (const item of items) {
            try {
                const fullItem = await data.getItem(item.SKU);
                if (!fullItem || !fullItem.description) {
                    results.failed.push({ sku: item.SKU, error: 'Missing description' });
                    continue;
                }

                // Sync inventory item first
                await ebayAPI.syncItemToEbay(req.params.accountId, {
                    SKU: fullItem.sku, Price: fullItem.price || 0, Quantity: fullItem.currentQty,
                    Description: fullItem.description, FullLocation: fullItem.fullLocation,
                    Condition: fullItem.condition || 'NEW', ItemSpecifics: fullItem.itemSpecifics || {}
                });

                // Create and publish offer
                const result = await ebayAPI.createAndPublishListing(req.params.accountId, {
                    SKU: fullItem.sku, Price: fullItem.price || 9.99, Quantity: fullItem.currentQty,
                    Description: fullItem.description, CategoryId: fullItem.categoryId
                }, policies);

                results.published.push({ sku: fullItem.sku, listingId: result.listingId, existing: result.existing });
            } catch (err) {
                results.failed.push({ sku: item.SKU, error: err.message });
            }
        }

        res.json({
            message: `Published ${results.published.length} listings, ${results.failed.length} failed`,
            results
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Main app
app.get('/app', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'app.html')); });

// Debug page
app.get('/debug', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'debug.html')); });

// Admin routes
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.post('/api/admin/login', (req, res) => {
    if (req.body.password === config.adminPassword) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});
app.post('/api/admin/ebay/connect', (req, res) => {
    if (req.body.password !== config.adminPassword) return res.status(401).json({ error: 'Invalid password' });
    if (!config.isEbayConfigured()) return res.status(400).json({ error: 'eBay API not configured' });
    if (!req.body.accountName) return res.status(400).json({ error: 'Account name required' });
    res.json({ authUrl: ebayAPI.getAuthUrl(req.body.accountName) });
});

// Reconnect existing account (refresh tokens)
app.post('/api/admin/ebay/reconnect', (req, res) => {
    if (req.body.password !== config.adminPassword) return res.status(401).json({ error: 'Invalid password' });
    if (!config.isEbayConfigured()) return res.status(400).json({ error: 'eBay API not configured' });
    if (!req.body.accountId || !req.body.accountName) return res.status(400).json({ error: 'Account ID and name required' });

    // Use existing account ID for reconnection
    const authUrl = ebayAPI.getReconnectUrl(req.body.accountId, req.body.accountName);
    res.json({ authUrl });
});
app.post('/api/admin/ebay/accounts', async (req, res) => {
    if (req.body.password !== config.adminPassword) return res.status(401).json({ error: 'Invalid password' });
    res.json(await data.getAllAccounts());
});
app.delete('/api/admin/ebay/account/:accountId', async (req, res) => {
    if (req.body.password !== config.adminPassword) return res.status(401).json({ error: 'Invalid password' });
    const removed = await data.removeAccount(req.params.accountId);
    res.json(removed ? { message: 'Account removed' } : { error: 'Account not found' });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        database: DB_MODE,
        useLocalDB: USE_LOCAL_DB
    });
});

// ============================================
// START SERVER
// ============================================

// Load local data if using local database
if (USE_LOCAL_DB) {
    loadLocalData();
}

// For Vercel serverless
if (process.env.VERCEL) {
    module.exports = app;
} else {
    app.listen(PORT, async () => {
        // Connect to MongoDB if using live database
        if (!USE_LOCAL_DB) {
            await db.connectDB();
        }

        const itemCount = USE_LOCAL_DB
            ? Object.keys(localInventory.items).length
            : await db.inventory.count();

        console.log(`\n========================================`);
        console.log(`  STOCKFORGE - Inventory Control`);
        console.log(`========================================`);
        console.log(`  URL:      http://localhost:${PORT}`);
        console.log(`  Admin:    http://localhost:${PORT}/admin`);
        console.log(`----------------------------------------`);
        console.log(`  Database: ${USE_LOCAL_DB ? 'LOCAL JSON' : 'MONGODB (Live)'}`);
        console.log(`  Items:    ${itemCount}`);
        console.log(`----------------------------------------`);
        if (!USE_LOCAL_DB) {
            console.log(`  Using live database - changes sync everywhere`);
        } else {
            console.log(`  Using local database - changes stay local`);
        }
        console.log(`========================================\n`);
    });
}

// Export for Vercel
module.exports = app;
