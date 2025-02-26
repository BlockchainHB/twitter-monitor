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
            console.log('📡 Checking webhook configuration...');
            
            // Get existing webhook from database
            const webhook = await new Promise((resolve, reject) => {
                this.db.get('SELECT webhook_id, webhook_url FROM helius_webhooks WHERE active = 1', [], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });

            if (!webhook) {
                console.log('⚠️ No active webhook found. Please run configure-webhook.js to set up the webhook.');
                return null;
            }

            // Verify webhook is still valid
            try {
                const webhookDetails = await this.getWebhook(webhook.webhook_id);
                if (!webhookDetails) {
                    console.error('❌ Webhook not found on Helius. Please run configure-webhook.js to set up the webhook.');
                    return null;
                }
                console.log('✅ Webhook verification successful');
                return webhook.webhook_id;
            } catch (error) {
                console.error('❌ Failed to verify webhook:', error);
                console.log('Please run configure-webhook.js to reconfigure the webhook.');
                return null;
            }
        } catch (error) {
            console.error('❌ Error checking webhook configuration:', error);
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
                },
                // Price impact and slippage
                priceImpact: swapEvent.priceImpact || null,
                slippage: swapEvent.slippage || null,
                // Additional context
                innerInstructions: transaction.innerInstructions || [],
                accountData: transaction.accountData || {},
                preTokenBalances: transaction.preTokenBalances || [],
                postTokenBalances: transaction.postTokenBalances || []
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

    // Handle webhook events with enhanced processing
    async handleWebhook(data) {
        if (!data || !data.events || !Array.isArray(data.events)) {
            console.log('[DEBUG] Invalid webhook data received');
            return;
        }

        console.log(`[DEBUG] Processing ${data.events.length} webhook events`);

        for (const event of data.events) {
            try {
                // Parse the swap transaction
                const swapData = this.parseSwapTransaction(event);
                if (!swapData) {
                    console.log('[DEBUG] Skipping non-swap event');
                    continue;
                }

                // Get wallet details from database
                const walletInfo = await new Promise((resolve, reject) => {
                    this.db.get(
                        'SELECT name, discord_user_id FROM monitored_wallets WHERE wallet_address = ?',
                        [swapData.wallet],
                        (err, row) => {
                            if (err) reject(err);
                            else resolve(row);
                        }
                    );
                });

                if (!walletInfo) {
                    console.log(`[WARN] Wallet ${swapData.wallet} not found in database, using shortened address as name`);
                    // Create a shortened version of the address for display
                    const shortAddr = `${swapData.wallet.slice(0, 4)}...${swapData.wallet.slice(-4)}`;
                    swapData.walletName = `Unknown (${shortAddr})`;
                    swapData.discordUserId = null;
                } else {
                    swapData.walletName = walletInfo.name;
                    swapData.discordUserId = walletInfo.discord_user_id;
                }

                // Check notification thresholds
                const shouldNotifyDiscord = swapData.usdValue >= (this.config?.helius?.minSwapValue || 100);
                const shouldNotifySMS = swapData.usdValue >= (this.config?.helius?.minSmsSwapValue || 1000);

                // Format notification messages
                const notificationData = this.formatSwapNotification(swapData);

                // Send Discord notification if threshold met
                if (shouldNotifyDiscord) {
                    try {
                        await this.sendDiscordNotification(notificationData);
                        console.log(`[INFO] Sent Discord notification for ${swapData.walletName}'s swap of $${swapData.usdValue}`);
                    } catch (error) {
                        console.error('[ERROR] Failed to send Discord notification:', error);
                    }
                }

                // Send SMS notification if threshold met and user subscribed
                if (shouldNotifySMS && swapData.discordUserId) {
                    try {
                        await this.sendSMSNotification(notificationData);
                        console.log(`[INFO] Sent SMS notification for ${swapData.walletName}'s swap of $${swapData.usdValue}`);
                    } catch (error) {
                        console.error('[ERROR] Failed to send SMS notification:', error);
                    }
                }

                // Log successful processing
                console.log(`[INFO] Processed swap event for ${swapData.walletName} (${swapData.wallet})`);
                console.log(`[INFO] Swap value: $${this.formatUSD(swapData.usdValue)}`);

            } catch (error) {
                console.error('[ERROR] Error processing webhook event:', error);
                // Continue processing other events even if one fails
            }
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
            color: 0x00ff00, // Green color for swap notifications
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
}

module.exports = HeliusService; 