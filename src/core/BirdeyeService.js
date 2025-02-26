const { default: axios } = require('axios');
const { EventEmitter } = require('events');

// Dedicated rate limit manager for Birdeye
class BirdeyeRateLimitManager extends EventEmitter {
    constructor() {
        super();
        this.window = {
            startTime: Date.now(),
            requestCount: 0
        };
        this.limit = {
            requestsPerWindow: 60,
            windowSizeMinutes: 1,
            safetyMargin: 0.9
        };
    }

    async scheduleRequest(requestFn) {
        const now = Date.now();
        const windowSize = this.limit.windowSizeMinutes * 60 * 1000;
        
        // Reset window if needed
        if (now - this.window.startTime >= windowSize) {
            this.window = {
                startTime: now,
                requestCount: 0
            };
        }

        // Check if we're within rate limits
        const safeLimit = Math.floor(this.limit.requestsPerWindow * this.limit.safetyMargin);
        if (this.window.requestCount >= safeLimit) {
            const waitTime = windowSize - (now - this.window.startTime);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            this.window = {
                startTime: Date.now(),
                requestCount: 0
            };
        }

        // Execute request
        this.window.requestCount++;
        return await requestFn();
    }
}

class BirdeyeService {
    constructor() {
        // Use dedicated rate limit manager for Birdeye
        this.rateLimitManager = new BirdeyeRateLimitManager();
        this.baseUrl = 'https://public-api.birdeye.so';
        this.apiKey = process.env.BIRDEYE_API_KEY;

        // Standard headers for all requests
        this.headers = {
            'X-API-KEY': this.apiKey,
            'accept': 'application/json'
        };

        // Minimal blacklist for major tokens
        this.blacklist = ['SOL', 'USDC', 'USDT', 'JUP', 'WBTC', 'WETH'];

        // Simple cache for token info
        this.tokenInfoCache = new Map();
        this.CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
    }

    // Simple token filtering
    shouldIncludeToken(token) {
        if (!token?.symbol) return false;
        if (!token.network === 'solana') return false;
        return !this.blacklist.includes(token.symbol.toUpperCase());
    }

    async getTrendingTokens() {
        try {
            const result = await this.rateLimitManager.scheduleRequest(
                async () => {
                    console.log('[DEBUG] Making Birdeye API request for trending tokens...');
                    const response = await axios.get(`${this.baseUrl}/defi/token_trending`, {
                        headers: {
                            ...this.headers,
                            'x-chain': 'solana'
                        },
                        params: {
                            sort_by: 'rank',
                            sort_type: 'asc',
                            offset: 0,
                            limit: 10
                        }
                    });
                    console.log('[DEBUG] Birdeye API response status:', response.status);
                    return response.data;
                },
                'birdeye/trending'
            );

            if (!result?.success || !result?.data?.tokens) {
                console.log('[DEBUG] Invalid response structure:', result);
                return [];
            }

            const tokenData = result.data.tokens;
            console.log('[DEBUG] Processing tokens:', tokenData.length);

            // Only filter out blacklisted tokens
            const tokens = tokenData
                .filter(token => !this.blacklist.includes(token.symbol?.toUpperCase()))
                .map(token => ({
                    name: token.name || 'Unknown',
                    symbol: token.symbol || 'UNKNOWN',
                    price: parseFloat(token.price || 0),
                    priceChange: parseFloat(token.price24hChangePercent || 0),
                    volume24h: parseFloat(token.volume24hUSD || 0),
                    marketCap: parseFloat(token.marketcap || token.fdv || 0),
                    liquidity: parseFloat(token.liquidity || 0),
                    address: token.address || '',
                    logoURI: token.logoURI || null,
                    trades24h: 0, // Not provided in this endpoint
                    buys24h: 0,   // Not provided in this endpoint
                    sells24h: 0    // Not provided in this endpoint
                }));

            console.log('[DEBUG] Filtered trending tokens:', tokens.length);
            return tokens.slice(0, 5);
        } catch (error) {
            console.error('[ERROR] Error fetching trending tokens:', error.message);
            if (error.response) {
                console.error('[ERROR] API Response:', {
                    status: error.response.status,
                    data: error.response.data,
                    headers: error.response.headers
                });
            }
            return [];
        }
    }

