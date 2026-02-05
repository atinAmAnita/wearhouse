/**
 * eBay API Service - Multi-Account Support
 * Handles OAuth authentication and Inventory API calls for multiple seller accounts
 */

const config = require('./config');

// eBay API endpoints
const ENDPOINTS = {
    sandbox: {
        auth: 'https://auth.sandbox.ebay.com',
        api: 'https://api.sandbox.ebay.com'
    },
    production: {
        auth: 'https://auth.ebay.com',
        api: 'https://api.ebay.com'
    }
};

class EbayAPI {
    constructor() {
        this.env = config.ebay.environment;
        this.endpoints = ENDPOINTS[this.env];
        // Pending auth state (for OAuth callback)
        this.pendingAuth = null;
    }

    /**
     * Check if a specific account has valid tokens
     */
    isAccountAuthenticated(accountId) {
        const account = config.getAccount(accountId);
        if (!account || !account.tokens || !account.tokens.access_token) {
            return false;
        }
        // Check if token is expired
        if (account.tokens.expires_at && Date.now() >= account.tokens.expires_at) {
            return false;
        }
        return true;
    }

    /**
     * Generate the OAuth consent URL for user authorization
     * @param {string} accountName - Friendly name for this account
     */
    getAuthUrl(accountName) {
        // Generate a unique ID for this account
        const accountId = 'acc_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

        // Store pending auth info
        this.pendingAuth = {
            accountId,
            accountName,
            startedAt: new Date().toISOString()
        };

        const scopes = encodeURIComponent(config.ebay.scopes.join(' '));
        const ruName = encodeURIComponent(config.ebay.ruName);

        // Include state parameter to track the account
        const state = encodeURIComponent(JSON.stringify({ accountId, accountName }));

        return `${this.endpoints.auth}/oauth2/authorize?` +
            `client_id=${config.ebay.clientId}&` +
            `redirect_uri=${ruName}&` +
            `response_type=code&` +
            `scope=${scopes}&` +
            `state=${state}`;
    }

    /**
     * Exchange authorization code for access token
     */
    async exchangeCodeForToken(authCode, state) {
        let accountId, accountName;

        try {
            const stateData = JSON.parse(decodeURIComponent(state));
            accountId = stateData.accountId;
            accountName = stateData.accountName;
        } catch (err) {
            // Fallback to pending auth
            if (this.pendingAuth) {
                accountId = this.pendingAuth.accountId;
                accountName = this.pendingAuth.accountName;
            } else {
                throw new Error('Invalid auth state');
            }
        }

        const credentials = Buffer.from(
            `${config.ebay.clientId}:${config.ebay.clientSecret}`
        ).toString('base64');

        const response = await fetch(`${this.endpoints.api}/identity/v1/oauth2/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${credentials}`
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: authCode,
                redirect_uri: config.ebay.ruName
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Token exchange failed: ${error}`);
        }

        const tokenData = await response.json();

        // Save account with tokens
        const tokens = {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_at: Date.now() + (tokenData.expires_in * 1000),
            token_type: tokenData.token_type
        };

        config.saveAccount(accountId, {
            name: accountName,
            tokens,
            addedAt: new Date().toISOString()
        });

        // Clear pending auth
        this.pendingAuth = null;

        return { accountId, accountName };
    }

    /**
     * Refresh the access token for an account
     */
    async refreshAccessToken(accountId) {
        const account = config.getAccount(accountId);
        if (!account || !account.tokens || !account.tokens.refresh_token) {
            throw new Error('No refresh token available for this account');
        }

        const credentials = Buffer.from(
            `${config.ebay.clientId}:${config.ebay.clientSecret}`
        ).toString('base64');

        const response = await fetch(`${this.endpoints.api}/identity/v1/oauth2/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${credentials}`
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: account.tokens.refresh_token,
                scope: config.ebay.scopes.join(' ')
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Token refresh failed: ${error}`);
        }

        const tokenData = await response.json();

        // Update tokens
        const tokens = {
            ...account.tokens,
            access_token: tokenData.access_token,
            expires_at: Date.now() + (tokenData.expires_in * 1000)
        };

        config.saveAccount(accountId, { tokens });

