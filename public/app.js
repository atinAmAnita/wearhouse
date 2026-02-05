// ============================================
// STOCKFORGE - Main Application
// ============================================

// ============================================
// STATE
// ============================================
const State = {
    currentItem: null,
    ebayAccounts: [],
    locationAutoFilled: false,  // Track if location was auto-filled
};

// ============================================
// API - All server communication
// ============================================
const API = {
    async get(endpoint) {
        const response = await fetch(endpoint);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');
        return data;
    },

    async post(endpoint, body = {}) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');
        return data;
    },

    async put(endpoint, body = {}) {
        const response = await fetch(endpoint, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');
        return data;
    },

    async delete(endpoint) {
        const response = await fetch(endpoint, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');
        return data;
    },

    // Inventory endpoints
    inventory: {
        getAll: () => API.get('/api/inventory'),
        getItem: (sku) => API.get(`/api/lookup/${sku}`),
        getHistory: (sku) => API.get(`/api/inventory/${sku}/history`),
        add: (data) => API.post('/api/inventory', data),
        update: (sku, data) => API.put(`/api/inventory/${sku}`, data),
        delete: (sku) => API.delete(`/api/inventory/${sku}`),
        checkItem: (itemId) => API.get(`/api/check-item/${itemId}`),
        checkLocation: (drawer, position) => API.get(`/api/check-location/${drawer}/${position}`),
        nextItemId: () => API.get('/api/next-item-id'),
        nextLocation: () => API.get('/api/next-location'),
    },

    // eBay endpoints
    ebay: {
        getStatus: () => API.get('/api/ebay/status'),
        getInventory: (accountId) => API.get(`/api/ebay/inventory/${accountId}`),
        syncAll: (accountId) => API.post(`/api/ebay/sync-all/${accountId}`),
        searchCategories: (accountId, query) => API.get(`/api/ebay/categories/search/${accountId}?q=${encodeURIComponent(query)}`),
        getCategoryAspects: (accountId, categoryId) => API.get(`/api/ebay/categories/${categoryId}/aspects/${accountId}`),
    },

    // Advanced settings endpoints
    advanced: {
        get: (sku) => API.get(`/api/inventory/${sku}/advanced`),
        update: (sku, data) => API.put(`/api/inventory/${sku}/advanced`, data),
    }
};

// ============================================
// UI - Reusable UI components and helpers
// ============================================
const UI = {
    // Get element by ID
    el: (id) => document.getElementById(id),

    // Show notification
    notify(message, type = 'info') {
        const el = UI.el('notification');
        el.textContent = message;
        el.className = `notification ${type}`;
        setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // Show/hide element
    show: (el) => el?.classList.remove('hidden'),
    hide: (el) => el?.classList.add('hidden'),
    toggle: (el, visible) => visible ? UI.show(el) : UI.hide(el),

    // Set element content
    setHTML: (id, html) => { const el = UI.el(id); if (el) el.innerHTML = html; },
    setText: (id, text) => { const el = UI.el(id); if (el) el.textContent = text; },

    // Modal management
    modal: {
        open(id) { UI.show(UI.el(id)); },
        close(id) { UI.hide(UI.el(id)); }
    },

    // Format date
    formatDate: (dateStr) => new Date(dateStr).toLocaleDateString(),
    formatDateTime: (dateStr) => new Date(dateStr).toLocaleString(),

    // Create button HTML
    btn(label, onclick, type = 'secondary', size = '') {
        const sizeClass = size ? ` btn-${size}` : '';
        return `<button class="btn btn-${type}${sizeClass}" onclick="${onclick}">${label}</button>`;
    },

    // Shorthand for common button types
    actionBtn(label, onclick, type = 'secondary') {
        return UI.btn(label, onclick, type, 'sm');
    },

    // Confirm dialog
    confirm: (message) => window.confirm(message),
};

// ============================================
// TABS - Navigation
// ============================================
const Tabs = {
    init() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => Tabs.switch(btn.dataset.tab));
        });
    },

    switch(tabId) {
        // Update buttons
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelector(`[data-tab="${tabId}"]`)?.classList.add('active');

        // Update content
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        UI.el(tabId)?.classList.add('active');

        // Tab-specific actions
        if (tabId === 'inventory') Inventory.load();
        if (tabId === 'advanced') Advanced.loadItems();
        if (tabId === 'ebay') eBay.loadStatus();
    }
};