    async getTopMovers() {
        try {
            const result = await this.rateLimitManager.scheduleRequest(
                async () => {
                    console.log('[DEBUG] Making Birdeye API request for top movers...');
                    const response = await axios.get(`${this.baseUrl}/defi/v3/search`, {
                        headers: this.headers,
                        params: { 
                            chain: 'solana',
                            target: 'token',
                            sort_by: 'price_change_24h_percent',
                            sort_type: 'desc',
                            offset: 0,
                            limit: 5
                        }
                    });
                    console.log('[DEBUG] Birdeye API response status:', response.status);
                    return response.data;
                },
                'birdeye/movers'
            );

            if (!result?.success) {
                console.log('[DEBUG] API request not successful:', result);
                return [];
            }

            if (!result?.data?.items?.[0]?.result) {
                console.log('[DEBUG] Invalid response structure:', result);
                return [];
            }

            const tokenData = result.data.items[0].result;
            console.log('[DEBUG] Processing tokens:', tokenData.length);

            const tokens = tokenData
                .filter(token => this.shouldIncludeToken(token))
                .map(token => ({
                    name: token.name || 'Unknown',
                    symbol: token.symbol || 'UNKNOWN',
                    price: parseFloat(token.price || 0),
                    priceChange: parseFloat(token.price_change_24h_percent || 0),
                    volume24h: parseFloat(token.volume_24h_usd || 0),
                    marketCap: parseFloat(token.market_cap || token.fdv || 0),
                    liquidity: parseFloat(token.liquidity || 0),
                    trades24h: parseInt(token.trade_24h || 0),
                    buys24h: parseInt(token.buy_24h || 0),
                    sells24h: parseInt(token.sell_24h || 0)
                }));

            console.log('[DEBUG] Filtered tokens:', tokens.length);
            return tokens;
        } catch (error) {
            console.error('[ERROR] Error fetching top movers:', error.message);
            if (error.response) {
                console.error('[ERROR] API Response:', {
                    status: error.response.status,
                    data: error.response.data,
                    headers: error.response.headers
                });
            }
            return [];
        }
    }

    async getVolumeLeaders() {
        try {
            const result = await this.rateLimitManager.scheduleRequest(
                async () => {
                    console.log('[DEBUG] Making Birdeye API request for volume leaders...');
                    const response = await axios.get(`${this.baseUrl}/defi/v3/search`, {
                        headers: this.headers,
                        params: { 
                            chain: 'solana',
                            target: 'token',
                            sort_by: 'volume_24h_usd',
                            sort_type: 'desc',
                            offset: 0,
                            limit: 10
                        }
                    });
                    console.log('[DEBUG] Birdeye API response status:', response.status);
                    return response.data;
                },
                'birdeye/volume'
            );

            if (!result?.success) {
                console.log('[DEBUG] API request not successful:', result);
                return [];
            }

            if (!result?.data?.items?.[0]?.result) {
                console.log('[DEBUG] Invalid response structure:', result);
                return [];
            }

            const tokenData = result.data.items[0].result;
            console.log('[DEBUG] Processing tokens:', tokenData.length);

            const tokens = tokenData
                .filter(token => this.shouldIncludeToken(token))
                .map(token => ({
                    name: token.name || 'Unknown',
                    symbol: token.symbol || 'UNKNOWN',
                    volume24h: parseFloat(token.volume_24h_usd || 0),
                    priceChange: parseFloat(token.price_change_24h_percent || 0),
                    price: parseFloat(token.price || 0),
                    trades24h: parseInt(token.trade_24h || 0),
                    buys24h: parseInt(token.buy_24h || 0),
                    sells24h: parseInt(token.sell_24h || 0),
                    buyRatio: token.buy_24h && token.trade_24h ? 
                        Math.round((token.buy_24h / token.trade_24h) * 100) : 50
                }));

            console.log('[DEBUG] Filtered volume leaders:', tokens.length);
            return tokens.slice(0, 5);
        } catch (error) {
            console.error('[ERROR] Error fetching volume leaders:', error.message);
            if (error.response) {
                console.error('[ERROR] API Response:', {
                    status: error.response.status,
                    data: error.response.data,
                    headers: error.response.headers
                });
            }
            return [];
        }
    }

