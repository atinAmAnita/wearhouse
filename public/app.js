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
// SEARCH — word-order independent, but strict per word
// ============================================
// "rear view mirror for toyota pickup" matches "Toyota Pick Up Mirror Rear View".
// Rules (strict but not exact-phrase):
//   - query split into words; filler words ("for", "the"...) dropped
//   - EVERY remaining query word must match a word in the item — order doesn't matter
//   - a word matches only a whole word or the START of a word ("mirr" → "mirror",
//     but "ram" does NOT match "ceramic")
//   - compounds handled both ways: "pickup" ↔ "pick up" (adjacent words joined)
const Search = {
    STOP_WORDS: new Set(['for', 'the', 'a', 'an', 'of', 'and', 'or', 'with', 'to', 'in', 'on', 'at', 'by']),

    tokenize(s) {
        return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    },

    matches(text, query) {
        const qWords = this.tokenize(query).filter(w => !this.STOP_WORDS.has(w));
        if (qWords.length === 0) return true;

        const tWords = this.tokenize(text);
        // Add joined adjacent pairs so text "pick up" also exposes the token "pickup".
        const tTokens = new Set(tWords);
        for (let i = 0; i < tWords.length - 1; i++) tTokens.add(tWords[i] + tWords[i + 1]);

        const wordHits = (w) => {
            // 1-2 letter words must match a whole word exactly ("f" shouldn't hit "ford",
            // "front", "fits"...). Prefix matching only kicks in from 3 letters ("mirr" → "mirror").
            const allowPrefix = w.length >= 3;
            for (const tok of tTokens) {
                if (tok === w || (allowPrefix && tok.startsWith(w))) return true;
            }
            return false;
        };

        // Each query word must hit; a miss may consume the NEXT query word as a
        // compound ("pick"+"up" → "pickup") before failing.
        for (let i = 0; i < qWords.length; i++) {
            if (wordHits(qWords[i])) continue;
            if (i + 1 < qWords.length && wordHits(qWords[i] + qWords[i + 1])) { i++; continue; }
            return false;
        }
        return true;
    }
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
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const err = new Error(data.error || 'Request failed');
            err.status = response.status;
            err.details = data.details;
            throw err;
        }
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
        getAll: (filter = 'all') => API.get(`/api/inventory?filter=${filter}`),
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
        pull: (accountId) => API.post(`/api/ebay/pull/${accountId}`),
        syncAll: (accountId) => API.post(`/api/ebay/sync-all/${accountId}`),
        publishAll: (accountId) => API.post(`/api/ebay/publish-all/${accountId}`),
        getPolicies: (accountId) => API.get(`/api/ebay/policies/${accountId}`),
        searchCategories: (accountId, query) => API.get(`/api/ebay/categories/search/${accountId}?q=${encodeURIComponent(query)}`),
        getCategoryAspects: (accountId, categoryId) => API.get(`/api/ebay/categories/${categoryId}/aspects/${accountId}`),
    },

    // Advanced settings endpoints
    advanced: {
        get: (sku) => API.get(`/api/inventory/${sku}/advanced`),
        update: (sku, data) => API.put(`/api/inventory/${sku}/advanced`, data),
    },

    // Pending updates endpoints
    updates: {
        getAll: (status = 'pending') => API.get(`/api/updates?status=${status}`),
        getCount: () => API.get('/api/updates/count'),
        dismiss: (id) => API.put(`/api/updates/${id}/dismiss`),
        dismissAll: () => API.put('/api/updates/dismiss-all'),
        apply: (id, accountId) => API.post(`/api/updates/${id}/apply`, { accountId }),
        undo: (undoData) => API.post('/api/updates/undo', undoData),
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

    // Wrap an async operation behind a button: disable during run, enforce min 2s cooldown,
    // handle 409 "sync in progress" gracefully. Returns the handler's result (or rethrows).
    async withButtonLock(btn, fn, opts = {}) {
        if (!btn) return fn();
        if (btn.disabled) return; // prevent double-clicks
        const cooldownMs = opts.cooldownMs ?? 2000;
        const originalHTML = btn.innerHTML;
        btn.disabled = true;
        const start = Date.now();
        try {
            return await fn();
        } catch (err) {
            // 409 Sync in progress — friendly message, keep cooldown
            if (err?.message?.includes('Sync already in progress') || err?.status === 409) {
                UI.notify(err.message || 'Sync already in progress, please wait', 'warning');
            } else {
                throw err;
            }
        } finally {
            const elapsed = Date.now() - start;
            setTimeout(() => {
                btn.disabled = false;
                if (opts.restoreHTML !== false) btn.innerHTML = originalHTML;
            }, Math.max(0, cooldownMs - elapsed));
        }
    },

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
        if (tabId === 'ebay') eBay.loadStatus();
        if (tabId === 'updates') Updates.load();
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
        const itemId = UI.el('itemId').value.padStart(6, '-');
        const location = UI.el('location').value.padStart(7, '-');
        UI.setText('skuPreview', itemId + location);
    },

    async checkItemId() {
        const itemId = UI.el('itemId').value;
        const statusEl = UI.el('itemStatus');

        if (itemId.length !== 6) {
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

        if (location.length !== 7) return;

        const drawer = location.substring(0, 3);
        const position = location.substring(3, 7);

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

        if (itemId.length !== 6) {
            UI.notify('Item ID must be 6 digits', 'error');
            return;
        }
        if (location.length !== 7) {
            UI.notify('Location must be 7 digits (3 drawer + 4 position)', 'error');
            return;
        }

        // Items must be tagged to a specific account.
        const activeAccountId = eBay.getActiveAccountId();
        if (!activeAccountId) {
            UI.notify('Pick an account in the header before adding items', 'error');
            return;
        }

        try {
            const data = await API.inventory.add({
                itemId,
                drawer: location.substring(0, 3),
                position: location.substring(3, 7),
                price,
                quantity,
                description,
                accountId: activeAccountId
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

            const detailsEl = resultPanel.querySelector('.item-details');
            if (detailsEl) {
                detailsEl.innerHTML = `
                    <p><strong>SKU:</strong> ${data.item.SKU}</p>
                    <p><strong>Item ID:</strong> ${data.item.ItemCode}</p>
                    <p><strong>Location:</strong> ${data.item.FullLocation}</p>
                    <p><strong>Price:</strong> $${parseFloat(data.item.Price || 0).toFixed(2)}</p>
                    <p><strong>Quantity:</strong> ${data.item.Quantity}</p>
                    <p><strong>Description:</strong> ${data.item.Description || 'N/A'}</p>
                    ${pendingAdvanced ? '<p><strong>Details:</strong> Category & condition set</p>' : ''}
                `;
            }

            UI.el('barcodeImage').src = data.barcode;
            UI.notify(data.message, 'success');
            Updates.refreshBadge();

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

            const lookupDetailsEl = resultPanel.querySelector('.item-details');
            if (lookupDetailsEl) {
                const imageHtml = data.item.ImageUrl
                    ? `<div class="item-image">
                        <img src="${data.item.ImageUrl}" alt="${data.item.SKU}" onerror="this.parentElement.querySelector('img').style.display='none'">
                        <button class="btn btn-sm" onclick="Lookup.uploadPhoto()" style="margin-top:5px;font-size:0.8rem;">Change Photo</button>
                       </div>`
                    : `<div class="item-image">
                        <div style="width:200px;height:120px;background:var(--bg-input);border:2px dashed var(--border-color);border-radius:8px;display:flex;align-items:center;justify-content:center;margin:0 auto;cursor:pointer;" onclick="Lookup.uploadPhoto()">
                            <span style="color:var(--text-muted);font-size:0.9rem;">+ Add Photo</span>
                        </div>
                       </div>`;
                lookupDetailsEl.innerHTML = `
                    ${imageHtml}
                    <input type="file" id="photoUploadInput" accept="image/*" style="display:none" onchange="Lookup.handlePhotoUpload(event)">
                    <p><strong>SKU:</strong> ${data.item.SKU}</p>
                    <p><strong>Location:</strong> Drawer ${data.item.DrawerNumber}, Position ${data.item.PositionNumber}</p>
                    <p class="item-price"><strong>Price:</strong> $${parseFloat(data.item.Price || 0).toFixed(2)}</p>
                    <p class="item-qty"><strong>Quantity:</strong> ${data.item.Quantity}</p>
                    <p><strong>Description:</strong> ${data.item.Description || 'N/A'}</p>
                    <p><strong>Added:</strong> ${UI.formatDateTime(data.item.DateAdded)}</p>
                    <button class="btn btn-secondary" onclick="History.show('${data.item.SKU}')" style="margin-top: 15px;">View History</button>
                `;
            }

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

    uploadPhoto() {
        if (!State.currentItem) return;
        UI.el('photoUploadInput')?.click();
    },

    async handlePhotoUpload(event) {
        const file = event.target.files[0];
        if (!file || !State.currentItem) return;

        const accountId = eBay.getSelectedAccount();
        if (!accountId) {
            UI.notify('Select an eBay account first (eBay Sync tab)', 'error');
            return;
        }

        UI.notify('Uploading photo to eBay...', 'info');

        try {
            const formData = new FormData();
            formData.append('image', file);
            const response = await fetch(`/api/ebay/upload-image/${accountId}`, { method: 'POST', body: formData });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error);

            // Save the eBay-hosted URL to the item
            await fetch(`/api/inventory/${State.currentItem.SKU}/image`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageUrl: result.imageUrl })
            });

            State.currentItem.ImageUrl = result.imageUrl;
            UI.notify('Photo uploaded!', 'success');
            // Refresh the item view
            this.search(State.currentItem.SKU);
        } catch (err) {
            UI.notify('Upload failed: ' + err.message, 'error');
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
            // Update local state so successive clicks stack correctly
            State.currentItem.Quantity = newQty;
            const qtyEl = document.querySelector('#lookupResult .qty-display, #currentQty');
            if (qtyEl) qtyEl.textContent = newQty;
            UI.notify(`Quantity change queued (${newQty - delta} → ${newQty})`, 'success');
            Updates.refreshBadge();
        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    async updatePrice() {
        if (!State.currentItem) return;

        const newPrice = parseFloat(UI.el('adjustPriceInput').value) || 0;

        try {
            await API.inventory.update(State.currentItem.SKU, { price: newPrice });
            // Update local state so successive changes track correctly
            const oldPrice = State.currentItem.Price;
            State.currentItem.Price = newPrice;
            UI.notify(`Price change queued ($${oldPrice.toFixed(2)} → $${newPrice.toFixed(2)})`, 'success');
            Updates.refreshBadge();
        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    async deleteCurrent() {
        if (!State.currentItem) return;
        if (!UI.confirm(`Are you sure you want to queue deletion of item ${State.currentItem.SKU}?`)) return;

        try {
            await API.inventory.delete(State.currentItem.SKU);
            UI.notify('Delete queued — apply in Updates tab', 'success');
            Updates.refreshBadge();
        } catch (err) {
            UI.notify(err.message, 'error');
        }
    }
};

// ============================================
// INVENTORY - Table management
// ============================================
const Inventory = {
    // State
    allItems: [],
    filteredItems: [],
    currentPage: 1,
    pageSize: 20,
    sortField: 'dateAdded',
    sortDir: 'desc',
    searchQuery: '',

    init() {
        // No longer need the old event listener
    },

    applyFilter() {
        this.currentPage = 1;
        this.load();
    },

    sortBy(field) {
        // Toggle direction if same field, otherwise default to asc
        if (this.sortField === field) {
            this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortField = field;
            this.sortDir = 'asc';
        }
        // Update dropdown to match
        const sortValue = `${field}-${this.sortDir}`;
        const sortSelect = UI.el('inventorySort');
        if (sortSelect) {
            // Find matching option or keep current
            for (let opt of sortSelect.options) {
                if (opt.value === sortValue) {
                    sortSelect.value = sortValue;
                    break;
                }
            }
        }
        this.render();
    },

    changePageSize() {
        this.pageSize = parseInt(UI.el('inventoryPageSize')?.value) || 20;
        this.currentPage = 1;
        this.render();
    },

    search() {
        this.searchQuery = (UI.el('searchInventory')?.value || '').toLowerCase();
        this.currentPage = 1;
        this.render();
    },

    prevPage() {
        if (this.currentPage > 1) {
            this.currentPage--;
            this.render();
        }
    },

    nextPage() {
        const totalPages = Math.ceil(this.getDisplayItems().length / this.pageSize);
        if (this.currentPage < totalPages) {
            this.currentPage++;
            this.render();
        }
    },

    getDisplayItems() {
        let items = [...this.allItems];

        // Apply search filter (word-order independent, see Search.matches)
        if (this.searchQuery) {
            items = items.filter(item =>
                Search.matches(`${item.SKU} ${item.FullLocation} ${item.Description || ''}`, this.searchQuery)
            );
        }

        // Account isolation: no account selected → no items shown.
        const activeAccount = eBay.getActiveAccountId();
        if (!activeAccount) return [];
        items = items.filter(i => i.EbayAccountId === activeAccount);

        // Apply sorting
        items.sort((a, b) => {
            let aVal, bVal;
            switch (this.sortField) {
                case 'sku':
                    aVal = a.SKU || '';
                    bVal = b.SKU || '';
                    break;
                case 'location':
                    aVal = a.FullLocation || '';
                    bVal = b.FullLocation || '';
                    break;
                case 'price':
                    aVal = parseFloat(a.Price) || 0;
                    bVal = parseFloat(b.Price) || 0;
                    break;
                case 'quantity':
                    aVal = parseInt(a.Quantity) || 0;
                    bVal = parseInt(b.Quantity) || 0;
                    break;
                case 'dateAdded':
                default:
                    aVal = new Date(a.DateAdded || 0);
                    bVal = new Date(b.DateAdded || 0);
            }
            if (aVal < bVal) return this.sortDir === 'asc' ? -1 : 1;
            if (aVal > bVal) return this.sortDir === 'asc' ? 1 : -1;
            return 0;
        });

        return items;
    },

    async load() {
        try {
            const filter = UI.el('inventoryFilter')?.value || 'all';
            this.allItems = await API.inventory.getAll(filter);
            this.render();
        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    render() {
        const tbody = document.querySelector('#inventoryTable tbody');
        // Hard guard: no account selected → empty table with a prompt row.
        if (!eBay.getActiveAccountId()) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--text-muted);">Pick an account in the header to view items.</td></tr>';
            UI.setText('totalItems', '0 items');
            UI.setText('totalQuantity', '0 total qty');
            UI.setText('pageInfo', 'Page 1 of 1');
            return;
        }
        const displayItems = this.getDisplayItems();
        const totalPages = Math.ceil(displayItems.length / this.pageSize) || 1;

        if (this.currentPage > totalPages) this.currentPage = totalPages;
        if (this.currentPage < 1) this.currentPage = 1;

        const startIdx = (this.currentPage - 1) * this.pageSize;
        const endIdx = startIdx + this.pageSize;
        const pageItems = displayItems.slice(startIdx, endIdx);

        tbody.innerHTML = '';

        let totalQty = 0;
        this.allItems.forEach(item => {
            totalQty += parseInt(item.Quantity) || 0;
        });

        // Build pending-SKU set once per render (Point 13 sync status column)
        const pendingSkus = new Set((Updates.allUpdates || []).map(u => u.sku));

        pageItems.forEach(item => {
            const row = document.createElement('tr');
            const thumb = item.ImageUrl
                ? `<img src="${item.ImageUrl}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:4px;" onerror="this.style.display='none'">`
                : '<span style="display:inline-block;width:36px;height:36px;background:var(--bg-input);border-radius:4px;"></span>';

            // Sync status icon
            let syncIcon, syncTitle;
            if (pendingSkus.has(item.SKU)) { syncIcon = '⏳'; syncTitle = 'Pending update'; }
            else if (item.EbayStatus === 'error') { syncIcon = '⚠️'; syncTitle = 'Sync error'; }
            else if (item.EbayItemId) { syncIcon = '✓'; syncTitle = 'Synced to eBay'; }
            else { syncIcon = '○'; syncTitle = 'Not on eBay'; }

            // Low stock row highlight (Point 14)
            const threshold = item.LowStockThreshold ?? 2;
            const isLowStock = parseInt(item.Quantity) <= threshold && item.EbayItemId;
            const rowStyle = isLowStock ? 'style="background:rgba(249, 168, 37, 0.08);"' : '';

            row.innerHTML = `
                <td class="cell-thumb" style="width:40px;padding:4px;" ${rowStyle}>${thumb}</td>
                <td data-label="Sync" style="text-align:center;" title="${syncTitle}">${syncIcon}</td>
                <td data-label="SKU">${item.SKU}</td>
                <td data-label="Location">${item.FullLocation}</td>
                <td data-label="Price">$${parseFloat(item.Price || 0).toFixed(2)}</td>
                <td data-label="Qty">${item.Quantity}${isLowStock ? ' <span style="color:#f9a825;font-size:0.8rem;">⚠ low</span>' : ''}</td>
                <td data-label="Description">${item.Description || '-'}</td>
                <td data-label="Added">${UI.formatDate(item.DateAdded)}</td>
                <td class="action-cell" data-label="Actions">
                    ${UI.actionBtn('History', `History.show('${item.SKU}')`)}
                    ${UI.actionBtn('View', `Inventory.view('${item.SKU}')`)}
                    ${UI.actionBtn('Delete', `Inventory.delete('${item.SKU}')`, 'danger')}
                </td>
            `;
            if (isLowStock) row.style.background = 'rgba(249, 168, 37, 0.08)';
            tbody.appendChild(row);
        });

        // Update stats
        UI.setText('totalItems', `${this.allItems.length} items`);
        UI.setText('totalQuantity', `${totalQty} total qty`);
        // Low-stock count (Point 14)
        const lowStockCount = this.allItems.filter(i => {
            const t = i.LowStockThreshold ?? 2;
            return parseInt(i.Quantity) <= t && i.EbayItemId;
        }).length;
        UI.setText('lowStockCount', lowStockCount > 0 ? `${lowStockCount} low stock` : '');

        // Update pagination
        UI.setText('pageInfo', `Page ${this.currentPage} of ${totalPages}`);
        UI.el('prevPageBtn').disabled = this.currentPage <= 1;
        UI.el('nextPageBtn').disabled = this.currentPage >= totalPages;

        // Update sort indicators on headers
        document.querySelectorAll('#inventoryTable th.sortable').forEach(th => {
            th.classList.remove('asc', 'desc');
        });
        const headerMap = { sku: 0, location: 1, price: 2, quantity: 3, dateAdded: 5 };
        const idx = headerMap[this.sortField];
        if (idx !== undefined) {
            const th = document.querySelectorAll('#inventoryTable th.sortable')[Object.keys(headerMap).indexOf(this.sortField)];
            if (th) th.classList.add(this.sortDir);
        }
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
                            <span class="history-qty">${entry.action === 'PRICE_CHANGE' ? `$${entry.newTotal - entry.qty} ${entry.qty >= 0 ? '+' : '-'} $${Math.abs(entry.qty)}` : `${entry.newTotal - entry.qty} ${entry.qty >= 0 ? '+' : '-'} ${Math.abs(entry.qty)}`}</span>
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
            EBAY_SYNC: 'action-sync', MIGRATE: 'action-migrate', PRICE_CHANGE: 'action-add',
            EBAY_SALE: 'action-remove', EBAY_SALE_REBASED: 'action-remove',
            EBAY_IMPORT: 'action-sync', SKU_CHANGE: 'action-migrate'
        };
        return map[action] || '';
    },

    getIcon(action) {
        const map = {
            CREATE: '+', ADD: '+', ADJUST_UP: '↑', ADJUST_DOWN: '↓',
            REMOVE: '-', EBAY_SYNC: '↔', MIGRATE: '→', PRICE_CHANGE: '$',
            EBAY_SALE: '🛒', EBAY_SALE_REBASED: '🛒', EBAY_IMPORT: '↔', SKU_CHANGE: '#'
        };
        return map[action] || '•';
    },

    getLabel(action) {
        const map = {
            CREATE: 'Item Created', ADD: 'Stock Added', ADJUST_UP: 'Quantity Increased',
            ADJUST_DOWN: 'Quantity Decreased', REMOVE: 'Stock Removed',
            EBAY_SYNC: 'Synced to eBay', MIGRATE: 'Migrated from Excel', PRICE_CHANGE: 'Price Changed',
            EBAY_SALE: 'Sold on eBay', EBAY_SALE_REBASED: 'Sold on eBay (update rebased)',
            EBAY_IMPORT: 'Imported from eBay', SKU_CHANGE: 'SKU Changed'
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
        const stored = localStorage.getItem('selectedEbayAccount') || '';
        const activeAccounts = State.ebayAccounts.filter(a => a.hasValidToken);
        const optionsHtml = '<option value="">-- Select Account --</option>' +
            State.ebayAccounts.map(acc =>
                `<option value="${acc.id}" ${!acc.hasValidToken ? 'disabled' : ''}>${acc.name}${!acc.hasValidToken ? ' (Token Expired)' : ''}</option>`
            ).join('');

        // Legacy eBay-tab selector is gone; guard in case it exists in an older shell.
        const select = UI.el('accountSelect');
        if (select) select.innerHTML = optionsHtml;

        // Global header selector — the single account control. No "All accounts".
        const globalSel = UI.el('globalAccountSelect');
        if (globalSel) globalSel.innerHTML = optionsHtml;

        // Pick initial selection: prefer stored; else auto-pick the sole active account.
        let initial = '';
        const validIds = new Set(activeAccounts.map(a => a.id));
        if (stored && validIds.has(stored)) {
            initial = stored;
        } else if (activeAccounts.length === 1) {
            initial = activeAccounts[0].id;
        }
        eBay.setActiveAccount(initial, { silent: true });
        if (select) select.onchange = () => eBay.setActiveAccount(select.value);

        // List
        UI.setHTML('accountsContainer', State.ebayAccounts.map(acc => `
            <div class="account-card" style="background: var(--bg-card); padding: 15px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
                <div>
                    <strong>${acc.name}</strong>
                    <span style="display: inline-block; padding: 2px 8px; font-size: 0.8rem; margin-left: 10px; ${acc.hasValidToken ? 'color: var(--success);' : 'color: var(--danger);'}">
                        ${acc.hasValidToken ? 'Active' : 'Expired'}
                    </span>
                    ${acc.tokenError ? `<p style="margin: 5px 0 0 0; color: var(--danger); font-size: 0.85rem;">${acc.tokenError}</p>` : ''}
                    <p style="margin: 5px 0 0 0; color: var(--text-muted); font-size: 0.9rem;">
                        ${acc.lastSync ? 'Last sync: ' + UI.formatDateTime(acc.lastSync) : 'Never synced'}
                    </p>
                </div>
                <div style="display:flex; align-items:center; gap:15px;">
                    <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer; user-select:none; font-size:0.85rem; color:var(--text-muted);" title="Auto-sync every 15 min via cron. Turn off if you don't want this account to sync automatically.">
                        <input type="checkbox" ${acc.cronEnabled !== false ? 'checked' : ''} onchange="eBay.toggleCron('${acc.id}', this.checked)" style="width:16px;height:16px;cursor:pointer;" ${!acc.hasValidToken ? 'disabled' : ''}>
                        Auto-sync
                    </label>
                    ${!acc.hasValidToken ? `<a href="/admin" style="color: var(--danger); font-size: 0.85rem; text-decoration: underline;">Reconnect</a>` : ''}
                </div>
            </div>
        `).join(''));
    },

    async toggleCron(accountId, enabled) {
        try {
            await API.put(`/api/ebay/accounts/${accountId}/cron`, { enabled });
            UI.notify(`Auto-sync ${enabled ? 'enabled' : 'disabled'}`, 'success');
            // Update local state so subsequent renders show the new value
            const acc = State.ebayAccounts.find(a => a.id === accountId);
            if (acc) acc.cronEnabled = enabled;
        } catch (err) {
            UI.notify('Failed to toggle auto-sync: ' + err.message, 'error');
            // Reload to revert the checkbox visual
            eBay.loadStatus();
        }
    },

    // Operational selector for eBay API calls — '' = none picked.
    // Falls back to localStorage so ops work from any tab after refresh.
    getSelectedAccount() {
        return UI.el('accountSelect')?.value || localStorage.getItem('selectedEbayAccount') || '';
    },

    // Active account ID — empty string when no account is selected.
    // No "all" mode: account isolation is enforced.
    getActiveAccountId() {
        return UI.el('globalAccountSelect')?.value || localStorage.getItem('selectedEbayAccount') || '';
    },

    // Single entry point for changing the active account. Mirrors both selectors,
    // persists to localStorage, updates the hint, and re-renders dependent tabs.
    setActiveAccount(accountId, opts = {}) {
        const stored = accountId || '';
        localStorage.setItem('selectedEbayAccount', stored);

        const opSel = UI.el('accountSelect');
        if (opSel) {
            const opt = [...opSel.options].find(o => o.value === stored);
            if (opt && !opt.disabled) opSel.value = stored;
            else if (!stored) opSel.value = '';
        }
        const globalSel = UI.el('globalAccountSelect');
        if (globalSel) globalSel.value = stored;

        const hint = UI.el('globalAccountHint');
        if (hint) {
            if (!stored) {
                hint.textContent = 'Pick an account to view items';
                hint.style.color = '#fbbf24';
            } else {
                const acc = State.ebayAccounts.find(a => a.id === stored);
                hint.textContent = acc ? `Showing ${acc.name}` : 'Showing selected account';
                hint.style.color = '#f97316';
            }
        }
        // Show the "pick an account" banner only when nothing is selected.
        const banner = UI.el('noAccountBanner');
        if (banner) banner.classList.toggle('hidden', !!stored);
        // Reflect the active account on the eBay Sync tab (the per-tab dropdown is gone).
        const opLabel = UI.el('ebayActiveAccountLabel');
        if (opLabel) {
            const acc = State.ebayAccounts.find(a => a.id === stored);
            opLabel.textContent = stored ? (acc ? acc.name : 'selected account') : 'none — pick one above';
        }

        if (!opts.silent) {
            Inventory.render?.();
            Updates.applyFilters?.();
            const ebayInvWasOpen = !UI.el('ebayInventory')?.classList.contains('hidden');
            eBay.clearAccountScopedUI();
            if (ebayInvWasOpen && stored) eBay.loadInventory();
        }
    },

    // Clear all eBay Sync tab UI that was scoped to a specific account.
    clearAccountScopedUI() {
        const tbody = document.querySelector('#ebayInventoryTable tbody');
        if (tbody) tbody.innerHTML = '';
        ['ebayInventory', 'comparisonResults', 'syncResults'].forEach(id => {
            const el = UI.el(id);
            if (el) el.classList.add('hidden');
        });
        this.comparisonData = null;
    },

    // Display sync results in the UI
    showSyncResults(data, operation) {
        const resultsDiv = UI.el('syncResults');
        UI.show(resultsDiv);

        // Update summary cards
        const summary = data.summary || {};
        UI.setHTML('importedCount', summary.imported || summary.created || 0);
        UI.setHTML('exportedCount', summary.exported || summary.pushed || 0);
        UI.setHTML('updatedCount', summary.updated || 0);
        UI.setHTML('salesCount', summary.sales || 0);

        // Show/hide errors card (if element exists)
        const errorsCard = UI.el('errorsCard');
        if (errorsCard) {
            if (summary.errors > 0) {
                UI.setHTML('errorsCount', summary.errors);
                errorsCard.style.display = 'block';
            } else {
                errorsCard.style.display = 'none';
            }
        }

        // Build details HTML
        const details = data.details || {};
        let detailsHtml = `<p style="margin-bottom: 10px;"><strong>${operation}:</strong> ${data.message}</p>`;

        if (details.imported?.length > 0 || details.created?.length > 0) {
            const items = details.imported || details.created || [];
            detailsHtml += `<details><summary style="cursor: pointer; font-weight: bold; color: #2e7d32;">Imported from eBay (${items.length})</summary><ul>${items.map(i => `<li>${i.sku}: ${i.title || ''}</li>`).join('')}</ul></details>`;
        }

        if (details.exported?.length > 0 || details.pushed?.length > 0) {
            const items = details.exported || details.pushed || [];
            detailsHtml += `<details><summary style="cursor: pointer; font-weight: bold; color: #1565c0;">Exported to eBay (${items.length})</summary><ul>${items.map(i => `<li>${i.sku}: ${i.title || ''}</li>`).join('')}</ul></details>`;
        }

        if (details.updated?.length > 0) {
            detailsHtml += `<details><summary style="cursor: pointer; font-weight: bold; color: #e65100;">Updated (${details.updated.length})</summary><ul>${details.updated.map(i => `<li>${i.sku}: ${i.fields?.join(', ') || 'synced'}</li>`).join('')}</ul></details>`;
        }

        if (details.sales?.length > 0) {
            const totalSold = details.sales.reduce((sum, s) => sum + s.sold, 0);
            detailsHtml += `<details open><summary style="cursor: pointer; font-weight: bold; color: #c2185b;">eBay Sales Detected (${totalSold} items sold)</summary><ul>${details.sales.map(s => `<li>${s.sku}: ${s.sold} sold (qty now ${s.newQty})</li>`).join('')}</ul></details>`;
        }

        if (details.errors?.length > 0) {
            detailsHtml += `<details open><summary style="cursor: pointer; font-weight: bold; color: #c62828;">Errors (${details.errors.length})</summary><ul>${details.errors.map(e => `<li>${e.sku}: ${e.error}</li>`).join('')}</ul></details>`;
        }

        if (details.skipped?.length > 0) {
            detailsHtml += `<details><summary style="cursor: pointer; color: #666;">Skipped (${details.skipped.length})</summary><ul>${details.skipped.map(s => `<li>${s.sku}: ${s.reason || 'No changes'}</li>`).join('')}</ul></details>`;
        }

        UI.setHTML('syncDetails', detailsHtml);
    },

    // Pull from eBay — HARD OVERWRITE of local database with eBay values (Point 17)
    async pull() {
        const accountId = eBay.getSelectedAccount();
        if (!accountId) {
            UI.notify('Please select an eBay account first', 'error');
            return;
        }

        const account = State.ebayAccounts.find(a => a.id === accountId);

        // Safety: if there are pending updates, warn loudly
        let pendingCount = 0;
        try {
            const updatesData = await API.get('/api/updates');
            pendingCount = (updatesData.updates || []).length;
        } catch (_) { /* ignore */ }

        let msg = `Refresh local data from "${account?.name}" with eBay's current state?\n\n`;
        msg += `This is safe: eBay sales are recorded, and eBay values are only applied to fields you haven't changed locally. Your pending updates are kept.`;
        if (pendingCount > 0) msg += `\n\n(${pendingCount} pending update${pendingCount === 1 ? '' : 's'} will remain in the Updates tab.)`;
        if (!confirm(msg)) {
            UI.notify('Pull cancelled', 'info');
            return;
        }

        UI.notify('Refreshing from eBay...', 'info');
        const btn = UI.el('pullBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Pulling...'; }
        const startTime = Date.now();
        try {
            const data = await API.ebay.pull(accountId);
            eBay.showSyncResults(data, 'Pull from eBay');
            UI.notify(data.message, data.summary?.errors > 0 ? 'info' : 'success');
            eBay.loadStatus();
            Inventory.load();
        } catch (err) {
            UI.notify(err.message, err.message?.includes('Sync already in progress') ? 'warning' : 'error');
        } finally {
            setTimeout(() => {
                if (btn) { btn.disabled = false; btn.textContent = 'Pull from eBay (Refresh)'; }
            }, Math.max(0, 2000 - (Date.now() - startTime)));
        }
    },

    // Push Pending Updates — shortcut for Updates → Apply All (Point 17)
    async push() {
        const accountId = eBay.getSelectedAccount();
        if (!accountId) {
            UI.notify('Please select an eBay account first', 'error');
            return;
        }

        // Load fresh pending updates list
        try {
            const updatesData = await API.get('/api/updates');
            const pending = updatesData.updates || [];
            if (pending.length === 0) {
                UI.notify('No pending updates to push. Use "Compare with eBay" to detect changes or edit items locally first.', 'info');
                return;
            }
            if (!Updates.allUpdates || Updates.allUpdates.length !== pending.length) {
                await Updates.load();
            }
            return Updates.applyAll();
        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    // Smart two-way sync
    async sync() {
        const accountId = eBay.getSelectedAccount();
        if (!accountId) {
            UI.notify('Please select an eBay account first', 'error');
            return;
        }

        const account = State.ebayAccounts.find(a => a.id === accountId);
        if (!UI.confirm(`Smart sync with "${account?.name}"? This will:\n- Import new eBay listings\n- Export new local items\n- Detect eBay sales\n- Sync changes both ways`)) return;

        UI.notify('Running smart sync...', 'info');
        const btn = UI.el('syncBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Syncing...'; }
        const startTime = Date.now();
        try {
            const data = await API.ebay.syncAll(accountId);
            eBay.showSyncResults(data, 'Smart Sync');
            UI.notify(data.message, data.summary?.errors > 0 ? 'info' : 'success');
            eBay.loadStatus();
            eBay.loadInventory();
            Inventory.load();
        } catch (err) {
            UI.notify(err.message, err.message?.includes('Sync already in progress') ? 'warning' : 'error');
        } finally {
            setTimeout(() => {
                if (btn) { btn.disabled = false; btn.innerHTML = '<span style="font-size: 1.2em;">&#8596;</span> Smart Sync'; }
            }, Math.max(0, 2000 - (Date.now() - startTime)));
        }
    },

    async publishAll() {
        const accountId = eBay.getSelectedAccount();
        if (!accountId) {
            UI.notify('Pick a specific account in the header — publishing requires one account, not "All accounts"', 'error');
            return;
        }

        const account = State.ebayAccounts.find(a => a.id === accountId);
        if (!UI.confirm(`Publish all items as eBay listings to "${account?.name}"?\n\nThis will create actual visible listings on eBay.`)) return;

        UI.notify('Publishing listings to eBay...', 'info');
        const btn = UI.el('publishBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Publishing...'; }
        const startTime = Date.now();
        try {
            const data = await API.ebay.publishAll(accountId);

            const resultsDiv = UI.el('syncResults');
            UI.show(resultsDiv);

            let html = `
                <p><strong>Account:</strong> ${account?.name}</p>
                <p><strong style="color: var(--success);">Published:</strong> ${data.results.published.length} listings</p>
            `;

            if (data.results.published.length > 0) {
                html += `<ul style="color: var(--success);">${data.results.published.map(p =>
                    `<li>${p.sku}: ${p.existing ? 'Already listed' : `Listed (ID: ${p.listingId})`}</li>`
                ).join('')}</ul>`;
            }

            if (data.results.failed.length > 0) {
                html += `
                    <p><strong style="color: var(--danger);">Failed:</strong> ${data.results.failed.length} items</p>
                    <ul style="color: var(--danger);">${data.results.failed.map(f => `<li>${f.sku}: ${f.error}</li>`).join('')}</ul>
                `;
            }

            const publishSummaryEl = resultsDiv.querySelector('.sync-summary');
            if (publishSummaryEl) publishSummaryEl.innerHTML = html;
            UI.notify(data.message, data.results.failed.length ? 'info' : 'success');
            eBay.loadStatus();
            eBay.loadInventory();

        } catch (err) {
            UI.notify(err.message, err.message?.includes('Sync already in progress') ? 'warning' : 'error');
        } finally {
            setTimeout(() => {
                if (btn) { btn.disabled = false; btn.textContent = 'Publish New Listings'; }
            }, Math.max(0, 2000 - (Date.now() - startTime)));
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
    },

    // Compare local inventory with eBay
    comparisonData: null,

    async compare(skipSkus = [], forceSkus = []) {
        const accountId = eBay.getSelectedAccount();
        if (!accountId) {
            UI.notify('Please select an eBay account first', 'error');
            return;
        }

        UI.notify('Comparing with eBay...', 'info');
        const btn = UI.el('compareBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Comparing...'; }
        const startTime = Date.now();
        try {
            const result = await API.post(`/api/ebay/compare-and-queue/${accountId}`, { skipSkus, forceSkus });

            if (result.error) throw new Error(result.error);

            // Handle conflicts — ask user per SKU
            if (result.conflicts && result.conflicts.length > 0) {
                const newSkips = [...skipSkus];
                const newForces = [...forceSkus];

                for (const conflict of result.conflicts) {
                    const pendingDesc = conflict.pendingChanges.map(c => `${c.field}: ${c.oldValue} → ${c.newValue}`).join(', ');
                    const ebayDesc = conflict.ebayChanges.map(c => `${c.field}: ${c.oldValue} → ${c.newValue}`).join(', ');

                    const choice = confirm(
                        `Conflict for SKU ${conflict.sku} (${conflict.description}):\n\n` +
                        `Your pending change: ${pendingDesc}\n` +
                        `eBay value: ${ebayDesc}\n\n` +
                        `OK = Overwrite with eBay values\n` +
                        `Cancel = Keep your pending change`
                    );

                    if (choice) {
                        newForces.push(conflict.sku);
                    } else {
                        newSkips.push(conflict.sku);
                    }
                }

                // Re-run with user's decisions
                if (btn) { btn.disabled = false; btn.textContent = 'Compare with eBay'; }
                return eBay.compare(newSkips, newForces);
            }

            if (result.queued > 0) {
                UI.notify(`${result.queued} differences queued in Updates tab`, 'success');
                await Updates.load();
                document.querySelector('[data-tab="updates"]').click();
            } else {
                UI.notify('Everything is in sync!', 'success');
            }

        } catch (err) {
            UI.notify(err.message, err.message?.includes('Sync already in progress') ? 'warning' : 'error');
        } finally {
            setTimeout(() => {
                if (btn) { btn.disabled = false; btn.textContent = 'Compare with eBay'; }
            }, Math.max(0, 2000 - (Date.now() - startTime)));
        }
    },

    showComparisonResults(data) {
        const resultsDiv = UI.el('comparisonResults');
        UI.show(resultsDiv);

        // Summary cards
        const summaryHtml = `
            <div style="background: #1a1a2e; padding: 15px; border-radius: 8px; text-align: center;">
                <div style="font-size: 24px; font-weight: bold;">${data.summary.totalLocal}</div>
                <div style="color: #888;">Local Items</div>
            </div>
            <div style="background: #1a1a2e; padding: 15px; border-radius: 8px; text-align: center;">
                <div style="font-size: 24px; font-weight: bold;">${data.summary.totalEbay}</div>
                <div style="color: #888;">eBay Listings</div>
            </div>
            <div style="background: #1a1a2e; padding: 15px; border-radius: 8px; text-align: center; border: 2px solid ${data.summary.differences > 0 ? '#ff9800' : '#4caf50'};">
                <div style="font-size: 24px; font-weight: bold; color: ${data.summary.differences > 0 ? '#ff9800' : '#4caf50'};">${data.summary.differences}</div>
                <div style="color: #888;">Differences</div>
            </div>
            <div style="background: #1a1a2e; padding: 15px; border-radius: 8px; text-align: center;">
                <div style="font-size: 24px; font-weight: bold; color: #4caf50;">${data.summary.localOnly}</div>
                <div style="color: #888;">Local Only</div>
            </div>
            <div style="background: #1a1a2e; padding: 15px; border-radius: 8px; text-align: center;">
                <div style="font-size: 24px; font-weight: bold; color: #2196f3;">${data.summary.ebayOnly}</div>
                <div style="color: #888;">eBay Only</div>
            </div>
        `;
        UI.setHTML('comparisonSummary', summaryHtml);

        // Show/hide bulk actions
        const bulkActions = UI.el('bulkActions');
        if (data.differences.length > 0) {
            UI.show(bulkActions);
        } else {
            UI.hide(bulkActions);
        }

        // Differences table
        const diffSection = UI.el('differencesSection');
        const diffTbody = document.querySelector('#differencesTable tbody');
        if (data.differences.length > 0) {
            UI.show(diffSection);
            diffTbody.innerHTML = data.differences.map(d => {
                const rows = [];
                if (d.priceDiff) {
                    rows.push(`
                        <tr>
                            <td>${d.sku}</td>
                            <td>${d.title || '-'}</td>
                            <td><span style="color: #ff9800;">Price</span></td>
                            <td>$${d.local.price.toFixed(2)}</td>
                            <td>$${d.ebay.price.toFixed(2)}</td>
                            <td>
                                <button class="btn btn-sm" onclick="eBay.resolve('${d.sku}', 'use_local', 'price')" style="background: #4caf50; margin-right: 5px;">Use Local</button>
                                <button class="btn btn-sm" onclick="eBay.resolve('${d.sku}', 'use_ebay', 'price')" style="background: #2196f3;">Use eBay</button>
                            </td>
                        </tr>
                    `);
                }
                if (d.qtyDiff) {
                    rows.push(`
                        <tr>
                            <td>${d.sku}</td>
                            <td>${d.title || '-'}</td>
                            <td><span style="color: #ff9800;">Quantity</span></td>
                            <td>${d.local.quantity}</td>
                            <td>${d.ebay.quantity}</td>
                            <td>
                                <button class="btn btn-sm" onclick="eBay.resolve('${d.sku}', 'use_local', 'quantity')" style="background: #4caf50; margin-right: 5px;">Use Local</button>
                                <button class="btn btn-sm" onclick="eBay.resolve('${d.sku}', 'use_ebay', 'quantity')" style="background: #2196f3;">Use eBay</button>
                            </td>
                        </tr>
                    `);
                }
                return rows.join('');
            }).join('');
        } else {
            UI.hide(diffSection);
        }

        // Local only table
        const localOnlySection = UI.el('localOnlySection');
        const localOnlyTbody = document.querySelector('#localOnlyTable tbody');
        if (data.localOnly.length > 0) {
            UI.show(localOnlySection);
            localOnlyTbody.innerHTML = data.localOnly.map(item => `
                <tr>
                    <td>${item.sku}</td>
                    <td>${item.title || '-'}</td>
                    <td>$${(item.localPrice || 0).toFixed(2)}</td>
                    <td>${item.localQty || 0}</td>
                    <td>${item.location || '-'}</td>
                </tr>
            `).join('');
        } else {
            UI.hide(localOnlySection);
        }

        // eBay only table
        const ebayOnlySection = UI.el('ebayOnlySection');
        const ebayOnlyTbody = document.querySelector('#ebayOnlyTable tbody');
        if (data.ebayOnly.length > 0) {
            UI.show(ebayOnlySection);
            ebayOnlyTbody.innerHTML = data.ebayOnly.map(item => `
                <tr>
                    <td>${item.sku}</td>
                    <td>${item.title || '-'}</td>
                    <td>$${(item.ebayPrice || 0).toFixed(2)}</td>
                    <td>${item.ebayQty || 0}</td>
                    <td>
                        <button class="btn btn-sm" onclick="eBay.resolve('${item.sku}', 'use_ebay', 'both')" style="background: #2196f3;">Import to Local</button>
                    </td>
                </tr>
            `).join('');
        } else {
            UI.hide(ebayOnlySection);
        }

        // All matched message
        const allMatchedMsg = UI.el('allMatchedMessage');
        if (data.differences.length === 0 && data.localOnly.length === 0 && data.ebayOnly.length === 0) {
            UI.show(allMatchedMsg);
        } else {
            UI.hide(allMatchedMsg);
        }
    },

    async resolve(sku, action, field) {
        const accountId = eBay.getSelectedAccount();
        if (!accountId) {
            UI.notify('Please select an eBay account first', 'error');
            return;
        }

        try {
            const response = await fetch(`/api/ebay/resolve/${accountId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sku, action, field })
            });

            const data = await response.json();
            if (data.error) throw new Error(data.error);

            UI.notify(data.message, 'success');

            // Refresh comparison
            await eBay.compare();
            Inventory.load();

        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    async bulkResolve(action) {
        const accountId = eBay.getSelectedAccount();
        if (!accountId || !eBay.comparisonData) {
            UI.notify('No comparison data available', 'error');
            return;
        }

        const items = eBay.comparisonData.differences.map(d => ({
            sku: d.sku,
            field: 'both'
        }));

        if (items.length === 0) {
            UI.notify('No differences to resolve', 'info');
            return;
        }

        if (!UI.confirm(`Apply "${action === 'use_local' ? 'Use Local' : 'Use eBay'}" to all ${items.length} differences?`)) return;

        UI.notify('Resolving differences...', 'info');

        try {
            const response = await fetch(`/api/ebay/resolve-bulk/${accountId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items, action })
            });

            const data = await response.json();
            if (data.error) throw new Error(data.error);

            UI.notify(data.message, 'success');

            // Refresh comparison
            await eBay.compare();
            Inventory.load();

        } catch (err) {
            UI.notify(err.message, 'error');
        }
    }
};

// ============================================
// UPDATES - Pending changes queue
// ============================================
const Updates = {
    allUpdates: [],

    init() {
        this.refreshBadge();
    },

    async load() {
        try {
            const result = await API.updates.getAll();
            this.allUpdates = result.updates;
            const countEl = UI.el('pendingCount');
            if (countEl) countEl.textContent = `${result.pendingCount} pending`;
            this.render();
            this.refreshBadge();
        } catch (err) {
            UI.notify('Failed to load updates: ' + err.message, 'error');
        }
    },

    // Compute the currently-filtered list from search + type + age + active account
    getFiltered() {
        const activeAccount = eBay.getActiveAccountId();
        if (!activeAccount) return [];
        const q = (UI.el('updatesSearch')?.value || '').trim().toLowerCase();
        const typeFilter = UI.el('updatesTypeFilter')?.value || 'all';
        const ageFilter = UI.el('updatesAgeFilter')?.value || 'all';
        const now = Date.now();
        return (this.allUpdates || []).filter(u => {
            if (u.ebayAccountId !== activeAccount) return false;
            if (typeFilter !== 'all' && u.updateType !== typeFilter) return false;
            if (q && !Search.matches(`${u.sku || ''} ${u.description || ''}`, q)) return false;
            if (ageFilter !== 'all' && u.createdAt) {
                const ageDays = (now - new Date(u.createdAt).getTime()) / 86400000;
                if (ageFilter === 'recent' && ageDays > 7) return false;
                if (ageFilter === 'stale' && ageDays < 7) return false;
                if (ageFilter === 'very-stale' && ageDays < 30) return false;
            }
            return true;
        });
    },

    applyFilters() { this.render(); },

    render() {
        const tbody = document.querySelector('#updatesTable tbody');
        if (!tbody) return;

        const emptyEl = UI.el('updatesEmpty');
        const filtered = this.getFiltered();
        const countEl = UI.el('updatesVisibleCount');
        if (countEl) countEl.textContent = filtered.length === this.allUpdates.length
            ? `${filtered.length} updates`
            : `Showing ${filtered.length} of ${this.allUpdates.length}`;
        // Keep the "N pending" badge in sync after single apply/dismiss (not just on load()).
        const pendingEl = UI.el('pendingCount');
        if (pendingEl) pendingEl.textContent = `${this.allUpdates.length} pending`;

        if (this.allUpdates.length === 0) {
            tbody.innerHTML = '';
            if (emptyEl) UI.show(emptyEl);
            return;
        }
        if (emptyEl) UI.hide(emptyEl);

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:30px;">No updates match the current filters.</td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(update => {
            const typeColors = {
                'CREATE': { bg: '#1b5e20', color: '#a5d6a7' },
                'UPDATE': { bg: '#0d47a1', color: '#90caf9' },
                'DELETE': { bg: '#b71c1c', color: '#ef9a9a' },
                'SKU_CHANGE': { bg: '#e65100', color: '#ffcc80' },
                'RECONCILE': { bg: '#78350f', color: '#fbbf24' }
            };
            const tc = typeColors[update.updateType] || { bg: '#333', color: '#ccc' };

            const changesHtml = (update.changes || []).map(c => {
                // Drift flagged by the daily reconciliation check.
                if (update.updateType === 'RECONCILE') {
                    return `<span class="change-tag change-tag-delete">⚠ Local <strong>${this.fmtVal(c.oldValue)}</strong> vs eBay <strong>${this.fmtVal(c.newValue)}</strong> — needs resolution</span>`;
                }
                // Stock movement (delta): show as a signed change that composes with eBay sales.
                if (c.delta !== undefined && c.delta !== null) {
                    const sign = c.delta >= 0 ? '+' : '';
                    const cls = c.delta >= 0 ? 'change-tag' : 'change-tag change-tag-delete';
                    const verb = c.delta >= 0 ? 'received' : 'removed';
                    return `<span class="${cls}">${c.field}: <strong>${sign}${c.delta}</strong> (${verb}, applied on top of live eBay)</span>`;
                }
                if (update.updateType === 'CREATE') {
                    return `<span class="change-tag">${c.field}: <strong>${this.fmtVal(c.newValue)}</strong></span>`;
                }
                if (update.updateType === 'DELETE') {
                    return `<span class="change-tag change-tag-delete">${c.field}: ${this.fmtVal(c.oldValue)} &rarr; removed</span>`;
                }
                return `<span class="change-tag">${c.field}: ${this.fmtVal(c.oldValue)} &rarr; <strong>${this.fmtVal(c.newValue)}</strong></span>`;
            }).join(' ');

            const time = update.createdAt ? new Date(update.createdAt).toLocaleString() : '';
            // Point 15: age indicator
            let ageBadge = '';
            if (update.createdAt) {
                const ageDays = (Date.now() - new Date(update.createdAt).getTime()) / (1000 * 60 * 60 * 24);
                if (ageDays >= 30) ageBadge = `<div style="color:#e53935;font-size:0.75rem;margin-top:2px;">⚠ ${Math.round(ageDays)} days old — eBay state likely drifted</div>`;
                else if (ageDays >= 7) ageBadge = `<div style="color:#f9a825;font-size:0.75rem;margin-top:2px;">⏱ ${Math.round(ageDays)} days old</div>`;
                else if (ageDays >= 1) ageBadge = `<div style="color:var(--text-muted);font-size:0.75rem;margin-top:2px;">${Math.round(ageDays)} days ago</div>`;
            }
            const id = update._id;

            // RECONCILE: Apply = accept eBay's count; Dismiss = keep local as-is.
            const isReconcile = update.updateType === 'RECONCILE';
            const applyLabel = isReconcile ? 'Accept eBay' : 'Update';
            const applyTitle = isReconcile ? "Set local quantity to eBay's count (no push to eBay)" : 'Apply this change to eBay';
            const dismissLabel = isReconcile ? 'Keep local' : 'Dismiss';

            return `<tr>
                <td data-label="Time" style="white-space: nowrap; font-size: 0.85rem;">${time}${ageBadge}</td>
                <td data-label="SKU"><strong>${update.sku}</strong></td>
                <td data-label="Type"><span class="type-badge" style="background: ${tc.bg}; color: ${tc.color};">${update.updateType}</span></td>
                <td data-label="Changes">${changesHtml}</td>
                <td data-label="Actions" style="white-space: nowrap;">
                    <button class="btn btn-sm btn-success" onclick="Updates.apply('${id}')" style="background:#2e7d32;color:#fff;" title="${applyTitle}">${applyLabel}</button>
                    <button class="btn btn-sm btn-secondary" onclick="Updates.dismiss('${id}')" title="${isReconcile ? 'Leave local quantity unchanged' : 'Discard this change'}">${dismissLabel}</button>
                    <button class="btn btn-sm btn-primary" onclick="Updates.viewItem('${update.sku}')">View</button>
                </td>
            </tr>`;
        }).join('');
    },

    fmtVal(val) {
        if (val === null || val === undefined) return 'N/A';
        if (typeof val === 'number') return val % 1 === 0 ? val : '$' + val.toFixed(2);
        return val;
    },

    async dismiss(id) {
        try {
            await API.updates.dismiss(id);
            this.allUpdates = this.allUpdates.filter(u => u._id !== id);
            this.render();
            this.refreshBadge();
            UI.notify('Update dismissed', 'success');
        } catch (err) {
            UI.notify(err.message, 'error');
        }
    },

    async apply(id, opts = {}) {
        const accountId = eBay.getSelectedAccount();
        if (!accountId) {
            UI.notify('Please select an eBay account first (eBay Sync tab)', 'error');
            return;
        }
        try {
            const result = await API.post(`/api/updates/${id}/apply`, { accountId, force: opts.force === true });
            UI.notify(result.message || 'Update applied', 'success');
            this.allUpdates = this.allUpdates.filter(u => u._id !== id);
            this.render();
            this.refreshBadge();
            Inventory.load();
            return { applied: true };
        } catch (err) {
            // 409 — either lock contention OR eBay drift
            if (err.status === 409) {
                // Drift response has details.drifted
                if (err.details?.drifted) {
                    const driftLines = err.details.drifted.map(d => `  ${d.field}: expected ${d.expected}, eBay has ${d.actual}`).join('\n');
                    const choice = confirm(`eBay has changed since this update was queued:\n\n${driftLines}\n\nOK = Overwrite eBay with your queued values\nCancel = Keep the update pending (re-review)`);
                    if (choice) {
                        return this.apply(id, { force: true });
                    }
                    UI.notify('Update kept pending', 'info');
                    return { applied: false, skipped: true };
                }
                // Otherwise lock contention
                UI.notify(err.message, 'warning');
                return { applied: false, skipped: true };
            }
            // Actual error (500, 400 etc.)
            UI.notify(err.message, 'error');
            return { applied: false, error: err.message };
        }
    },

    async applyAll() {
        const accountId = eBay.getSelectedAccount();
        if (!accountId) {
            UI.notify('Please select an eBay account first (eBay Sync tab)', 'error');
            return;
        }
        const targets = this.getFiltered();
        if (!targets.length) {
            UI.notify('No updates match the current filters', 'info');
            return;
        }
        const total = targets.length;
        const allCount = this.allUpdates.length;
        const scopeMsg = total === allCount ? `all ${total}` : `${total} filtered (of ${allCount})`;
        if (!UI.confirm(`Apply ${scopeMsg} pending updates?\n\nEach will push to eBay. Conflicts stay in queue.`)) return;

        const btn = UI.el('applyAllBtn');
        if (btn) { btn.disabled = true; btn.textContent = `Applying 0/${total}...`; }

        let applied = 0, skipped = 0, failed = 0;
        for (let i = 0; i < targets.length; i++) {
            const u = targets[i];
            if (btn) btn.textContent = `Applying ${i + 1}/${total}...`;
            try {
                const result = await this.apply(u._id);
                if (result?.applied) applied++;
                else if (result?.skipped) skipped++;
                else if (result?.error) failed++;
            } catch (err) {
                failed++;
            }
        }

        if (btn) { btn.disabled = false; btn.textContent = 'Apply Filtered'; }
        const parts = [];
        if (applied) parts.push(`${applied} applied`);
        if (skipped) parts.push(`${skipped} skipped (conflicts or in-progress)`);
        if (failed) parts.push(`${failed} failed`);
        UI.notify(`Done: ${parts.join(', ') || 'nothing to apply'}`, failed ? 'info' : 'success');
    },

    async dismissAll() {
        const targets = this.getFiltered();
        if (!targets.length) {
            UI.notify('No updates match the current filters', 'info');
            return;
        }
        const total = targets.length;
        const allCount = this.allUpdates.length;
        // If user dismissed everything, use the bulk endpoint; otherwise dismiss one-by-one
        if (total === allCount) {
            if (!UI.confirm(`Dismiss all ${total} pending updates? This cannot be undone.`)) return;
            try {
                await API.updates.dismissAll();
                this.allUpdates = [];
                this.render();
                this.refreshBadge();
                UI.notify(`Dismissed ${total} updates`, 'success');
            } catch (err) {
                UI.notify('Failed to dismiss: ' + err.message, 'error');
            }
            return;
        }
        if (!UI.confirm(`Dismiss ${total} filtered updates (of ${allCount})? This cannot be undone.`)) return;
        let dismissed = 0, failed = 0;
        for (const u of targets) {
            try {
                await API.updates.dismiss(u._id);
                dismissed++;
            } catch (_) { failed++; }
        }
        // Reload from server to get a clean state
        await this.load();
        UI.notify(`Dismissed ${dismissed} updates${failed ? `, ${failed} failed` : ''}`, failed ? 'info' : 'success');
    },

    viewItem(sku) {
        const input = UI.el('skuInput');
        if (input) input.value = sku;
        Tabs.switch('lookup');
        Lookup.search();
    },

    async refreshBadge() {
        try {
            const result = await API.updates.getCount();
            const badge = UI.el('updatesBadge');
            if (badge) {
                if (result.count > 0) {
                    badge.textContent = result.count;
                    badge.classList.remove('hidden');
                } else {
                    badge.classList.add('hidden');
                }
            }
        } catch (err) {
            // Silently fail - badge is non-critical
        }
    }
};

// ============================================
// EDIT ITEM - SKU Change Functionality
// ============================================
const EditItem = {
    currentSku: null,

    open() {
        if (!State.currentItem) {
            UI.notify('No item selected', 'error');
            return;
        }
        this.currentSku = State.currentItem.SKU;

        // Populate current info
        UI.el('editCurrentSku').textContent = this.currentSku;
        UI.el('editDescription').value = State.currentItem.Description || '';

        // Show eBay reference if exists
        const ebayItemId = State.currentItem.ebaySync?.ebayItemId;
        if (ebayItemId) {
            UI.el('editEbayItemId').textContent = ebayItemId;
            UI.show(UI.el('editEbayRef'));
        } else {
            UI.hide(UI.el('editEbayRef'));
        }

        // Pre-fill if valid warehouse format (13 digits: 6 itemCode + 3 drawer + 4 position)
        if (/^\d{13}$/.test(this.currentSku)) {
            UI.el('editItemId').value = this.currentSku.substring(0, 6);
            UI.el('editLocation').value = this.currentSku.substring(6);
        } else {
            UI.el('editItemId').value = '';
            UI.el('editLocation').value = '';
        }

        this.updatePreview();
        UI.hide(UI.el('editValidation'));
        UI.modal.open('editItemModal');
    },

    updatePreview() {
        const itemId = UI.el('editItemId').value || '';
        const location = UI.el('editLocation').value || '';
        const preview = (itemId.padEnd(6, '-')) + '+' + (location.padEnd(7, '-'));
        UI.el('editSkuPreview').textContent = preview;
    },

    async autoItemId() {
        try {
            const result = await API.inventory.nextItemId();
            UI.el('editItemId').value = result.nextId;
            this.updatePreview();
        } catch (err) {
            UI.notify('Failed to generate Item ID', 'error');
        }
    },

    async autoLocation() {
        try {
            const result = await API.inventory.nextLocation();
            UI.el('editLocation').value = result.nextLocation;
            this.updatePreview();
        } catch (err) {
            UI.notify('Failed to generate Location', 'error');
        }
    },

    async save() {
        const itemId = UI.el('editItemId').value;
        const location = UI.el('editLocation').value;
        const description = UI.el('editDescription').value;

        // Validate
        if (!/^\d{4}$/.test(itemId)) {
            this.showError('Item ID must be exactly 4 digits');
            return;
        }
        if (!/^\d{5}$/.test(location)) {
            this.showError('Location must be exactly 5 digits');
            return;
        }

        const newSku = itemId + location;

        // If SKU unchanged, just update description
        if (newSku === this.currentSku) {
            try {
                await API.inventory.update(this.currentSku, { description });
                UI.notify('Description change queued', 'success');
                Updates.refreshBadge();
                this.close();
                await Lookup.search();
                return;
            } catch (err) {
                this.showError(err.message);
                return;
            }
        }

        // Confirm SKU change
        if (!confirm(`Change SKU from "${this.currentSku}" to "${newSku}"?\n\nThis will update the item in the database.`)) {
            return;
        }

        try {
            UI.el('editSaveBtn').disabled = true;
            await API.post(`/api/inventory/${encodeURIComponent(this.currentSku)}/change-sku`, { newSku, description });
            UI.notify('SKU change queued', 'success');
            Updates.refreshBadge();
            this.close();

            // Refresh with new SKU
            UI.el('skuInput').value = newSku;
            await Lookup.search();
            Inventory.load();
        } catch (err) {
            this.showError(err.message);
        } finally {
            UI.el('editSaveBtn').disabled = false;
        }
    },

    showError(msg) {
        const el = UI.el('editValidation');
        el.textContent = msg;
        UI.show(el);
    },

    close() {
        UI.modal.close('editItemModal');
        UI.hide(UI.el('editValidation'));
    }
};

// ============================================
// SCANNER - Camera barcode scanner (html5-qrcode)
// ============================================
const Scanner = {
    instance: null,
    busy: false,

    isAvailable() {
        return typeof Html5Qrcode !== 'undefined';
    },

    setStatus(msg, color) {
        const el = UI.el('scannerStatus');
        if (el) { el.textContent = msg; if (color) el.style.color = color; }
    },

    async open() {
        if (this.busy) return;
        if (!this.isAvailable()) {
            UI.notify('Scanner library not loaded — refresh the page', 'error');
            return;
        }
        const modal = UI.el('scannerModal');
        if (!modal) return;
        modal.classList.remove('hidden');
        this.setStatus('Starting camera…', '#94a3b8');

        try {
            this.busy = true;
            this.instance = new Html5Qrcode('scannerReader');
            // Prefer rear camera on mobile
            const config = {
                fps: 10,
                qrbox: { width: 280, height: 140 },
                // CODE128 is what our labels use; include common 1D formats for flexibility
                formatsToSupport: [
                    Html5QrcodeSupportedFormats.CODE_128,
                    Html5QrcodeSupportedFormats.CODE_39,
                    Html5QrcodeSupportedFormats.EAN_13,
                    Html5QrcodeSupportedFormats.UPC_A
                ],
                aspectRatio: 1.5
            };
            // Keep the start promise so close() can await it — closing while the camera
            // is still STARTING used to orphan the stream (camera stayed on).
            this.startPromise = this.instance.start(
                { facingMode: 'environment' },
                config,
                (decoded) => this.onDecode(decoded),
                () => { /* per-frame failure — ignore, normal during scanning */ }
            );
            await this.startPromise;
        } catch (err) {
            this.busy = false;
            this.setStatus('Camera error: ' + (err?.message || err), '#fca5a5');
            UI.notify('Could not start camera — check browser permissions', 'error');
        }
    },

    async close() {
        const modal = UI.el('scannerModal');
        if (modal) modal.classList.add('hidden');

        // Wait for any in-flight start to settle first — otherwise the camera can
        // finish starting AFTER we stop, leaving it running with the modal hidden.
        if (this.startPromise) {
            try { await this.startPromise; } catch (_) { /* start failed — nothing running */ }
            this.startPromise = null;
        }

        if (this.instance) {
            // Stop unconditionally (not gated on isScanning — that flag can lag reality).
            try { await this.instance.stop(); } catch (_) { /* already stopped */ }
            try { this.instance.clear(); } catch (_) { /* ignore */ }
            this.instance = null;
        }

        // Belt and braces: kill any leftover camera tracks on the reader's <video>
        // directly, so the camera light goes off no matter what the library did.
        document.querySelectorAll('#scannerReader video').forEach(v => {
            try {
                const stream = v.srcObject;
                if (stream) {
                    stream.getTracks().forEach(t => t.stop());
                    v.srcObject = null;
                }
            } catch (_) { /* ignore */ }
        });

        this.busy = false;
    },

    async onDecode(text) {
        // Decoded! Auto-submit lookup and close.
        if (!this.instance || !this.busy) return;
        this.busy = false; // prevent multiple submissions if frames keep firing
        this.setStatus(`Decoded: ${text}`, '#4ade80');
        try { if (this.instance.isScanning) await this.instance.stop(); } catch (_) {}

        const input = UI.el('skuInput');
        if (input) input.value = text.trim();
        await this.close();

        // Trigger the existing lookup flow
        const form = UI.el('lookupForm');
        if (form) form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
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
const publishAllToEbay = () => eBay.publishAll();
const exportEbayToExcel = () => {
    const accountId = eBay.getSelectedAccount();
    if (!accountId) {
        UI.notify('Please select an eBay account first', 'error');
        return;
    }
    UI.notify('Downloading eBay inventory...', 'info');
    window.location.href = `/api/debug/ebay-export/${accountId}`;
};
const printBarcode = () => window.print();

// ============================================
// LABEL PRINT — barcode + SKU only, opens dedicated print window
// ============================================
const LabelPrint = {
    SETTINGS_KEY: 'labelPrintSettings',

    // method: 'system' = OS print dialog (AirPrint/Mopria/desktop); 'share' = image to a BT label app.
    defaults: { width: 50, height: 30, scale: 100, offsetX: 0, offsetY: 0, method: 'system' },

    // Common label/tape sizes. SUPVAN-style tape printers print a continuous strip,
    // so tape presets use a generous length and let the printer cut.
    PRESETS: [
        { id: '50x30', label: 'Address / shelf 50 × 30 mm', width: 50, height: 30 },
        { id: '62x29', label: 'Brother 62 × 29 mm', width: 62, height: 29 },
        { id: '40x30', label: 'Small 40 × 30 mm', width: 40, height: 30 },
        { id: '12tape', label: 'SUPVAN/Brother 12 mm tape', width: 60, height: 12 },
        { id: '24tape', label: 'SUPVAN 24 mm tape', width: 70, height: 24 },
        { id: 'custom', label: 'Custom…', width: null, height: null }
    ],

    load() {
        try { return { ...this.defaults, ...(JSON.parse(localStorage.getItem(this.SETTINGS_KEY) || '{}')) }; }
        catch { return { ...this.defaults }; }
    },

    save(settings) {
        localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(settings));
    },

    readFromUI() {
        const get = (id, fallback) => {
            const el = UI.el(id);
            const v = parseFloat(el?.value);
            return Number.isFinite(v) ? v : fallback;
        };
        const methodEl = document.querySelector('input[name="labelMethod"]:checked');
        return {
            width: get('labelWidth', this.defaults.width),
            height: get('labelHeight', this.defaults.height),
            scale: get('labelScale', this.defaults.scale),
            offsetX: get('labelOffsetX', this.defaults.offsetX),
            offsetY: get('labelOffsetY', this.defaults.offsetY),
            method: methodEl ? methodEl.value : this.load().method
        };
    },

    populateUI() {
        const s = this.load();
        const set = (id, v) => { const el = UI.el(id); if (el) el.value = v; };
        set('labelWidth', s.width);
        set('labelHeight', s.height);
        set('labelScale', s.scale);
        set('labelOffsetX', s.offsetX);
        set('labelOffsetY', s.offsetY);
        // Method radios
        document.querySelectorAll('input[name="labelMethod"]').forEach(r => { r.checked = (r.value === s.method); });
        // Preset dropdown — select a matching preset, else "custom"
        const presetSel = UI.el('labelPreset');
        if (presetSel) {
            const match = this.PRESETS.find(p => p.width === s.width && p.height === s.height);
            presetSel.value = match ? match.id : 'custom';
        }
    },

    applyPreset() {
        const presetSel = UI.el('labelPreset');
        if (!presetSel) return;
        const p = this.PRESETS.find(x => x.id === presetSel.value);
        if (!p || p.width == null) return; // "custom" — leave fields as-is
        const set = (id, v) => { const el = UI.el(id); if (el) el.value = v; };
        set('labelWidth', p.width);
        set('labelHeight', p.height);
    },

    toggleSettings() {
        const panel = UI.el('labelPrintSettings');
        if (!panel) return;
        const isOpen = panel.style.display !== 'none';
        if (!isOpen) this.populateUI();
        panel.style.display = isOpen ? 'none' : 'block';
    },

    // Resolve current settings (live from UI if the panel is open, else saved) and persist.
    resolveSettings() {
        const open = UI.el('labelPrintSettings')?.style.display !== 'none';
        const settings = open ? this.readFromUI() : this.load();
        if (open) this.save(settings);
        return settings;
    },

    // System print (AirPrint / Mopria / desktop). Renders into the in-page #printLabelArea
    // and calls window.print() — far more reliable on mobile than a pop-up window.
    print() {
        if (!State.currentItem) { UI.notify('No item selected', 'error'); return; }
        const sku = State.currentItem.SKU;
        const barcodeSrc = UI.el('lookupBarcodeImage')?.src;
        if (!barcodeSrc) { UI.notify('Barcode not available — try lookup again', 'error'); return; }

        const settings = this.resolveSettings();
        const w = Math.max(20, Math.min(300, settings.width));
        const h = Math.max(10, Math.min(300, settings.height));

        // Inject the page size so the OS prints exactly one label at the tape/label dimensions.
        const styleEl = UI.el('printPageStyle');
        if (styleEl) {
            styleEl.textContent = `@page { size: ${w}mm ${h}mm; margin: 0; }
                #printLabelArea { width: ${w}mm; height: ${h}mm; }
                #printLabelArea .print-label-sku { font-size: ${Math.max(8, h * 0.18)}pt; }`;
        }
        const skuEl = UI.el('printLabelSku');
        if (skuEl) skuEl.textContent = sku;

        const printImg = UI.el('printLabelBarcode');
        const go = () => { window.print(); };
        if (printImg) {
            if (printImg.src === barcodeSrc && printImg.complete) go();
            else { printImg.onload = go; printImg.onerror = () => UI.notify('Barcode image failed to load', 'error'); printImg.src = barcodeSrc; }
        } else {
            go();
        }
    },

    // SMART PRINT — the primary button.
    //   1. If a direct Bluetooth (ESC/POS) printer is connected → print to it (fast).
    //   2. If that fails → silently fall back to the Share sheet (within the browser's
    //      ~5s user-activation budget, so it opens like the user tapped Share).
    //   3. If the browser blocks the auto-Share (budget expired) → gently highlight the
    //      "Send to Print" button so finishing is one tap. No scary errors, ever.
    // With no direct printer connected, it goes straight to Share (the SUPVAN path).
    async smartPrint() {
        if (!State.currentItem) { UI.notify('No item selected', 'error'); return; }

        const hasDirect = (typeof BtPrint !== 'undefined') && BtPrint.isConnected && BtPrint.isConnected();
        if (hasDirect) {
            const status = await BtPrint.tryPrintFast();
            if (status === 'ok') {
                UI.notify('Sent to printer ✓ — if nothing printed, tap “Send to Print”', 'success');
                return;
            }
            if (status === 'failed') {
                // Clean failure, nothing sent → safe to silently fall back to Share.
                const shared = await this.share({ silentFail: true });
                if (shared) return;
                UI.notify('Direct print didn’t work — tap “Send to Print” to finish', 'info');
                this.flashSendButton();
                return;
            }
            // status === 'unknown' (partial/timeout) — do NOT auto-Share (could double-print).
            UI.notify('Couldn’t confirm the print. Check the printer; tap “Send to Print” if nothing came out.', 'info');
            this.flashSendButton();
            return;
        }

        // No direct printer → Share immediately (fresh tap → reliably opens the sheet).
        const shared = await this.share({ silentFail: true });
        if (!shared) { UI.notify('Tap “Send to Print” to finish', 'info'); this.flashSendButton(); }
    },

    // Briefly outline the Send-to-Print button so the manual fallback is obvious.
    flashSendButton() {
        const b = UI.el('btnSendToPrint');
        if (!b) return;
        const prev = b.style.boxShadow;
        b.style.transition = 'box-shadow 0.2s';
        b.style.boxShadow = '0 0 0 3px #f97316';
        setTimeout(() => { b.style.boxShadow = prev; }, 2400);
    },

    // Render the label (barcode + SKU) to a PNG and hand it to the OS Share sheet.
    // This is the path for Bluetooth label makers (SUPVAN etc.) that don't speak the
    // system print stack: save/share the image, then print it from the printer's own app.
    // Returns true if handled (shared/cancelled/downloaded), false if it couldn't proceed.
    // opts.silentFail: don't show error toasts (used by smartPrint's auto-fallback).
    async share(opts = {}) {
        const silent = opts.silentFail === true;
        if (!State.currentItem) { if (!silent) UI.notify('No item selected', 'error'); return false; }
        const sku = State.currentItem.SKU;
        const barcodeSrc = UI.el('lookupBarcodeImage')?.src;
        if (!barcodeSrc) { if (!silent) UI.notify('Barcode not available — try lookup again', 'error'); return false; }

        const settings = this.resolveSettings();
        let blob;
        try {
            blob = await this.renderPng(barcodeSrc, sku, settings);
        } catch (err) {
            if (!silent) UI.notify('Could not create label image: ' + (err?.message || err), 'error');
            return false;
        }
        const file = new File([blob], `label-${sku}.png`, { type: 'image/png' });

        // Preferred: native Share sheet (Android Chrome + iOS Safari).
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ files: [file], title: `Label ${sku}` });
                UI.notify('Shared — print it in your label app', 'success');
                return true;
            } catch (err) {
                if (err?.name === 'AbortError') return true;          // user dismissed — handled
                if (err?.name === 'NotAllowedError') return false;    // blocked (no activation) — caller shows manual button
                // any other share error → fall through to download
            }
        }
        // Fallback: download the PNG (desktop / Share unsupported).
        try {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `label-${sku}.png`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            UI.notify('Label image saved — open it in your label app to print', 'success');
            return true;
        } catch (err) {
            if (!silent) UI.notify('Could not save label: ' + (err?.message || err), 'error');
            return false;
        }
    },

    // Compose the label onto a canvas at print resolution and return a PNG blob.
    renderPng(barcodeSrc, sku, settings) {
        return new Promise((resolve, reject) => {
            const w = Math.max(20, Math.min(300, settings.width));
            const h = Math.max(10, Math.min(300, settings.height));
            const DPMM = 8; // ~203 dpi, standard for thermal label printers
            const cw = Math.round(w * DPMM);
            const ch = Math.round(h * DPMM);

            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = cw; canvas.height = ch;
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);

                    const pad = Math.round(cw * 0.04);
                    const skuFont = Math.max(12, Math.round(ch * 0.16));
                    const skuArea = skuFont + pad;
                    // Barcode fills the area above the SKU text, keeping aspect ratio.
                    const availW = cw - pad * 2;
                    const availH = ch - skuArea - pad;
                    const ratio = Math.min(availW / img.width, availH / img.height);
                    const bw = img.width * ratio, bh = img.height * ratio;
                    ctx.drawImage(img, (cw - bw) / 2, pad, bw, bh);

                    ctx.fillStyle = '#000';
                    ctx.font = `bold ${skuFont}px monospace`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(sku, cw / 2, ch - pad / 2);

                    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
                } catch (e) { reject(e); }
            };
            img.onerror = () => reject(new Error('barcode image failed to load'));
            img.src = barcodeSrc;
        });
    }
};

