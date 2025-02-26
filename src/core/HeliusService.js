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
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.helius.xyz/v0';
        this.rateLimitManager = new HeliusRateLimitManager();
        this.activeWebhooks = new Map(); // In-memory storage
        this.walletNames = new Map(); // In-memory wallet name storage
    }

    // Get webhook URL for a specific wallet
    getWebhookUrl(webhookId) {
        return `${this.baseUrl}/webhook/${webhookId}?api-key=${this.apiKey}`;
    }

    // Sync wallets with Helius webhook
    async syncWallets(webhookUrl, accountAddresses) {
        try {
            console.log('📡 Checking webhook configuration...');
            
            // Get existing webhooks
            const webhooks = await this.listWebhooks();
            let webhook = webhooks.find(w => w.webhookURL === webhookUrl);

            if (webhook) {
                // Update existing webhook
                console.log('📝 Updating existing webhook...');
                await this.updateWebhook(webhook.webhookID, accountAddresses);
                this.activeWebhooks.set(webhook.webhookID, webhookUrl);
            } else {
                // Create new webhook
                console.log('🆕 Creating new webhook...');
                webhook = await this.createWebhook(webhookUrl, accountAddresses);
                this.activeWebhooks.set(webhook.webhookID, webhookUrl);
            }

            console.log('✅ Webhook sync complete');
            return webhook.webhookID;
        } catch (error) {
            console.error('❌ Error syncing webhook:', error);
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
            this.activeWebhooks.delete(webhookId);
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

    // Parse SWAP transaction data with enhanced details
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

            // Enhanced swap data parsing
            const swapData = {
                timestamp,
                signature,
                wallet: source,
                fee: fee || 0,
                type: 'SWAP',
                usdValue: swapEvent.usdValue || 0,
                // Token sent details
                tokenSent: {
                    mint: swapEvent.tokenIn,
                    amount: swapEvent.amountIn,
                    symbol: swapEvent.tokenInSymbol || 'Unknown',
                    decimals: swapEvent.tokenInDecimals || 0,
                    usdValue: swapEvent.tokenInUsdValue || 0
                },
                // Token received details
                tokenReceived: {
                    mint: swapEvent.tokenOut,
                    amount: swapEvent.amountOut,
                    symbol: swapEvent.tokenOutSymbol || 'Unknown',
                    decimals: swapEvent.tokenOutDecimals || 0,
                    usdValue: swapEvent.tokenOutUsdValue || 0
                },
                // Market details
                market: {
                    name: swapEvent.platformName || 'Unknown DEX',
                    address: swapEvent.platformAddress || null,
                    fee: swapEvent.platformFee || 0
                }
            };

            // Calculate price per token
            if (swapEvent.amountIn && swapEvent.amountOut) {
                swapData.pricePerToken = {
                    in: swapEvent.tokenInUsdValue / swapEvent.amountIn,
                    out: swapEvent.tokenOutUsdValue / swapEvent.amountOut
                };
            }

            return swapData;
        } catch (error) {
            console.error('[ERROR] Failed to parse swap transaction:', error.message);
            return null;
        }
    }

    // Format swap notification with rich details
    formatSwapNotification(swapData) {
        const {
            walletName,
            tokenSent,
            tokenReceived,
            market,
            signature,
            usdValue
        } = swapData;

        // Format amounts with proper decimals
        const sentAmount = this.formatTokenAmount(tokenSent.amount, tokenSent.decimals);
        const receivedAmount = this.formatTokenAmount(tokenReceived.amount, tokenReceived.decimals);

        return {
            title: `🔄 Swap by ${walletName}`,
            description: `Swapped tokens worth $${this.formatUSD(usdValue)}`,
            fields: [
                {
                    name: '📤 Sent',
                    value: `${sentAmount} ${tokenSent.symbol}\n($${this.formatUSD(tokenSent.usdValue)})`,
                    inline: true
                },
                {
                    name: '📥 Received',
                    value: `${receivedAmount} ${tokenReceived.symbol}\n($${this.formatUSD(tokenReceived.usdValue)})`,
                    inline: true
                },
                {
                    name: '🏦 Market',
                    value: market.name,
                    inline: true
                },
                {
                    name: '🔍 Transaction',
                    value: `[View on Solscan](https://solscan.io/tx/${signature})`,
                    inline: false
                }
            ],
            color: 0x00ff00,
            timestamp: new Date().toISOString()
        };
    }

    // Helper function to format token amounts
    formatTokenAmount(amount, decimals) {
        if (!amount) return '0';
        const value = amount / Math.pow(10, decimals);
        return value.toLocaleString('en-US', {
            maximumFractionDigits: 6,
            minimumFractionDigits: 2
        });
    }

    // Helper function to format USD values
    formatUSD(value) {
        if (!value) return '0.00';
        return value.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
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

    // Validate Solana address format
    isValidSolanaAddress(address) {
        return address && 
               address.length === 44 && 
               /^[1-9A-HJ-NP-Za-km-z]{44}$/.test(address);
    }

    // Handle webhook events with simplified in-memory approach
    async handleWebhook(data) {
        if (!data || !data.events || !Array.isArray(data.events)) {
            console.log('[DEBUG] Invalid webhook data received');
            return;
        }

        console.log(`[DEBUG] Processing ${data.events.length} webhook events`);

        for (const event of data.events) {
            try {
                const swapData = this.parseSwapTransaction(event);
                if (!swapData) continue;

                // Use in-memory wallet name or create a shortened version
                const walletName = this.walletNames.get(swapData.wallet) || 
                                 `${swapData.wallet.slice(0, 4)}...${swapData.wallet.slice(-4)}`;

                // Add wallet name to swap data
                swapData.walletName = walletName;

                // Format notification
                const notification = this.formatSwapNotification(swapData);

                // Return the formatted notification for the bot to handle
                return notification;

            } catch (error) {
                console.error('[ERROR] Error processing webhook event:', error);
            }
        }
    }

    // Add a wallet name to in-memory storage
    setWalletName(address, name) {
        this.walletNames.set(address, name);
    }

    // Get a wallet name from in-memory storage
    getWalletName(address) {
        return this.walletNames.get(address);
    }
}

module.exports = HeliusService; 