    createTrendingEmbed(tokens) {
        const embed = {
            title: '📈 Trending Tokens',
            description: 'Top trending tokens by volume and activity:',
            color: 0x9945FF,
            fields: [],
            footer: {
                text: 'built by keklabs',
                icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
            },
            timestamp: new Date().toISOString()
        };

        // Take only top 5 tokens
        tokens.slice(0, 5).forEach((token, index) => {
            const priceChangeEmoji = (token.priceChange || 0) >= 0 ? '🟢' : '🔴';
            const priceChangeSymbol = (token.priceChange || 0) >= 0 ? '+' : '';
            
            embed.fields.push({
                name: `${index + 1}. ${token.name || 'Unknown'} (${token.symbol || 'UNKNOWN'})`,
                value: [
                    `💰 Price: $${this.formatNumber(token.price || token.priceUsd || 0)}`,
                    `${priceChangeEmoji} 24h Change: ${priceChangeSymbol}${this.formatNumber(token.priceChange || 0)}%`,
                    `📊 24h Volume: $${this.formatNumber(token.volume24h || 0)}`,
                    `💎 Market Cap: $${this.formatNumber(token.marketCap || 0)}`,
                    `💧 Liquidity: $${this.formatNumber(token.liquidity || 0)}`
                ].join('\n'),
                inline: false
            });
        });

        if (!tokens || tokens.length === 0) {
            embed.description = 'No trending tokens found at this time.';
        }

        return embed;
    }

    createMoversEmbed(tokens, type = 'gainers') {
        if (!tokens || tokens.length === 0) {
            return {
                title: type === 'gainers' ? '📈 Top SOL Gainers (24H)' : '📉 Top SOL Losers (24H)',
                description: `No ${type} found at this time.`,
                color: type === 'gainers' ? 0x00FF00 : 0xFF0000,
                footer: {
                    text: "built by keklabs",
                    icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                },
                timestamp: new Date().toISOString()
            };
        }

        return {
            title: type === 'gainers' ? '📈 Top SOL Gainers (24H)' : '📉 Top SOL Losers (24H)',
            description: tokens.map((token, index) => {
                const priceChangeEmoji = token.priceChange >= 0 ? '🟢' : '🔴';
                const priceChangeSymbol = token.priceChange >= 0 ? '+' : '';
                return `${index + 1}. ${token.name} ($${token.symbol})
💰 Price: $${this.formatNumber(token.price)}
${priceChangeEmoji} Change: ${priceChangeSymbol}${this.formatNumber(token.priceChange)}%
📊 Vol: $${this.formatNumber(token.volume24h)} • 💧 LP: $${this.formatNumber(token.liquidity)}
🔄 Trades: ${this.formatNumber(token.trades24h)} (📈 ${this.formatNumber(token.buys24h)} • 📉 ${this.formatNumber(token.sells24h)})`
            }).join('\n\n'),
            color: type === 'gainers' ? 0x00FF00 : 0xFF0000,
            footer: {
                text: "built by keklabs",
                icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
            },
            timestamp: new Date().toISOString()
        };
    }

    createVolumeEmbed(tokens) {
        return {
            title: '📊 Volume Leaders (24H)',
            description: tokens.map((token, index) => {
                const priceChange = parseFloat(token.priceChange || 0);
                const priceChangeEmoji = priceChange >= 0 ? '🟢' : '🔴';
                const priceChangeSymbol = priceChange >= 0 ? '+' : '';
                return `${index + 1}. ${token.name} ($${token.symbol})
💰 Price: $${this.formatNumber(token.price)}
📊 Volume: $${this.formatNumber(token.volume24h)}
${priceChangeEmoji} 24h Change: ${priceChangeSymbol}${this.formatNumber(priceChange)}%
🔄 Trades: ${this.formatNumber(token.trades24h)} (📈 ${token.buyRatio}% • 📉 ${100 - token.buyRatio}%)`
            }).join('\n\n'),
            color: 0x9945FF,
            footer: {
                text: "built by keklabs",
                icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
            },
            timestamp: new Date().toISOString()
        };
    }

