const { default: axios } = require('axios');
const RateLimitManager = require('./RateLimitManager');
const BirdeyeService = require('./BirdeyeService');

class DexScreenerRateLimitManager extends RateLimitManager {
    constructor() {
        super({
            endpoints: {
                'dexscreener/tokens': {
                    requestsPerWindow: 60,
                    windowSizeMinutes: 1,
                    safetyMargin: 0.9
                }
            },
            defaultLimit: {
                requestsPerWindow: 60,
                windowSizeMinutes: 1
            }
        });
    }
}

class DexScreenerService {
    constructor() {
        this.rateLimitManager = new DexScreenerRateLimitManager();
        this.baseUrl = 'https://api.dexscreener.com/latest/dex';
        this.birdeye = new BirdeyeService();
    }

    async getTokenInfo(address) {
        try {
            const [dexScreenerData, birdeyeData] = await Promise.all([
                this.getDexScreenerInfo(address),
                this.birdeye.getTokenInfo(address)
            ]);

            if (!dexScreenerData) return null;

            return {
                ...dexScreenerData,
                birdeye: birdeyeData
            };
        } catch (error) {
            console.error('[ERROR] Error fetching combined token info:', error.message);
            return null;
        }
    }

    async getDexScreenerInfo(address) {
        try {
            const result = await this.rateLimitManager.scheduleRequest(
                async () => {
                    const response = await axios.get(`${this.baseUrl}/tokens/${address}`);
                    return response.data;
                },
                'dexscreener/tokens'
            );

            if (!result.pairs || result.pairs.length === 0) {
                console.log(`[DEBUG] No pairs found for address ${address}`);
                return null;
            }

            // Get the most relevant pair (usually the one with highest volume)
            const bestPair = result.pairs.sort((a, b) => 
                (parseFloat(b.volume?.h24 || 0) - parseFloat(a.volume?.h24 || 0))
            )[0];

            return {
                symbol: bestPair.baseToken?.symbol || 'UNKNOWN',
                name: bestPair.baseToken?.name || bestPair.baseToken?.symbol || 'Unknown Token',
                marketCap: bestPair.marketCap || '0',
                volume: {
                    m5: bestPair.volume?.m5 || '0',
                    h1: bestPair.volume?.h1 || '0',
                    h24: bestPair.volume?.h24 || '0'
                },
                priceUsd: bestPair.priceUsd || '0',
                liquidity: bestPair.liquidity || '0',
                txns: bestPair.txns || { h24: { buys: 0, sells: 0 } },
                pairCreatedAt: bestPair.pairCreatedAt,
                address: address,
                pairAddress: bestPair.pairAddress,
                chainId: bestPair.chainId,
                url: `https://dexscreener.com/${bestPair.chainId}/${bestPair.pairAddress}`,
                logoUrl: bestPair.baseToken?.logoUrl || null
            };
        } catch (error) {
            console.error('[ERROR] Error fetching DexScreener info:', error.message);
            if (error.response) {
                console.error('[ERROR] DexScreener API response:', error.response.data);
            }
            return null;
        }
    }

    async createTokenEmbed(tokenInfo, color = 0xFF0000) {
        // Format the contract address to be clickable and shortened
        const shortAddress = `${tokenInfo.address.slice(0, 6)}...${tokenInfo.address.slice(-4)}`;
        const contractLink = `[${shortAddress}](https://solscan.io/token/${tokenInfo.address})`;

        // Format creation date if available
        const timeAgo = tokenInfo.pairCreatedAt ? this.formatTimeAgo(new Date(tokenInfo.pairCreatedAt)) : 'Unknown';

        // Create description with only available data
        const description = [
            `💰 **MC:** $${this.formatNumber(tokenInfo.marketCap)} • 💎 **Price:** $${this.formatNumber(tokenInfo.priceUsd)}`,
            `💧 **Liq:** $${this.formatNumber(tokenInfo.liquidity?.usd || 0)}`,
            '',
            `📊 **Vol:** $${this.formatNumber(tokenInfo.volume?.h24 || 0)}`,
            `🔄 **24h Txns:** 📈 ${this.formatNumber(tokenInfo.txns?.h24?.buys || 0)} • 📉 ${this.formatNumber(tokenInfo.txns?.h24?.sells || 0)}`,
            '',
            `⏰ Created ${timeAgo} • 📜 ${contractLink}`
        ].join('\n');

        return {
            author: {
                name: `${tokenInfo.symbol} (${tokenInfo.name})`,
                icon_url: tokenInfo.logoUrl || "https://dexscreener.com/favicon.ico"
            },
            description: description,
            color: color,
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

        if (diffInDays > 0) return `${diffInDays} day${diffInDays > 1 ? 's' : ''} ago`;
        if (diffInHours > 0) return `${diffInHours} hour${diffInHours > 1 ? 's' : ''} ago`;
        if (diffInMinutes > 0) return `${diffInMinutes} minute${diffInMinutes > 1 ? 's' : ''} ago`;
        return `${diffInSeconds} second${diffInSeconds !== 1 ? 's' : ''} ago`;
    }

    formatNumber(num) {
        if (!num) return 'N/A';
        
        const value = parseFloat(num);
        if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
        if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
        if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
        if (value < 0.00001) return value.toExponential(2);
        return value.toFixed(value < 1 ? 6 : 2);
    }
}

module.exports = DexScreenerService; 