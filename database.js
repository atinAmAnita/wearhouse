/**
 * MongoDB Database Module
 * Handles connection and provides models for inventory and eBay accounts
 */

const mongoose = require('mongoose');

// Connection state
let isConnected = false;

// Connect to MongoDB
async function connectDB() {
    if (isConnected) return;

    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
        console.warn('MONGODB_URI not set - using in-memory fallback');
        return;
    }

    try {
        await mongoose.connect(mongoUri, {
            serverSelectionTimeoutMS: 5000,
        });
        isConnected = true;
        console.log('Connected to MongoDB');
    } catch (err) {
        console.error('MongoDB connection error:', err.message);
    }
}

// Inventory Item Schema
const inventoryItemSchema = new mongoose.Schema({
    sku: { type: String, required: true, unique: true, index: true },
    itemCode: { type: String, required: true, index: true },
    drawerNumber: { type: String, required: true },
    positionNumber: { type: String, required: true },
    fullLocation: { type: String, required: true },
    price: { type: Number, default: 0 },
    currentQty: { type: Number, default: 0 },
    description: { type: String, default: '' },
    categoryId: { type: String, default: null },
    categoryName: { type: String, default: null },
    condition: { type: String, default: null },
    itemSpecifics: { type: mongoose.Schema.Types.Mixed, default: {} },
    dateAdded: { type: Date, default: Date.now },
    lastModified: { type: Date, default: Date.now },
    lastSyncedQty: { type: Number, default: null },
    // eBay sync tracking
    ebaySync: {
        snapshot: {
            quantity: Number,
            price: Number,
            title: String,
            description: String,
            condition: String,
            takenAt: Date
        },
        lastSyncTime: Date,
        ebayItemId: String,
        ebayOfferId: String,
        status: { type: String, default: 'not_synced' }  // 'synced' | 'pending' | 'error' | 'not_synced'
    },
    history: [{
        date: { type: Date, default: Date.now },
        action: String,
        qty: Number,
        newTotal: Number,
        note: String
    }]
});

// eBay Account Schema
const ebayAccountSchema = new mongoose.Schema({
    accountId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    tokens: {
        access_token: String,
        refresh_token: String,
        expires_at: Number,
        token_type: String
    },
    addedAt: { type: Date, default: Date.now },
    lastSync: { type: Date, default: null }
});

// Models
const InventoryItem = mongoose.models.InventoryItem || mongoose.model('InventoryItem', inventoryItemSchema);
const EbayAccount = mongoose.models.EbayAccount || mongoose.model('EbayAccount', ebayAccountSchema);

// ============================================
// INVENTORY OPERATIONS
// ============================================

const inventory = {
    async getAll() {
        await connectDB();
        if (!isConnected) return [];
        return InventoryItem.find().lean();
    },

    async getItem(sku) {
        await connectDB();
        if (!isConnected) return null;
        return InventoryItem.findOne({ sku }).lean();
    },

    async getByItemCode(itemCode) {
        await connectDB();
        if (!isConnected) return null;
        return InventoryItem.findOne({ itemCode }).lean();
    },

    async getByLocation(fullLocation) {
        await connectDB();
        if (!isConnected) return null;
        return InventoryItem.findOne({ fullLocation }).lean();
    },

    async create(itemData) {
        await connectDB();
        if (!isConnected) return null;
        const item = new InventoryItem(itemData);
        return item.save();
    },

    async update(sku, updates) {
        await connectDB();
        if (!isConnected) return null;
        updates.lastModified = new Date();
        return InventoryItem.findOneAndUpdate({ sku }, updates, { new: true }).lean();
    },

    async addHistory(sku, historyEntry) {
        await connectDB();
        if (!isConnected) return null;
        return InventoryItem.findOneAndUpdate(
            { sku },
            { 
                $push: { history: historyEntry },
                $set: { lastModified: new Date() }
            },
            { new: true }
        ).lean();
    },

    async delete(sku) {
        await connectDB();
        if (!isConnected) return null;
        return InventoryItem.findOneAndDelete({ sku }).lean();
    },

    async count() {
        await connectDB();
        if (!isConnected) return 0;
        return InventoryItem.countDocuments();
    },

    async getAllItemCodes() {
        await connectDB();
        if (!isConnected) return [];
        const items = await InventoryItem.find().select('itemCode').lean();
        return items.map(i => i.itemCode);
    },

    async getAllLocations() {
        await connectDB();
        if (!isConnected) return [];
        const items = await InventoryItem.find().select('fullLocation drawerNumber positionNumber').lean();
        return items.map(i => i.drawerNumber + i.positionNumber);
    },

    async updateEbaySync(sku, syncData) {
        await connectDB();
        if (!isConnected) return null;
        return InventoryItem.findOneAndUpdate(
            { sku },
            { $set: { ebaySync: syncData, lastModified: new Date() } },
            { new: true }
        ).lean();
    },

    async getByEbayItemId(ebayItemId) {
        await connectDB();
        if (!isConnected) return null;
        return InventoryItem.findOne({ 'ebaySync.ebayItemId': ebayItemId }).lean();
    }
};

// ============================================
// EBAY ACCOUNTS OPERATIONS
// ============================================

const ebayAccounts = {
    async getAll() {
        await connectDB();
        if (!isConnected) return [];
        return EbayAccount.find().lean();
    },

    async get(accountId) {
        await connectDB();
        if (!isConnected) return null;
        return EbayAccount.findOne({ accountId }).lean();
    },

    async save(accountId, data) {
        await connectDB();
        if (!isConnected) return null;
        return EbayAccount.findOneAndUpdate(
            { accountId },
            { accountId, ...data },
            { upsert: true, new: true }
        ).lean();
    },

    async updateTokens(accountId, tokens) {
        await connectDB();
        if (!isConnected) return null;
        return EbayAccount.findOneAndUpdate(
            { accountId },
            { tokens },
            { new: true }
        ).lean();
    },

    async delete(accountId) {
        await connectDB();
        if (!isConnected) return null;
        return EbayAccount.findOneAndDelete({ accountId }).lean();
    }
};

module.exports = {
    connectDB,
    isConnected: () => isConnected,
    inventory,
    ebayAccounts,
    InventoryItem,
    EbayAccount
};
