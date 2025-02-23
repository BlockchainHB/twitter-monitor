const { default: axios } = require('axios');
const RateLimitManager = require('./RateLimitManager');

class DexScreenerService {
    constructor() {
        this.rateLimitManager = new RateLimitManager({
            requestsPerWindow: 60,  // DexScreener's rate limit
            windowSizeMinutes: 1,
            safetyMargin: 0.9
        });
        this.baseUrl = 'https://api.dexscreener.com/latest/dex';
    }

    async getTokenInfo(address) {
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

            // Ensure all required fields are present with fallbacks
            return {
                symbol: bestPair.baseToken?.symbol || 'UNKNOWN',
                name: bestPair.baseToken?.name || bestPair.baseToken?.symbol || 'Unknown Token',
                marketCap: bestPair.marketCap || '0',
                volume24h: bestPair.volume?.h24 || '0',
                priceUsd: bestPair.priceUsd || '0',
                liquidity: bestPair.liquidity?.usd || '0',
                pairAddress: bestPair.pairAddress,
                dexId: bestPair.dexId,
                url: `https://dexscreener.com/${bestPair.chainId}/${bestPair.pairAddress}`,
                logoUrl: bestPair.baseToken?.logoUrl || null
            };
        } catch (error) {
            console.error('[ERROR] Error fetching token info:', error.message);
            if (error.response) {
                console.error('[ERROR] DexScreener API response:', error.response.data);
            }
            return null;
        }
    }
}

module.exports = DexScreenerService; 