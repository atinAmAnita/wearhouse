require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const bwipjs = require('bwip-js');
const config = require('./config');
const ebayAPI = require('./ebay-api');

const app = express();
const PORT = config.server.port;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Data file paths
const JSON_DATA_FILE = path.join(__dirname, 'inventory.json');
const LEGACY_EXCEL_FILE = path.join(__dirname, 'inventory.xlsx');

// 3D Inventory Structure
// {
//   "items": {
//     "SKU": {
//       sku, itemCode, drawerNumber, positionNumber, fullLocation,
//       currentQty, description, dateAdded, lastModified,
//       history: [{date, action, qty, newTotal, note}]
//     }
//   },
//   "metadata": { version, lastModified, totalItems }
// }
let inventoryDB = {
    items: {},
    metadata: {
        version: "2.0",
        lastModified: new Date().toISOString(),
        totalItems: 0
    }
};

// Load inventory from JSON file
function loadInventory() {
    // First, check if JSON file exists
    if (fs.existsSync(JSON_DATA_FILE)) {
        try {
            const data = fs.readFileSync(JSON_DATA_FILE, 'utf8');
            inventoryDB = JSON.parse(data);
            console.log(`Loaded ${Object.keys(inventoryDB.items).length} items from JSON inventory`);
            return;
        } catch (err) {
            console.error('Error loading JSON inventory:', err);
        }
    }

    // If no JSON, try to migrate from legacy Excel
    if (fs.existsSync(LEGACY_EXCEL_FILE)) {
        console.log('Migrating from legacy Excel format...');
        migrateFromExcel();
        return;
    }

    console.log('Starting with empty inventory');
}

// Migrate existing Excel data to new JSON format
function migrateFromExcel() {
    try {
        const workbook = XLSX.readFile(LEGACY_EXCEL_FILE);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const excelData = XLSX.utils.sheet_to_json(sheet);

        for (const row of excelData) {
            const sku = row.SKU;
            inventoryDB.items[sku] = {
                sku: sku,
                itemCode: row.ItemCode,
                drawerNumber: row.DrawerNumber,
                positionNumber: row.PositionNumber,
                fullLocation: row.FullLocation,
                currentQty: parseInt(row.Quantity) || 0,
                description: row.Description || '',
                dateAdded: row.DateAdded || new Date().toISOString(),
                lastModified: row.LastModified || new Date().toISOString(),
                history: [{
                    date: row.DateAdded || new Date().toISOString(),
                    action: 'MIGRATE',
                    qty: parseInt(row.Quantity) || 0,
                    newTotal: parseInt(row.Quantity) || 0,
                    note: 'Migrated from Excel'
                }]
            };
        }

        inventoryDB.metadata.totalItems = Object.keys(inventoryDB.items).length;
        inventoryDB.metadata.lastModified = new Date().toISOString();
        saveInventory();

        // Rename old Excel file as backup
        const backupPath = LEGACY_EXCEL_FILE.replace('.xlsx', '_backup.xlsx');
        fs.renameSync(LEGACY_EXCEL_FILE, backupPath);
        console.log(`Migrated ${excelData.length} items. Old file backed up to inventory_backup.xlsx`);
    } catch (err) {
        console.error('Migration error:', err);
    }
}

// Save inventory to JSON file
function saveInventory() {
    inventoryDB.metadata.lastModified = new Date().toISOString();
    inventoryDB.metadata.totalItems = Object.keys(inventoryDB.items).length;

    fs.writeFileSync(JSON_DATA_FILE, JSON.stringify(inventoryDB, null, 2));
}

// Add history entry to an item
function addHistoryEntry(sku, action, qtyChange, newTotal, note = '') {
    if (inventoryDB.items[sku]) {
        inventoryDB.items[sku].history.push({
            date: new Date().toISOString(),
            action: action,
            qty: qtyChange,
            newTotal: newTotal,
            note: note
        });
    }
}

// Get inventory as flat array (for API compatibility)
function getInventoryArray() {
    return Object.values(inventoryDB.items).map(item => ({
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
    }));
}