// ============================================
// ADD ITEM - Form handling
// ============================================
const AddItem = {
    init() {
        // Input listeners
        UI.el('itemId').addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9]/g, '');
            AddItem.debounceCheck('item');
        });

        UI.el('location').addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9]/g, '');
            State.locationAutoFilled = false;  // User manually edited location
            AddItem.debounceCheck('location');
            AddItem.updatePreview();
        });

        // Form submit
        UI.el('addItemForm').addEventListener('submit', (e) => {
            e.preventDefault();
            AddItem.submit();
        });
    },

    checkTimeout: null,

    debounceCheck(type) {
        clearTimeout(AddItem.checkTimeout);
        AddItem.checkTimeout = setTimeout(() => {
            if (type === 'item') AddItem.checkItemId();
            else AddItem.checkLocation();
        }, 300);
        AddItem.updatePreview();
    },

    updatePreview() {
        const itemId = UI.el('itemId').value.padStart(4, '-');
        const location = UI.el('location').value.padStart(5, '-');
        UI.setText('skuPreview', itemId + location);
    },

    async checkItemId() {
        const itemId = UI.el('itemId').value;
        const statusEl = UI.el('itemStatus');

        if (itemId.length !== 4) {
            statusEl.style.display = 'none';
            // Clear auto-filled location if ID is incomplete
            if (State.locationAutoFilled) {
                UI.el('location').value = '';
                State.locationAutoFilled = false;
                AddItem.updatePreview();
            }
            return;
        }

        try {
            const data = await API.inventory.checkItem(itemId);

            if (data.exists) {
                UI.el('location').value = data.item.DrawerNumber + data.item.PositionNumber;
                UI.el('price').value = data.item.Price || '';
                State.locationAutoFilled = true;
                AddItem.updatePreview();
                statusEl.className = 'location-status exists';
                statusEl.innerHTML = `<strong>Item exists!</strong> Located at ${data.item.FullLocation} with quantity ${data.item.Quantity}. Price: $${parseFloat(data.item.Price || 0).toFixed(2)}. Adding will increase quantity.`;
                statusEl.style.display = 'block';
                UI.setText('submitBtn', 'Add Item');
            } else {
                // Clear location only if it was auto-filled before
                if (State.locationAutoFilled) {
                    UI.el('location').value = '';
                    State.locationAutoFilled = false;
                    AddItem.updatePreview();
                }
                statusEl.className = 'location-status available';
                statusEl.textContent = 'New item - enter location.';
                statusEl.style.display = 'block';
                UI.setText('submitBtn', 'New Item');
            }
        } catch (err) {
            console.error('Error checking item:', err);
        }
    },

    async checkLocation() {
        const location = UI.el('location').value;
        const statusEl = UI.el('itemStatus');

        if (location.length !== 5) return;

        const drawer = location.substring(0, 3);
        const position = location.substring(3, 5);

        try {
            const data = await API.inventory.checkLocation(drawer, position);

            if (data.exists) {
                UI.el('itemId').value = data.item.ItemCode;
                AddItem.updatePreview();
                statusEl.className = 'location-status exists';
                statusEl.innerHTML = `<strong>Location occupied!</strong> Item ${data.item.ItemCode} exists here with quantity ${data.item.Quantity}. Adding will increase quantity.`;
                statusEl.style.display = 'block';
            }
        } catch (err) {
            console.error('Error checking location:', err);
        }
    },

    async submit() {
        const itemId = UI.el('itemId').value;
        const location = UI.el('location').value;
        const price = UI.el('price').value;
        const quantity = UI.el('quantity').value;
        const description = UI.el('description').value;

        if (itemId.length !== 4) {
            UI.notify('Item ID must be 4 digits', 'error');
            return;
        }
        if (location.length !== 5) {
            UI.notify('Location must be 5 digits (3 drawer + 2 position)', 'error');
            return;
        }

        try {
            const data = await API.inventory.add({
                itemId,
                drawer: location.substring(0, 3),
                position: location.substring(3, 5),
                price,
                quantity,
                description
            });

            // Apply pending advanced settings if any
            const pendingAdvanced = Advanced.getPendingSettings();
            if (pendingAdvanced && data.item?.SKU) {
                try {
                    await API.advanced.update(data.item.SKU, pendingAdvanced);
                } catch (advErr) {
                    console.error('Error saving advanced settings:', advErr);
                }
            }

            // Show result
            const resultPanel = UI.el('addResult');
            UI.show(resultPanel);

            UI.setHTML(resultPanel.querySelector('.item-details'), `
                <p><strong>SKU:</strong> ${data.item.SKU}</p>
                <p><strong>Item ID:</strong> ${data.item.ItemCode}</p>
                <p><strong>Location:</strong> ${data.item.FullLocation}</p>
                <p><strong>Price:</strong> $${parseFloat(data.item.Price || 0).toFixed(2)}</p>
                <p><strong>Quantity:</strong> ${data.item.Quantity}</p>
                <p><strong>Description:</strong> ${data.item.Description || 'N/A'}</p>
                ${pendingAdvanced ? '<p><strong>Details:</strong> Category & condition set</p>' : ''}
            `);

            UI.el('barcodeImage').src = data.barcode;
            UI.notify(data.message, 'success');

            // Reset form
            UI.el('addItemForm').reset();
            UI.el('quantity').value = '1';
            UI.el('itemStatus').style.display = 'none';
            UI.setText('submitBtn', 'New Item');
            AddItem.updatePreview();

        } catch (err) {
            UI.notify(err.message, 'error');
        }
    }
};