        return tokens;
    }

    /**
     * Make authenticated API request for a specific account
     */
    async apiRequest(accountId, method, path, body = null) {
        const account = config.getAccount(accountId);
        if (!account) {
            throw new Error('Account not found');
        }

        // Ensure we have valid tokens
        if (!this.isAccountAuthenticated(accountId)) {
            if (account.tokens && account.tokens.refresh_token) {
                await this.refreshAccessToken(accountId);
            } else {
                throw new Error('Account not authenticated. Please reconnect this eBay account.');
            }
        }

        // Re-fetch account after potential refresh
        const updatedAccount = config.getAccount(accountId);

        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${updatedAccount.tokens.access_token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Accept-Language': 'en-US',
                'Content-Language': 'en-US'
            }
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(`${this.endpoints.api}${path}`, options);

        // Handle 204 No Content
        if (response.status === 204) {
            return { success: true };
        }

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.errors?.[0]?.message || `API error: ${response.status}`);
        }

        return data;
    }

    /**
     * Remove an eBay account
     */
    removeAccount(accountId) {
        return config.removeAccount(accountId);
    }

    // ============================================
    // INVENTORY API METHODS (account-specific)
    // ============================================

    async getInventoryItems(accountId, limit = 100, offset = 0) {
        return this.apiRequest(accountId, 'GET', `/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`);
    }

    async getInventoryItem(accountId, sku) {
        return this.apiRequest(accountId, 'GET', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
    }

    async createOrUpdateInventoryItem(accountId, sku, itemData) {
        return this.apiRequest(accountId, 'PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, itemData);
    }

    async deleteInventoryItem(accountId, sku) {
        return this.apiRequest(accountId, 'DELETE', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
    }

    async updateInventoryQuantity(accountId, sku, quantity) {
        let existingItem;
        try {
            existingItem = await this.getInventoryItem(accountId, sku);
        } catch (err) {
            return { error: 'Item not found on eBay', sku };
        }

        const itemData = {
            ...existingItem,
            availability: {
                shipToLocationAvailability: {
                    quantity: quantity
                }
            }
        };

        return this.apiRequest(accountId, 'PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, itemData);
    }

    // ============================================
    // LOCATION API METHODS
    // ============================================

    async getInventoryLocations(accountId) {
        return this.apiRequest(accountId, 'GET', '/sell/inventory/v1/location');
    }

    // ============================================
    // TAXONOMY API METHODS (Categories & Item Specifics)
    // ============================================

    /**
     * Get category suggestions based on search query
     * @param {string} accountId - eBay account ID for authentication
     * @param {string} query - Search query (e.g., "vintage watches")
     */
    async getCategorySuggestions(accountId, query) {
        // Category tree ID 0 = EBAY_US
        const categoryTreeId = 0;
        const encodedQuery = encodeURIComponent(query);
        return this.apiRequest(
            accountId,
            'GET',
            `/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_category_suggestions?q=${encodedQuery}`
        );
    }

    /**
     * Get item aspects (specifics) for a category
     * @param {string} accountId - eBay account ID for authentication
     * @param {string} categoryId - eBay category ID
     */
    async getItemAspectsForCategory(accountId, categoryId) {
        const categoryTreeId = 0;
        return this.apiRequest(
            accountId,
            'GET',
            `/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_item_aspects_for_category?category_id=${categoryId}`
        );
    }

    /**
     * Get the default category tree for a marketplace
     */
    async getDefaultCategoryTree(accountId) {
        return this.apiRequest(accountId, 'GET', '/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_US');
    }

    // ============================================
    // HELPER METHODS
    // ============================================

    /**
     * Sync a local warehouse item to a specific eBay account
     * Includes advanced settings: condition, item specifics
     * Note: Category is used when creating offers, not inventory items
     */
    async syncItemToEbay(accountId, warehouseItem) {
        const price = parseFloat(warehouseItem.Price) || 0;

        // Build aspects from item specifics + warehouse location
        const aspects = {
            'Warehouse Location': [warehouseItem.FullLocation]
        };

        // Add item specifics if provided
        if (warehouseItem.ItemSpecifics && typeof warehouseItem.ItemSpecifics === 'object') {
            Object.entries(warehouseItem.ItemSpecifics).forEach(([key, value]) => {
                if (value) {
                    aspects[key] = [value];
                }
            });
        }

        const itemData = {
            availability: {
                shipToLocationAvailability: {
                    quantity: warehouseItem.Quantity
                }
            },
            condition: warehouseItem.Condition || 'NEW',
            product: {
                title: warehouseItem.Description || `Item ${warehouseItem.SKU}`,
                description: warehouseItem.Description || '',
                aspects: aspects
            }
        };

        const result = await this.createOrUpdateInventoryItem(accountId, warehouseItem.SKU, itemData);

        // Update last sync time for account
        config.saveAccount(accountId, { lastSync: new Date().toISOString() });

        return result;
    }

    /**
     * Get overall status
     */
    getStatus() {
        return {
            configured: config.isEbayConfigured(),
            environment: this.env,
            accounts: config.getAllAccounts()
        };
    }
}

module.exports = new EbayAPI();
