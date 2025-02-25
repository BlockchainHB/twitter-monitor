const axios = require('axios');
const RateLimitManager = require('./RateLimitManager');

class HeliusRateLimitManager extends RateLimitManager {
    constructor() {
        super({
            endpoints: {
                'helius/webhooks/list': {
                    requestsPerWindow: 30,
                    windowSizeMinutes: 1
                },
                'helius/webhooks/create': {
                    requestsPerWindow: 10,
                    windowSizeMinutes: 1
                },
                'helius/webhooks/delete': {
                    requestsPerWindow: 10,
                    windowSizeMinutes: 1
                }
            },
            defaultLimit: {
                requestsPerWindow: 10,
                windowSizeMinutes: 1
            },
            safetyMargin: 0.9
        });
    }
}

class HeliusService {
    constructor(apiKey, db) {
        this.apiKey = apiKey;
        this.db = db;
        this.baseUrl = 'https://api.helius.xyz/v0';
        this.rateLimitManager = new HeliusRateLimitManager();
    }

    // Get webhook URL for a specific wallet
    getWebhookUrl(webhookId) {
        return `${this.baseUrl}/webhook/${webhookId}?api-key=${this.apiKey}`;
    }

    // Sync wallets with Helius webhook
    async syncWallets(webhookUrl) {
        try {
            console.log('📡 Syncing wallets with Helius...');

            // Get all monitored wallets from database
            const wallets = await this.db.all('SELECT wallet_address FROM monitored_wallets');
            const accountAddresses = wallets.map(w => w.wallet_address);

            // First, list all existing webhooks
            console.log('🔍 Checking existing webhooks...');
            const existingWebhooks = await this.rateLimitManager.scheduleRequest(
                () => this.listWebhooks(),
                'helius/webhooks/list'
            );
            
            // Clean up existing webhooks if any
            if (existingWebhooks && existingWebhooks.length > 0) {
                console.log(`🧹 Found ${existingWebhooks.length} existing webhooks, cleaning up...`);
                for (const webhook of existingWebhooks) {
                    try {
                        await this.rateLimitManager.scheduleRequest(
                            () => this.deleteWebhook(webhook.webhookID),
                            'helius/webhooks/delete'
                        );
                        console.log(`✅ Deleted webhook ${webhook.webhookID}`);
                        // Add a small delay between deletions
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } catch (error) {
                        console.warn(`⚠️ Failed to delete webhook ${webhook.webhookID}:`, error.message);
                    }
                }
            }

            // Clear any existing webhook records in the database
            await this.db.run('DELETE FROM helius_webhooks');

            // Create new webhook
            console.log('🆕 Creating new webhook...');
            const response = await this.rateLimitManager.scheduleRequest(
                () => this.createWebhook(webhookUrl, accountAddresses),
                'helius/webhooks/create'
            );
            const webhookId = response.webhookID;

            // Store webhook info
            await this.db.run(
                'INSERT INTO helius_webhooks (webhook_id, webhook_url, active) VALUES (?, ?, ?)',
                [webhookId, webhookUrl, 1]
            );

            console.log(`✅ Successfully synced ${accountAddresses.length} wallets with Helius`);
            return webhookId;
        } catch (error) {
            console.error('❌ Failed to sync wallets with Helius:', error.message);
            throw error;
        }
    }

    // Create a new webhook for tracking wallets
    async createWebhook(webhookUrl, accountAddresses) {
        try {
            const response = await axios.post(`${this.baseUrl}/webhooks?api-key=${this.apiKey}`, {
                webhookURL: webhookUrl,
                accountAddresses,
                transactionTypes: ['SWAP'],
                webhookType: 'enhanced'
            });
            return response.data;
        } catch (error) {
            console.error('[ERROR] Failed to create Helius webhook:', error.message);
            throw error;
        }
    }

    // Update existing webhook with new wallet addresses
    async updateWebhook(webhookId, accountAddresses) {
        try {
            const response = await axios.put(`${this.baseUrl}/webhooks/${webhookId}?api-key=${this.apiKey}`, {
                accountAddresses,
                transactionTypes: ['SWAP'],
                webhookType: 'enhanced'
            });
            return response.data;
        } catch (error) {
            console.error('[ERROR] Failed to update Helius webhook:', error.message);
            throw error;
        }
    }

    // Delete a webhook
    async deleteWebhook(webhookId) {
        try {
            await axios.delete(`${this.baseUrl}/webhooks/${webhookId}?api-key=${this.apiKey}`);
            return true;
        } catch (error) {
            console.error('[ERROR] Failed to delete Helius webhook:', error.message);
            throw error;
        }
    }

    // List all active webhooks
    async listWebhooks() {
        try {
            const response = await axios.get(`${this.baseUrl}/webhooks?api-key=${this.apiKey}`);
            return response.data;
        } catch (error) {
            console.error('[ERROR] Failed to list Helius webhooks:', error.message);
            throw error;
        }
    }

    // Parse SWAP transaction data
    parseSwapTransaction(transaction) {
        if (!transaction || transaction.type !== 'SWAP') return null;

        try {
            const {
                timestamp,
                signature,
                tokenTransfers,
                nativeTransfers,
                source,
                fee,
                events
            } = transaction;

            // Extract swap details from events
            const swapEvent = events?.swap;
            if (!swapEvent) return null;

            return {
                timestamp,
                signature,
                tokenTransfers,
                nativeTransfers,
                source,
                fee,
                swapDetails: swapEvent,
                usdValue: swapEvent.usdValue || 0
            };
        } catch (error) {
            console.error('[ERROR] Failed to parse swap transaction:', error.message);
            return null;
        }
    }
}

module.exports = HeliusService; 