    formatTimeAgo(date) {
        const now = new Date();
        const diffInSeconds = Math.floor((now - date) / 1000);
        const diffInMinutes = Math.floor(diffInSeconds / 60);
        const diffInHours = Math.floor(diffInMinutes / 60);
        const diffInDays = Math.floor(diffInHours / 24);

        if (diffInDays > 0) return `${diffInDays}d`;
        if (diffInHours > 0) return `${diffInHours}h`;
        if (diffInMinutes > 0) return `${diffInMinutes}m`;
        return `${diffInSeconds}s`;
    }

    formatNumber(num) {
        if (!num && num !== 0) return '0';
        
        const value = parseFloat(num);
        if (isNaN(value)) return '0';
        
        if (value === 0) return '0';
        
        // Format large numbers
        if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
        if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
        if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
        
        // Format small numbers
        if (Math.abs(value) < 0.000001) return value.toExponential(2);
        if (Math.abs(value) < 0.01) return value.toFixed(6);
        if (Math.abs(value) < 1) return value.toFixed(4);
        return value.toFixed(2);
    }

    // Helper method to format token data consistently
    formatTokenData(tokens) {
        return tokens.map(token => ({
            name: token.name || 'Unknown',
            symbol: token.symbol || 'UNKNOWN',
            price: parseFloat(token.price || 0),
            priceChange: parseFloat(token.priceChange24h || 0),
            volume24h: parseFloat(token.volume24h || 0),
            marketCap: parseFloat(token.marketCap || 0),
            liquidity: parseFloat(token.liquidity || 0),
            txCount24h: parseInt(token.txCount24h || 0),
            holders: parseInt(token.holders || 0),
            address: token.address || ''
        }));
    }

    async getTokenSecurity(address) {
        try {
            const result = await this.rateLimitManager.scheduleRequest(
                async () => {
                    console.log('[DEBUG] Making Birdeye API request for token security...');
                    const response = await axios.get(`${this.baseUrl}/defi/token_security`, {
                        headers: {
                            ...this.headers,
                            'x-chain': 'solana'
                        },
                        params: {
                            address: address
                        }
                    });
                    console.log('[DEBUG] Birdeye API security response status:', response.status);
                    return response.data;
                },
                'birdeye/security'
            );

            if (!result?.success || !result?.data) {
                console.log('[DEBUG] Invalid security response structure:', result);
                return null;
            }

            return result.data;
        } catch (error) {
            console.error('[ERROR] Error fetching token security:', error.message);
            if (error.response) {
                console.error('[ERROR] API Response:', {
                    status: error.response.status,
                    data: error.response.data,
                    headers: error.response.headers
                });
            }
            return null;
        }
    }

