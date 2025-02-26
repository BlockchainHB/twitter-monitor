const axios = require('axios');
const RateLimitManager = require('./RateLimitManager');
const BirdeyeService = require('./BirdeyeService');
const path = require('path');
const fs = require('fs').promises;

class HeliusRateLimitManager extends RateLimitManager {
    constructor() {
        super({
            endpoints: {
                'helius/webhooks/list': {
                    requestsPerWindow: 10,
                    windowSizeMinutes: 1
                },
                'helius/webhooks/create': {
                    requestsPerWindow: 5,
                    windowSizeMinutes: 1
                },
                'helius/webhooks/delete': {
                    requestsPerWindow: 5,
                    windowSizeMinutes: 1
                },
                'helius/webhooks/get': {
                    requestsPerWindow: 10,
                    windowSizeMinutes: 1
                },
                'helius/webhooks/update': {
                    requestsPerWindow: 5,
                    windowSizeMinutes: 1
                }
            },
            defaultLimit: {
                requestsPerWindow: 5,
                windowSizeMinutes: 1
            },
            safetyMargin: 0.9
        });
    }
}

class HeliusService {
    constructor(apiKey, birdeyeService) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.helius.xyz/v0';
        this.rateLimitManager = new HeliusRateLimitManager();
        this.activeWebhooks = new Map(); // In-memory storage
        this.walletNames = new Map(); // In-memory wallet name storage
        this.birdeyeService = birdeyeService; // Use provided Birdeye service
        this.walletsPath = path.join(__dirname, '../config/wallets.json');
    }

    // Add this new method
    async loadWalletsFromJson() {
        try {
            console.log('📝 Loading wallets from JSON file...');
            const data = await fs.readFile(this.walletsPath, 'utf8');
            const jsonData = JSON.parse(data);
            
            const wallets = jsonData.wallets || [];
            
            if (wallets.length === 0) {
                console.log('⚠️ No wallets found in wallets.json');
                return;
            }

            // Initialize wallets in memory
            wallets.forEach(wallet => {
                if (wallet.address && wallet.name) {
                    this.walletNames.set(wallet.address, wallet.name);
                }
            });

            console.log(`✅ Loaded ${this.walletNames.size} wallets into memory`);
            
            // Log first few wallets as sample
            console.log('Sample wallets loaded:');
            [...this.walletNames.entries()].slice(0, 3).forEach(([address, name]) => {
                console.log(`- ${name}: ${address}`);
            });

        } catch (error) {
            console.error('❌ Failed to load wallets from JSON:', error);
            throw error;
        }
    }

    // Get webhook URL for a specific wallet
    getWebhookUrl(webhookId) {
        return `${this.baseUrl}/webhook/${webhookId}?api-key=${this.apiKey}`;
    }

    // Sync wallets with Helius webhook
    async syncWallets(webhookUrl, accountAddresses) {
        try {
            // Load initial wallets if not already loaded
            if (this.walletNames.size === 0) {
                await this.loadWalletsFromJson();
            }
            
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
                transactionTypes: ['SWAP', 'TOKEN_TRANSFER'],
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
            // Get existing webhook to preserve other settings
            const existingWebhook = await this.getWebhook(webhookId);
            
            // Ensure accountAddresses is an array
            const addresses = Array.isArray(accountAddresses) ? accountAddresses : [accountAddresses];
            
            const payload = {
                webhookURL: existingWebhook.webhookURL,
                accountAddresses: addresses,
                transactionTypes: ['SWAP', 'TOKEN_TRANSFER'],
                webhookType: 'enhanced'
            };

            console.log('Updating webhook with payload:', JSON.stringify(payload, null, 2));
            
            const response = await axios.put(`${this.baseUrl}/webhooks/${webhookId}?api-key=${this.apiKey}`, payload);
            return response.data;
        } catch (error) {
            console.error('[ERROR] Failed to update Helius webhook:', error.message);
            if (error.response?.data) {
                console.error('Response data:', error.response.data);
            }
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
        console.log('[DEBUG] Parsing swap transaction:', JSON.stringify(transaction, null, 2));

        // Handle both enhanced and basic webhook formats
        if (!transaction) return null;

        try {
            // For enhanced webhook format
            if (transaction.type === 'SWAP' && transaction.events?.swap) {
                const {
                    timestamp,
                    signature,
                    source,
                    fee,
                    events
                } = transaction;

                const swapEvent = events.swap;

                return {
                    timestamp,
                    signature,
                    wallet: source,
                    fee: fee || 0,
                    type: 'SWAP',
                    usdValue: swapEvent.usdValue || 0,
                    tokenSent: {
                        mint: swapEvent.tokenIn,
                        amount: swapEvent.amountIn,
                        symbol: swapEvent.tokenInSymbol || 'Unknown',
                        decimals: swapEvent.tokenInDecimals || 0,
                        usdValue: swapEvent.tokenInUsdValue || 0
                    },
                    tokenReceived: {
                        mint: swapEvent.tokenOut,
                        amount: swapEvent.amountOut,
                        symbol: swapEvent.tokenOutSymbol || 'Unknown',
                        decimals: swapEvent.tokenOutDecimals || 0,
                        usdValue: swapEvent.tokenOutUsdValue || 0
                    },
                    market: {
                        name: swapEvent.platformName || 'Unknown DEX',
                        address: swapEvent.platformAddress || null,
                        fee: swapEvent.platformFee || 0
                    }
                };
            }

            // For basic webhook format
            if (transaction.description?.includes('Swap') || transaction.type?.includes('SWAP')) {
                const {
                    timestamp,
                    signature,
                    accountData,
                    tokenTransfers,
                    nativeTransfers
                } = transaction;

                // Calculate total value
                let usdValue = 0;
                let tokenSent = null;
                let tokenReceived = null;

                if (tokenTransfers?.length >= 2) {
                    tokenSent = {
                        mint: tokenTransfers[0].mint,
                        amount: tokenTransfers[0].tokenAmount,
                        symbol: tokenTransfers[0].symbol || 'Unknown',
                        decimals: tokenTransfers[0].decimals || 0,
                        usdValue: tokenTransfers[0].usdValue || 0
                    };
                    tokenReceived = {
                        mint: tokenTransfers[1].mint,
                        amount: tokenTransfers[1].tokenAmount,
                        symbol: tokenTransfers[1].symbol || 'Unknown',
                        decimals: tokenTransfers[1].decimals || 0,
                        usdValue: tokenTransfers[1].usdValue || 0
                    };
                    usdValue = Math.max(tokenSent.usdValue, tokenReceived.usdValue);
                }

                return {
                    timestamp,
                    signature,
                    wallet: accountData?.account || transaction.source,
                    fee: transaction.fee || 0,
                    type: 'SWAP',
                    usdValue,
                    tokenSent,
                    tokenReceived,
                    market: {
                        name: 'DEX',
                        address: null,
                        fee: 0
                    }
                };
            }

            return null;
        } catch (error) {
            console.error('[ERROR] Failed to parse swap transaction:', error);
            console.error('[ERROR] Transaction data:', JSON.stringify(transaction, null, 2));
            return null;
        }
    }

    // Format swap notification with rich details
    async formatSwapNotification(swapData) {
        const {
            walletName,
            tokenSent,
            tokenReceived,
            usdValue
        } = swapData;

        // Format amounts with proper decimals
        const sentAmount = this.formatTokenAmount(tokenSent.amount, tokenSent.decimals);
        const receivedAmount = this.formatTokenAmount(tokenReceived.amount, tokenReceived.decimals);

        // List of stablecoin/base token mints
        const baseTokens = [
            'So11111111111111111111111111111111111111112', // SOL
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
        ];

        const fields = [
            {
                name: '📤 Sent',
                value: `${sentAmount} ${tokenSent.symbol}\n($${this.formatUSD(tokenSent.usdValue)})`,
                inline: true
            },
            {
                name: '📥 Received',
                value: `${receivedAmount} ${tokenReceived.symbol}\n($${this.formatUSD(tokenReceived.usdValue)})`,
                inline: true
            }
        ];

        // Only show token stats if:
        // 1. Sending a base token (SOL/USDC/USDT)
        // 2. Receiving a non-base token
        if (baseTokens.includes(tokenSent.mint) && !baseTokens.includes(tokenReceived.mint)) {
            // Get token info for received token
            const tokenInfo = await this.birdeyeService.getTokenInfo(tokenReceived.mint);
            if (tokenInfo) {
                fields.push({
                    name: '📊 Token Stats',
                    value: [
                        `💰 Price: $${this.formatUSD(tokenInfo.price)}`,
                        tokenInfo.marketCap ? `💎 MC: $${this.formatUSD(tokenInfo.marketCap)}` : null,
                        tokenInfo.liquidity ? `💧 LP: $${this.formatUSD(tokenInfo.liquidity)}` : null,
                        tokenInfo.holders ? `👥 Holders: ${this.formatNumber(tokenInfo.holders)}` : null,
                        `\n[📈 View Chart](https://dexscreener.com/solana/${tokenReceived.mint})`
                    ].filter(Boolean).join('\n'),
                    inline: false
                });
            }
        }

        return {
            title: `🔄 Swap by ${walletName}`,
            description: `Swapped tokens worth $${this.formatUSD(usdValue)}`,
            fields,
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
        try {
            console.log('[DEBUG] Received webhook data:', JSON.stringify(data, null, 2));

            // Ensure we have the correct channel ID from environment
            const WALLETS_CHANNEL = process.env.DISCORD_WALLETS_CHANNEL;
            if (!WALLETS_CHANNEL) {
                console.error('[ERROR] DISCORD_WALLETS_CHANNEL not configured');
                return;
            }

            // Process transactions in small batches with slight delays
            const BATCH_SIZE = 3;
            const DELAY_BETWEEN_NOTIFICATIONS = 2000;

            // Group transactions into batches
            for (let i = 0; i < data.length; i += BATCH_SIZE) {
                const batch = data.slice(i, i + BATCH_SIZE);
                
                // Process each transaction in the batch concurrently
                await Promise.all(batch.map(async (transaction) => {
                    try {
                        // Find the relevant wallet address from the transaction
                        let walletAddress = transaction.accountData?.account || 
                                          transaction.source ||
                                          (transaction.tokenBalanceChanges?.[0]?.userAccount);

                        console.log(`[DEBUG] Identified wallet address: ${walletAddress}`);

                        // Skip if not a tracked wallet
                        if (!walletAddress || !this.walletNames.has(walletAddress)) {
                            console.log(`[DEBUG] Skipping transaction for untracked wallet: ${walletAddress}`);
                            return;
                        }

                        let notification;
                        const walletName = this.walletNames.get(walletAddress);

                        // Handle SWAP transactions
                        if (transaction.type === 'SWAP') {
                            const swapData = this.parseSwapTransaction(transaction);
                            if (swapData) {
                                notification = await this.formatSwapNotification({
                                    ...swapData,
                                    walletName
                                });

                                // Send notification if we have one
                                if (notification && this.onNotification) {
                                    // Check if this is a high-value transaction (>= $1000)
                                    const isHighValue = swapData.usdValue >= 1000;
                                    await this.onNotification({
                                        content: isHighValue ? '@everyone High-value swap detected! 🔥' : null,
                                        embeds: [notification],
                                        allowedMentions: { parse: isHighValue ? ['everyone'] : [] }
                                    });
                                    console.log('[DEBUG] Sent notification for swap transaction');
                                }
                            }
                        } 
                        // Handle TRANSFER transactions
                        else if (transaction.tokenBalanceChanges?.length > 0) {
                            notification = await this.formatTransferNotification(transaction, walletName);

                            // Send notification if we have one
                            if (notification && this.onNotification) {
                                // Check if this is a high-value transfer (>= $1000)
                                const isHighValue = notification.color === 0xFF0000;
                                await this.onNotification({
                                    content: isHighValue ? '@everyone High-value transfer detected! 🔥' : null,
                                    embeds: [notification],
                                    allowedMentions: { parse: isHighValue ? ['everyone'] : [] }
                                });
                                console.log('[DEBUG] Sent notification for transfer transaction');
                            }
                        }

                    } catch (txError) {
                        console.error('[ERROR] Error processing transaction:', txError);
                    }
                }));

                // Add delay between batches if there are more to process
                if (i + BATCH_SIZE < data.length) {
                    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_NOTIFICATIONS));
                }
            }

        } catch (error) {
            console.error('[ERROR] Error processing webhook:', error);
        }
    }

    // Format transfer notification
    async formatTransferNotification(transaction, walletName) {
        try {
            let totalUsdValue = 0;
            const fields = [];

            // List of stablecoin/base token mints
            const baseTokens = [
                'So11111111111111111111111111111111111111112', // SOL
                'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
            ];

            // Process token transfers
            for (const transfer of transaction.tokenBalanceChanges) {
                let tokenInfo = null;
                if (transfer.mint) {
                    try {
                        tokenInfo = await this.birdeyeService.getTokenInfo(transfer.mint);
                    } catch (error) {
                        console.error(`[ERROR] Failed to fetch Birdeye data for token ${transfer.mint}:`, error);
                    }
                }

                const amount = Math.abs(Number(transfer.rawTokenAmount.tokenAmount));
                const decimals = transfer.rawTokenAmount.decimals;
                const formattedAmount = this.formatTokenAmount(amount, decimals);
                const isOutgoing = Number(transfer.rawTokenAmount.tokenAmount) < 0;

                // Calculate USD value if available
                if (tokenInfo?.price) {
                    const usdValue = (amount / Math.pow(10, decimals)) * tokenInfo.price;
                    totalUsdValue += usdValue;
                }

                // Create token transfer field
                const fieldValue = [`${formattedAmount} ${tokenInfo?.symbol || 'tokens'}`];
                
                if (tokenInfo?.price) {
                    fieldValue.push(`$${this.formatUSD((amount / Math.pow(10, decimals)) * tokenInfo.price)}`);
                }

                fields.push({
                    name: isOutgoing ? '📤 Sent' : '📥 Received',
                    value: fieldValue.join('\n'),
                    inline: true
                });

                // Only show token stats for non-base tokens
                if (tokenInfo && !baseTokens.includes(transfer.mint)) {
                    fields.push({
                        name: '📊 Token Stats',
                        value: [
                            `💰 Price: $${this.formatUSD(tokenInfo.price)}`,
                            tokenInfo.marketCap ? `💎 MC: $${this.formatUSD(tokenInfo.marketCap)}` : null,
                            tokenInfo.liquidity ? `💧 LP: $${this.formatUSD(tokenInfo.liquidity)}` : null,
                            tokenInfo.holders ? `👥 Holders: ${this.formatNumber(tokenInfo.holders)}` : null,
                            `\n[📈 View Chart](https://dexscreener.com/solana/${transfer.mint})`
                        ].filter(Boolean).join('\n'),
                        inline: false
                    });
                }
            }

            return {
                title: totalUsdValue >= 1000 ? '🔥 High Value Transfer' : '💸 Token Transfer',
                description: `Transfer by ${walletName}${totalUsdValue > 0 ? ` worth $${this.formatUSD(totalUsdValue)}` : ''}`,
                fields,
                color: totalUsdValue >= 1000 ? 0xFF0000 : 0x9945FF,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('[ERROR] Error formatting transfer notification:', error);
            return null;
        }
    }

    // Register notification callback
    setNotificationHandler(callback) {
        this.onNotification = callback;
    }

    // Add a wallet name to in-memory storage
    setWalletName(address, name) {
        this.walletNames.set(address, name);
    }

    // Get a wallet name from in-memory storage
    getWalletName(address) {
        return this.walletNames.get(address);
    }

    // Helper function to format numbers
    formatNumber(num) {
        if (!num && num !== 0) return '0';
        
        const value = parseFloat(num);
        if (isNaN(value)) return '0';
        
        if (value === 0) return '0';
        
        if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
        if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
        if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
        
        if (Math.abs(value) < 0.000001) return value.toExponential(2);
        if (Math.abs(value) < 0.01) return value.toFixed(6);
        if (Math.abs(value) < 1) return value.toFixed(4);
        return value.toFixed(2);
    }
}

module.exports = HeliusService; 