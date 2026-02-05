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
        clientId: process.env.EBAY_CLIENT_ID,
        clientSecret: process.env.EBAY_CLIENT_SECRET,
        ruName: process.env.EBAY_RUNAME,
        environment: process.env.EBAY_ENVIRONMENT || 'sandbox',
        scopes: [
            'https://api.ebay.com/oauth/api_scope',
            'https://api.ebay.com/oauth/api_scope/sell.inventory',
            'https://api.ebay.com/oauth/api_scope/sell.account'
        ]
    },
    adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
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

    // Smart two-way sync: reconcile eBay sales with local inventory changes
    async smartSyncAll(accountId) {
        const results = { success: [], failed: [], sales: [] };

        // 1. Fetch current eBay inventory
        let ebayInventory = {};
        try {
            const ebayData = await this.getInventoryItems(accountId);
            if (ebayData.inventoryItems) {
                ebayData.inventoryItems.forEach(item => {
                    ebayInventory[item.sku] = item.availability?.shipToLocationAvailability?.quantity || 0;
                });
            }
        } catch (err) {
            console.log('Could not fetch eBay inventory, proceeding with push-only sync:', err.message);
        }

        // 2. Get all local items
        const localItems = await data.getAllItems();

        // 3. Process each item
        for (const item of localItems) {
            try {
                const fullItem = await data.getItem(item.SKU);
                if (!fullItem) continue;

                const localQty = fullItem.currentQty;
                const lastSyncedQty = fullItem.lastSyncedQty ?? localQty; // Default to current if never synced
                const ebayQty = ebayInventory[fullItem.sku];

                let finalQty = localQty;
                let salesDetected = 0;

                // If item exists on eBay, reconcile quantities
                if (ebayQty !== undefined) {
                    // Calculate how many sold on eBay since last sync
                    // sales = lastSyncedQty - ebayQty (if positive)
                    salesDetected = Math.max(0, lastSyncedQty - ebayQty);

                    if (salesDetected > 0) {
                        // Subtract sales from local quantity
                        finalQty = Math.max(0, localQty - salesDetected);

                        // Update local inventory with sales deduction
                        await data.updateItem(fullItem.sku, { currentQty: finalQty, lastSyncedQty: finalQty });
                        await data.addHistory(fullItem.sku, {
                            date: new Date(),
                            action: 'EBAY_SALE',
                            qty: -salesDetected,
                            newTotal: finalQty,
                            note: `${salesDetected} sold on eBay (detected during sync)`
                        });

                        results.sales.push({ sku: fullItem.sku, sold: salesDetected, newQty: finalQty });
                    }
                }

                // Push to eBay with final quantity
                await this.syncItemToEbay(accountId, {
                    SKU: fullItem.sku,
                    Price: fullItem.price || 0,
                    Quantity: finalQty,
                    Description: fullItem.description,
                    FullLocation: fullItem.fullLocation,
                    Condition: fullItem.condition || 'NEW',
                    ItemSpecifics: fullItem.itemSpecifics || {}
                });

                // Update lastSyncedQty after successful sync
                await data.updateItem(fullItem.sku, { lastSyncedQty: finalQty });

                results.success.push({ sku: fullItem.sku, qty: finalQty, salesDetected });

            } catch (err) {
                results.failed.push({ sku: item.SKU, error: err.message });
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
        res.json(await data.getAllItems());
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
        res.json({ item: { SKU: item.sku, ItemCode: item.itemCode, DrawerNumber: item.drawerNumber, PositionNumber: item.positionNumber, FullLocation: item.fullLocation, Price: item.price || 0, Quantity: item.currentQty, Description: item.description, DateAdded: item.dateAdded, LastModified: item.lastModified }, barcode });
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

app.post('/api/ebay/sync/:accountId/:sku', async (req, res) => {
    try {
        const item = await data.getItem(req.params.sku);
        if (!item) return res.status(404).json({ error: 'Item not found' });
        const result = await ebayAPI.syncItemToEbay(req.params.accountId, { SKU: item.sku, Price: item.price || 0, Quantity: item.currentQty, Description: item.description, FullLocation: item.fullLocation, Condition: item.condition || 'NEW', ItemSpecifics: item.itemSpecifics || {} });
        await data.addHistory(req.params.sku, { date: new Date(), action: 'EBAY_SYNC', qty: 0, newTotal: item.currentQty, note: `Synced to eBay` });
        res.json({ message: 'Item synced to eBay', result });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ebay/sync-all/:accountId', async (req, res) => {
    try {
        if (!(await ebayAPI.isAccountAuthenticated(req.params.accountId))) return res.status(401).json({ error: 'eBay account not connected' });

        // Use smart two-way sync
        const results = await ebayAPI.smartSyncAll(req.params.accountId);

        let message = `Synced ${results.success.length} items`;
        if (results.sales.length > 0) {
            const totalSold = results.sales.reduce((sum, s) => sum + s.sold, 0);
            message += `, detected ${totalSold} eBay sales`;
        }
        if (results.failed.length > 0) {
            message += `, ${results.failed.length} failed`;
        }

        res.json({ message, results });
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

// Admin routes
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.post('/api/admin/login', (req, res) => { res.json({ success: req.body.password === config.adminPassword }); });
app.post('/api/admin/ebay/connect', (req, res) => {
    if (req.body.password !== config.adminPassword) return res.status(401).json({ error: 'Invalid password' });
    if (!config.isEbayConfigured()) return res.status(400).json({ error: 'eBay API not configured' });
    if (!req.body.accountName) return res.status(400).json({ error: 'Account name required' });
    res.json({ authUrl: ebayAPI.getAuthUrl(req.body.accountName) });
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
