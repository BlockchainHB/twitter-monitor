require('dotenv').config();

module.exports = {
    discord: {
        token: process.env.DISCORD_BOT_TOKEN,
        clientId: process.env.DISCORD_CLIENT_ID,
        guildId: process.env.DISCORD_GUILD_ID,
        channels: {
            tweets: process.env.TWEETS_CHANNEL_ID,
            solana: process.env.SOLANA_CHANNEL_ID,
            vip: process.env.VIP_CHANNEL_ID,
            wallets: process.env.WALLETS_CHANNEL_ID
        }
    },
    twitter: {
        apiKey: process.env.TWITTER_API_KEY,
        apiKeySecret: process.env.TWITTER_API_KEY_SECRET,
        bearerToken: process.env.TWITTER_BEARER_TOKEN,
        accessToken: process.env.TWITTER_ACCESS_TOKEN,
        accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
        endpoints: {
            'users/by/username': {
                requestsPerWindow: 180,
                windowSizeMinutes: 15,
                safetyMargin: 0.9
            },
            'users/tweets': {
                requestsPerWindow: 180,
                windowSizeMinutes: 15,
                safetyMargin: 0.9
            },
            'tweets/search': {
                requestsPerWindow: 180,
                windowSizeMinutes: 15,
                safetyMargin: 0.9
            }
        }
    },
    database: {
        path: process.env.DATABASE_PATH || 'monitor.db'
    },
    monitoring: {
        interval: parseInt(process.env.MONITORING_INTERVAL, 10) || 60000, // 1 minute
        types: ['tweet', 'solana']
    }
};