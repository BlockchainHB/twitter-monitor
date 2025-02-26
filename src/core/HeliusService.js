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
                },
                'helius/webhooks/get': {
                    requestsPerWindow: 30,
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
    async syncWallets() {
        try {
            console.log('📡 Syncing wallets with Helius...');
            
            // Get all wallet addresses from database
            const wallets = await new Promise((resolve, reject) => {
                this.db.all('SELECT wallet_address FROM monitored_wallets', [], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                });
            });
            
            if (!wallets || wallets.length === 0) {
                console.log('No wallets to sync');
                return null;
            }

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
            await new Promise((resolve, reject) => {
                this.db.run('DELETE FROM helius_webhooks', [], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            // Only create webhook if we have wallets to monitor
            if (wallets.length === 0) {
                console.log('ℹ️ No wallets to monitor, skipping webhook creation');
                return null;
            }

            // Create new webhook
            console.log('🆕 Creating new webhook...');
            const webhookUrl = this.getWebhookUrl(wallets[0].wallet_address);
            console.log(`Webhook URL: ${webhookUrl}`);
            console.log(`Account Addresses: ${JSON.stringify(wallets.map(w => w.wallet_address))}`);
            
            const response = await this.rateLimitManager.scheduleRequest(
                () => this.createWebhook(webhookUrl, wallets.map(w => w.wallet_address)),
                'helius/webhooks/create'
            );

            if (!response || !response.webhookID) {
                throw new Error('Failed to get webhook ID from response');
            }

            const webhookId = response.webhookID;
            console.log(`✅ Created webhook with ID: ${webhookId}`);

            // Verify webhook was created correctly
            console.log('🔍 Verifying webhook configuration...');
            const webhookDetails = await this.getWebhook(webhookId);
            
            if (!webhookDetails || webhookDetails.webhookURL !== webhookUrl) {
                throw new Error('Webhook verification failed: URL mismatch');
            }

            if (!webhookDetails.accountAddresses || 
                !Array.isArray(webhookDetails.accountAddresses) || 
                webhookDetails.accountAddresses.length !== wallets.length) {
                throw new Error('Webhook verification failed: Account addresses mismatch');
            }

            console.log('✅ Webhook verification successful');

            // Store webhook info
            await new Promise((resolve, reject) => {
                this.db.run(
                    'INSERT INTO helius_webhooks (webhook_id, webhook_url, active) VALUES (?, ?, ?)',
                    [webhookId, webhookUrl, 1],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });

            console.log(`✅ Successfully synced ${wallets.length} wallets with Helius`);
            return webhookId;
        } catch (error) {
            console.error('❌ Failed to sync wallets with Helius:', error);
            if (error.response) {
                console.error('Response data:', error.response.data);
                console.error('Response status:', error.response.status);
            }
            throw error;
        }
    }

    // Create a new webhook for tracking wallets
    async createWebhook(webhookUrl, accountAddresses) {
        if (!webhookUrl) {
            throw new Error('Webhook URL is required');
        }
        if (!Array.isArray(accountAddresses) || accountAddresses.length === 0) {
            throw new Error('At least one account address is required');
        }

        try {
            const payload = {
                webhookURL: webhookUrl,
                accountAddresses,
                transactionTypes: ['SWAP'],
                webhookType: 'enhanced'
            };
            console.log('Creating webhook with payload:', JSON.stringify(payload, null, 2));

            const response = await axios.post(`${this.baseUrl}/webhooks?api-key=${this.apiKey}`, payload);
            
            if (!response.data || !response.data.webhookID) {
                throw new Error('Invalid response from Helius API: ' + JSON.stringify(response.data));
            }
            
            return response.data;
        } catch (error) {
            console.error('[ERROR] Failed to create Helius webhook:', error.message);
            if (error.response) {
                console.error('Response data:', error.response.data);
                console.error('Response status:', error.response.status);
            }
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

    // Get webhook details
    async getWebhook(webhookId) {
        if (!webhookId) {
            throw new Error('Webhook ID is required');
        }

        try {
            const response = await this.rateLimitManager.scheduleRequest(
                async () => {
                    const result = await axios.get(
                        `${this.baseUrl}/webhooks/${webhookId}?api-key=${this.apiKey}`
                    );
                    return result.data;
                },
                'helius/webhooks/get'
            );

            if (!response || !response.webhookID) {
                throw new Error('Invalid response from Helius API: ' + JSON.stringify(response));
            }

            return response;
        } catch (error) {
            console.error('[ERROR] Failed to get Helius webhook details:', error.message);
            if (error.response) {
                console.error('Response data:', error.response.data);
                console.error('Response status:', error.response.status);
            }
            throw error;
        }
    }
}

module.exports = HeliusService; 