// ============================================
// LOOKUP - Item lookup and actions
// ============================================
const Lookup = {
    init() {
        UI.el('lookupForm').addEventListener('submit', (e) => {
            e.preventDefault();
            Lookup.search();
        });
    },

    async search() {
        const sku = UI.el('skuInput').value.trim();
        if (!sku) return;

        try {
            const data = await API.inventory.getItem(sku);
            State.currentItem = data.item;

            const resultPanel = UI.el('lookupResult');
            UI.show(resultPanel);

            UI.setHTML(resultPanel.querySelector('.item-details'), `
                <p><strong>SKU:</strong> ${data.item.SKU}</p>
                <p><strong>Location:</strong> Drawer ${data.item.DrawerNumber}, Position ${data.item.PositionNumber}</p>
                <p class="item-price"><strong>Price:</strong> $${parseFloat(data.item.Price || 0).toFixed(2)}</p>
                <p class="item-qty"><strong>Quantity:</strong> ${data.item.Quantity}</p>
                <p><strong>Description:</strong> ${data.item.Description || 'N/A'}</p>
                <p><strong>Added:</strong> ${UI.formatDateTime(data.item.DateAdded)}</p>
                <button class="btn btn-secondary" onclick="History.show('${data.item.SKU}')" style="margin-top: 15px;">View History</button>
            `);

            // Set the price input to current price
            UI.el('adjustPriceInput').value = data.item.Price || '';

            // Fetch and display item details (category, condition)
            try {
                const advData = await API.advanced.get(sku);
                const categoryEl = UI.el('lookupCategory');
                const conditionEl = UI.el('lookupCondition');

                if (advData.CategoryName) {
                    categoryEl.textContent = advData.CategoryName;
                    categoryEl.classList.remove('not-set');
                } else {
                    categoryEl.textContent = 'Not set';
                    categoryEl.classList.add('not-set');
                }

                if (advData.Condition) {
                    conditionEl.textContent = advData.Condition.replace(/_/g, ' ');
                    conditionEl.classList.remove('not-set');
                } else {
                    conditionEl.textContent = 'Not set';
                    conditionEl.classList.add('not-set');
                }
            } catch (advErr) {
                console.error('Error loading item details:', advErr);
            }

            UI.el('lookupBarcodeImage').src = data.barcode;
            UI.notify('Item found!', 'success');

        } catch (err) {
            UI.hide(UI.el('lookupResult'));
            UI.notify(err.message, 'error');
        }
    },

    async adjustQuantity(delta) {
        if (!State.currentItem) return;

        const newQty = parseInt(State.currentItem.Quantity) + delta;
        if (newQty < 0) {
            UI.notify('Quantity cannot be negative', 'error');
            return;
        }

        try {
            await API.inventory.update(State.currentItem.SKU, { quantity: newQty });
            State.currentItem.Quantity = newQty;

            const details = document.querySelector('#lookupResult .item-details');
            const qtyP = details.querySelector('.item-qty');
            qtyP.innerHTML = `<strong>Quantity:</strong> ${newQty}`;

            UI.notify(`Quantity updated to ${newQty}`, 'success');
        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    async updatePrice() {
        if (!State.currentItem) return;

        const newPrice = parseFloat(UI.el('adjustPriceInput').value) || 0;

        try {
            await API.inventory.update(State.currentItem.SKU, { price: newPrice });
            State.currentItem.Price = newPrice;

            const details = document.querySelector('#lookupResult .item-details');
            const priceP = details.querySelector('.item-price');
            priceP.innerHTML = `<strong>Price:</strong> $${newPrice.toFixed(2)}`;

            UI.notify(`Price updated to $${newPrice.toFixed(2)}`, 'success');
        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    async deleteCurrent() {
        if (!State.currentItem) return;
        if (!UI.confirm(`Are you sure you want to delete item ${State.currentItem.SKU}?`)) return;

        try {
            await API.inventory.delete(State.currentItem.SKU);
            UI.hide(UI.el('lookupResult'));
            UI.el('skuInput').value = '';
            State.currentItem = null;
            UI.notify('Item deleted successfully', 'success');
        } catch (err) {
            UI.notify(err.message, 'error');
        }
    }
};

// ============================================
// INVENTORY - Table management
// ============================================
const Inventory = {
    init() {
        UI.el('searchInventory').addEventListener('input', Inventory.filter);
    },

    async load() {
        try {
            const items = await API.inventory.getAll();
            const tbody = document.querySelector('#inventoryTable tbody');
            tbody.innerHTML = '';

            let totalQty = 0;

            items.forEach(item => {
                totalQty += parseInt(item.Quantity) || 0;
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${item.SKU}</td>
                    <td>${item.FullLocation}</td>
                    <td>$${parseFloat(item.Price || 0).toFixed(2)}</td>
                    <td>${item.Quantity}</td>
                    <td>${item.Description || '-'}</td>
                    <td>${UI.formatDate(item.DateAdded)}</td>
                    <td class="action-cell">
                        ${UI.actionBtn('History', `History.show('${item.SKU}')`)}
                        ${UI.actionBtn('View', `Inventory.view('${item.SKU}')`)}
                        ${UI.actionBtn('Delete', `Inventory.delete('${item.SKU}')`, 'danger')}
                    </td>
                `;
                tbody.appendChild(row);
            });

            UI.setText('totalItems', `Total: ${items.length} items`);
            UI.setText('totalQuantity', `Total quantity: ${totalQty}`);

        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    filter(e) {
        const query = e.target.value.toLowerCase();
        document.querySelectorAll('#inventoryTable tbody tr').forEach(row => {
            row.style.display = row.textContent.toLowerCase().includes(query) ? '' : 'none';
        });
    },

    view(sku) {
        UI.el('skuInput').value = sku;
        Tabs.switch('lookup');
        Lookup.search();
    },

    async delete(sku) {
        if (!UI.confirm(`Are you sure you want to delete item ${sku}?`)) return;

        try {
            await API.inventory.delete(sku);
            UI.notify('Item deleted', 'success');
            Inventory.load();
        } catch (err) {
            UI.notify(err.message, 'error');
        }
    }
};

// ============================================
// HISTORY - Transaction history
// ============================================
const History = {
    async show(sku) {
        try {
            const data = await API.inventory.getHistory(sku);

            let html = `
                <div class="history-header">
                    <h3>SKU: ${data.sku}</h3>
                    <p>Current Quantity: <strong>${data.currentQty}</strong></p>
                </div>
                <div class="history-list">
            `;

            if (data.history?.length > 0) {
                [...data.history].reverse().forEach(entry => {
                    const cls = History.getClass(entry.action);
                    const icon = History.getIcon(entry.action);
                    const label = History.getLabel(entry.action);

                    html += `
                        <div class="history-entry ${cls}">
                            <div class="history-icon">${icon}</div>
                            <span class="history-action">${label}</span>
                            <span class="history-qty">${entry.qty >= 0 ? '+' : ''}${entry.qty} → ${entry.newTotal}</span>
                            <span class="history-date">${UI.formatDateTime(entry.date)}</span>
                            ${entry.note ? `<span class="history-note">${entry.note}</span>` : ''}
                        </div>
                    `;
                });
            } else {
                html += '<p class="no-history">No history available</p>';
            }

            html += '</div>';
            UI.setHTML('historyContent', html);
            UI.modal.open('historyModal');

        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    close() {
        UI.modal.close('historyModal');
    },

    getClass(action) {
        const map = {
            CREATE: 'action-create', ADD: 'action-add', ADJUST_UP: 'action-add',
            ADJUST_DOWN: 'action-remove', REMOVE: 'action-remove',
            EBAY_SYNC: 'action-sync', MIGRATE: 'action-migrate'
        };
        return map[action] || '';
    },

    getIcon(action) {
        const map = {
            CREATE: '+', ADD: '+', ADJUST_UP: '↑', ADJUST_DOWN: '↓',
            REMOVE: '-', EBAY_SYNC: '↔', MIGRATE: '→'
        };
        return map[action] || '•';
    },

    getLabel(action) {
        const map = {
            CREATE: 'Item Created', ADD: 'Stock Added', ADJUST_UP: 'Quantity Increased',
            ADJUST_DOWN: 'Quantity Decreased', REMOVE: 'Stock Removed',
            EBAY_SYNC: 'Synced to eBay', MIGRATE: 'Migrated from Excel'
        };
        return map[action] || action;
    }
};

// ============================================
// GENERATORS - Auto-generate IDs
// ============================================
const Generate = {
    async itemId() {
        try {
            const data = await API.inventory.nextItemId();
            UI.el('itemId').value = data.nextId;
            AddItem.updatePreview();
            AddItem.checkItemId();
            UI.notify(`Generated Item ID: ${data.nextId}`, 'success');
        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    async location() {
        try {
            const data = await API.inventory.nextLocation();
            UI.el('location').value = data.nextLocation;
            AddItem.updatePreview();
            UI.notify(`Generated Location: ${data.drawer}-${data.position}`, 'success');
        } catch (err) {
            UI.notify(err.message, 'error');
        }
    }
};

// ============================================
// ADVANCED - Category & Item Specifics (Modal)
// ============================================
const Advanced = {
    selectedCategory: null,
    currentSku: null,
    itemSpecificsDefs: [],
    context: null, // 'add' or 'lookup'
    pendingSettings: null, // Store settings for new items before they're created

    init() {
        // Close modal when clicking outside
        UI.el('advancedModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'advancedModal') {
                Advanced.closeModal();
            }
        });
    },

    openModal(context) {
        Advanced.context = context;
        const modal = UI.el('advancedModal');
        UI.show(modal);

        if (context === 'lookup' && State.currentItem) {
            // Lookup context - load existing item's advanced settings
            Advanced.loadItem(State.currentItem.SKU);
        } else if (context === 'add') {
            // Add context - show pending settings or clear form
            Advanced.currentSku = null;
            const itemId = UI.el('itemId')?.value || '';
            const location = UI.el('location')?.value || '';
            const desc = UI.el('description')?.value || '';

            // Show preview info
            const infoDiv = UI.el('advancedItemInfo');
            infoDiv.querySelector('.advanced-sku').textContent = itemId && location ? `${itemId}${location}` : 'New Item';
            infoDiv.querySelector('.advanced-desc').textContent = desc || 'No description';

            // Load pending settings if any
            if (Advanced.pendingSettings) {
                UI.el('itemCondition').value = Advanced.pendingSettings.condition || '';
                if (Advanced.pendingSettings.categoryId) {
                    Advanced.selectedCategory = {
                        id: Advanced.pendingSettings.categoryId,
                        name: Advanced.pendingSettings.categoryName
                    };
                    Advanced.showSelectedCategory();
                }
            } else {
                Advanced.resetForm();
            }
        }
    },

    closeModal() {
        UI.hide(UI.el('advancedModal'));
    },

    resetForm() {
        UI.el('itemCondition').value = '';
        UI.el('categorySearch').value = '';
        Advanced.selectedCategory = null;
        UI.hide(UI.el('selectedCategory'));
        UI.hide(UI.el('categoryResults'));
        UI.hide(UI.el('itemSpecificsSection'));
        UI.el('itemSpecificsContainer').innerHTML = '';
    },

    async loadItem(sku) {
        if (!sku) {
            Advanced.resetForm();
            return;
        }

        Advanced.currentSku = sku;

        try {
            // Get basic item info
            const data = await API.inventory.getItem(sku);
            const item = data.item;

            // Show item info
            const infoDiv = UI.el('advancedItemInfo');
            infoDiv.querySelector('.advanced-sku').textContent = item.SKU;
            infoDiv.querySelector('.advanced-desc').textContent = item.Description || 'No description';

            // Get advanced settings
            const advData = await API.advanced.get(sku);

            // Set condition
            UI.el('itemCondition').value = advData.Condition || '';

            // Set category
            if (advData.CategoryId) {
                Advanced.selectedCategory = {
                    id: advData.CategoryId,
                    name: advData.CategoryName
                };
                Advanced.showSelectedCategory();

                // Load and fill item specifics
                if (advData.ItemSpecifics) {
                    await Advanced.loadItemSpecifics(advData.CategoryId);
                    Advanced.fillItemSpecifics(advData.ItemSpecifics);
                }
            } else {
                Advanced.selectedCategory = null;
                UI.hide(UI.el('selectedCategory'));
                UI.el('categorySearch').value = '';
                UI.hide(UI.el('itemSpecificsSection'));
            }

        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    async searchCategories() {
        const query = UI.el('categorySearch').value.trim();
        if (!query) {
            UI.notify('Enter a search term', 'error');
            return;
        }

        // Need an eBay account to search categories
        if (State.ebayAccounts.length === 0) {
            UI.notify('Connect an eBay account first (Admin panel)', 'error');
            return;
        }

        const accountId = State.ebayAccounts[0].id;

        try {
            UI.notify('Searching categories...', 'info');
            const result = await API.ebay.searchCategories(accountId, query);

            const resultsDiv = UI.el('categoryResults');
            UI.show(resultsDiv);

            if (!result.categorySuggestions || result.categorySuggestions.length === 0) {
                resultsDiv.innerHTML = '<p style="padding: 15px; color: var(--text-muted);">No categories found</p>';
                return;
            }

            resultsDiv.innerHTML = result.categorySuggestions.map(cat => `
                <div class="category-result-item" onclick="Advanced.selectCategory('${cat.category.categoryId}', '${cat.category.categoryName.replace(/'/g, "\\'")}')">
                    <div class="category-name">${cat.category.categoryName}</div>
                    <div class="category-path">${cat.categoryTreeNodeAncestors?.map(a => a.categoryName).join(' > ') || ''}</div>
                </div>
            `).join('');

        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    async selectCategory(categoryId, categoryName) {
        Advanced.selectedCategory = { id: categoryId, name: categoryName };
        Advanced.showSelectedCategory();
        UI.hide(UI.el('categoryResults'));

        // Load item specifics for this category
        await Advanced.loadItemSpecifics(categoryId);
    },

    showSelectedCategory() {
        const selectedDiv = UI.el('selectedCategory');
        UI.show(selectedDiv);
        selectedDiv.querySelector('.category-name').textContent = Advanced.selectedCategory.name;
    },

    clearCategory() {
        Advanced.selectedCategory = null;
        UI.hide(UI.el('selectedCategory'));
        UI.hide(UI.el('itemSpecificsSection'));
        UI.el('categorySearch').value = '';
        Advanced.itemSpecificsDefs = [];
    },

    async loadItemSpecifics(categoryId) {
        if (State.ebayAccounts.length === 0) return;

        const accountId = State.ebayAccounts[0].id;

        try {
            const result = await API.ebay.getCategoryAspects(accountId, categoryId);

            if (!result.aspects || result.aspects.length === 0) {
                UI.hide(UI.el('itemSpecificsSection'));
                return;
            }

            Advanced.itemSpecificsDefs = result.aspects;
            const container = UI.el('itemSpecificsContainer');
            container.innerHTML = '';

            // Sort: required first, then recommended
            const sortedAspects = [...result.aspects].sort((a, b) => {
                const aReq = a.aspectConstraint?.aspectRequired || false;
                const bReq = b.aspectConstraint?.aspectRequired || false;
                if (aReq && !bReq) return -1;
                if (!aReq && bReq) return 1;
                return 0;
            });

            // Only show first 20 aspects to avoid overwhelming the UI
            const displayAspects = sortedAspects.slice(0, 20);

            displayAspects.forEach(aspect => {
                const isRequired = aspect.aspectConstraint?.aspectRequired || false;
                const hasValues = aspect.aspectValues && aspect.aspectValues.length > 0;
                const fieldId = `aspect_${aspect.localizedAspectName.replace(/[^a-zA-Z0-9]/g, '_')}`;

                let inputHtml;
                if (hasValues && aspect.aspectValues.length <= 50) {
                    // Dropdown for predefined values
                    inputHtml = `
                        <select id="${fieldId}" data-aspect="${aspect.localizedAspectName}">
                            <option value="">-- Select --</option>
                            ${aspect.aspectValues.map(v => `<option value="${v.localizedValue}">${v.localizedValue}</option>`).join('')}
                        </select>
                    `;
                } else {
                    // Text input for free-form
                    inputHtml = `<input type="text" id="${fieldId}" data-aspect="${aspect.localizedAspectName}" placeholder="Enter ${aspect.localizedAspectName}">`;
                }

                container.innerHTML += `
                    <div class="item-specific-field">
                        <label class="${isRequired ? 'required' : ''}">${aspect.localizedAspectName}</label>
                        ${inputHtml}
                    </div>
                `;
            });

            UI.show(UI.el('itemSpecificsSection'));

        } catch (err) {
            console.error('Error loading item specifics:', err);
        }
    },

    fillItemSpecifics(specifics) {
        if (!specifics) return;

        Object.entries(specifics).forEach(([name, value]) => {
            const fieldId = `aspect_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
            const field = UI.el(fieldId);
            if (field) {
                field.value = value;
            }
        });
    },

    getItemSpecifics() {
        const specifics = {};
        const container = UI.el('itemSpecificsContainer');
        const inputs = container.querySelectorAll('input, select');

        inputs.forEach(input => {
            const aspectName = input.dataset.aspect;
            const value = input.value.trim();
            if (aspectName && value) {
                specifics[aspectName] = value;
            }
        });

        return specifics;
    },

    async saveSettings() {
        const condition = UI.el('itemCondition').value;
        const itemSpecifics = Advanced.getItemSpecifics();

        const data = {
            condition: condition || null,
            categoryId: Advanced.selectedCategory?.id || null,
            categoryName: Advanced.selectedCategory?.name || null,
            itemSpecifics: itemSpecifics
        };

        if (Advanced.context === 'add') {
            // Store settings for when item is created
            Advanced.pendingSettings = data;
            UI.notify('Item details saved', 'success');
            Advanced.closeModal();
        } else if (Advanced.context === 'lookup' && Advanced.currentSku) {
            // Save to existing item
            try {
                await API.advanced.update(Advanced.currentSku, data);
                UI.notify('Item details updated!', 'success');
                Advanced.closeModal();
                // Refresh the lookup display
                Lookup.search();
            } catch (err) {
                UI.notify(err.message, 'error');
            }
        } else {
            UI.notify('No item selected', 'error');
        }
    },

    // Get pending settings and clear them (called when creating new item)
    getPendingSettings() {
        const settings = Advanced.pendingSettings;
        Advanced.pendingSettings = null;
        return settings;
    }
};

// ============================================
// EBAY - eBay integration
// ============================================
const eBay = {
    async loadStatus() {
        try {
            const status = await API.ebay.getStatus();
            eBay.updateUI(status);
        } catch (err) {
            console.error('Error loading eBay status:', err);
        }
    },

    updateUI(status) {
        const statusCard = document.querySelector('#ebayStatus .status-card');
        const sections = {
            notConfigured: UI.el('ebayNotConfigured'),
            noAccounts: UI.el('ebayNoAccounts'),
            controls: UI.el('ebayControls')
        };

        // Hide all
        Object.values(sections).forEach(s => UI.hide(s));

        State.ebayAccounts = status.accounts || [];
        State.ebayEnvironment = status.environment || 'sandbox';

        if (!status.configured) {
            statusCard.className = 'status-card not-configured';
            statusCard.innerHTML = `
                <div class="status-icon">!</div>
                <div class="status-info">
                    <h3>eBay API Not Configured</h3>
                    <p>Contact admin to configure eBay credentials</p>
                </div>
            `;
            UI.show(sections.notConfigured);

        } else if (State.ebayAccounts.length === 0) {
            statusCard.className = 'status-card configured';
            statusCard.innerHTML = `
                <div class="status-icon">~</div>
                <div class="status-info">
                    <h3>No eBay Accounts Connected</h3>
                    <p>Environment: ${status.environment}</p>
                </div>
            `;
            UI.show(sections.noAccounts);

        } else {
            const activeCount = State.ebayAccounts.filter(a => a.hasValidToken).length;
            statusCard.className = 'status-card connected';
            statusCard.innerHTML = `
                <div class="status-icon">${activeCount}</div>
                <div class="status-info">
                    <h3>${State.ebayAccounts.length} Account${State.ebayAccounts.length > 1 ? 's' : ''} Connected</h3>
                    <p>Environment: ${status.environment} | ${activeCount} active</p>
                </div>
            `;
            UI.show(sections.controls);
            eBay.populateAccounts();
        }
    },

    populateAccounts() {
        // Selector
        const select = UI.el('accountSelect');
        select.innerHTML = '<option value="">-- Select Account --</option>' +
            State.ebayAccounts.map(acc =>
                `<option value="${acc.id}" ${!acc.hasValidToken ? 'disabled' : ''}>
                    ${acc.name} ${!acc.hasValidToken ? '(Token Expired)' : ''}
                </option>`
            ).join('');

        // List
        UI.setHTML('accountsContainer', State.ebayAccounts.map(acc => `
            <div class="account-card" style="background: var(--bg-card); padding: 15px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
                <div>
                    <strong>${acc.name}</strong>
                    <span style="display: inline-block; padding: 2px 8px; font-size: 0.8rem; margin-left: 10px; ${acc.hasValidToken ? 'color: var(--success);' : 'color: var(--danger);'}">
                        ${acc.hasValidToken ? 'Active' : 'Expired'}
                    </span>
                    <p style="margin: 5px 0 0 0; color: var(--text-muted); font-size: 0.9rem;">
                        ${acc.lastSync ? 'Last sync: ' + UI.formatDateTime(acc.lastSync) : 'Never synced'}
                    </p>
                </div>
            </div>
        `).join(''));
    },

    getSelectedAccount() {
        return UI.el('accountSelect')?.value || '';
    },

    async syncAll() {
        const accountId = eBay.getSelectedAccount();
        if (!accountId) {
            UI.notify('Please select an eBay account first', 'error');
            return;
        }

        const account = State.ebayAccounts.find(a => a.id === accountId);
        if (!UI.confirm(`Sync all inventory items to "${account?.name}"?`)) return;

        UI.notify('Syncing items to eBay...', 'info');

        try {
            const data = await API.ebay.syncAll(accountId);

            const resultsDiv = UI.el('syncResults');
            UI.show(resultsDiv);

            let html = `
                <p><strong>Account:</strong> ${account?.name}</p>
                <p><strong>Successful:</strong> ${data.results.success.length} items</p>
            `;

            // Show eBay sales detected
            if (data.results.sales?.length > 0) {
                const totalSold = data.results.sales.reduce((sum, s) => sum + s.sold, 0);
                html += `
                    <p><strong style="color: var(--info);">eBay Sales Detected:</strong> ${totalSold} items sold</p>
                    <ul style="color: var(--info);">${data.results.sales.map(s => `<li>${s.sku}: ${s.sold} sold (qty now ${s.newQty})</li>`).join('')}</ul>
                `;
            }

            if (data.results.failed.length > 0) {
                html += `
                    <p><strong style="color: var(--danger);">Failed:</strong> ${data.results.failed.length} items</p>
                    <ul style="color: var(--danger);">${data.results.failed.map(f => `<li>${f.sku}: ${f.error}</li>`).join('')}</ul>
                `;
            }

            UI.setHTML(resultsDiv.querySelector('.sync-summary'), html);
            UI.notify(data.message, data.results.failed.length ? 'info' : 'success');
            eBay.loadStatus();
            // Also refresh the eBay inventory list and local inventory
            eBay.loadInventory();
            Inventory.load();

        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    async loadInventory() {
        const accountId = eBay.getSelectedAccount();
        if (!accountId) {
            UI.notify('Please select an eBay account first', 'error');
            return;
        }

        try {
            const data = await API.ebay.getInventory(accountId);
            const inventoryDiv = UI.el('ebayInventory');
            const tbody = document.querySelector('#ebayInventoryTable tbody');

            UI.show(inventoryDiv);
            tbody.innerHTML = '';

            // Determine eBay environment for links
            const ebayBase = State.ebayEnvironment === 'production'
                ? 'https://www.ebay.com'
                : 'https://sandbox.ebay.com';

            if (data.inventoryItems?.length > 0) {
                data.inventoryItems.forEach(item => {
                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td>${item.sku}</td>
                        <td>${item.product?.title || '-'}</td>
                        <td>${item.availability?.shipToLocationAvailability?.quantity || 0}</td>
                        <td>${item.condition || '-'}</td>
                        <td>
                            <a href="${ebayBase}/sh/lst/active?q=${encodeURIComponent(item.sku)}" target="_blank" class="btn btn-sm btn-secondary">View</a>
                        </td>
                    `;
                    tbody.appendChild(row);
                });
            } else {
                tbody.innerHTML = '<tr><td colspan="5">No items found on eBay</td></tr>';
            }

            UI.notify('eBay inventory loaded', 'success');
        } catch (err) {
            UI.notify(err.message, 'error');
        }
    }
};

// ============================================
// GLOBAL FUNCTIONS - For onclick handlers
// ============================================
const generateNextItemId = () => Generate.itemId();
const generateNextLocation = () => Generate.location();
const adjustQuantity = (delta) => Lookup.adjustQuantity(delta);
const updatePrice = () => Lookup.updatePrice();
const deleteCurrentItem = () => Lookup.deleteCurrent();
const closeHistoryModal = () => History.close();
const openAdvancedModal = (context) => Advanced.openModal(context);
const closeAdvancedModal = () => Advanced.closeModal();
const syncAllToEbay = () => eBay.syncAll();
const loadEbayInventory = () => eBay.loadInventory();
const printBarcode = () => window.print();
const getAdjustQty = () => parseInt(UI.el('adjustQtyInput')?.value) || 1;

// Full backup import
async function importFullBackup(input) {
    const file = input.files[0];
    if (!file) return;

    try {
        UI.notify('Reading backup file...', 'info');
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.inventory || !Array.isArray(data.inventory)) {
            throw new Error('Invalid backup file format');
        }

        UI.notify(`Importing ${data.inventory.length} items...`, 'info');

        const response = await API.post('/api/import/full', data);
        UI.notify(response.message, 'success');

        // Refresh inventory view
        Inventory.load();
    } catch (err) {
        UI.notify('Import failed: ' + err.message, 'error');
    }

    // Reset file input
    input.value = '';
}

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    Tabs.init();
    AddItem.init();
    Lookup.init();
    Inventory.init();
    Advanced.init();

    // Load eBay status to populate accounts (needed for Advanced tab)
    eBay.loadStatus();

    // Modal close handlers
    document.addEventListener('click', (e) => {
        if (e.target.id === 'historyModal') History.close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') History.close();
    });

    // Initial focus
    UI.el('skuInput')?.focus();

    // Load eBay status
    eBay.loadStatus();
});
