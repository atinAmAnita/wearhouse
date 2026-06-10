require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const bwipjs = require('bwip-js');
const multer = require('multer');
const db = require('./database');
const { HttpError, ah, errorMiddleware } = require('./lib/errors');
const { ebayLocks, withEbayLock } = require('./lib/ebayLocks');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
}));

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
    async getAllItems() {
        if (!USE_LOCAL_DB) {
            const items = await db.inventory.getAll();
            return items.map(formatItem);
        }
        return Object.values(localInventory.items).map(formatItem);
    },

    // Raw schema-shape items — for internal sync/diff logic that reads
    // lowercase fields like item.sku, item.ebaySync, item.imageUrl, etc.
    // formatItem renames these for the API; never call this from a route handler.
    async getAllItemsRaw() {
        if (!USE_LOCAL_DB) {
            return db.inventory.getAll();
        }
        return Object.values(localInventory.items);
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

    async getItemByEbayId(ebayItemId) {
        if (!USE_LOCAL_DB) {
            return db.inventory.getByEbayId(ebayItemId);
        }
        return Object.values(localInventory.items).find(i => i.ebaySync?.ebayItemId === ebayItemId) || null;
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

    // Rename an item's SKU + apply other field updates atomically.
    // Throws if newSku already exists or source item missing.
    async renameItem(oldSku, newSku, additionalFields = {}) {
        if (oldSku === newSku) return null;
        if (!USE_LOCAL_DB) {
            const existing = await db.inventory.getItem(newSku);
            if (existing) throw new Error(`Target SKU ${newSku} already exists`);
            return db.inventory.update(oldSku, { sku: newSku, ...additionalFields });
        }
        if (localInventory.items[newSku]) throw new Error(`Target SKU ${newSku} already exists`);
        const item = localInventory.items[oldSku];
        if (!item) throw new Error(`Source SKU ${oldSku} not found`);
        item.sku = newSku;
        Object.assign(item, additionalFields, { lastModified: new Date().toISOString() });
        localInventory.items[newSku] = item;
        delete localInventory.items[oldSku];
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
                hasValidToken: !!a.tokens?.refresh_token,
                lastSync: a.lastSync,
                addedAt: a.addedAt || a.createdAt,
                cronEnabled: a.cronEnabled !== false
            }));
        }
        return Object.entries(localAccounts).map(([id, acc]) => ({
            id,
            name: acc.name,
            hasValidToken: !!acc.tokens?.refresh_token,
            lastSync: acc.lastSync,
            addedAt: acc.addedAt || acc.createdAt,
            cronEnabled: acc.cronEnabled !== false
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
    },

    // Pending Updates
    async createPendingUpdate(updateData) {
        if (!USE_LOCAL_DB) {
            return db.pendingUpdates.create(updateData);
        }
        if (!localInventory.pendingUpdates) localInventory.pendingUpdates = [];
        const update = {
            _id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            ...updateData,
            createdAt: new Date().toISOString(),
            status: 'pending'
        };
        localInventory.pendingUpdates.push(update);
        saveLocalData();
        return update;
    },

    async getPendingUpdates(status = 'pending') {
        if (!USE_LOCAL_DB) {
            return db.pendingUpdates.getAll(status);
        }
        return (localInventory.pendingUpdates || [])
            .filter(u => u.status === status)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },

    async updatePendingChanges(id, newChanges) {
        if (!USE_LOCAL_DB) {
            return db.pendingUpdates.updateChanges(id, newChanges);
        }
        const update = (localInventory.pendingUpdates || []).find(u => u._id === id);
        if (update) {
            update.changes = newChanges;
            saveLocalData();
        }
        return update;
    },

    async dismissPendingUpdate(id) {
        if (!USE_LOCAL_DB) {
            return db.pendingUpdates.dismiss(id);
        }
        const update = (localInventory.pendingUpdates || []).find(u => u._id === id);
        if (update) {
            update.status = 'dismissed';
            update.dismissedAt = new Date().toISOString();
            saveLocalData();
        }
        return update;
    },

    async dismissAllPendingUpdates() {
        if (!USE_LOCAL_DB) {
            return db.pendingUpdates.dismissAll();
        }
        (localInventory.pendingUpdates || []).forEach(u => {
            if (u.status === 'pending') {
                u.status = 'dismissed';
                u.dismissedAt = new Date().toISOString();
            }
        });
        saveLocalData();
    },

    async countPendingUpdates() {
        if (!USE_LOCAL_DB) {
            return db.pendingUpdates.count();
        }
        return (localInventory.pendingUpdates || []).filter(u => u.status === 'pending').length;
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
        ImageUrl: item.imageUrl || null,
        DateAdded: item.dateAdded,
        LastModified: item.lastModified,
        Staged: item.staged || false,
        EbayItemId: item.ebaySync?.ebayItemId || null,
        EbayAccountId: item.ebaySync?.ebayAccountId || null,
        EbayStatus: item.ebaySync?.status || 'not_synced',
        LowStockThreshold: item.lowStockThreshold ?? null
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
        if (account.tokens.expires_at && Date.now() >= account.tokens.expires_at) {
            return !!account.tokens.refresh_token;
        }
        return true;
    },

    // Ensure account has a fresh access token, refreshing if needed. Returns the account.
    // ========================================
    // TRADING API HELPERS (Point 8)
    // Reusable primitives for all Trading API XML calls.
    // ========================================

    // Escape user input for safe XML embedding
    escapeXml(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    },

    // Parse eBay XML response: separate real errors (SeverityCode=Error) from warnings.
    // Returns { ack, errors: [LongMessage strings], warnings: [LongMessage strings] }
    parseEbayResponse(xmlText) {
        const ack = xmlText.match(/<Ack>([^<]+)<\/Ack>/)?.[1] || 'Unknown';
        const errorBlocks = [...xmlText.matchAll(/<Errors>([\s\S]*?)<\/Errors>/g)];
        const errors = [];
        const warnings = [];
        for (const m of errorBlocks) {
            const block = m[1];
            const msg = block.match(/<LongMessage>([^<]*)<\/LongMessage>/)?.[1]
                     || block.match(/<ShortMessage>([^<]*)<\/ShortMessage>/)?.[1]
                     || 'Unknown';
            if (block.includes('<SeverityCode>Error</SeverityCode>')) errors.push(msg);
            else warnings.push(msg);
        }
        return { ack, errors, warnings };
    },

    // Generic Trading API call. innerXml is the content between <RequesterCredentials> and footer.
    // Throws on real errors (warnings are returned but don't throw).
    async tradingApiCall(accountId, callName, innerXml) {
        const account = await this.ensureFreshToken(accountId);
        const token = account.tokens.access_token;
        const endpoint = config.ebay.environment === 'production'
            ? 'https://api.ebay.com/ws/api.dll'
            : 'https://api.sandbox.ebay.com/ws/api.dll';
        const body = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
    ${innerXml}
    <ErrorLanguage>en_US</ErrorLanguage>
    <WarningLevel>High</WarningLevel>
</${callName}Request>`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'X-EBAY-API-CALL-NAME': callName,
                'X-EBAY-API-IAF-TOKEN': token
            },
            body
        });
        const xmlText = await response.text();
        const parsed = this.parseEbayResponse(xmlText);
        if (parsed.ack === 'Failure' && parsed.errors.length > 0) {
            throw new Error(parsed.errors.join('; '));
        }
        return { xmlText, ...parsed };
    },

    // ========================================
    // DRIFT DETECTION (Point 1)
    // Fetch current eBay state for a listing, cached 30s to avoid hammering on bulk apply.
    // ========================================
    _listingStateCache: new Map(), // key: `${accountId}:${ebayItemId}`, value: { state, at }

    async getCurrentListingState(accountId, ebayItemId) {
        const key = `${accountId}:${ebayItemId}`;
        const cached = this._listingStateCache.get(key);
        // 5s TTL: short enough that drift detection during Apply All sees fresh state per item,
        // long enough to absorb double-clicks. (Was 30s — risked stale on rapid sequential applies.)
        if (cached && Date.now() - cached.at < 5 * 1000) return cached.state;

        const account = await this.ensureFreshToken(accountId);
        const token = account.tokens.access_token;
        const endpoint = config.ebay.environment === 'production'
            ? 'https://api.ebay.com/ws/api.dll'
            : 'https://api.sandbox.ebay.com/ws/api.dll';
        const body = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
    <ItemID>${ebayItemId}</ItemID>
    <DetailLevel>ReturnAll</DetailLevel>
    <ErrorLanguage>en_US</ErrorLanguage>
    <WarningLevel>High</WarningLevel>
</GetItemRequest>`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'X-EBAY-API-CALL-NAME': 'GetItem',
                'X-EBAY-API-IAF-TOKEN': token
            },
            body
        });
        const xmlText = await response.text();
        const ack = xmlText.match(/<Ack>([^<]+)<\/Ack>/)?.[1];
        if (ack === 'Failure') {
            const errBlocks = [...xmlText.matchAll(/<Errors>([\s\S]*?)<\/Errors>/g)];
            const realErr = errBlocks.find(m => m[1].includes('<SeverityCode>Error</SeverityCode>'));
            if (realErr) {
                const msg = realErr[1].match(/<LongMessage>([^<]*)/)?.[1] || realErr[1].match(/<ShortMessage>([^<]*)/)?.[1];
                throw new Error(`GetItem failed: ${msg}`);
            }
        }
        // Find the <Item> block and parse qty/price
        const itemMatch = xmlText.match(/<Item>([\s\S]*?)<\/Item>/);
        if (!itemMatch) throw new Error('GetItem: no Item in response');
        const itemXml = itemMatch[1];
        const price = parseFloat(itemXml.match(/<StartPrice[^>]*>([^<]*)<\/StartPrice>/)?.[1] || itemXml.match(/<BuyItNowPrice[^>]*>([^<]*)<\/BuyItNowPrice>/)?.[1] || '0');
        // eBay <Quantity> is the listing TOTAL (ever listed); <QuantitySold> is how many sold.
        // AVAILABLE = total - sold. We expose all three so delta math stays correct when items
        // have already sold (push total = desiredAvailable + sold).
        const quantityTotal = parseInt(itemXml.match(/<Quantity>([^<]*)<\/Quantity>/)?.[1] || '0');
        const quantitySold = parseInt(itemXml.match(/<QuantitySold>([^<]*)<\/QuantitySold>/)?.[1] || '0');
        const quantity = Math.max(0, quantityTotal - quantitySold); // available
        const title = itemXml.match(/<Title>([^<]*)<\/Title>/)?.[1] || '';
        const state = { price, quantity, quantityTotal, quantitySold, title };
        this._listingStateCache.set(key, { state, at: Date.now() });
        return state;
    },

    async ensureFreshToken(accountId) {
        let account = await data.getAccount(accountId);
        if (!account) throw new Error('Account not found');
        if (!account.tokens?.access_token && !account.tokens?.refresh_token) {
            throw new Error('Account not authenticated');
        }
        const tokenExpired = !account.tokens?.access_token || !account.tokens.expires_at || Date.now() >= account.tokens.expires_at;
        if (tokenExpired) {
            if (account.tokens?.refresh_token) {
                console.log(`Token expired for ${accountId}, refreshing...`);
                await this.refreshAccessToken(accountId);
                account = await data.getAccount(accountId);
            } else {
                throw new Error('Token expired - please reconnect eBay account');
            }
        }
        return account;
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

        console.log(`Token exchange successful for ${accountName}:`, {
            hasAccessToken: !!tokenData.access_token,
            hasRefreshToken: !!tokenData.refresh_token,
            expiresIn: tokenData.expires_in
        });

        const accountData = {
            name: accountName,
            tokens: {
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token,
                expires_at: Date.now() + (tokenData.expires_in * 1000),
                token_type: tokenData.token_type
            },
            addedAt: new Date().toISOString()
        };

        await data.saveAccount(accountId, accountData);
        console.log(`Account ${accountId} saved to database`);

        // Verify save worked
        const savedAccount = await data.getAccount(accountId);
        if (!savedAccount?.tokens?.refresh_token) {
            console.error('WARNING: Account save verification failed - refresh token not found!');
        } else {
            console.log(`Account ${accountId} verified - refresh token saved correctly`);
        }

        this.pendingAuth = null;
        return { accountId, accountName };
    },

    async refreshAccessToken(accountId) {
        const account = await data.getAccount(accountId);
        if (!account?.tokens?.refresh_token) throw new Error('No refresh token - please reconnect eBay account');

        const credentials = Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString('base64');

        try {
            const response = await fetch(`${this.endpoints.api}/identity/v1/oauth2/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` },
                body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: account.tokens.refresh_token, scope: config.ebay.scopes.join(' ') })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('Token refresh failed:', errorText);
                // If refresh token is invalid/expired, clear ALL tokens so UI shows expired
                if (errorText.includes('invalid_grant') || errorText.includes('expired') || errorText.includes('HARD EXPIRED')) {
                    await data.saveAccount(accountId, { tokens: null });
                    throw new Error('eBay session expired - please reconnect your account');
                }
                throw new Error(`Token refresh failed: ${errorText}`);
            }

            const tokenData = await response.json();

            // Save new tokens - including new refresh_token if eBay provides one
            const tokens = {
                ...account.tokens,
                access_token: tokenData.access_token,
                expires_at: Date.now() + (tokenData.expires_in * 1000),
                // Use new refresh_token if provided, otherwise keep the old one
                refresh_token: tokenData.refresh_token || account.tokens.refresh_token
            };

            await data.saveAccount(accountId, { tokens });
            console.log(`Refreshed eBay token for account ${accountId}, expires in ${tokenData.expires_in}s`);
            return tokens;
        } catch (err) {
            console.error('Error refreshing eBay token:', err.message);
            throw err;
        }
    },

    async apiRequest(accountId, method, path, body = null) {
        let account = await data.getAccount(accountId);
        if (!account) throw new Error('Account not found');

        // Refresh access token if expired, missing, or no expiry timestamp
        if (!account.tokens?.access_token && !account.tokens?.refresh_token) {
            throw new Error('Account not authenticated');
        }
        const tokenExpired = !account.tokens?.access_token || !account.tokens.expires_at || Date.now() >= account.tokens.expires_at;
        if (tokenExpired) {
            if (account.tokens?.refresh_token) {
                console.log(`Token expired for ${accountId}, refreshing...`);
                await this.refreshAccessToken(accountId);
                account = await data.getAccount(accountId);
            } else {
                throw new Error('Token expired - please reconnect eBay account');
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

        let response = await fetch(`${this.endpoints.api}${path}`, options);

        // If 401, try refreshing token once and retry
        if (response.status === 401 && account.tokens?.refresh_token) {
            try {
                await this.refreshAccessToken(accountId);
                account = await data.getAccount(accountId);
                options.headers['Authorization'] = `Bearer ${account.tokens.access_token}`;
                response = await fetch(`${this.endpoints.api}${path}`, options);
            } catch (refreshErr) {
                throw new Error('eBay session expired - please reconnect your account');
            }
        }

        if (response.status === 204) return { success: true };
        const responseData = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(responseData.errors?.[0]?.message || `API error: ${response.status}`);
        return responseData;
    },

    async getInventoryItems(accountId) {
        // Paginate to fetch ALL inventory items, not just first 100
        const PAGE_SIZE = 100;
        const MAX_PAGES = 100; // safety cap = 10,000 items
        let offset = 0;
        const all = [];
        let total = 0;
        for (let page = 0; page < MAX_PAGES; page++) {
            const resp = await this.apiRequest(accountId, 'GET', `/sell/inventory/v1/inventory_item?limit=${PAGE_SIZE}&offset=${offset}`);
            const items = resp?.inventoryItems || [];
            all.push(...items);
            if (typeof resp?.total === 'number') total = resp.total;
            // Stop conditions: empty page, partial page, or reached known total
            if (items.length === 0) break;
            if (items.length < PAGE_SIZE) break;
            if (total > 0 && all.length >= total) break;
            offset += PAGE_SIZE;
        }
        return { inventoryItems: all, total: total || all.length, size: all.length };
    },
    async createOrUpdateInventoryItem(accountId, sku, itemData) { return this.apiRequest(accountId, 'PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, itemData); },
    async getCategorySuggestions(accountId, query) { return this.apiRequest(accountId, 'GET', `/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(query)}`); },
    async getItemAspectsForCategory(accountId, categoryId) { return this.apiRequest(accountId, 'GET', `/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${categoryId}`); },


    // Revise listing via Trading API (for legacy listings not managed by Inventory API)
    async reviseItemPrice(accountId, ebayItemId, newPrice, newQuantity = null) {
        let account = await this.ensureFreshToken(accountId);
        const token = account.tokens.access_token;
        const tradingEndpoint = config.ebay.environment === 'production'
            ? 'https://api.ebay.com/ws/api.dll'
            : 'https://api.sandbox.ebay.com/ws/api.dll';

        let quantityXml = '';
        if (newQuantity !== null) {
            quantityXml = `<Quantity>${newQuantity}</Quantity>`;
        }

        const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${token}</eBayAuthToken>
    </RequesterCredentials>
    <Item>
        <ItemID>${ebayItemId}</ItemID>
        <StartPrice currencyID="USD">${parseFloat(newPrice).toFixed(2)}</StartPrice>
        ${quantityXml}
    </Item>
    <ErrorLanguage>en_US</ErrorLanguage>
    <WarningLevel>High</WarningLevel>
</ReviseFixedPriceItemRequest>`;

        const response = await fetch(tradingEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem',
                'X-EBAY-API-IAF-TOKEN': token
            },
            body: xmlRequest
        });

        const xmlText = await response.text();
        const ackMatch = xmlText.match(/<Ack>([^<]+)<\/Ack>/);
        const ack = ackMatch ? ackMatch[1] : 'Unknown';

        if (ack === 'Failure') {
            // Parse all errors — only look at SeverityCode=Error, ignore Warnings
            const errorBlocks = [...xmlText.matchAll(/<Errors>([\s\S]*?)<\/Errors>/g)];
            const realErrors = errorBlocks
                .filter(m => m[1].includes('<SeverityCode>Error</SeverityCode>'))
                .map(m => {
                    const short = m[1].match(/<ShortMessage>([^<]*)<\/ShortMessage>/)?.[1] || '';
                    const long = m[1].match(/<LongMessage>([^<]*)<\/LongMessage>/)?.[1] || '';
                    const code = m[1].match(/<ErrorCode>([^<]*)<\/ErrorCode>/)?.[1] || '';
                    return { short, long, code };
                });
            if (realErrors.length > 0) {
                throw new Error(realErrors.map(e => e.long || e.short).join('; '));
            }
            // Only warnings, no real errors — treat as success
        }

        return { success: true, ack };
    },

    // Rename an eBay listing's SKU (Trading API ReviseFixedPriceItem with <SKU>)
    // ebayItemId stays the same — only the SKU label changes.
    async reviseItemSku(accountId, ebayItemId, newSku) {
        const account = await this.ensureFreshToken(accountId);
        const token = account.tokens.access_token;
        const endpoint = config.ebay.environment === 'production'
            ? 'https://api.ebay.com/ws/api.dll'
            : 'https://api.sandbox.ebay.com/ws/api.dll';
        const body = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
    <Item>
        <ItemID>${ebayItemId}</ItemID>
        <SKU>${this.escapeXml(newSku)}</SKU>
    </Item>
    <ErrorLanguage>en_US</ErrorLanguage>
    <WarningLevel>High</WarningLevel>
</ReviseFixedPriceItemRequest>`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem',
                'X-EBAY-API-IAF-TOKEN': token
            },
            body
        });
        const xmlText = await response.text();
        const parsed = this.parseEbayResponse(xmlText);
        if (parsed.ack === 'Failure' && parsed.errors.length > 0) {
            throw new Error(parsed.errors.join('; '));
        }
        return { success: true, ack: parsed.ack };
    },

    // Create a new listing via Trading API (AddFixedPriceItem)
    async addFixedPriceItem(accountId, item) {
        let account = await this.ensureFreshToken(accountId);
        const token = account.tokens.access_token;
        const tradingEndpoint = config.ebay.environment === 'production'
            ? 'https://api.ebay.com/ws/api.dll'
            : 'https://api.sandbox.ebay.com/ws/api.dll';

        const categoryId = item.CategoryId || '175673'; // Default: Other
        const condition = item.Condition || 'NEW';
        const conditionMap = { 'NEW': '1000', 'USED': '3000', 'USED_EXCELLENT': '3000', 'USED_GOOD': '4000', 'USED_ACCEPTABLE': '5000', 'FOR_PARTS': '7000' };
        const conditionId = conditionMap[condition] || '1000';

        const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${token}</eBayAuthToken>
    </RequesterCredentials>
    <Item>
        <Title>${(item.Description || 'Item ' + item.SKU).replace(/&/g, '&amp;').replace(/</g, '&lt;').substring(0, 80)}</Title>
        <Description>${(item.Description || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Description>
        <PrimaryCategory>
            <CategoryID>${categoryId}</CategoryID>
        </PrimaryCategory>
        <StartPrice currencyID="USD">${parseFloat(item.Price || 9.99).toFixed(2)}</StartPrice>
        <ConditionID>${conditionId}</ConditionID>
        <Country>US</Country>
        <Currency>USD</Currency>
        <DispatchTimeMax>3</DispatchTimeMax>
        <ListingDuration>GTC</ListingDuration>
        <ListingType>FixedPriceItem</ListingType>
        <Location>${item.Location || 'United States'}</Location>
        <PostalCode>${item.PostalCode || '10001'}</PostalCode>
        <Quantity>${parseInt(item.Quantity) || 1}</Quantity>
        <SKU>${item.SKU}</SKU>
        ${item.ImageUrl ? `<PictureDetails><PictureURL>${item.ImageUrl}</PictureURL></PictureDetails>` : ''}
        ${item.ItemSpecifics && Object.keys(item.ItemSpecifics).length > 0 ? `<ItemSpecifics>${Object.entries(item.ItemSpecifics).filter(([k,v]) => k && v).map(([k,v]) => `<NameValueList><Name>${this.escapeXml(k)}</Name><Value>${this.escapeXml(v)}</Value></NameValueList>`).join('')}</ItemSpecifics>` : ''}
        <ShippingDetails>
            <ShippingType>Flat</ShippingType>
            <ShippingServiceOptions>
                <ShippingServicePriority>1</ShippingServicePriority>
                <ShippingService>USPSPriority</ShippingService>
                <FreeShipping>true</FreeShipping>
            </ShippingServiceOptions>
        </ShippingDetails>
        <ReturnPolicy>
            <ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption>
            <RefundOption>MoneyBack</RefundOption>
            <ReturnsWithinOption>Days_30</ReturnsWithinOption>
            <ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption>
        </ReturnPolicy>
    </Item>
    <ErrorLanguage>en_US</ErrorLanguage>
    <WarningLevel>High</WarningLevel>
</AddFixedPriceItemRequest>`;

        const response = await fetch(tradingEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'X-EBAY-API-CALL-NAME': 'AddFixedPriceItem',
                'X-EBAY-API-IAF-TOKEN': token
            },
            body: xmlRequest
        });

        const xmlText = await response.text();
        const ackMatch = xmlText.match(/<Ack>([^<]+)<\/Ack>/);
        const ack = ackMatch ? ackMatch[1] : 'Unknown';

        if (ack === 'Failure') {
            const errorBlocks = [...xmlText.matchAll(/<Errors>([\s\S]*?)<\/Errors>/g)];
            const realErrors = errorBlocks
                .filter(m => m[1].includes('<SeverityCode>Error</SeverityCode>'))
                .map(m => m[1].match(/<LongMessage>([^<]*)<\/LongMessage>/)?.[1] || m[1].match(/<ShortMessage>([^<]*)<\/ShortMessage>/)?.[1] || 'Unknown error');
            if (realErrors.length > 0) {
                throw new Error(realErrors.join('; '));
            }
        }

        const itemIdMatch = xmlText.match(/<ItemID>([^<]+)<\/ItemID>/);
        return { success: true, ack, itemId: itemIdMatch?.[1] || null };
    },

    // Upload image to eBay Picture Services (UploadSiteHostedPictures)
    async uploadImage(accountId, imageBuffer, fileName) {
        let account = await this.ensureFreshToken(accountId);
        const token = account.tokens.access_token;
        const tradingEndpoint = config.ebay.environment === 'production'
            ? 'https://api.ebay.com/ws/api.dll'
            : 'https://api.sandbox.ebay.com/ws/api.dll';

        // eBay requires multipart/form-data with XML part + image part
        const boundary = '----EbayImageUpload' + Date.now();
        const xmlPart = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${token}</eBayAuthToken>
    </RequesterCredentials>
    <PictureName>${fileName || 'item-photo.jpg'}</PictureName>
    <PictureSet>Supersize</PictureSet>
    <ErrorLanguage>en_US</ErrorLanguage>
    <WarningLevel>High</WarningLevel>
</UploadSiteHostedPicturesRequest>`;

        // Build multipart body
        const parts = [];
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="XML Payload"\r\nContent-Type: text/xml\r\n\r\n${xmlPart}\r\n`));
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${fileName || 'photo.jpg'}"\r\nContent-Type: image/jpeg\r\n\r\n`));
        parts.push(imageBuffer);
        parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
        const body = Buffer.concat(parts);

        const response = await fetch(tradingEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length.toString(),
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'X-EBAY-API-CALL-NAME': 'UploadSiteHostedPictures',
                'X-EBAY-API-IAF-TOKEN': token
            },
            body
        });

        const xmlText = await response.text();
        const ackMatch = xmlText.match(/<Ack>([^<]+)<\/Ack>/);
        const ack = ackMatch ? ackMatch[1] : 'Unknown';

        if (ack === 'Failure') {
            const errorMsg = xmlText.match(/<LongMessage>([^<]*)<\/LongMessage>/)?.[1] ||
                             xmlText.match(/<ShortMessage>([^<]*)<\/ShortMessage>/)?.[1] || 'Upload failed';
            throw new Error(errorMsg);
        }

        const urlMatch = xmlText.match(/<FullURL>([^<]+)<\/FullURL>/);
        if (!urlMatch) throw new Error('No image URL returned from eBay');

        return { imageUrl: urlMatch[1], ack };
    },

    // Business Policies (needed for offers)
    async getFulfillmentPolicies(accountId, marketplaceId = 'EBAY_US') { return this.apiRequest(accountId, 'GET', `/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`); },
    async getPaymentPolicies(accountId, marketplaceId = 'EBAY_US') { return this.apiRequest(accountId, 'GET', `/sell/account/v1/payment_policy?marketplace_id=${marketplaceId}`); },
    async getReturnPolicies(accountId, marketplaceId = 'EBAY_US') { return this.apiRequest(accountId, 'GET', `/sell/account/v1/return_policy?marketplace_id=${marketplaceId}`); },

    // Purchase History (Trading API - XML based)
    async getPurchaseHistory(accountId, days = 30) {
        let account = await this.ensureFreshToken(accountId);

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
                // Handle tags with attributes like <CurrentPrice currencyID="USD">19.99</CurrentPrice>
                const m = itemXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
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
            // Handle tags with or without attributes
            const m = xmlText.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
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
                // Handle tags with attributes like <CurrentPrice currencyID="USD">19.99</CurrentPrice>
                const m = itemXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
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

        const ENTRIES_PER_PAGE = 200;
        const MAX_PAGES = 50; // safety cap = 10,000 listings
        const items = [];
        let totalEntries = 0;
        let lastError = null;
        let pageNumber = 1;

        while (pageNumber <= MAX_PAGES) {
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
            <EntriesPerPage>${ENTRIES_PER_PAGE}</EntriesPerPage>
            <PageNumber>${pageNumber}</PageNumber>
        </Pagination>
        <Sort>TimeLeft</Sort>
    </ActiveList>
    <OutputSelector>ItemID,Title,SKU,StartPrice,BuyItNowPrice,CurrentPrice,QuantityAvailable,Quantity,QuantitySold,ListingType,StartTime,EndTime,HitCount,PictureDetails.PictureURL,GalleryURL,PaginationResult,TotalNumberOfEntries,TotalNumberOfPages</OutputSelector>
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

            // Capture pagination info on first page
            if (pageNumber === 1) {
                const totalMatch = xmlText.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/);
                if (totalMatch) totalEntries = parseInt(totalMatch[1]);
                const errorMatch = xmlText.match(/<ShortMessage>([^<]*)<\/ShortMessage>/);
                if (errorMatch) lastError = errorMatch[1];
            }

            // Extract items from this page
            const itemArrayMatch = xmlText.match(/<ItemArray>([\s\S]*?)<\/ItemArray>/);
            const itemArrayXml = itemArrayMatch ? itemArrayMatch[1] : '';
            const itemMatches = [...itemArrayXml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)];

            // Stop if no items on this page (we're past the end)
            if (itemMatches.length === 0) break;

            for (const match of itemMatches) {
                const itemXml = match[1];
                const getTag = (tag) => {
                    const m = itemXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
                    return m ? m[1] : '';
                };

                const price = getTag('StartPrice') || getTag('BuyItNowPrice') || getTag('CurrentPrice') || '0';

                let pictureUrl = (itemXml.match(/<PictureURL>([^<]+)<\/PictureURL>/) ||
                                  itemXml.match(/<GalleryURL>([^<]+)<\/GalleryURL>/))?.[1] || null;
                if (pictureUrl && pictureUrl.includes('s-l140')) {
                    pictureUrl = pictureUrl.replace('s-l140', 's-l500');
                }

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
                    viewCount: getTag('HitCount') || '0',
                    pictureUrl
                });
            }

            // Stop if we got fewer items than the page size (last page) or reached total
            if (itemMatches.length < ENTRIES_PER_PAGE) break;
            if (totalEntries > 0 && items.length >= totalEntries) break;
            pageNumber++;
        }

        if (pageNumber > MAX_PAGES) {
            console.warn(`getActiveListings: hit MAX_PAGES safety cap (${MAX_PAGES}) for account ${accountId}`);
        }

        return {
            items,
            count: items.length,
            totalEntries: totalEntries || items.length,
            error: lastError
        };
    },

    // Revise price/quantity on an eBay listing using Trading API
    async reviseInventoryStatus(accountId, itemId, updates) {
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

        let inventoryStatusXml = '';
        if (updates.price !== null && updates.price !== undefined) {
            inventoryStatusXml += `<StartPrice>${updates.price}</StartPrice>`;
        }
        if (updates.quantity !== null && updates.quantity !== undefined) {
            inventoryStatusXml += `<Quantity>${updates.quantity}</Quantity>`;
        }

        const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${token}</eBayAuthToken>
    </RequesterCredentials>
    <InventoryStatus>
        <ItemID>${itemId}</ItemID>
        ${inventoryStatusXml}
    </InventoryStatus>
    <ErrorLanguage>en_US</ErrorLanguage>
    <WarningLevel>High</WarningLevel>
</ReviseInventoryStatusRequest>`;

        const response = await fetch(tradingEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'X-EBAY-API-CALL-NAME': 'ReviseInventoryStatus',
                'X-EBAY-API-IAF-TOKEN': token
            },
            body: xmlRequest
        });

        const xmlText = await response.text();

        // Check for errors
        const errorMatch = xmlText.match(/<ShortMessage>([^<]*)<\/ShortMessage>/);
        const ackMatch = xmlText.match(/<Ack>([^<]*)<\/Ack>/);

        if (ackMatch && (ackMatch[1] === 'Failure' || ackMatch[1] === 'PartialFailure')) {
            throw new Error(errorMatch ? errorMatch[1] : 'Failed to update eBay listing');
        }

        return {
            success: true,
            itemId,
            updates
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
    // Get or use default business policies
    async getBusinessPolicies(accountId) {
        const marketplaceId = 'EBAY_US';
        let fulfillmentPolicyId, paymentPolicyId, returnPolicyId;
        const fetchErrors = [];

        try {
            const fulfillment = await this.getFulfillmentPolicies(accountId, marketplaceId);
            fulfillmentPolicyId = fulfillment.fulfillmentPolicies?.[0]?.fulfillmentPolicyId;
        } catch (e) { fetchErrors.push(`fulfillment: ${e.message}`); }

        try {
            const payment = await this.getPaymentPolicies(accountId, marketplaceId);
            paymentPolicyId = payment.paymentPolicies?.[0]?.paymentPolicyId;
        } catch (e) { fetchErrors.push(`payment: ${e.message}`); }

        try {
            const returns = await this.getReturnPolicies(accountId, marketplaceId);
            returnPolicyId = returns.returnPolicies?.[0]?.returnPolicyId;
        } catch (e) { fetchErrors.push(`return: ${e.message}`); }

        if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
            const missing = [];
            if (!fulfillmentPolicyId) missing.push('fulfillment');
            if (!paymentPolicyId) missing.push('payment');
            if (!returnPolicyId) missing.push('return');
            const errSuffix = fetchErrors.length > 0 ? ` (fetch errors: ${fetchErrors.join('; ')})` : '';
            throw new Error(`Missing ${missing.join(', ')} policy. Create it in eBay Seller Hub.${errSuffix}`);
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

    // Detect changes between two states. Returns array of { field, oldValue, newValue }.
    // before/after: { price, quantity, title? }. Either can be null for "no baseline" scenarios.
    // opts: { priceEpsilon = 0.01, includeTitle = false }
    detectChanges(before, after, opts = {}) {
        if (!before) return [{ field: 'all', oldValue: null, newValue: after, reason: 'no_baseline' }];
        if (!after) return [{ field: 'all', oldValue: before, newValue: null, reason: 'no_current' }];
        const priceEps = opts.priceEpsilon ?? 0.01;
        const changes = [];
        const beforePrice = parseFloat(before.price) || 0;
        const afterPrice = parseFloat(after.price) || 0;
        const beforeQty = parseInt(before.quantity) || 0;
        const afterQty = parseInt(after.quantity) || 0;
        if (Math.abs(beforePrice - afterPrice) > priceEps) {
            changes.push({ field: 'price', oldValue: beforePrice, newValue: afterPrice });
        }
        if (beforeQty !== afterQty) {
            changes.push({ field: 'quantity', oldValue: beforeQty, newValue: afterQty });
        }
        if (opts.includeTitle && (before.title || '') !== (after.title || '')) {
            changes.push({ field: 'title', oldValue: before.title || '', newValue: after.title || '' });
        }
        return changes;
    },

    // Legacy alias — forwards to detectChanges. Kept for callers not yet migrated.
    detectEbayChanges(currentEbay, snapshot) {
        return this.detectChanges(snapshot, currentEbay, { includeTitle: true })
            .map(c => c.reason ? { field: c.field, reason: c.reason === 'no_baseline' ? 'no_snapshot' : c.reason } : { field: c.field, old: c.oldValue, new: c.newValue });
    },

    // Rebase pending updates to reflect current eBay state (Point B hybrid).
    // For price/title/description: update oldValue to current eBay value, keep newValue.
    // For quantity: if eBay dropped (sale detected), subtract the sold amount from newValue too.
    // Rationale: admin thinks of price as absolute; admin's qty intent is stock-delta, not absolute.
    async rebasePendingUpdatesForSku(sku, ebayItem, soldOnEbay) {
        const pending = await data.getPendingUpdates('pending');
        const relevant = pending.filter(u => u.sku === sku && u.updateType === 'UPDATE');
        for (const update of relevant) {
            let mutated = false;
            const newChanges = update.changes.map(c => {
                const updated = { ...c };
                // Delta (stock movement) changes need no rebasing — they're applied relative to
                // live eBay at apply time, so they already compose with sales. Leave untouched.
                if (c.delta !== undefined && c.delta !== null) return updated;
                if (c.field === 'price') {
                    const ebayPrice = parseFloat(ebayItem.price) || 0;
                    if (Math.abs((c.oldValue ?? 0) - ebayPrice) > 0.01) {
                        updated.oldValue = ebayPrice;
                        mutated = true;
                    }
                } else if (c.field === 'quantity') {
                    const ebayQty = parseInt(ebayItem.quantity) || 0;
                    if (c.oldValue !== ebayQty) {
                        updated.oldValue = ebayQty;
                        mutated = true;
                    }
                    if (soldOnEbay > 0) {
                        // Admin's intent was stock-delta; subtract the sale from the target
                        updated.newValue = Math.max(0, (c.newValue ?? 0) - soldOnEbay);
                        mutated = true;
                    }
                } else if (c.field === 'description' || c.field === 'title') {
                    const ebayTitle = ebayItem.title || '';
                    if ((c.oldValue || '') !== ebayTitle) {
                        updated.oldValue = ebayTitle;
                        mutated = true;
                    }
                }
                return updated;
            });
            if (mutated) {
                await data.updatePendingChanges(update._id.toString(), newChanges);
                console.log(`Rebased pending update ${update._id} for SKU ${sku} (sold=${soldOnEbay})`);
            }
        }
    },

    // Create a local inventory item from eBay data
    createLocalItemFromEbay(ebayItem, accountId = null) {
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
            imageUrl: ebayItem.pictureUrl || null,
            dateAdded: new Date(),
            lastModified: new Date(),
            lastSyncedQty: parseInt(ebayItem.quantity) || 0,
            ebaySync: {
                snapshot: this.captureEbaySnapshot(ebayItem),
                lastSyncTime: new Date(),
                ebayItemId: ebayItem.itemId || null,
                ebayAccountId: accountId || null,
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

        // Cross-check: which SKUs have pending admin changes? (Point 3 cross-check)
        // Don't auto-apply eBay-side changes for SKUs where admin has queued changes;
        // Point 1's drift check in Apply handles the conflict when admin clicks Apply.
        const pendingUpdates = await data.getPendingUpdates('pending');
        const pendingQtySkus = new Set(
            pendingUpdates
                .filter(u => u.changes?.some(c => c.field === 'quantity'))
                .map(u => u.sku)
        );

        for (const ebayItem of ebayItems) {
            try {
                const sku = ebayItem.sku || ebayItem.itemId;

                // Try to find existing item by SKU first, then by eBay ItemID
                let localItem = await data.getItem(sku);

                // If not found by SKU, try to find by eBay ItemID (in case SKU was changed locally)
                if (!localItem && ebayItem.itemId) {
                    localItem = await data.getItemByEbayId(ebayItem.itemId);
                    if (localItem) {
                        console.log(`Found item by eBay ItemID ${ebayItem.itemId}, local SKU: ${localItem.sku}`);
                    }
                }

                if (!localItem) {
                    // Item exists on eBay but not locally - CREATE
                    const newItem = this.createLocalItemFromEbay(ebayItem, accountId);
                    await data.createItem(newItem);
                    results.created.push({ sku, title: ebayItem.title, source: 'ebay' });
                } else {
                    // Item exists both places - check for changes
                    const snapshot = localItem.ebaySync?.snapshot;
                    const lastSyncTime = localItem.ebaySync?.lastSyncTime;
                    const localModified = localItem.lastModified;

                    const ebayChanges = this.detectEbayChanges(ebayItem, snapshot);

                    // Always retag the item to the pulling account — a pull is the user's
                    // explicit declaration that "these are this account's listings."
                    // Previously this only backfilled when missing, which left items
                    // permanently stuck on whichever account pulled them first.
                    const backfill = {};
                    if (ebayItem.pictureUrl && !localItem.imageUrl) backfill.imageUrl = ebayItem.pictureUrl;
                    if (localItem.ebaySync?.ebayAccountId !== accountId) {
                        backfill.ebaySync = {
                            ...(localItem.ebaySync || {}),
                            ebayAccountId: accountId,
                            ebayItemId: ebayItem.itemId || localItem.ebaySync?.ebayItemId || null
                        };
                    }
                    if (Object.keys(backfill).length > 0) await data.updateItem(sku, backfill);

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
                                const oldQty = snapshot?.quantity ?? localItem.currentQty;
                                const newQty = change.new;
                                if (newQty < oldQty) {
                                    const sold = oldQty - newQty;
                                    // Cross-check: if admin has a pending qty change for this SKU,
                                    // rebase the pending update (subtract sold from newValue) instead of deferring.
                                    if (pendingQtySkus.has(sku)) {
                                        await this.rebasePendingUpdatesForSku(sku, ebayItem, sold);
                                        await data.addHistory(sku, {
                                            date: new Date(),
                                            action: 'EBAY_SALE_REBASED',
                                            qty: -sold,
                                            newTotal: localItem.currentQty,
                                            note: `${sold} sold on eBay — pending update rebased (newValue -= ${sold})`
                                        });
                                    } else {
                                        updates.currentQty = Math.max(0, localItem.currentQty - sold);
                                        await data.addHistory(sku, {
                                            date: new Date(),
                                            action: 'EBAY_SALE',
                                            qty: -sold,
                                            newTotal: updates.currentQty,
                                            note: `${sold} sold on eBay (detected during pull)`
                                        });
                                    }
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
                        // Rebase pending updates (price/title only; qty was already rebased in the sale branch)
                        if (pendingQtySkus.has(sku) || changedFields.includes('price') || changedFields.includes('title')) {
                            await this.rebasePendingUpdatesForSku(sku, ebayItem, 0);
                        }

                        // Update local item — preserve existing ebaySync fields
                        updates.ebaySync = {
                            ...(localItem.ebaySync || {}),
                            snapshot: this.captureEbaySnapshot(ebayItem),
                            lastSyncTime: new Date(),
                            ebayItemId: ebayItem.itemId,
                            ebayAccountId: accountId,
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
    // SMART SYNC (Two-Way with Sales Detection)
    // ============================================
    async smartSyncAll(accountId) {
        const results = {
            imported: [],      // Created locally from eBay
            exported: [],      // Created on eBay from local
            updated: [],       // Updated (either direction)
            sales: [],         // eBay sales detected
            skipped: [],       // Skipped (already exists, or safety guard)
            errors: []
        };

        // 1. Fetch eBay active listings (Trading API)
        let ebayInventory = {};
        // Don't silently swallow eBay API failures — caller (cron, sync button) needs to know.
        // Throw only when the fetch genuinely failed (no items + error). A warning alongside
        // valid items is OK; ShortMessage covers both warnings and errors.
        const ebayData = await this.getActiveListings(accountId);
        if (!ebayData.items?.length && ebayData.error) {
            throw new Error(`eBay API error: ${ebayData.error}`);
        }
        if (ebayData.error) console.warn(`getActiveListings warning for ${accountId}: ${ebayData.error}`);
        if (ebayData.items) {
            ebayData.items.forEach(item => {
                const sku = item.sku || item.itemId;
                ebayInventory[sku] = item;
            });
        }

        // 2. Get all local items (raw schema — internal sync logic reads lowercase fields)
        const localItems = await data.getAllItemsRaw();
        const localMap = {};
        localItems.forEach(item => { localMap[item.sku] = item; });

        // Cross-check: SKUs with pending admin qty changes (Point 3)
        const pendingUpdates = await data.getPendingUpdates('pending');
        const pendingQtySkus = new Set(
            pendingUpdates
                .filter(u => u.changes?.some(c => c.field === 'quantity'))
                .map(u => u.sku)
        );

        const processedSkus = new Set();

        // 3. Process items that exist on BOTH sides
        for (const [sku, ebayItem] of Object.entries(ebayInventory)) {
            const localItem = localMap[sku];
            if (!localItem) continue; // Will handle eBay-only items later

            processedSkus.add(sku);

            try {
                const fullItem = await data.getItem(sku);
                if (!fullItem) continue;

                // Always retag to the syncing account (matches pullFromEbay behavior).
                const _bf = {};
                if (ebayItem.pictureUrl && !fullItem.imageUrl) _bf.imageUrl = ebayItem.pictureUrl;
                if (fullItem.ebaySync?.ebayAccountId !== accountId) {
                    _bf.ebaySync = {
                        ...(fullItem.ebaySync || {}),
                        ebayAccountId: accountId,
                        ebayItemId: ebayItem.itemId || fullItem.ebaySync?.ebayItemId || null
                    };
                }
                if (Object.keys(_bf).length > 0) await data.updateItem(sku, _bf);

                const snapshot = fullItem.ebaySync?.snapshot;
                const lastSyncTime = fullItem.ebaySync?.lastSyncTime;
                const snapshotQty = snapshot?.quantity ?? fullItem.currentQty;
                const ebayQty = parseInt(ebayItem.quantity) || 0;
                const localQty = fullItem.currentQty;

                let finalQty = localQty;
                let salesDetected = 0;

                // Detect eBay sales (quantity decreased on eBay)
                if (ebayQty < snapshotQty) {
                    salesDetected = snapshotQty - ebayQty;

                    // Cross-check: if admin has a pending qty change, rebase it (subtract sold from newValue)
                    if (pendingQtySkus.has(sku)) {
                        await this.rebasePendingUpdatesForSku(sku, ebayItem, salesDetected);
                        await data.addHistory(sku, {
                            date: new Date(),
                            action: 'EBAY_SALE_REBASED',
                            qty: -salesDetected,
                            newTotal: localQty,
                            note: `${salesDetected} sold on eBay — pending update rebased (newValue -= ${salesDetected})`
                        });
                        results.updated.push({ sku, qty: localQty, salesDetected, rebased: true });
                        continue;
                    }

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

                // Update local with new snapshot — preserve existing ebaySync fields
                await data.updateItem(sku, {
                    currentQty: finalQty,
                    lastSyncedQty: finalQty,
                    ebaySync: {
                        ...(fullItem.ebaySync || {}),
                        snapshot: this.captureLocalSnapshot({ ...fullItem, currentQty: finalQty }),
                        lastSyncTime: new Date(),
                        ebayItemId: ebayItem.itemId,
                        ebayAccountId: accountId,
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
                // Check if item already exists locally by eBay ItemID (in case SKU was changed)
                const existingByEbayId = ebayItem.itemId ? await data.getItemByEbayId(ebayItem.itemId) : null;
                if (existingByEbayId) {
                    // Backfill missing imageUrl + tag accountId for items matched by eBay ID
                    const patch = {};
                    if (ebayItem.pictureUrl && !existingByEbayId.imageUrl) patch.imageUrl = ebayItem.pictureUrl;
                    if (!existingByEbayId.ebaySync?.ebayAccountId) {
                        patch.ebaySync = { ...(existingByEbayId.ebaySync || {}), ebayAccountId: accountId, ebayItemId: ebayItem.itemId };
                    }
                    if (Object.keys(patch).length > 0) await data.updateItem(existingByEbayId.sku, patch);
                    results.skipped.push({ sku, reason: 'Already exists (matched by eBay ItemID)' });
                    continue;
                }

                const newItem = this.createLocalItemFromEbay(ebayItem, accountId);
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

                // Guard: if item already has ebayItemId pointing to a different account's listing,
                // don't create a duplicate on this account. Transfer feature will handle moves explicitly.
                if (fullItem.ebaySync?.ebayItemId) {
                    results.skipped.push({
                        sku: fullItem.sku,
                        reason: `Already listed on another eBay account (ID ${fullItem.ebaySync.ebayItemId}). Use Transfer to move it.`
                    });
                    continue;
                }

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
                        ...(fullItem.ebaySync || {}),
                        snapshot: this.captureLocalSnapshot(fullItem),
                        lastSyncTime: new Date(),
                        ebayAccountId: accountId,
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
        const accounts = await data.getAllAccounts();

        // Verify tokens are actually working for each account
        for (const account of accounts) {
            if (account.hasValidToken) {
                try {
                    await this.refreshAccessToken(account.id);
                } catch (err) {
                    account.hasValidToken = false;
                    account.tokenError = err.message;
                }
            }
        }

        return {
            configured: config.isEbayConfigured(),
            environment: config.ebay.environment,
            accounts
        };
    }
};

// ============================================
// API Routes
// ============================================

app.get('/api/inventory', async (req, res) => {
    try {
        let items = await data.getAllItems();
        // Filter out staged items (not yet approved via Updates tab)
        items = items.filter(item => !item.Staged);
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

// ============================================
// PENDING UPDATES ROUTES
// ============================================

app.get('/api/updates', async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        const [updates, allItems, count] = await Promise.all([
            data.getPendingUpdates(status),
            data.getAllItemsRaw(),
            data.countPendingUpdates()
        ]);
        // Build sku -> ebayAccountId map once, then enrich each update in O(1).
        const skuToAccount = new Map();
        for (const it of allItems) skuToAccount.set(it.sku, it.ebaySync?.ebayAccountId || null);
        const enriched = updates.map(u => {
            const obj = u.toObject ? u.toObject() : { ...u };
            // For SKU_CHANGE: try the new SKU first (post-rename), else the old SKU.
            let acc = null;
            if (obj.updateType === 'SKU_CHANGE') {
                const newSku = (obj.changes || []).find(c => /^sku$/i.test(c.field))?.newValue;
                acc = (newSku && skuToAccount.get(newSku)) || skuToAccount.get(obj.sku) || null;
            } else {
                acc = skuToAccount.get(obj.sku) || null;
            }
            obj.ebayAccountId = acc;
            return obj;
        });
        res.json({ updates: enriched, pendingCount: count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/updates/count', async (req, res) => {
    try {
        const count = await data.countPendingUpdates();
        res.json({ count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/updates/:id/dismiss', async (req, res) => {
    try {
        // Fetch update first to check type
        const allPending = await data.getPendingUpdates('pending');
        const pending = allPending.find(u => u._id.toString() === req.params.id);
        const update = await data.dismissPendingUpdate(req.params.id);
        if (!update) return res.status(404).json({ error: 'Update not found' });
        // If dismissing a CREATE, delete the orphaned staged item
        if (pending && pending.updateType === 'CREATE') {
            await data.deleteItem(pending.sku);
        }
        res.json({ message: 'Update dismissed', update });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/updates/dismiss-all', async (req, res) => {
    try {
        // Find all pending CREATE updates to clean up staged items
        const allPending = await data.getPendingUpdates('pending');
        const creates = allPending.filter(u => u.updateType === 'CREATE');
        for (const create of creates) {
            await data.deleteItem(create.sku);
        }
        await data.dismissAllPendingUpdates();
        res.json({ message: 'All updates dismissed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Apply a pending update (actually perform the staged change)
// Apply a pending update — eBay-first with drift check (Point 1)
// Invariant: if eBay fails, local does not change. Local ↔ eBay stay in lockstep.
app.post('/api/updates/:id/apply', ah(async (req, res) => {
    const accountId = req.body?.accountId || null;
    const force = req.body?.force === true; // bypass drift check
    if (!accountId) throw new HttpError(400, 'Please select an eBay account first');

    // Lock
    const existingLock = ebayLocks.get(accountId);
    if (existingLock && Date.now() - existingLock.startedAt < 5 * 60 * 1000) {
        throw new HttpError(409, `Sync already in progress: ${existingLock.operation} (${Math.round((Date.now() - existingLock.startedAt) / 1000)}s ago)`);
    }
    ebayLocks.set(accountId, { operation: 'apply', startedAt: Date.now() });

    try {
        const allPending = await data.getPendingUpdates('pending');
        const update = allPending.find(u => u._id.toString() === req.params.id);
        if (!update) throw new HttpError(404, 'Pending update not found');
        const { sku, updateType, changes } = update;

        // Account isolation guard: an update may only be pushed through the account
        // that owns the item. Prevents one account's change from ever hitting another's
        // listing, regardless of which account is selected in the UI.
        const guardItem = await data.getItem(sku);
        const ownerAccount = guardItem?.ebaySync?.ebayAccountId;
        if (ownerAccount && ownerAccount !== accountId) {
            throw new HttpError(409, `This change belongs to account ${ownerAccount}. Switch to that account to apply it.`);
        }

        // UPDATE: eBay-first flow with drift check
        if (updateType === 'UPDATE') {
            const item = await data.getItem(sku);
            if (!item) throw new HttpError(404, 'Item not found');
            const priceChange = changes.find(c => c.field === 'price');
            const qtyChange = changes.find(c => c.field === 'quantity');
            const descChange = changes.find(c => c.field === 'description');
            const hasEbayListing = !!item.ebaySync?.ebayItemId;

            // Read live eBay state once — it's the source of truth for what's currently listed.
            // If we CAN'T read it for an eBay-listed item, abort the apply (unless forced):
            // pushing off stale local data would defeat the delta model and risk lost stock.
            // The update stays queued so the user can retry once eBay is reachable.
            let liveEbay = null;
            if (hasEbayListing && (priceChange || qtyChange)) {
                try {
                    liveEbay = await ebayAPI.getCurrentListingState(accountId, item.ebaySync.ebayItemId);
                } catch (e) {
                    console.warn(`Could not read live eBay state for ${sku}:`, e.message);
                    if (!force) {
                        throw new HttpError(503, `Couldn't read current eBay state for ${sku} — try again in a moment. (Nothing was changed.)`);
                    }
                }
            }

            // Resolve the target AVAILABLE quantity (what we want sellable on eBay / in stock).
            //   - Movement (delta): target = liveAvailable + delta → composes with sales, never overwrites them.
            //   - Recount (absolute newValue): drift-checked set.
            let targetQty = null;          // target available
            let pushTotalQty = null;       // what to send to eBay <Quantity> = available + sold
            if (qtyChange) {
                const isDelta = qtyChange.delta !== undefined && qtyChange.delta !== null;
                const sold = liveEbay ? (liveEbay.quantitySold || 0) : 0;
                const baseAvail = (liveEbay && typeof liveEbay.quantity === 'number') ? liveEbay.quantity : item.currentQty;
                if (isDelta) {
                    targetQty = Math.max(0, baseAvail + qtyChange.delta);
                } else {
                    // Absolute recount — guard against an unseen live change.
                    if (liveEbay && !force && liveEbay.quantity !== (qtyChange.oldValue ?? 0)) {
                        throw new HttpError(409, 'eBay quantity changed since this recount was queued', {
                            sku, drifted: [{ field: 'quantity', expected: qtyChange.oldValue, actual: liveEbay.quantity }]
                        });
                    }
                    targetQty = Math.max(0, qtyChange.newValue);
                }
                // eBay <Quantity> is the total (available + already-sold).
                pushTotalQty = targetQty + sold;
            }

            // Price drift guard (price is always absolute).
            if (priceChange && liveEbay && !force && Math.abs(liveEbay.price - (priceChange.oldValue ?? 0)) > 0.01) {
                throw new HttpError(409, 'eBay price changed since this update was queued', {
                    sku, drifted: [{ field: 'price', expected: priceChange.oldValue, actual: liveEbay.price }]
                });
            }

            // Push to eBay first. On failure, nothing else happens (invariant preserved).
            if (hasEbayListing && (priceChange || qtyChange)) {
                const newPrice = priceChange ? priceChange.newValue : item.price;
                await ebayAPI.reviseItemPrice(accountId, item.ebaySync.ebayItemId, newPrice, pushTotalQty);
            }

            // Commit local + history + snapshot (only reached if eBay confirmed).
            const updates = {};
            if (qtyChange) {
                if (targetQty === null) targetQty = item.currentQty;
                updates.currentQty = targetQty;
                const diff = targetQty - item.currentQty;
                const isDelta = qtyChange.delta !== undefined && qtyChange.delta !== null;
                const note = isDelta
                    ? `Stock movement ${qtyChange.delta >= 0 ? '+' : ''}${qtyChange.delta} → ${targetQty}`
                    : `Quantity recounted to ${targetQty}`;
                await data.addHistory(sku, { date: new Date(), action: diff >= 0 ? 'ADJUST_UP' : 'ADJUST_DOWN', qty: diff, newTotal: targetQty, note });
            }
            if (priceChange) {
                updates.price = priceChange.newValue;
                const priceDiff = priceChange.newValue - item.price;
                await data.addHistory(sku, { date: new Date(), action: 'PRICE_CHANGE', qty: priceDiff, newTotal: priceChange.newValue, note: `Price changed to $${priceChange.newValue}` });
            }
            if (descChange) updates.description = descChange.newValue;

            if (hasEbayListing) {
                updates.ebaySync = {
                    ...(item.ebaySync || {}),
                    snapshot: {
                        quantity: updates.currentQty ?? item.currentQty,
                        price: updates.price ?? item.price,
                        title: updates.description ?? item.description,
                        description: updates.description ?? item.description,
                        condition: item.condition || '',
                        takenAt: new Date()
                    },
                    lastSyncTime: new Date(),
                    status: 'synced'
                };
            }
            await data.updateItem(sku, updates);
            await data.dismissPendingUpdate(req.params.id);
            if (!USE_LOCAL_DB) {
                await db.PendingUpdate.findByIdAndUpdate(req.params.id, { status: 'pushed' });
            } else {
                const localUpdate = (localInventory.pendingUpdates || []).find(u => u._id === req.params.id);
                if (localUpdate) { localUpdate.status = 'pushed'; saveLocalData(); }
            }
            return res.json({ message: hasEbayListing ? 'Update applied & synced to eBay' : 'Update applied locally', updateType, ebaySynced: hasEbayListing });
        }

        // RECONCILE — drift flagged by the daily check. Applying ACCEPTS eBay's value
        // locally (no push to eBay; eBay is treated as the source of truth for the count).
        // To instead keep the local count and push it, the user edits/recounts the item.
        if (updateType === 'RECONCILE') {
            const item = await data.getItem(sku);
            if (!item) throw new HttpError(404, 'Item not found');
            const qtyChange = changes.find(c => c.field === 'quantity');
            const ebayQty = qtyChange ? qtyChange.newValue : item.currentQty;
            const diff = ebayQty - item.currentQty;
            await data.updateItem(sku, {
                currentQty: ebayQty,
                ebaySync: {
                    ...(item.ebaySync || {}),
                    snapshot: { ...(item.ebaySync?.snapshot || {}), quantity: ebayQty, takenAt: new Date() },
                    lastSyncTime: new Date(),
                    status: 'synced'
                }
            });
            await data.addHistory(sku, {
                date: new Date(), action: diff >= 0 ? 'ADJUST_UP' : 'ADJUST_DOWN', qty: diff, newTotal: ebayQty,
                note: `Reconciled to eBay count (${ebayQty})`
            });
            await data.dismissPendingUpdate(req.params.id);
            if (!USE_LOCAL_DB) await db.PendingUpdate.findByIdAndUpdate(req.params.id, { status: 'pushed' });
            else { const lu = (localInventory.pendingUpdates || []).find(u => u._id === req.params.id); if (lu) { lu.status = 'pushed'; saveLocalData(); } }
            return res.json({ message: 'Reconciled to eBay count', updateType, ebaySynced: false });
        }

        // CREATE / DELETE / SKU_CHANGE — eBay-first ordering not applicable (no existing listing or local-only op)
        if (updateType === 'CREATE') {
            const item = await data.getItem(sku);
            if (!item) throw new HttpError(404, 'Staged item not found');
            await data.updateItem(sku, { staged: false });
        } else if (updateType === 'DELETE') {
            await data.deleteItem(sku);
        } else if (updateType === 'SKU_CHANGE') {
            const oldItem = await data.getItem(sku);
            if (!oldItem) throw new HttpError(404, 'Item not found');
            const skuChange = changes.find(c => c.field === 'sku');
            const descChange = changes.find(c => c.field === 'description');
            if (!skuChange) throw new HttpError(400, 'SKU change data missing');
            const newSku = skuChange.newValue;
            const newItemCode = newSku.substring(0, 6);
            const newDrawer = newSku.substring(6, 9);
            const newPosition = newSku.substring(9);

            // Push SKU rename to eBay FIRST if the item has a listing.
            // Invariant: if eBay fails, local doesn't change.
            if (oldItem.ebaySync?.ebayItemId) {
                const targetAccountId = oldItem.ebaySync?.ebayAccountId || accountId;
                await ebayAPI.reviseItemSku(targetAccountId, oldItem.ebaySync.ebayItemId, newSku);
            }

            // Atomic local rename — keeps history, snapshot, etc.
            await data.renameItem(sku, newSku, {
                itemCode: newItemCode,
                drawerNumber: newDrawer,
                positionNumber: newPosition,
                fullLocation: `${newDrawer}-${newPosition}`,
                description: descChange ? descChange.newValue : oldItem.description,
                staged: false
            });
            await data.addHistory(newSku, {
                date: new Date(), action: 'SKU_CHANGE', qty: 0, newTotal: oldItem.currentQty,
                note: `SKU changed from ${sku} to ${newSku}`
            });
        }

        await data.dismissPendingUpdate(req.params.id);
        if (!USE_LOCAL_DB) {
            await db.PendingUpdate.findByIdAndUpdate(req.params.id, { status: 'pushed' });
        } else {
            const localUpdate = (localInventory.pendingUpdates || []).find(u => u._id === req.params.id);
            if (localUpdate) { localUpdate.status = 'pushed'; saveLocalData(); }
        }
        res.json({ message: 'Update applied locally', updateType, ebaySynced: false });
    } finally {
        ebayLocks.delete(accountId);
    }
}));