// Generate full SKU: ItemCode + Location
function generateSKU(itemCode, drawer, position) {
    const drawerStr = String(drawer).padStart(3, '0');
    const positionStr = String(position).padStart(2, '0');
    return `${itemCode}${drawerStr}${positionStr}`;
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
// API Routes
// ============================================

// Get all inventory items (flat array for compatibility)
app.get('/api/inventory', (req, res) => {
    res.json(getInventoryArray());
});

// Get item history
app.get('/api/inventory/:sku/history', (req, res) => {
    const { sku } = req.params;
    const item = inventoryDB.items[sku];

    if (!item) {
        return res.status(404).json({ error: 'Item not found' });
    }

    res.json({
        sku: item.sku,
        currentQty: item.currentQty,
        history: item.history
    });
});

// Check if Item ID exists
app.get('/api/check-item/:itemId', (req, res) => {
    const { itemId } = req.params;
    const items = Object.values(inventoryDB.items);
    const existingItem = items.find(item => item.itemCode === itemId);

    if (existingItem) {
        res.json({
            exists: true,
            item: {
                SKU: existingItem.sku,
                ItemCode: existingItem.itemCode,
                DrawerNumber: existingItem.drawerNumber,
                PositionNumber: existingItem.positionNumber,
                FullLocation: existingItem.fullLocation,
                Price: existingItem.price || 0,
                Quantity: existingItem.currentQty,
                Description: existingItem.description
            }
        });
    } else {
        res.json({ exists: false, item: null });
    }
});

// Get next available Item ID (lowest unused 4-digit number)
app.get('/api/next-item-id', (req, res) => {
    const usedIds = new Set(Object.values(inventoryDB.items).map(item => item.itemCode));

    for (let i = 1; i <= 9999; i++) {
        const id = String(i).padStart(4, '0');
        if (!usedIds.has(id)) {
            return res.json({ nextId: id });
        }
    }

    res.status(400).json({ error: 'No available Item IDs' });
});

// Get next available Location (lowest unused drawer+position)
app.get('/api/next-location', (req, res) => {
    const usedLocations = new Set(
        Object.values(inventoryDB.items).map(item => item.drawerNumber + item.positionNumber)
    );

    for (let drawer = 1; drawer <= 999; drawer++) {
        for (let position = 1; position <= 99; position++) {
            const location = String(drawer).padStart(3, '0') + String(position).padStart(2, '0');
            if (!usedLocations.has(location)) {
                return res.json({
                    nextLocation: location,
                    drawer: String(drawer).padStart(3, '0'),
                    position: String(position).padStart(2, '0')
                });
            }
        }
    }

    res.status(400).json({ error: 'No available locations' });
});

// Add new item or update existing
app.post('/api/inventory', async (req, res) => {
    const { itemId, drawer, position, price = 0, quantity = 1, description = '' } = req.body;

    if (!itemId || !drawer || !position) {
        return res.status(400).json({ error: 'Item ID, drawer, and position are required' });
    }

    if (!/^\d{4}$/.test(itemId)) {
        return res.status(400).json({ error: 'Item ID must be exactly 4 digits' });
    }

    const drawerStr = String(drawer).padStart(3, '0');
    const positionStr = String(position).padStart(2, '0');
    const fullLocation = `${drawerStr}-${positionStr}`;
    const sku = `${itemId}${drawerStr}${positionStr}`;
    const qtyToAdd = parseInt(quantity);

    // Check if this exact Item ID already exists
    const items = Object.values(inventoryDB.items);
    const existingByItemId = items.find(item => item.itemCode === itemId);

    if (existingByItemId) {
        // Item ID exists - add to its quantity
        const oldQty = existingByItemId.currentQty;
        existingByItemId.currentQty = oldQty + qtyToAdd;
        existingByItemId.lastModified = new Date().toISOString();

        if (description) {
            existingByItemId.description = description;
        }
        if (price > 0) {
            existingByItemId.price = parseFloat(price);
        }

        // Log history
        addHistoryEntry(existingByItemId.sku, 'ADD', qtyToAdd, existingByItemId.currentQty, `Added ${qtyToAdd} units`);
        saveInventory();

        const barcode = await generateBarcode(existingByItemId.sku);
        return res.json({
            message: `Quantity added to existing item (now ${existingByItemId.currentQty})`,
            item: {
                SKU: existingByItemId.sku,
                ItemCode: existingByItemId.itemCode,
                DrawerNumber: existingByItemId.drawerNumber,
                PositionNumber: existingByItemId.positionNumber,
                FullLocation: existingByItemId.fullLocation,
                Price: existingByItemId.price || 0,
                Quantity: existingByItemId.currentQty,
                Description: existingByItemId.description
            },
            barcode
        });
    }

    // Check if location already has a DIFFERENT item
    const existingByLocation = items.find(item => item.fullLocation === fullLocation);

    if (existingByLocation) {
        return res.status(400).json({
            error: `Location ${fullLocation} already has item ${existingByLocation.itemCode}. Use that Item ID or choose a different location.`
        });
    }

    // Create new item
    try {
        const now = new Date().toISOString();
        const priceValue = parseFloat(price) || 0;

        inventoryDB.items[sku] = {
            sku: sku,
            itemCode: itemId,
            drawerNumber: drawerStr,
            positionNumber: positionStr,
            fullLocation: fullLocation,
            price: priceValue,
            currentQty: qtyToAdd,
            description: description,
            dateAdded: now,
            lastModified: now,
            history: [{
                date: now,
                action: 'CREATE',
                qty: qtyToAdd,
                newTotal: qtyToAdd,
                note: 'Item created'
            }]
        };

        saveInventory();

        const barcode = await generateBarcode(sku);
        res.json({
            message: 'New item added',
            item: {
                SKU: sku,
                ItemCode: itemId,
                DrawerNumber: drawerStr,
                PositionNumber: positionStr,
                FullLocation: fullLocation,
                Price: priceValue,
                Quantity: qtyToAdd,
                Description: description,
                DateAdded: now
            },
            barcode
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update item quantity by SKU
app.put('/api/inventory/:sku', (req, res) => {
    const { sku } = req.params;
    const { quantity, price, description } = req.body;

    const item = inventoryDB.items[sku];

    if (!item) {
        return res.status(404).json({ error: 'Item not found' });
    }

    const oldQty = item.currentQty;

    if (quantity !== undefined) {
        const newQty = parseInt(quantity);
        const diff = newQty - oldQty;
        item.currentQty = newQty;

        // Log history
        const action = diff >= 0 ? 'ADJUST_UP' : 'ADJUST_DOWN';
        addHistoryEntry(sku, action, diff, newQty, `Quantity adjusted from ${oldQty} to ${newQty}`);
    }

    if (price !== undefined) {
        item.price = parseFloat(price);
    }

    if (description !== undefined) {
        item.description = description;
    }

    item.lastModified = new Date().toISOString();
    saveInventory();

    res.json({
        message: 'Item updated',
        item: {
            SKU: item.sku,
            ItemCode: item.itemCode,
            DrawerNumber: item.drawerNumber,
            PositionNumber: item.positionNumber,
            FullLocation: item.fullLocation,
            Price: item.price || 0,
            Quantity: item.currentQty,
            Description: item.description
        }
    });
});

// Delete item by SKU
app.delete('/api/inventory/:sku', (req, res) => {
    const { sku } = req.params;
    const item = inventoryDB.items[sku];

    if (!item) {
        return res.status(404).json({ error: 'Item not found' });
    }

    // Store deleted item info before removing
    const deletedItem = {
        SKU: item.sku,
        ItemCode: item.itemCode,
        FullLocation: item.fullLocation,
        Quantity: item.currentQty
    };

    delete inventoryDB.items[sku];
    saveInventory();

    res.json({ message: 'Item deleted', item: deletedItem });
});

// Lookup by scanning/entering SKU
app.get('/api/lookup/:sku', async (req, res) => {
    const { sku } = req.params;
    const item = inventoryDB.items[sku];

    if (!item) {
        return res.status(404).json({ error: 'Item not found' });
    }

    const barcode = await generateBarcode(item.sku);
    res.json({
        item: {
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
        },
        barcode
    });
});

// Generate barcode for SKU
app.get('/api/barcode/:sku', async (req, res) => {
    const { sku } = req.params;
    const barcode = await generateBarcode(sku);
    res.json({ barcode });
});

// Export for eBay (File Exchange format)
app.get('/api/export/ebay', (req, res) => {
    const inventory = getInventoryArray();
    const ebayData = inventory.map(item => ({
        'Action': 'Revise',
        'ItemID': '',
        'CustomLabel': item.SKU,
        'Quantity': item.Quantity,
        'Title': item.Description || '',
        'Location': item.FullLocation
    }));

    const worksheet = XLSX.utils.json_to_sheet(ebayData);
    const csv = XLSX.utils.sheet_to_csv(worksheet);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=ebay_inventory.csv');
    res.send(csv);
});

// Export inventory as Excel (generated from JSON)
app.get('/api/export/excel', (req, res) => {
    const inventory = getInventoryArray();

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(inventory, {
        header: ['SKU', 'ItemCode', 'DrawerNumber', 'PositionNumber', 'FullLocation', 'Quantity', 'Description', 'DateAdded', 'LastModified']
    });

    worksheet['!cols'] = [
        { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 14 },
        { wch: 12 }, { wch: 10 }, { wch: 30 }, { wch: 20 }, { wch: 20 }
    ];

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventory');

    // Write to temp file and send
    const tempFile = path.join(__dirname, 'temp_export.xlsx');
    XLSX.writeFile(workbook, tempFile);
    res.download(tempFile, 'inventory.xlsx', () => {
        fs.unlinkSync(tempFile); // Clean up temp file
    });
});

// Check if location exists
app.get('/api/check-location/:drawer/:position', (req, res) => {
    const { drawer, position } = req.params;
    const fullLocation = `${String(drawer).padStart(3, '0')}-${String(position).padStart(2, '0')}`;
    const items = Object.values(inventoryDB.items);
    const existingItem = items.find(item => item.fullLocation === fullLocation);

    if (existingItem) {
        res.json({
            exists: true,
            item: {
                SKU: existingItem.sku,
                ItemCode: existingItem.itemCode,
                FullLocation: existingItem.fullLocation,
                Quantity: existingItem.currentQty
            }
        });
    } else {
        res.json({ exists: false, item: null });
    }
});

// ============================================
// EBAY API ROUTES (Multi-Account)
// ============================================

app.get('/api/ebay/status', (req, res) => {
    res.json(ebayAPI.getStatus());
});

app.get('/api/ebay/accounts', (req, res) => {
    res.json(config.getAllAccounts());
});

app.get('/api/ebay/callback', async (req, res) => {
    const { code, error, state } = req.query;

    if (error) {
        return res.redirect('/admin?ebay_error=' + encodeURIComponent(error));
    }

    if (!code) {
        return res.redirect('/admin?ebay_error=no_code');
    }

    try {
        const result = await ebayAPI.exchangeCodeForToken(code, state);
        res.redirect('/admin?ebay_connected=' + encodeURIComponent(result.accountName));
    } catch (err) {
        console.error('eBay OAuth error:', err);
        res.redirect('/admin?ebay_error=' + encodeURIComponent(err.message));
    }
});

app.get('/api/ebay/inventory/:accountId', async (req, res) => {
    const { accountId } = req.params;

    try {
        const items = await ebayAPI.getInventoryItems(accountId);
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ebay/sync/:accountId/:sku', async (req, res) => {
    const { accountId, sku } = req.params;
    const item = inventoryDB.items[sku];

    if (!item) {
        return res.status(404).json({ error: 'Item not found in local inventory' });
    }

    try {
        const result = await ebayAPI.syncItemToEbay(accountId, {
            SKU: item.sku,
            Price: item.price || 0,
            Quantity: item.currentQty,
            Description: item.description,
            FullLocation: item.fullLocation,
            Condition: item.condition || 'NEW',
            CategoryId: item.categoryId || null,
            ItemSpecifics: item.itemSpecifics || {}
        });

        // Log sync to history
        addHistoryEntry(sku, 'EBAY_SYNC', 0, item.currentQty, `Synced to eBay account ${accountId}`);
        saveInventory();

        res.json({ message: 'Item synced to eBay', result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ebay/sync-all/:accountId', async (req, res) => {
    const { accountId } = req.params;

    if (!ebayAPI.isAccountAuthenticated(accountId)) {
        return res.status(401).json({ error: 'eBay account not connected or token expired' });
    }

    const results = { success: [], failed: [] };
    const items = Object.values(inventoryDB.items);

    for (const item of items) {
        try {
            await ebayAPI.syncItemToEbay(accountId, {
                SKU: item.sku,
                Price: item.price || 0,
                Quantity: item.currentQty,
                Description: item.description,
                FullLocation: item.fullLocation,
                Condition: item.condition || 'NEW',
                CategoryId: item.categoryId || null,
                ItemSpecifics: item.itemSpecifics || {}
            });
            results.success.push(item.sku);
            addHistoryEntry(item.sku, 'EBAY_SYNC', 0, item.currentQty, `Synced to eBay account ${accountId}`);
        } catch (err) {
            results.failed.push({ sku: item.sku, error: err.message });
        }
    }

    saveInventory();

    res.json({
        message: `Synced ${results.success.length} items, ${results.failed.length} failed`,
        results
    });
});

app.put('/api/ebay/quantity/:accountId/:sku', async (req, res) => {
    const { accountId, sku } = req.params;
    const item = inventoryDB.items[sku];

    if (!item) {
        return res.status(404).json({ error: 'Item not found' });
    }

    try {
        const result = await ebayAPI.updateInventoryQuantity(accountId, sku, item.currentQty);
        res.json({ message: 'Quantity updated on eBay', result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// EBAY TAXONOMY API ROUTES (Categories & Item Specifics)
// ============================================

// Search for eBay categories
app.get('/api/ebay/categories/search/:accountId', async (req, res) => {
    const { accountId } = req.params;
    const { q } = req.query;

    if (!q) {
        return res.status(400).json({ error: 'Search query (q) is required' });
    }

    try {
        const result = await ebayAPI.getCategorySuggestions(accountId, q);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get item specifics for a category
app.get('/api/ebay/categories/:categoryId/aspects/:accountId', async (req, res) => {
    const { categoryId, accountId } = req.params;

    try {
        const result = await ebayAPI.getItemAspectsForCategory(accountId, categoryId);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// ADVANCED SETTINGS API ROUTES
// ============================================

// Update item with advanced settings (category, condition, item specifics)
app.put('/api/inventory/:sku/advanced', (req, res) => {
    const { sku } = req.params;
    const { categoryId, categoryName, condition, itemSpecifics } = req.body;

    const item = inventoryDB.items[sku];

    if (!item) {
        return res.status(404).json({ error: 'Item not found' });
    }

    // Update advanced fields
    if (categoryId !== undefined) {
        item.categoryId = categoryId;
        item.categoryName = categoryName || '';
    }
    if (condition !== undefined) {
        item.condition = condition;
    }
    if (itemSpecifics !== undefined) {
        item.itemSpecifics = itemSpecifics;
    }

    item.lastModified = new Date().toISOString();
    saveInventory();

    res.json({
        message: 'Advanced settings updated',
        item: {
            SKU: item.sku,
            CategoryId: item.categoryId,
            CategoryName: item.categoryName,
            Condition: item.condition,
            ItemSpecifics: item.itemSpecifics
        }
    });
});

// Get item with advanced settings
app.get('/api/inventory/:sku/advanced', (req, res) => {
    const { sku } = req.params;
    const item = inventoryDB.items[sku];

    if (!item) {
        return res.status(404).json({ error: 'Item not found' });
    }

    res.json({
        SKU: item.sku,
        CategoryId: item.categoryId || null,
        CategoryName: item.categoryName || null,
        Condition: item.condition || null,
        ItemSpecifics: item.itemSpecifics || {}
    });
});

// ============================================
// ADMIN ROUTES
// ============================================

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;

    if (password === config.adminPassword) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

app.post('/api/admin/ebay/connect', (req, res) => {
    const { password, accountName } = req.body;

    if (password !== config.adminPassword) {
        return res.status(401).json({ error: 'Invalid admin password' });
    }

    if (!config.isEbayConfigured()) {
        return res.status(400).json({
            error: 'eBay API not configured',
            message: 'Please add your eBay API credentials to config.js'
        });
    }

    if (!accountName) {
        return res.status(400).json({ error: 'Account name is required' });
    }

    const authUrl = ebayAPI.getAuthUrl(accountName);
    res.json({ authUrl });
});

app.delete('/api/admin/ebay/account/:accountId', (req, res) => {
    const { accountId } = req.params;
    const { password } = req.body;

    if (password !== config.adminPassword) {
        return res.status(401).json({ error: 'Invalid admin password' });
    }

    const removed = ebayAPI.removeAccount(accountId);

    if (removed) {
        res.json({ message: 'Account removed' });
    } else {
        res.status(404).json({ error: 'Account not found' });
    }
});

app.post('/api/admin/ebay/accounts', (req, res) => {
    const { password } = req.body;

    if (password !== config.adminPassword) {
        return res.status(401).json({ error: 'Invalid admin password' });
    }

    res.json(config.getAllAccounts());
});

// ============================================
// DATABASE INFO ENDPOINT
// ============================================

app.get('/api/db/stats', (req, res) => {
    const items = Object.values(inventoryDB.items);
    const totalHistory = items.reduce((sum, item) => sum + item.history.length, 0);

    res.json({
        version: inventoryDB.metadata.version,
        totalItems: items.length,
        totalQuantity: items.reduce((sum, item) => sum + item.currentQty, 0),
        totalHistoryEntries: totalHistory,
        lastModified: inventoryDB.metadata.lastModified
    });
});

// ============================================
// START SERVER
// ============================================

loadInventory();
app.listen(PORT, () => {
    const accounts = config.getAllAccounts();
    const itemCount = Object.keys(inventoryDB.items).length;
    console.log(`\n========================================`);
    console.log(`  STOCKFORGE - Inventory Control`);
    console.log(`========================================`);
    console.log(`  Main App: http://localhost:${PORT}`);
    console.log(`  Admin:    http://localhost:${PORT}/admin`);
    console.log(`----------------------------------------`);
    console.log(`  Database: JSON (v${inventoryDB.metadata.version})`);
    console.log(`  Items:    ${itemCount} loaded`);
    console.log(`  eBay API: ${config.isEbayConfigured() ? 'Configured' : 'Not configured'}`);
    console.log(`  eBay Accounts: ${accounts.length} connected`);
    console.log(`========================================\n`);
});