    createSecurityEmbed(address, securityData) {
        if (!securityData) {
            return {
                title: '🔒 Token Security Analysis',
                description: 'Could not fetch security information for this token.',
                color: 0xFF0000,
                footer: {
                    text: "built by keklabs",
                    icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                },
                timestamp: new Date().toISOString()
            };
        }

        // Format token address for display
        const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
        const addressLink = `[${shortAddress}](https://solscan.io/token/${address})`;

        // Calculate risk indicators
        const riskIndicators = [];
        if (securityData.mutableMetadata) riskIndicators.push("⚠️ Mutable Metadata");
        if (securityData.freezeable) riskIndicators.push("⚠️ Can be Frozen");
        if (securityData.transferFeeEnable) riskIndicators.push("⚠️ Transfer Fee Enabled");
        if (securityData.isToken2022) riskIndicators.push("ℹ️ Token-2022 Program");
        if (securityData.jupStrictList) riskIndicators.push("✅ Jupiter Strict Listed");

        // Format holder concentrations
        const holderStats = [
            `Top 10 Holders: ${(securityData.top10HolderPercent * 100).toFixed(2)}%`,
            `Top 10 Users: ${(securityData.top10UserPercent * 100).toFixed(2)}%`
        ];

        // Format creation info
        const creationInfo = [];
        if (securityData.creationTime) {
            creationInfo.push(`Created: ${new Date(securityData.creationTime).toLocaleString()}`);
        }
        if (securityData.creatorAddress) {
            const shortCreator = `${securityData.creatorAddress.slice(0, 6)}...${securityData.creatorAddress.slice(-4)}`;
            creationInfo.push(`Creator: [${shortCreator}](https://solscan.io/account/${securityData.creatorAddress})`);
        }

        return {
            title: '🔒 Token Security Analysis',
            description: [
                `**Contract Address:** ${addressLink}`,
                '',
                '**Risk Indicators:**',
                riskIndicators.length > 0 ? riskIndicators.join('\n') : '✅ No major risks detected',
                '',
                '**Holder Distribution:**',
                holderStats.join('\n'),
                '',
                '**Supply Information:**',
                `Total Supply: ${this.formatNumber(securityData.totalSupply)}`,
                '',
                creationInfo.length > 0 ? `**Creation Info:**\n${creationInfo.join('\n')}` : ''
            ].join('\n'),
            color: riskIndicators.length > 2 ? 0xFF0000 : riskIndicators.length > 0 ? 0xFFA500 : 0x00FF00,
            footer: {
                text: "built by keklabs",
                icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
            },
            timestamp: new Date().toISOString()
        };
    }

    async getTokenMetrics(address) {
        try {
            const result = await this.rateLimitManager.scheduleRequest(
                async () => {
                    console.log('[DEBUG] Making Birdeye API request for token metrics...');
                    const response = await axios.get(`${this.baseUrl}/defi/v3/token/trade-data/single`, {
                        headers: {
                            ...this.headers,
                            'x-chain': 'solana'
                        },
                        params: {
                            address: address
                        }
                    });
                    console.log('[DEBUG] Birdeye API metrics response status:', response.status);
                    return response.data;
                },
                'birdeye/metrics'
            );

            if (!result?.success || !result?.data) {
                console.log('[DEBUG] Invalid metrics response structure:', result);
                return null;
            }

            return result.data;
        } catch (error) {
            console.error('[ERROR] Error fetching token metrics:', error.message);
            if (error.response) {
                console.error('[ERROR] API Response:', {
                    status: error.response.status,
                    data: error.response.data
                });
            }
            return null;
        }
    }