// Undo a local update (revert to old values)
app.post('/api/updates/undo', async (req, res) => {
    try {
        const { sku, updateType, changes } = req.body;
        if (!sku || !changes) return res.status(400).json({ error: 'Missing undo data' });

        if (updateType === 'UPDATE') {
            const reverts = {};
            for (const change of changes) {
                if (change.field === 'quantity') reverts.currentQty = change.oldValue;
                else if (change.field === 'price') reverts.price = change.oldValue;
                else if (change.field === 'description') reverts.description = change.oldValue;
            }
            await data.updateItem(sku, reverts);
            await data.addHistory(sku, { date: new Date(), action: 'UNDO', qty: 0, newTotal: reverts.currentQty || 0, note: 'Reverted — eBay sync failed' });
        } else if (updateType === 'CREATE') {
            await data.updateItem(sku, { staged: true });
        } else if (updateType === 'DELETE') {
            // Item was already deleted, re-create would need full data — just notify
            return res.json({ message: 'Cannot undo delete — item data is gone' });
        }

        // Re-create the pending update so it shows back in the queue
        await data.createPendingUpdate({ sku, updateType, changes, status: 'pending' });

        res.json({ message: 'Change reverted successfully' });
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
        for (let i = 1; i <= 999999; i++) {
            const id = String(i).padStart(6, '0');
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
        for (let drawer = 0; drawer <= 999; drawer++) {
            for (let position = 1; position <= 9999; position++) {
                const drawerStr = String(drawer).padStart(3, '0');
                const positionStr = String(position).padStart(4, '0');
                const location = drawerStr + positionStr;
                if (!usedLocations.has(location)) {
                    return res.json({ nextLocation: location, drawer: drawerStr, position: positionStr });
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
        const { itemId, drawer, position, price = 0, quantity = 1, description = '', accountId = null } = req.body;
        if (!itemId || !drawer || position == null || position === '') return res.status(400).json({ error: 'Item ID, drawer, and position are required' });
        if (!/^\d{6}$/.test(itemId)) return res.status(400).json({ error: 'Item ID must be exactly 6 digits' });

        // Require a real account so the item is scoped — prevents items from leaking across accounts
        if (!accountId) return res.status(400).json({ error: 'accountId is required (pick an account in the header)' });
        const targetAccount = await data.getAccount(accountId);
        if (!targetAccount) return res.status(400).json({ error: `Unknown account: ${accountId}` });

        const drawerStr = String(drawer).padStart(3, '0');
        const positionStr = String(position).padStart(4, '0');
        const fullLocation = `${drawerStr}-${positionStr}`;
        const sku = `${itemId}${drawerStr}${positionStr}`;
        const qtyToAdd = parseInt(quantity);

        const existingByItemId = await data.getItemByCode(itemId);
        if (existingByItemId) {
            const ownerAccount = existingByItemId.ebaySync?.ebayAccountId;
            if (ownerAccount && ownerAccount !== accountId) {
                return res.status(400).json({ error: `Item ${itemId} already exists on another account (${ownerAccount}). Switch to that account or use a different Item ID.` });
            }
            // Receiving stock is a MOVEMENT (delta), not an absolute target. On apply it's
            // added relative to live eBay quantity, so a sale that happened meanwhile is
            // never overwritten: gained +5 while 2 sold => net +3, nothing lost.
            const pendingChanges = [{ field: 'quantity', delta: qtyToAdd, oldValue: existingByItemId.currentQty }];
            if (price > 0) pendingChanges.push({ field: 'price', oldValue: existingByItemId.price, newValue: parseFloat(price) });
            if (description) pendingChanges.push({ field: 'description', oldValue: existingByItemId.description, newValue: description });
            await data.createPendingUpdate({ sku: existingByItemId.sku, itemCode: existingByItemId.itemCode, description: description || existingByItemId.description, updateType: 'UPDATE', changes: pendingChanges });
            const barcode = await generateBarcode(existingByItemId.sku);
            return res.json({ message: `Change queued for existing item`, item: { SKU: existingByItemId.sku, ItemCode: existingByItemId.itemCode, DrawerNumber: existingByItemId.drawerNumber, PositionNumber: existingByItemId.positionNumber, FullLocation: existingByItemId.fullLocation, Price: existingByItemId.price || 0, Quantity: existingByItemId.currentQty, Description: existingByItemId.description }, barcode });
        }

        const existingByLocation = await data.getItemByLocation(fullLocation);
        if (existingByLocation) return res.status(400).json({ error: `Location ${fullLocation} already has item ${existingByLocation.itemCode}` });

        const now = new Date();
        const newItem = {
            sku, itemCode: itemId, drawerNumber: drawerStr, positionNumber: positionStr, fullLocation,
            price: parseFloat(price) || 0, currentQty: qtyToAdd, description,
            staged: true, dateAdded: now, lastModified: now,
            ebaySync: {
                snapshot: { quantity: qtyToAdd, price: parseFloat(price) || 0, title: description, description: '', condition: '', takenAt: now },
                status: 'not_synced',
                ebayAccountId: accountId
            },
            history: [{ date: now, action: 'CREATE', qty: qtyToAdd, newTotal: qtyToAdd, note: 'Item created' }]
        };
        await data.createItem(newItem);
        // Queue pending update
        await data.createPendingUpdate({ sku, itemCode: itemId, description, updateType: 'CREATE', changes: [
            { field: 'quantity', oldValue: null, newValue: qtyToAdd },
            { field: 'price', oldValue: null, newValue: parseFloat(price) || 0 },
            { field: 'description', oldValue: null, newValue: description },
            { field: 'location', oldValue: null, newValue: fullLocation }
        ]});
        const barcode = await generateBarcode(sku);
        res.json({ message: 'New item added', item: { SKU: sku, ItemCode: itemId, DrawerNumber: drawerStr, PositionNumber: positionStr, FullLocation: fullLocation, Price: newItem.price, Quantity: qtyToAdd, Description: description, DateAdded: now }, barcode });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/inventory/:sku', async (req, res) => {
    try {
        const { sku } = req.params;
        const { quantity, quantityDelta, price, description } = req.body;
        const item = await data.getItem(sku);
        if (!item) return res.status(404).json({ error: 'Item not found' });

        // Stage changes - do NOT apply to item yet.
        // quantityDelta = stock MOVEMENT (+received / -removed), composes with eBay sales.
        // quantity = absolute RECOUNT (set exact), drift-checked on apply.
        const pendingChanges = [];
        if (quantityDelta !== undefined && quantityDelta !== null && parseInt(quantityDelta) !== 0) {
            pendingChanges.push({ field: 'quantity', delta: parseInt(quantityDelta), oldValue: item.currentQty });
        } else if (quantity !== undefined) {
            pendingChanges.push({ field: 'quantity', oldValue: item.currentQty, newValue: parseInt(quantity) });
        }
        if (price !== undefined) pendingChanges.push({ field: 'price', oldValue: item.price, newValue: parseFloat(price) });
        if (description !== undefined) pendingChanges.push({ field: 'description', oldValue: item.description, newValue: description });
        if (pendingChanges.length > 0) {
            await data.createPendingUpdate({ sku, itemCode: item.itemCode, description: description !== undefined ? description : item.description, updateType: 'UPDATE', changes: pendingChanges });
        }
        // Return current (unchanged) item
        res.json({ message: 'Change queued', item: formatItem(item) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/inventory/:sku', async (req, res) => {
    try {
        const item = await data.getItem(req.params.sku);
        if (!item) return res.status(404).json({ error: 'Item not found' });
        // Stage delete - do NOT actually delete yet
        await data.createPendingUpdate({ sku: item.sku, itemCode: item.itemCode, description: item.description, updateType: 'DELETE', changes: [
            { field: 'quantity', oldValue: item.currentQty, newValue: null },
            { field: 'price', oldValue: item.price, newValue: null },
            { field: 'item', oldValue: item.sku, newValue: null }
        ]});
        res.json({ message: 'Delete queued', item: { SKU: item.sku, ItemCode: item.itemCode, FullLocation: item.fullLocation, Quantity: item.currentQty } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/lookup/:sku', async (req, res) => {
    try {
        const item = await data.getItem(req.params.sku);
        if (!item) return res.status(404).json({ error: 'Item not found' });
        const barcode = await generateBarcode(item.sku);
        res.json({ item: { SKU: item.sku, ItemCode: item.itemCode, DrawerNumber: item.drawerNumber, PositionNumber: item.positionNumber, FullLocation: item.fullLocation, Price: item.price || 0, Quantity: item.currentQty, Description: item.description, ImageUrl: item.imageUrl || null, DateAdded: item.dateAdded, LastModified: item.lastModified, ebaySync: item.ebaySync || null }, barcode });
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

        // Parse new SKU components (6 itemCode + 3 drawer + 4 position = 13 digits)
        const newItemCode = newSku.substring(0, 6);
        const newLocation = newSku.substring(6);
        const newDrawer = newLocation.substring(0, 3);
        const newPosition = newLocation.substring(3);
        const newFullLocation = `${newDrawer}-${newPosition}`;

        // Stage SKU change - do NOT perform it yet
        await data.createPendingUpdate({ sku: oldSku, itemCode: oldItem.itemCode, description: description !== undefined ? description : oldItem.description, updateType: 'SKU_CHANGE', changes: [
            { field: 'sku', oldValue: oldSku, newValue: newSku },
            { field: 'location', oldValue: oldItem.fullLocation, newValue: newFullLocation },
            { field: 'description', oldValue: oldItem.description, newValue: description !== undefined ? description : oldItem.description }
        ]});

        // Generate barcode for current (unchanged) SKU
        const barcode = await generateBarcode(oldSku);

        res.json({
            message: 'SKU change queued',
            oldSku,
            newSku,
            item: formatItem(oldItem),
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

// Toggle cron auto-sync for a single account
app.put('/api/ebay/accounts/:accountId/cron', ah(async (req, res) => {
    const { accountId } = req.params;
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'Field "enabled" must be a boolean');

    if (!USE_LOCAL_DB) {
        const acct = await db.ebayAccounts.get(accountId);
        if (!acct) throw new HttpError(404, 'Account not found');
        await db.ebayAccounts.save(accountId, { cronEnabled: enabled });
    } else {
        if (!localAccounts[accountId]) throw new HttpError(404, 'Account not found');
        localAccounts[accountId].cronEnabled = enabled;
        saveLocalData();
    }
    res.json({ message: `Auto-sync ${enabled ? 'enabled' : 'disabled'}`, accountId, cronEnabled: enabled });
}));
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

// Pull from eBay to local inventory
app.post('/api/ebay/pull/:accountId', ah(async (req, res) => {
    const accountId = req.params.accountId;
    if (!(await ebayAPI.isAccountAuthenticated(accountId))) throw new HttpError(401, 'eBay account not connected');
    const results = await withEbayLock(accountId, 'pull', () => ebayAPI.pullFromEbay(accountId));
    res.json({
        message: `Pulled from eBay: ${results.created.length} imported, ${results.updated.length} updated, ${results.skipped.length} skipped`,
        summary: { created: results.created.length, updated: results.updated.length, skipped: results.skipped.length, errors: results.errors.length },
        details: results
    });
}));

// Smart two-way sync
app.post('/api/ebay/sync-all/:accountId', ah(async (req, res) => {
    const accountId = req.params.accountId;
    if (!(await ebayAPI.isAccountAuthenticated(accountId))) throw new HttpError(401, 'eBay account not connected');
    const results = await withEbayLock(accountId, 'sync', () => ebayAPI.smartSyncAll(accountId));

    const parts = [];
    if (results.imported.length > 0) parts.push(`${results.imported.length} imported from eBay`);
    if (results.exported.length > 0) parts.push(`${results.exported.length} exported to eBay`);
    if (results.updated.length > 0) parts.push(`${results.updated.length} updated`);
    if (results.sales.length > 0) parts.push(`${results.sales.reduce((sum, s) => sum + s.sold, 0)} eBay sales detected`);
    if (results.errors.length > 0) parts.push(`${results.errors.length} errors`);
    res.json({
        message: `Sync complete: ${parts.length > 0 ? parts.join(', ') : 'No changes'}`,
        summary: { imported: results.imported.length, exported: results.exported.length, updated: results.updated.length, sales: results.sales.length, errors: results.errors.length },
        details: results
    });
}));

// Cron endpoint — runs smartSyncAll on every account with a valid token.
// Called by external cron service (cron-job.org) on a schedule.
// Requires Authorization: Bearer <CRON_SECRET> header to prevent abuse.
app.post('/api/cron/sync-all-accounts', ah(async (req, res) => {
    const expected = process.env.CRON_SECRET;
    if (!expected) throw new HttpError(500, 'CRON_SECRET env var not configured');
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (provided !== expected) throw new HttpError(401, 'Unauthorized');

    const accounts = await data.getAllAccounts();
    const results = [];
    for (const account of accounts) {
        // Per-account cron toggle (default enabled when field absent)
        if (account.cronEnabled === false) {
            results.push({ accountId: account.id, account: account.name, status: 'skipped', reason: 'cron disabled by admin' });
            continue;
        }
        // Refresh the access token FIRST every run. eBay access tokens expire ~2h, so a
        // 15-min cron keeps the session alive on its own — independent of whether the pull
        // succeeds. If the refresh token is hard-expired, surface needs_reconnect clearly.
        try {
            await ebayAPI.refreshAccessToken(account.id);
        } catch (err) {
            results.push({ accountId: account.id, account: account.name, status: 'needs_reconnect', error: err.message });
            continue;
        }
        try {
            // Cron is PULL-ONLY: detect eBay-side changes (sales, edits) and update local.
            // Never pushes to eBay — that's reserved for explicit user actions (Apply / Push / Publish).
            const pullResult = await withEbayLock(account.id, 'cron-pull', () => ebayAPI.pullFromEbay(account.id));
            // Count sales by scanning history entries (pullFromEbay logs EBAY_SALE inline; not in result shape)
            const salesDetected = (pullResult.updated || []).filter(u => Array.isArray(u.fields) && u.fields.includes('quantity')).length;
            results.push({
                accountId: account.id,
                account: account.name,
                status: 'synced',
                imported: (pullResult.created || []).length,
                updated: (pullResult.updated || []).length,
                salesDetected,
                skipped: (pullResult.skipped || []).length,
                errors: (pullResult.errors || []).length,
                errorSamples: (pullResult.errors || []).slice(0, 3).map(e => ({ sku: e.sku, error: (e.error || '').slice(0, 200) }))
            });
        } catch (err) {
            // 409 (manual sync in progress) is expected and not an error
            if (err.status === 409) {
                results.push({ accountId: account.id, account: account.name, status: 'skipped', reason: 'manual sync in progress' });
            } else {
                console.error(`Cron sync failed for ${account.name}:`, err.message);
                results.push({ accountId: account.id, account: account.name, status: 'error', error: err.message });
            }
        }
    }
    console.log('[cron] sync-all-accounts:', JSON.stringify(results));
    res.json({ ranAt: new Date().toISOString(), results });
}));

// Upload image to eBay and return hosted URL
app.post('/api/ebay/upload-image/:accountId', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image file provided' });
        const result = await ebayAPI.uploadImage(req.params.accountId, req.file.buffer, req.file.originalname);
        res.json({ imageUrl: result.imageUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Save image URL to an item
app.put('/api/inventory/:sku/image', async (req, res) => {
    try {
        const { imageUrl } = req.body;
        if (!imageUrl) return res.status(400).json({ error: 'Missing imageUrl' });
        await data.updateItem(req.params.sku, { imageUrl });
        res.json({ message: 'Image updated', imageUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Backfill images from eBay for all items
app.post('/api/ebay/backfill-images/:accountId', async (req, res) => {
    try {
        const ebayData = await ebayAPI.getActiveListings(req.params.accountId);
        if (ebayData.error) throw new Error(ebayData.error);

        let updated = 0;
        for (const ebayItem of (ebayData.items || [])) {
            if (!ebayItem.pictureUrl) continue;
            const sku = ebayItem.sku || ebayItem.itemId;
            const localItem = await data.getItem(sku);
            if (localItem && !localItem.imageUrl) {
                await data.updateItem(sku, { imageUrl: ebayItem.pictureUrl });
                updated++;
            }
        }
        res.json({ message: `Updated ${updated} item images`, updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Compare and queue differences as pending updates
app.post('/api/ebay/compare-and-queue/:accountId', ah(async (req, res) => {
  const accountId = req.params.accountId;
  if (!(await ebayAPI.isAccountAuthenticated(accountId))) throw new HttpError(401, 'eBay account not connected');
  const result = await withEbayLock(accountId, 'compare', async () => {
        const skipSkus = req.body.skipSkus || []; // SKUs user chose to skip (conflicts)
        const forceSkus = req.body.forceSkus || []; // SKUs user chose to overwrite

        // Get all local items (raw schema — diff logic reads lowercase fields)
        const localItems = await data.getAllItemsRaw();
        const localMap = new Map();
        localItems.forEach(item => localMap.set(item.sku, item));

        // Get eBay listings
        const ebayData = await ebayAPI.getActiveListings(req.params.accountId);
        if (ebayData.error) throw new Error(ebayData.error);

        const ebayMap = new Map();
        (ebayData.items || []).forEach(item => {
            const sku = item.sku || item.itemId;
            ebayMap.set(sku, item);
        });

        // Get existing pending updates to detect conflicts
        const pendingUpdates = await data.getPendingUpdates('pending');
        const pendingSkus = new Set(pendingUpdates.map(u => u.sku));

        let queued = 0;
        const conflicts = [];
        const skipped = 0;

        // Items in both but with differences — queue UPDATE
        for (const [sku, localItem] of localMap) {
            const ebayItem = ebayMap.get(sku);
            if (!ebayItem) continue;

            const localPrice = parseFloat(localItem.price) || 0;
            const ebayPrice = parseFloat(ebayItem.price) || 0;
            const localQty = parseInt(localItem.currentQty) || 0;
            const ebayQty = parseInt(ebayItem.quantity) || 0;

            const changes = [];
            if (Math.abs(localPrice - ebayPrice) > 0.01) {
                changes.push({ field: 'price', oldValue: localPrice, newValue: ebayPrice });
            }
            if (localQty !== ebayQty) {
                changes.push({ field: 'quantity', oldValue: localQty, newValue: ebayQty });
            }

            // Update image URL if eBay has one and local doesn't
            if (ebayItem.pictureUrl && !localItem.imageUrl) {
                await data.updateItem(sku, { imageUrl: ebayItem.pictureUrl });
            }

            if (changes.length === 0) continue;

            // Check for conflict with existing pending updates
            if (pendingSkus.has(sku) && !forceSkus.includes(sku)) {
                if (skipSkus.includes(sku)) continue; // User said skip
                // First pass — report conflict back to frontend
                const existingPending = pendingUpdates.filter(u => u.sku === sku);
                conflicts.push({
                    sku,
                    description: localItem.description || localItem.itemCode,
                    pendingChanges: existingPending.map(u => u.changes).flat(),
                    ebayChanges: changes
                });
                continue;
            }

            await data.createPendingUpdate({
                sku,
                itemCode: localItem.itemCode,
                description: localItem.description,
                updateType: 'UPDATE',
                changes
            });
            queued++;
        }

        // Items on eBay but not local — queue CREATE
        for (const [sku, ebayItem] of ebayMap) {
            if (localMap.has(sku)) continue;
            if (skipSkus.includes(sku)) continue;

            const ebayPrice = parseFloat(ebayItem.price) || 0;
            const ebayQty = parseInt(ebayItem.quantity) || 0;

            const itemCode = sku.substring(0, 4);
            const location = sku.substring(4);
            const drawer = location.substring(0, 3);
            const position = location.substring(3);
            const fullLocation = `${drawer}-${position}`;

            try {
                await data.createItem({
                    sku,
                    itemCode,
                    drawerNumber: drawer,
                    positionNumber: position,
                    fullLocation,
                    price: ebayPrice,
                    currentQty: ebayQty,
                    description: ebayItem.title || '',
                    imageUrl: ebayItem.pictureUrl || null,
                    staged: true,
                    ebaySync: {
                        ebayItemId: ebayItem.itemId,
                        snapshot: ebayAPI.captureEbaySnapshot(ebayItem),
                        lastSyncTime: new Date(),
                        status: 'synced'
                    }
                });

                await data.createPendingUpdate({
                    sku,
                    itemCode,
                    description: ebayItem.title || '',
                    updateType: 'CREATE',
                    changes: [
                        { field: 'quantity', oldValue: null, newValue: ebayQty },
                        { field: 'price', oldValue: null, newValue: ebayPrice },
                        { field: 'description', oldValue: null, newValue: ebayItem.title || '' },
                        { field: 'location', oldValue: null, newValue: fullLocation }
                    ]
                });
                queued++;
            } catch (createErr) {
                console.warn(`Skipping eBay-only item ${sku}:`, createErr.message);
            }
        }

        return {
            message: conflicts.length > 0
                ? `${queued} queued, ${conflicts.length} conflicts need your decision`
                : `Comparison complete: ${queued} differences queued in Updates`,
            queued,
            conflicts,
            summary: { totalLocal: localItems.length, totalEbay: ebayData.items?.length || 0 }
        };
  });
  res.json(result);
}));

// Resolve a difference - update local or push to eBay
app.post('/api/ebay/resolve/:accountId', async (req, res) => {
    try {
        if (!(await ebayAPI.isAccountAuthenticated(req.params.accountId))) {
            return res.status(401).json({ error: 'eBay account not connected' });
        }

        const { sku, action, field } = req.body;
        // action: 'use_local' or 'use_ebay'
        // field: 'price', 'quantity', or 'both'

        if (!sku || !action) {
            return res.status(400).json({ error: 'SKU and action required' });
        }

        const localItem = await data.getItem(sku);
        const ebayData = await ebayAPI.getActiveListings(req.params.accountId);
        const ebayItem = ebayData.items?.find(i => (i.sku || i.itemId) === sku);

        if (action === 'use_local') {
            // Push local values to eBay
            if (!localItem) {
                return res.status(404).json({ error: 'Local item not found' });
            }
            if (!ebayItem) {
                return res.status(404).json({ error: 'eBay item not found - cannot update' });
            }

            // Use ReviseInventoryStatus to update price/quantity on eBay
            const result = await ebayAPI.reviseInventoryStatus(req.params.accountId, ebayItem.itemId, {
                price: field === 'quantity' ? null : localItem.price,
                quantity: field === 'price' ? null : localItem.currentQty
            });

            res.json({ message: 'Updated eBay to match local', result });

        } else if (action === 'use_ebay') {
            // Update local with eBay values
            if (!ebayItem) {
                return res.status(404).json({ error: 'eBay item not found' });
            }

            const updates = {};
            if (field === 'price' || field === 'both') {
                updates.price = parseFloat(ebayItem.price) || 0;
            }
            if (field === 'quantity' || field === 'both') {
                updates.currentQty = parseInt(ebayItem.quantity) || 0;
            }

            if (localItem) {
                await data.updateItem(sku, updates);
                res.json({ message: 'Updated local to match eBay', updates });
            } else {
                // Create new local item from eBay
                const newItem = {
                    sku: sku,
                    itemCode: sku,
                    description: ebayItem.title,
                    price: parseFloat(ebayItem.price) || 0,
                    currentQty: parseInt(ebayItem.quantity) || 0,
                    ebaySync: {
                        ebayItemId: ebayItem.itemId,
                        lastSynced: new Date().toISOString()
                    }
                };
                await data.createItem(newItem);
                res.json({ message: 'Created local item from eBay', item: newItem });
            }

        } else {
            res.status(400).json({ error: 'Invalid action. Use "use_local" or "use_ebay"' });
        }

    } catch (err) {
        console.error('Resolve error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Bulk resolve - apply action to multiple items
app.post('/api/ebay/resolve-bulk/:accountId', async (req, res) => {
    try {
        if (!(await ebayAPI.isAccountAuthenticated(req.params.accountId))) {
            return res.status(401).json({ error: 'eBay account not connected' });
        }

        const { items, action } = req.body;
        // items: array of { sku, field }
        // action: 'use_local' or 'use_ebay'

        if (!items || !Array.isArray(items) || !action) {
            return res.status(400).json({ error: 'Items array and action required' });
        }

        const results = { success: [], failed: [] };

        for (const item of items) {
            try {
                const localItem = await data.getItem(item.sku);
                const ebayData = await ebayAPI.getActiveListings(req.params.accountId);
                const ebayItem = ebayData.items?.find(i => (i.sku || i.itemId) === item.sku);

                if (action === 'use_local' && localItem && ebayItem) {
                    await ebayAPI.reviseInventoryStatus(req.params.accountId, ebayItem.itemId, {
                        price: localItem.price,
                        quantity: localItem.currentQty
                    });
                    results.success.push(item.sku);
                } else if (action === 'use_ebay' && ebayItem) {
                    const updates = {
                        price: parseFloat(ebayItem.price) || 0,
                        currentQty: parseInt(ebayItem.quantity) || 0
                    };
                    if (localItem) {
                        await data.updateItem(item.sku, updates);
                    }
                    results.success.push(item.sku);
                } else {
                    results.failed.push({ sku: item.sku, error: 'Item not found' });
                }
            } catch (err) {
                results.failed.push({ sku: item.sku, error: err.message });
            }
        }

        res.json({
            message: `Resolved ${results.success.length} items, ${results.failed.length} failed`,
            results
        });

    } catch (err) {
        console.error('Bulk resolve error:', err);
        res.status(500).json({ error: err.message });
    }
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
        if (item.ebaySync?.ebayItemId) return res.status(400).json({ error: 'Item already has an eBay listing' });

        // Create listing via Trading API (works for all items)
        const result = await ebayAPI.addFixedPriceItem(req.params.accountId, {
            SKU: item.sku, Price: item.price || 9.99, Quantity: item.currentQty,
            Description: item.description, Condition: item.condition || 'NEW',
            CategoryId: item.categoryId, ImageUrl: item.imageUrl || null, ItemSpecifics: item.itemSpecifics || {}
        });

        // Save eBay item ID — preserve existing ebaySync fields
        await data.updateItem(item.sku, {
            ebaySync: {
                ...(item.ebaySync || {}),
                ebayItemId: result.itemId || null,
                ebayAccountId: req.params.accountId,
                snapshot: ebayAPI.captureLocalSnapshot(item),
                lastSyncTime: new Date(),
                status: 'synced'
            }
        });

        await data.addHistory(req.params.sku, { date: new Date(), action: 'EBAY_PUBLISH', qty: 0, newTotal: item.currentQty, note: `Published to eBay (Listing: ${result.itemId})` });
        res.json({ message: 'Item published to eBay', result });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Publish all items as listings
app.post('/api/ebay/publish-all/:accountId', ah(async (req, res) => {
    const accountId = req.params.accountId;
    if (!(await ebayAPI.isAccountAuthenticated(accountId))) throw new HttpError(401, 'eBay account not connected');

    const results = await withEbayLock(accountId, 'publish-all', async () => {
        const out = { published: [], skipped: [], failed: [] };
        const items = await data.getAllItems();
        for (const item of items) {
            try {
                const fullItem = await data.getItem(item.SKU);
                if (!fullItem || !fullItem.description) {
                    out.failed.push({ sku: item.SKU, error: 'Missing description' });
                    continue;
                }
                if (fullItem.ebaySync?.ebayItemId) {
                    out.skipped.push({ sku: fullItem.sku, reason: 'Already on eBay' });
                    continue;
                }
                // Account isolation: only publish items tagged to this account (or untagged ones)
                const ownerAccount = fullItem.ebaySync?.ebayAccountId;
                if (ownerAccount && ownerAccount !== accountId) {
                    out.skipped.push({ sku: fullItem.sku, reason: `Belongs to another account (${ownerAccount})` });
                    continue;
                }
                const result = await ebayAPI.addFixedPriceItem(accountId, {
                    SKU: fullItem.sku, Price: fullItem.price || 9.99, Quantity: fullItem.currentQty,
                    Description: fullItem.description, Condition: fullItem.condition || 'NEW',
                    CategoryId: fullItem.categoryId, ImageUrl: fullItem.imageUrl || null, ItemSpecifics: fullItem.itemSpecifics || {}
                });
                await data.updateItem(fullItem.sku, {
                    ebaySync: {
                        ...(fullItem.ebaySync || {}),
                        ebayItemId: result.itemId || null,
                        ebayAccountId: accountId,
                        snapshot: ebayAPI.captureLocalSnapshot(fullItem),
                        lastSyncTime: new Date(),
                        status: 'synced'
                    }
                });
                out.published.push({ sku: fullItem.sku, listingId: result.itemId });
            } catch (err) {
                out.failed.push({ sku: item.SKU, error: err.message });
            }
        }
        return out;
    });

    res.json({
        message: `Published ${results.published.length} listings, ${results.failed.length} failed`,
        results
    });
}));

// Main app
app.get('/app', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'app.html')); });

// Admin routes
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/debug', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'debug.html')); });

// Read-only debug snapshot — admin-password gated, no mutations
app.post('/api/admin/debug', ah(async (req, res) => {
    if (req.body.password !== config.adminPassword) throw new HttpError(401, 'Invalid password');

    const accounts = await data.getAllAccounts();
    const allItems = await data.getAllItemsRaw();
    const allPending = await data.getPendingUpdates('pending');

    // Per-account breakdown
    const accountStats = [];
    for (const acc of accounts) {
        let ebayCount = null;
        let ebayErr = null;
        let ebayUserId = null;
        let ebayStoreName = null;
        if (acc.hasValidToken) {
            try {
                const ebayData = await ebayAPI.getActiveListings(acc.id);
                ebayCount = ebayData.totalEntries ?? ebayData.items?.length ?? 0;
            } catch (err) { ebayErr = err.message; }
            // Fetch the real eBay seller identity so we don't have to guess from the local-typed name
            try {
                const userInfo = await ebayAPI.getUserInfo(acc.id);
                ebayUserId = userInfo?.user?.userId || null;
                ebayStoreName = userInfo?.user?.storeName || null;
            } catch (err) { /* non-fatal — keep going */ }
        }
        const localItemsForAcc = allItems.filter(i => i.ebaySync?.ebayAccountId === acc.id);
        accountStats.push({
            id: acc.id,
            name: acc.name,
            ebayUserId,
            ebayStoreName,
            hasValidToken: acc.hasValidToken,
            cronEnabled: acc.cronEnabled !== false,
            lastSync: acc.lastSync,
            ebayListingsCount: ebayCount,
            ebayFetchError: ebayErr,
            localItemsTagged: localItemsForAcc.length
        });
    }

    // Global stats
    const itemsByStatus = {
        synced: allItems.filter(i => i.ebaySync?.ebayItemId).length,
        notSynced: allItems.filter(i => !i.ebaySync?.ebayItemId).length,
        staged: allItems.filter(i => i.staged).length,
        withImage: allItems.filter(i => i.imageUrl).length,
        withoutImage: allItems.filter(i => !i.imageUrl).length,
        defaultLocation: allItems.filter(i => i.fullLocation === '000-00').length,
        // Items synced to eBay but missing the account tag — these are invisible
        // when filtering Inventory by a specific account. Run /api/admin/backfill-account-ids to fix.
        untaggedButSynced: allItems.filter(i => i.ebaySync?.ebayItemId && !i.ebaySync?.ebayAccountId).length
    };

    // Pending update breakdown
    const pendingByType = {};
    for (const u of allPending) {
        pendingByType[u.updateType] = (pendingByType[u.updateType] || 0) + 1;
    }

    res.json({
        snapshotAt: new Date().toISOString(),
        accounts: accountStats,
        items: { total: allItems.length, ...itemsByStatus },
        pendingUpdates: { total: allPending.length, byType: pendingByType },
        env: {
            mode: USE_LOCAL_DB ? 'local' : 'mongodb',
            ebayEnvironment: config.ebay.environment,
            cronSecretConfigured: !!process.env.CRON_SECRET
        }
    });
}));

// One-shot backfill: walks each connected account's active eBay listings and tags any
// matching local item whose ebaySync.ebayAccountId is missing. Safe to re-run.
// Never overwrites an existing tag — earlier-pulled items win, which is the right call
// (an item already belonging to account A shouldn't be reassigned to B just because B
// happens to also list the same SKU).
app.post('/api/admin/backfill-account-ids', ah(async (req, res) => {
    if (req.body.password !== config.adminPassword) throw new HttpError(401, 'Invalid password');

    const accounts = await data.getAllAccounts();
    const perAccount = [];
    let totalTagged = 0;

    for (const acc of accounts) {
        const row = { id: acc.id, name: acc.name, tagged: 0, alreadyTagged: 0, notFoundLocally: 0, error: null };
        if (!acc.hasValidToken) { row.error = 'Token expired'; perAccount.push(row); continue; }
        try {
            const ebayData = await ebayAPI.getActiveListings(acc.id);
            for (const ebayItem of (ebayData.items || [])) {
                const sku = ebayItem.sku || ebayItem.itemId;
                if (!sku) continue;
                const localItem = await data.getItem(sku);
                if (!localItem) { row.notFoundLocally++; continue; }
                if (localItem.ebaySync?.ebayAccountId) { row.alreadyTagged++; continue; }
                await data.updateItem(sku, {
                    ebaySync: {
                        ...(localItem.ebaySync || {}),
                        ebayAccountId: acc.id,
                        ebayItemId: localItem.ebaySync?.ebayItemId || ebayItem.itemId || null
                    }
                });
                row.tagged++;
                totalTagged++;
            }
        } catch (err) {
            row.error = err.message;
        }
        perAccount.push(row);
    }

    res.json({ totalTagged, perAccount });
}));

// ============================================
// SKU CONVERTER — one-shot tool to normalize all SKUs to the standard 13-digit format
// ============================================
// Standard format: <6-digit itemCode><3-digit drawer><4-digit position>. Default drawer is 000.
//
// Classification is multi-pass so "more legit" SKUs reserve their warehouse location
// (drawer 000 + position) BEFORE weaker guesses try to claim one:
//   1. skip            — already 13 numeric digits, or staged (CREATE pending)
//   2. convert_divider — all-numeric with a usable "000": rightmost split into
//                        itemCode (1-6 digits) + position (1-4 digits), drawer=000.
//   3. convert_tail    — no usable "000" but the last 4 chars are digits: keep them as the
//                        position (preserve physical location), fresh itemCode, drawer=000 —
//                        ONLY if that location isn't already taken by a skip/divider SKU.
//   4. generate_fresh  — everything else (or a tail whose location collides): smallest unused
//                        itemCode + smallest unused position in drawer 000.
//
// On Apply, a converted item with an eBay listing is pushed via ReviseFixedPriceItem first;
// local only renames on eBay success (invariant preserved).

// Rightmost valid "000" split. Returns { before, after } or null.
function splitDivider(sku) {
    if (!/^\d+$/.test(sku)) return null;
    for (let idx = sku.length - 3; idx >= 1; idx--) {
        if (sku.substr(idx, 3) !== '000') continue;
        const before = sku.substring(0, idx);
        const after = sku.substring(idx + 3);
        if (before.length < 1 || before.length > 6) continue;
        if (after.length < 1 || after.length > 4) continue;
        return { before, after };
    }
    return null;
}

function buildConvertPlan(allItems) {
    const usedItemCodes = new Set();
    const reservedPos000 = new Set(); // positions in drawer 000 held by skip/divider SKUs

    // Reserve from already-standard SKUs.
    for (const item of allItems) {
        if (/^\d{13}$/.test(item.sku)) {
            usedItemCodes.add(item.sku.substring(0, 6));
            if (item.sku.substring(6, 9) === '000') reservedPos000.add(item.sku.substring(9));
        }
    }

    const plannedSkus = new Set();
    const prelim = [];

    // Pass 1 — skips and dividers (these reserve codes + drawer-000 positions).
    for (const item of allItems) {
        const sku = item.sku;
        if (/^\d{13}$/.test(sku)) { prelim.push({ item, action: 'skip', reason: 'already standard format' }); continue; }
        if (item.staged) { prelim.push({ item, action: 'skip', reason: 'staged (CREATE pending)' }); continue; }

        const div = splitDivider(sku);
        if (div) {
            const newItemCode = div.before.padStart(6, '0');
            const newPosition = div.after.padStart(4, '0');
            const newSku = newItemCode + '000' + newPosition;
            if (!plannedSkus.has(newSku)) {
                plannedSkus.add(newSku);
                usedItemCodes.add(newItemCode);
                reservedPos000.add(newPosition);
                prelim.push({ item, action: 'convert_divider', newSku, newItemCode, newDrawer: '000', newPosition });
                continue;
            }
            // newSku collision — treat as tail/fresh below
        }

        // Tail candidate: last 4 chars are digits → preserve as position (location).
        const tail = sku.slice(-4);
        if (/^\d{4}$/.test(tail)) prelim.push({ item, action: '__tail__', candidatePos: tail });
        else prelim.push({ item, action: '__fresh__' });
    }

    // Pass 2 — assign tails (preserve location if free), then fresh.
    const takenPos000 = new Set(reservedPos000);
    let nextCode = 0, nextPos = 0;
    const assignCode = () => {
        do { nextCode++; if (nextCode > 999999) throw new Error('Ran out of 6-digit item codes'); }
        while (usedItemCodes.has(String(nextCode).padStart(6, '0')));
        const c = String(nextCode).padStart(6, '0'); usedItemCodes.add(c); return c;
    };
    const assignFreePos = () => {
        do { nextPos++; if (nextPos > 9999) throw new Error('Ran out of positions in drawer 000'); }
        while (takenPos000.has(String(nextPos).padStart(4, '0')));
        const p = String(nextPos).padStart(4, '0'); takenPos000.add(p); return p;
    };

    const wrap = (item, r) => ({
        sku: item.sku,
        description: item.description || '',
        hasEbayListing: !!item.ebaySync?.ebayItemId,
        ebayItemId: item.ebaySync?.ebayItemId || null,
        ebayAccountId: item.ebaySync?.ebayAccountId || null,
        ...r
    });

    const plan = [];
    for (const pre of prelim) {
        if (pre.action === 'skip' || pre.action === 'convert_divider') { plan.push(wrap(pre.item, pre)); continue; }

        if (pre.action === '__tail__' && !takenPos000.has(pre.candidatePos)) {
            takenPos000.add(pre.candidatePos);
            const code = assignCode();
            const newSku = code + '000' + pre.candidatePos;
            plannedSkus.add(newSku);
            plan.push(wrap(pre.item, { action: 'convert_tail', newSku, newItemCode: code, newDrawer: '000', newPosition: pre.candidatePos }));
            continue;
        }

        // Fresh (or a tail whose location was already taken).
        const code = assignCode();
        const pos = assignFreePos();
        const newSku = code + '000' + pos;
        plannedSkus.add(newSku);
        plan.push(wrap(pre.item, { action: 'generate_fresh', newSku, newItemCode: code, newDrawer: '000', newPosition: pos }));
    }
    return plan;
}

app.post('/api/admin/convert/preview', ah(async (req, res) => {
    if (req.body.password !== config.adminPassword) throw new HttpError(401, 'Invalid password');
    const accountId = req.body.accountId || null; // 'all' or undefined = all; 'none' = items with no account; specific id = filter
    const allItemsRaw = await data.getAllItemsRaw();

    // Build account-list metadata first (counts per account, regardless of selected filter)
    const allAccounts = await data.getAllAccounts();
    const countsByAcc = new Map();
    let noneCount = 0;
    for (const it of allItemsRaw) {
        const aid = it.ebaySync?.ebayAccountId;
        if (!aid) noneCount++;
        else countsByAcc.set(aid, (countsByAcc.get(aid) || 0) + 1);
    }
    const accountsForUi = allAccounts.map(a => ({
        id: a.id, name: a.name, itemCount: countsByAcc.get(a.id) || 0
    }));
    // Append synthetic 'none' bucket if there are untagged items
    if (noneCount > 0) accountsForUi.push({ id: 'none', name: 'Not assigned to any account', itemCount: noneCount });

    // Account isolation: only build a plan when a specific account is chosen.
    // No account / 'all' → empty plan (the accounts list is still returned so the
    // dropdown can populate). This keeps SKU conversion strictly per-account.
    let plan = [];
    if (accountId && accountId !== 'all') {
        const items = accountId === 'none'
            ? allItemsRaw.filter(i => !i.ebaySync?.ebayAccountId)
            : allItemsRaw.filter(i => i.ebaySync?.ebayAccountId === accountId);
        plan = buildConvertPlan(items);
    }
    const summary = {
        total: plan.length,
        skip: plan.filter(p => p.action === 'skip').length,
        convertDivider: plan.filter(p => p.action === 'convert_divider').length,
        convertTail: plan.filter(p => p.action === 'convert_tail').length,
        generateFresh: plan.filter(p => p.action === 'generate_fresh').length,
        withEbayListing: plan.filter(p => p.hasEbayListing && p.action !== 'skip').length
    };
    res.json({ summary, plan, accounts: accountsForUi, totalItemsAllAccounts: allItemsRaw.length });
}));

// Convert execute: queue SKU_CHANGE pending updates — does NOT touch eBay directly.
// The user reviews them in the Updates tab and applies one-by-one (or Apply Filtered).
// Apply on SKU_CHANGE pushes the rename to eBay first; local stays unchanged on failure.
// Optional body.categories filters which action types to queue (e.g. ["convert_divider"] only).
app.post('/api/admin/convert/execute', ah(async (req, res) => {
    if (req.body.password !== config.adminPassword) throw new HttpError(401, 'Invalid password');
    const allowedCategories = Array.isArray(req.body.categories) && req.body.categories.length > 0
        ? new Set(req.body.categories)
        : null; // null = all non-skip categories
    const accountId = req.body.accountId || null;
    // Account isolation: refuse to convert across all accounts at once.
    if (!accountId || accountId === 'all') throw new HttpError(400, 'Select a specific account before converting SKUs');
    let items = await data.getAllItemsRaw();
    if (accountId === 'none') items = items.filter(i => !i.ebaySync?.ebayAccountId);
    else items = items.filter(i => i.ebaySync?.ebayAccountId === accountId);
    const plan = buildConvertPlan(items);

    const pending = await data.getPendingUpdates('pending');
    const alreadyQueued = new Set(
        pending.filter(u => u.updateType === 'SKU_CHANGE').map(u => u.sku)
    );

    const results = { queued: [], skipped: [], failed: [] };
    for (const step of plan) {
        if (step.action === 'skip') {
            results.skipped.push({ sku: step.sku, reason: step.reason });
            continue;
        }
        if (allowedCategories && !allowedCategories.has(step.action)) {
            results.skipped.push({ sku: step.sku, reason: `not in requested categories (${step.action})` });
            continue;
        }
        if (alreadyQueued.has(step.sku)) {
            results.skipped.push({ sku: step.sku, reason: 'SKU_CHANGE already pending' });
            continue;
        }
        try {
            await data.createPendingUpdate({
                sku: step.sku,
                itemCode: step.newItemCode,
                description: step.description,
                updateType: 'SKU_CHANGE',
                changes: [{ field: 'sku', oldValue: step.sku, newValue: step.newSku }]
            });
            results.queued.push({ from: step.sku, to: step.newSku, action: step.action });
        } catch (err) {
            results.failed.push({ sku: step.sku, target: step.newSku, error: err.message });
        }
    }
    console.log(`[convert] queued=${results.queued.length} skipped=${results.skipped.length} failed=${results.failed.length}`);
    res.json({
        ranAt: new Date().toISOString(),
        summary: { queued: results.queued.length, skipped: results.skipped.length, failed: results.failed.length },
        results
    });
}));

app.get('/convert', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'convert.html')); });

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

// Clear all inventory (using POST because Vercel has issues with DELETE + body)
app.post('/api/admin/inventory/clear', async (req, res) => {
    if (req.body.password !== config.adminPassword) return res.status(401).json({ error: 'Invalid password' });
    try {
        const items = await data.getAllItems();
        const count = items.length;

        // Delete all items (items are formatted with uppercase SKU)
        for (const item of items) {
            await data.deleteItem(item.SKU);
        }

        console.log(`Admin cleared all inventory: ${count} items deleted`);
        res.json({ message: 'Inventory cleared', deleted: count });
    } catch (err) {
        console.error('Error clearing inventory:', err);
        res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        database: DB_MODE,
        useLocalDB: USE_LOCAL_DB
    });
});

// Keep tokens alive - called every 30 mins by Vercel Cron to prevent token expiry
app.get('/api/keep-alive', async (req, res) => {
    const results = { refreshed: [], failed: [], skipped: [] };

    try {
        const accounts = await data.getAllAccounts();

        for (const account of accounts) {
            if (!account.hasValidToken) {
                results.skipped.push({ id: account.id, reason: 'no valid token' });
                continue;
            }

            try {
                // Get full account data to check token expiry
                const fullAccount = await data.getAccount(account.id);

                // Always refresh if token expires within 2 hours (since cron runs every 30 min)
                const twoHours = 2 * 60 * 60 * 1000;
                if (fullAccount?.tokens?.refresh_token &&
                    fullAccount?.tokens?.expires_at &&
                    (fullAccount.tokens.expires_at - Date.now() < twoHours)) {
                    await ebayAPI.refreshAccessToken(account.id);
                    results.refreshed.push(account.id);
                    console.log(`Keep-alive: Refreshed token for ${account.name}`);
                } else if (fullAccount?.tokens?.refresh_token && !fullAccount?.tokens?.expires_at) {
                    // No expiry set, refresh anyway to be safe
                    await ebayAPI.refreshAccessToken(account.id);
                    results.refreshed.push(account.id);
                    console.log(`Keep-alive: Refreshed token for ${account.name} (no expiry set)`);
                } else {
                    results.skipped.push({ id: account.id, reason: 'token still valid' });
                }
            } catch (err) {
                results.failed.push({ id: account.id, error: err.message });
                console.error(`Keep-alive: Failed to refresh ${account.id}:`, err.message);
            }
        }

        // Daily drift check: compare live eBay available qty vs local; flag mismatches.
        try {
            results.reconciliation = await runReconciliation();
        } catch (recErr) {
            console.error('Keep-alive reconciliation failed:', recErr.message);
            results.reconciliation = { error: recErr.message };
        }

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            results
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// Reconciliation: per account, fetch live eBay listings (one call) and compare each
// listing's AVAILABLE quantity to the local count. A mismatch that ISN'T already explained
// by a pending quantity change (delta or recount) becomes a RECONCILE entry in the Updates
// tab for the user to resolve. Re-runnable: won't duplicate an existing RECONCILE for a SKU.
async function runReconciliation() {
    const summary = { checked: 0, drift: 0, created: 0, perAccount: [] };
    const accounts = await data.getAllAccounts();
    const pending = await data.getPendingUpdates('pending');
    const skusWithPendingQty = new Set(
        pending.filter(u => (u.changes || []).some(c => c.field === 'quantity')).map(u => u.sku)
    );
    const skusWithReconcile = new Set(
        pending.filter(u => u.updateType === 'RECONCILE').map(u => u.sku)
    );

    for (const account of accounts) {
        const row = { accountId: account.id, account: account.name, drift: 0, created: 0, error: null };
        try {
            const ebayData = await ebayAPI.getActiveListings(account.id);
            for (const listing of (ebayData.items || [])) {
                const sku = listing.sku || listing.itemId;
                const local = await data.getItem(sku);
                // Only reconcile items we track for THIS account.
                if (!local || local.ebaySync?.ebayAccountId !== account.id) continue;
                summary.checked++;
                const ebayAvail = parseInt(listing.quantity) || 0;
                const localQty = local.currentQty || 0;
                if (ebayAvail === localQty) continue;
                row.drift++; summary.drift++;
                // Skip if a pending qty change or an existing RECONCILE already covers this SKU.
                if (skusWithPendingQty.has(sku) || skusWithReconcile.has(sku)) continue;
                await data.createPendingUpdate({
                    sku,
                    itemCode: local.itemCode,
                    description: local.description || '',
                    updateType: 'RECONCILE',
                    changes: [{ field: 'quantity', oldValue: localQty, newValue: ebayAvail, drift: true }]
                });
                skusWithReconcile.add(sku);
                row.created++; summary.created++;
            }
        } catch (err) {
            row.error = err.message;
        }
        summary.perAccount.push(row);
    }
    console.log('[reconcile]', JSON.stringify(summary));
    return summary;
}

// Global error handler — must be last app.use()
app.use(errorMiddleware);

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