// ============================================
// BLUETOOTH PRINT (beta) — direct Web Bluetooth printing, Android Chrome only.
// iOS Safari has no Web Bluetooth. The SUPVAN protocol is undocumented, so this:
//   1) connects + dumps the GATT profile (always works — our diagnostic),
//   2) sends the label as a standard ESC/POS raster (best effort — tape printers
//      sometimes use proprietary formats; if it fails the dump tells us what to do).
// ============================================
const BtPrint = {
    device: null,
    server: null,
    writeChar: null,
    chars: [],   // [{uuid, char, props}]

    // Broad list so requestDevice can reach common printer services after pairing.
    OPTIONAL_SERVICES: [
        0x18f0, 0xff00, 0xffe0, 0xfff0, 0xfee0, 0xfee7, 0xae00, 0xae30,
        0x180a, 0x180f, 0x1800, 0x1801,
        '0000ff00-0000-1000-8000-00805f9b34fb',
        '6e400001-b5a3-f393-e0a9-e50e24dcca9e' // Nordic UART
    ],

    available() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; },

    setStatus(msg, color) {
        const el = UI.el('btStatus');
        if (el) { el.textContent = msg; if (color) el.style.color = color; }
    },

    open() {
        const modal = UI.el('btPrintModal');
        if (!modal) return;
        modal.classList.remove('hidden');
        if (!this.available()) {
            this.setStatus('Web Bluetooth is not supported on this browser. Use Android Chrome — on iPhone use “Save / Share” instead.', '#fca5a5');
            UI.el('btConnectBtn').disabled = true;
            return;
        }
        UI.el('btConnectBtn').disabled = false;
        if (!this.server) this.setStatus('Not connected. Turn the printer on, then tap “Connect printer”.', '#94a3b8');
    },

    close() {
        const modal = UI.el('btPrintModal');
        if (modal) modal.classList.add('hidden');
    },

    async connect() {
        if (!this.available()) return;
        try {
            this.setStatus('Choose your printer in the Bluetooth dialog…', '#94a3b8');
            this.device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: this.OPTIONAL_SERVICES
            });
            this.device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
            this.setStatus(`Connecting to ${this.device.name || 'printer'}…`, '#94a3b8');
            this.server = await this.device.gatt.connect();

            // Enumerate services + characteristics (the diagnostic).
            this.chars = [];
            const dump = [];
            const services = await this.server.getPrimaryServices();
            for (const svc of services) {
                let chs = [];
                try { chs = await svc.getCharacteristics(); } catch (_) {}
                dump.push(`service ${svc.uuid}`);
                for (const c of chs) {
                    const p = c.properties;
                    const props = [p.write && 'write', p.writeWithoutResponse && 'writeNR', p.notify && 'notify', p.read && 'read'].filter(Boolean).join(',');
                    dump.push(`   char ${c.uuid}  [${props}]`);
                    if (p.write || p.writeWithoutResponse) this.chars.push({ uuid: c.uuid, char: c, props });
                }
            }
            const dumpEl = UI.el('btServicesDump');
            if (dumpEl) dumpEl.textContent = dump.join('\n') || '(no services found)';

            // Populate the write-characteristic selector and auto-pick the best candidate.
            const sel = UI.el('btCharSelect');
            if (sel) {
                sel.innerHTML = this.chars.map((c, i) => `<option value="${i}">${c.uuid} [${c.props}]</option>`).join('');
            }
            this.writeChar = this.pickBestChar();
            if (sel && this.writeChar) {
                const idx = this.chars.findIndex(c => c.char === this.writeChar);
                if (idx >= 0) sel.value = String(idx);
            }

            UI.el('btAdvanced').style.display = 'block';
            UI.el('btPrintBtn').disabled = !this.writeChar;
            UI.el('btDisconnectBtn').disabled = false;
            this.setStatus(
                this.writeChar
                    ? `Connected to ${this.device.name || 'printer'}. Ready to print.`
                    : `Connected, but no writable channel found — open “Device capabilities” and send it to me.`,
                this.writeChar ? '#4ade80' : '#fbbf24'
            );
        } catch (err) {
            if (err?.name === 'NotFoundError') { this.setStatus('No printer selected.', '#94a3b8'); return; }
            this.setStatus('Connection failed: ' + (err?.message || err), '#fca5a5');
        }
    },

    pickBestChar() {
        if (!this.chars.length) return null;
        // Prefer known printer write characteristics, then any writeWithoutResponse, then any write.
        const known = ['2af1', 'ff02', 'ffe1', '6e400002'];
        for (const k of known) {
            const m = this.chars.find(c => c.uuid.includes(k));
            if (m) return m.char;
        }
        const nr = this.chars.find(c => c.props.includes('writeNR'));
        return (nr || this.chars[0]).char;
    },

    onDisconnected() {
        this.server = null; this.writeChar = null;
        UI.el('btPrintBtn').disabled = true;
        UI.el('btDisconnectBtn').disabled = true;
        this.setStatus('Printer disconnected.', '#fbbf24');
    },

    disconnect() {
        try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch (_) {}
        this.onDisconnected();
    },

    // True only when there's a live GATT connection AND a writable channel.
    isConnected() {
        return !!(this.device && this.device.gatt && this.device.gatt.connected && this.writeChar);
    },

    // Direct print used by LabelPrint.smartPrint(). Returns a STATUS, never throws:
    //   'ok'      — the full raster was written
    //   'failed'  — failed before ANY byte was sent → safe to auto-fall back to Share
    //   'unknown' — some bytes went out then it errored/timed out → ambiguous, so the
    //               caller must NOT auto-Share (could double-print); it asks the user.
    async tryPrintFast(timeoutMs = 6000) {
        if (!this.isConnected() || !State.currentItem) return 'failed';
        const barcodeSrc = UI.el('lookupBarcodeImage')?.src;
        if (!barcodeSrc) return 'failed';
        const widthDots = Math.max(64, Math.min(832, parseInt(UI.el('btWidthDots')?.value) || 384));

        let bytes;
        try { bytes = await this.buildEscPosRaster(barcodeSrc, State.currentItem.SKU, widthDots); }
        catch (_) { return 'failed'; } // nothing sent yet

        const useNR = this.chars.find(c => c.char === this.writeChar)?.props.includes('writeNR');
        let sentAny = false;
        const send = (async () => {
            for (let i = 0; i < bytes.length; i += 100) {
                const chunk = bytes.slice(i, i + 100);
                if (useNR && this.writeChar.writeValueWithoutResponse) await this.writeChar.writeValueWithoutResponse(chunk);
                else await this.writeChar.writeValue(chunk);
                sentAny = true;
                await new Promise(r => setTimeout(r, 12));
            }
        })();
        try {
            await Promise.race([send, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
            return 'ok';
        } catch (_) {
            return sentAny ? 'unknown' : 'failed';
        }
    },

    async printCurrent() {
        if (!State.currentItem) { UI.notify('No item selected', 'error'); return; }
        const barcodeSrc = UI.el('lookupBarcodeImage')?.src;
        if (!barcodeSrc) { UI.notify('Barcode not available — try lookup again', 'error'); return; }

        // Honor a manual characteristic override.
        const sel = UI.el('btCharSelect');
        if (sel && this.chars[sel.value]) this.writeChar = this.chars[sel.value].char;
        if (!this.writeChar) { this.setStatus('No writable channel selected.', '#fca5a5'); return; }

        const widthDots = Math.max(64, Math.min(832, parseInt(UI.el('btWidthDots')?.value) || 384));
        try {
            this.setStatus('Rendering label…', '#94a3b8');
            const bytes = await this.buildEscPosRaster(barcodeSrc, State.currentItem.SKU, widthDots);
            this.setStatus(`Sending ${bytes.length} bytes…`, '#94a3b8');
            await this.sendChunked(bytes);
            this.setStatus('Sent ✓ — if nothing printed, open “Device capabilities” and send it to me to tune the format.', '#4ade80');
            UI.notify('Label sent to printer', 'success');
        } catch (err) {
            this.setStatus('Print failed: ' + (err?.message || err), '#fca5a5');
        }
    },

    // Render label to a monochrome canvas, then encode as ESC/POS GS v 0 raster.
    buildEscPosRaster(barcodeSrc, sku, widthDots) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                try {
                    const W = widthDots - (widthDots % 8); // multiple of 8
                    const pad = Math.round(W * 0.04);
                    const skuFont = Math.max(16, Math.round(W * 0.07));
                    const ratio = (W - pad * 2) / img.width;
                    const bh = Math.round(img.height * ratio);
                    const H = pad + bh + Math.round(skuFont * 1.4) + pad;

                    const canvas = document.createElement('canvas');
                    canvas.width = W; canvas.height = H;
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
                    ctx.drawImage(img, pad, pad, W - pad * 2, bh);
                    ctx.fillStyle = '#000';
                    ctx.font = `bold ${skuFont}px monospace`;
                    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
                    ctx.fillText(sku, W / 2, pad + bh + 4);

                    const data = ctx.getImageData(0, 0, W, H).data;
                    const widthBytes = W / 8;
                    const raster = new Uint8Array(widthBytes * H);
                    for (let y = 0; y < H; y++) {
                        for (let x = 0; x < W; x++) {
                            const i = (y * W + x) * 4;
                            // luminance; dark pixel => print bit
                            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                            if (lum < 128) raster[y * widthBytes + (x >> 3)] |= (0x80 >> (x & 7));
                        }
                    }
                    // ESC @ (init) + GS v 0 raster + feed
                    const header = [0x1B, 0x40, 0x1D, 0x76, 0x30, 0x00,
                        widthBytes & 0xff, (widthBytes >> 8) & 0xff, H & 0xff, (H >> 8) & 0xff];
                    const feed = [0x0A, 0x0A, 0x0A];
                    const out = new Uint8Array(header.length + raster.length + feed.length);
                    out.set(header, 0);
                    out.set(raster, header.length);
                    out.set(feed, header.length + raster.length);
                    resolve(out);
                } catch (e) { reject(e); }
            };
            img.onerror = () => reject(new Error('barcode image failed to load'));
            img.src = barcodeSrc;
        });
    },

    async sendChunked(bytes, chunkSize = 100) {
        const useNR = this.chars.find(c => c.char === this.writeChar)?.props.includes('writeNR');
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.slice(i, i + chunkSize);
            if (useNR && this.writeChar.writeValueWithoutResponse) await this.writeChar.writeValueWithoutResponse(chunk);
            else await this.writeChar.writeValue(chunk);
            await new Promise(r => setTimeout(r, 12)); // small gap so the printer buffer keeps up
        }
    }
};

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

// Header dropdown onchange handler — see eBay.setActiveAccount for the impl.
function setActiveAccountFromHeader() {
    eBay.setActiveAccount(document.getElementById('globalAccountSelect')?.value || '');
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
    Updates.init();

    // Register service worker — gives the app installability + instant shell loads
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(err => console.warn('SW registration failed:', err));
    }

    // Load eBay status to populate accounts (needed for Advanced tab)
    eBay.loadStatus();

    // Modal close handlers
    document.addEventListener('click', (e) => {
        if (e.target.id === 'historyModal') History.close();
        if (e.target.id === 'editItemModal') EditItem.close();
        if (e.target.id === 'scannerModal') Scanner.close();
        if (e.target.id === 'btPrintModal') BtPrint.close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            History.close();
            EditItem.close();
            Scanner.close();
            BtPrint.close();
        }
    });
    // Stop the camera if the app is backgrounded mid-scan (phone lock, tab switch).
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && Scanner.instance) Scanner.close();
    });

    // Initial focus
    UI.el('skuInput')?.focus();

    // Load eBay status
    eBay.loadStatus();
});