    createMetricsEmbed(address, metricsData) {
        if (!metricsData) {
            return {
                title: '📊 Token Metrics',
                description: 'Could not fetch metrics for this token.',
                color: 0xFF0000,
                footer: {
                    text: "built by keklabs",
                    icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                }
            };
        }

        const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
        const addressLink = `[${shortAddress}](https://solscan.io/token/${address})`;

        // Format 24h metrics with safe defaults
        const volume24h = this.formatNumber(metricsData.volume_24h_usd || 0);
        const priceChange24h = (metricsData.price_change_24h_percent || 0).toFixed(2);
        const trades24h = this.formatNumber(metricsData.trade_24h || 0);
        const buys24h = this.formatNumber(metricsData.buy_24h || 0);
        const sells24h = this.formatNumber(metricsData.sell_24h || 0);

        // Format 1h metrics with safe defaults
        const volume1h = this.formatNumber(metricsData.volume_1h_usd || 0);
        const priceChange1h = (metricsData.price_change_1h_percent || 0).toFixed(2);
        const trades1h = this.formatNumber(metricsData.trade_1h || 0);
        const buys1h = this.formatNumber(metricsData.buy_1h || 0);
        const sells1h = this.formatNumber(metricsData.sell_1h || 0);

        // Calculate buy/sell ratios with safe defaults
        const buyRatio24h = ((buys24h / Math.max(buys24h + sells24h, 1)) * 100).toFixed(1);
        const buyRatio1h = ((buys1h / Math.max(buys1h + sells1h, 1)) * 100).toFixed(1);

        return {
            title: '📊 Token Metrics Analysis',
            description: [
                `**Contract:** ${addressLink}`,
                `**Current Price:** $${this.formatNumber(metricsData.price || 0)}`,
                '',
                '**24h Statistics:**',
                `💰 Price Change: ${priceChange24h}%`,
                `📊 Volume: $${volume24h}`,
                `🔄 Trades: ${trades24h} (${buyRatio24h}% buys)`,
                `📈 Buys: ${buys24h}`,
                `📉 Sells: ${sells24h}`,
                '',
                '**1h Statistics:**',
                `💰 Price Change: ${priceChange1h}%`,
                `📊 Volume: $${volume1h}`,
                `🔄 Trades: ${trades1h} (${buyRatio1h}% buys)`,
                `📈 Buys: ${buys1h}`,
                `📉 Sells: ${sells1h}`,
                '',
                `👥 Total Holders: ${this.formatNumber(metricsData.holder || 0)}`,
                `🏦 Markets: ${this.formatNumber(metricsData.market || 0)}`
            ].join('\n'),
            color: (metricsData.price_change_24h_percent || 0) >= 0 ? 0x00FF00 : 0xFF0000,
            footer: {
                text: "built by keklabs",
                icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
            },
            timestamp: new Date().toISOString()
        };
    }

    async getTokenHolders(address) {
        try {
            const result = await this.rateLimitManager.scheduleRequest(
                async () => {
                    console.log('[DEBUG] Making Birdeye API request for token holders...');
                    const response = await axios.get(`${this.baseUrl}/defi/v3/token/holder`, {
                        headers: {
                            ...this.headers,
                            'x-chain': 'solana'
                        },
                        params: {
                            address: address,
                            offset: 0,
                            limit: 3
                        }
                    });
                    console.log('[DEBUG] Birdeye API holders response status:', response.status);
                    return response.data;
                },
                'birdeye/holders'
            );

            if (!result?.success || !result?.data?.items) {
                console.log('[DEBUG] Invalid holders response structure:', result);
                return null;
            }

            // Get top 3 holders (no need to slice since we're only requesting 3)
            const topHolders = result.data.items.map(holder => ({
                owner: holder.owner,
                amount: holder.ui_amount,
                tokenAccount: holder.token_account,
                percentage: 0 // Will calculate if total supply is available
            }));

            return topHolders;
        } catch (error) {
            console.error('[ERROR] Error fetching token holders:', error.message);
            if (error.response) {
                console.error('[ERROR] API Response:', {
                    status: error.response.status,
                    data: error.response.data
                });
            }
            return null;
        }
    }

    async getTokenTopTraders(address) {
        try {
            const result = await this.rateLimitManager.scheduleRequest(
                async () => {
                    console.log('[DEBUG] Making Birdeye API request for top traders...');
                    const response = await axios.get(`${this.baseUrl}/defi/v2/tokens/top_traders`, {
                        headers: {
                            ...this.headers,
                            'x-chain': 'solana'
                        },
                        params: {
                            address: address,
                            time_frame: '24h',
                            sort_type: 'desc',
                            sort_by: 'volume',
                            offset: 0,
                            limit: 3
                        }
                    });
                    console.log('[DEBUG] Birdeye API top traders response status:', response.status);
                    return response.data;
                },
                'birdeye/top_traders'
            );

            if (!result?.success || !result?.data?.items) {
                console.log('[DEBUG] Invalid top traders response structure:', result);
                return null;
            }

            return result.data.items;
        } catch (error) {
            console.error('[ERROR] Error fetching top traders:', error.message);
            if (error.response) {
                console.error('[ERROR] API Response:', {
                    status: error.response.status,
                    data: error.response.data
                });
            }
            return null;
        }
    }

