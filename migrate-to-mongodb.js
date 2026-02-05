/**
 * Migration script to transfer local inventory.json to MongoDB
 * Run once: node migrate-to-mongodb.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error('ERROR: MONGODB_URI not found in .env file');
    console.log('Add your MongoDB connection string to .env file');
    process.exit(1);
}

// Inventory Item Schema (same as database.js)
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
    history: [{
        date: { type: Date, default: Date.now },
        action: String,
        qty: Number,
        newTotal: Number,
        note: String
    }]
});

const InventoryItem = mongoose.model('InventoryItem', inventoryItemSchema);

async function migrate() {
    console.log('Connecting to MongoDB...');

    try {
        await mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 10000,
        });
        console.log('Connected to MongoDB!');
    } catch (err) {
        console.error('Failed to connect:', err.message);
        process.exit(1);
    }

    // Read local inventory
    const inventoryPath = path.join(__dirname, 'inventory.json');
    if (!fs.existsSync(inventoryPath)) {
        console.log('No local inventory.json found');
        process.exit(0);
    }

    const localData = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    const items = Object.values(localData.items || {});

    console.log(`Found ${items.length} items to migrate`);

    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const item of items) {
        try {
            // Check if already exists
            const existing = await InventoryItem.findOne({ sku: item.sku });
            if (existing) {
                console.log(`  Skipping ${item.sku} (already exists)`);
                skipped++;
                continue;
            }

            // Create new item
            const newItem = new InventoryItem({
                sku: item.sku,
                itemCode: item.itemCode,
                drawerNumber: item.drawerNumber,
                positionNumber: item.positionNumber,
                fullLocation: item.fullLocation,
                price: item.price || 0,
                currentQty: item.currentQty || 0,
                description: item.description || '',
                categoryId: item.categoryId || null,
                categoryName: item.categoryName || null,
                condition: item.condition || null,
                itemSpecifics: item.itemSpecifics || {},
                dateAdded: item.dateAdded ? new Date(item.dateAdded) : new Date(),
                lastModified: item.lastModified ? new Date(item.lastModified) : new Date(),
                history: (item.history || []).map(h => ({
                    date: h.date ? new Date(h.date) : new Date(),
                    action: h.action,
                    qty: h.qty,
                    newTotal: h.newTotal,
                    note: h.note
                }))
            });

            await newItem.save();
            console.log(`  Migrated: ${item.sku} - ${item.description || 'No description'}`);
            migrated++;
        } catch (err) {
            console.error(`  Error migrating ${item.sku}:`, err.message);
            errors++;
        }
    }

    console.log('\n--- Migration Complete ---');
    console.log(`Migrated: ${migrated}`);
    console.log(`Skipped:  ${skipped}`);
    console.log(`Errors:   ${errors}`);

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
}

migrate();