    createHoldersEmbed(address, holders, traders = null) {
        if (!holders) {
            return {
                title: '👥 Token Holders & Traders',
                description: 'Could not fetch holder information for this token.',
                color: 0xFF0000,
                footer: {
                    text: "built by keklabs",
                    icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                }
            };
        }

        const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
        const addressLink = `[${shortAddress}](https://solscan.io/token/${address})`;

        const holderList = holders.map((holder, index) => {
            const shortOwner = `${holder.owner.slice(0, 6)}...${holder.owner.slice(-4)}`;
            const ownerLink = `[${shortOwner}](https://solscan.io/account/${holder.owner})`;
            return `${index + 1}. ${ownerLink}\n💰 Amount: ${this.formatNumber(holder.amount)} tokens`;
        }).join('\n\n');

        let traderList = '';
        if (traders && traders.length > 0) {
            traderList = '\n\n**Top 24h Traders:**\n' + traders.map((trader, index) => {
                const shortOwner = `${trader.owner.slice(0, 6)}...${trader.owner.slice(-4)}`;
                const ownerLink = `[${shortOwner}](https://solscan.io/account/${trader.owner})`;
                const buyRatio = ((trader.tradeBuy / trader.trade) * 100).toFixed(1);
                return `${index + 1}. ${ownerLink}\n` +
                       `💱 Volume: $${this.formatNumber(trader.volume)}\n` +
                       `🔄 Trades: ${trader.trade} (${buyRatio}% buys)\n` +
                       `📈 Buy Vol: $${this.formatNumber(trader.volumeBuy)}\n` +
                       `📉 Sell Vol: $${this.formatNumber(trader.volumeSell)}`;
            }).join('\n\n');
        }

        return {
            title: '👥 Token Holders & Traders',
            description: [
                `**Contract:** ${addressLink}`,
                '',
                '**Top 3 Holders:**',
                holderList,
                traderList
            ].join('\n'),
            color: 0x9945FF,
            footer: {
                text: "built by keklabs",
                icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
            },
            timestamp: new Date().toISOString()
        };
    }

    isValidSolanaAddress(address) {
        // Basic validation - just check length and base58 characters
        return address && 
               address.length === 44 && 
               /^[1-9A-HJ-NP-Za-km-z]{44}$/.test(address);
    }

    async getTokenInfo(address) {
        try {
            // Check cache first
            const cached = this.tokenInfoCache.get(address);
            const now = Date.now();
            if (cached && (now - cached.timestamp) < this.CACHE_DURATION) {
                return cached.data;
            }

            // If not in cache or expired, fetch from API
            const response = await axios.get(`https://public-api.birdeye.so/public/token_info?address=${address}`);
            const tokenData = response?.data?.data;

            if (!tokenData) {
                console.log(`[Cache Miss] No data for token ${address}`);
                return null;
            }

            // Format and cache the data
            const formattedData = {
                name: tokenData.name || 'Unknown',
                symbol: tokenData.symbol || 'UNKNOWN',
                price: parseFloat(tokenData.price || 0),
                priceChange: parseFloat(tokenData.priceChange24hPercent || 0),
                volume24h: parseFloat(tokenData.v24hUSD || 0),
                marketCap: parseFloat(tokenData.marketCap || tokenData.fdv || 0),
                liquidity: parseFloat(tokenData.liquidity || 0),
                trades24h: parseInt(tokenData.trade24h || 0),
                buys24h: parseInt(tokenData.buy24h || 0),
                sells24h: parseInt(tokenData.sell24h || 0),
                holders: parseInt(tokenData.holder || 0),
                uniqueWallets24h: parseInt(tokenData.uniqueWallet24h || 0),
                buyRatio24h: tokenData.buy24h && tokenData.trade24h ? 
                    (tokenData.buy24h / tokenData.trade24h * 100) : 50,
                social: tokenData.extensions || {},
                logoURI: tokenData.logoURI,
                priceChange1h: parseFloat(tokenData.priceChange1hPercent || 0),
                priceChange4h: parseFloat(tokenData.priceChange4hPercent || 0),
                uniqueWallets1h: parseInt(tokenData.uniqueWallet1h || 0),
                uniqueWalletChange1h: parseFloat(tokenData.uniqueWallet1hChangePercent || 0),
                volumeChange24h: parseFloat(tokenData.v24hChangePercent || 0)
            };

            // Store in cache
            this.tokenInfoCache.set(address, {
                timestamp: now,
                data: formattedData
            });

            return formattedData;
        } catch (error) {
            console.error('[ERROR] Error fetching token info:', error.message);
            return null;
        }
    }

    createTokenEmbed(address, tokenInfo) {
        if (!tokenInfo) return null;

        const addressLink = `[${address}](https://birdeye.so/token/${address}?chain=solana)`;
        const priceFormatted = tokenInfo.price < 0.01 ? 
            tokenInfo.price.toExponential(2) : 
            tokenInfo.price.toLocaleString(undefined, { maximumFractionDigits: 4 });
        
        const mcapFormatted = tokenInfo.marketCap >= 1000000 ?
            `$${(tokenInfo.marketCap / 1000000).toFixed(2)}M` :
            `$${tokenInfo.marketCap.toLocaleString()}`;
        
        const volumeFormatted = tokenInfo.volume24h >= 1000000 ?
            `$${(tokenInfo.volume24h / 1000000).toFixed(2)}M` :
            `$${tokenInfo.volume24h.toLocaleString()}`;

        const liquidityFormatted = tokenInfo.liquidity >= 1000000 ?
            `$${(tokenInfo.liquidity / 1000000).toFixed(2)}M` :
            `$${tokenInfo.liquidity.toLocaleString()}`;

        // Color based on 1h price change
        const color = tokenInfo.priceChange1h > 0 ? 0x00ff00 : 0xff0000;

        // Momentum indicators
        const volumeChangeIndicator = tokenInfo.volumeChange24h > 20 ? '🚀' : 
                                    tokenInfo.volumeChange24h > 0 ? '📈' : '📉';
        const walletChangeIndicator = tokenInfo.uniqueWalletChange1h > 5 ? '👥🔥' : 
                                    tokenInfo.uniqueWalletChange1h > 0 ? '👥📈' : '👥📉';
        const buyPressureIndicator = tokenInfo.buyRatio24h > 55 ? '💫' : 
                                    tokenInfo.buyRatio24h > 45 ? '⚖️' : '🔻';

        return {
            title: `${tokenInfo.name} (${tokenInfo.symbol}) ${buyPressureIndicator}`,
            description: [
                `**Contract:** ${addressLink}`,
                '',
                `💰 **Price:** $${priceFormatted}`,
                `📊 **Price Changes:**`,
                `• 1H: ${tokenInfo.priceChange1h.toFixed(2)}%`,
                `• 4H: ${tokenInfo.priceChange4h.toFixed(2)}%`,
                `• 24H: ${tokenInfo.priceChange.toFixed(2)}%`,
                '',
                `💎 **Market Metrics:**`,
                `• MCap: ${mcapFormatted}`,
                `• Liquidity: ${liquidityFormatted}`,
                `• 24h Volume: ${volumeFormatted} ${volumeChangeIndicator}`,
                '',
                `👥 **Holder Activity:**`,
                `• Total Holders: ${tokenInfo.holders.toLocaleString()}`,
                `• Active (1H): ${tokenInfo.uniqueWallets1h.toLocaleString()} ${walletChangeIndicator}`,
                `• Buy Pressure: ${tokenInfo.buyRatio24h.toFixed(1)}%`,
                '',
                tokenInfo.social.twitter ? `🐦 [Twitter](${tokenInfo.social.twitter})` : '',
                tokenInfo.social.discord ? `💬 [Discord](${tokenInfo.social.discord})` : '',
                tokenInfo.social.website ? `🌐 [Website](${tokenInfo.social.website})` : ''
            ].filter(Boolean).join('\n'),
            color: color,
            thumbnail: tokenInfo.logoURI ? { url: tokenInfo.logoURI } : null,
            footer: {
                text: "built by keklabs",
                icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
            },
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = BirdeyeService; 