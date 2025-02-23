require('dotenv').config();
const path = require('path');

// Configuration
const config = {
    twitter: {
        apiKey: process.env.TWITTER_API_KEY || '',
        apiKeySecret: process.env.TWITTER_API_KEY_SECRET || '',
        bearerToken: process.env.TWITTER_BEARER_TOKEN || '',
        accessToken: process.env.TWITTER_ACCESS_TOKEN || '',
        accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET || '',
        rateLimit: {
            requestsPerWindow: 500,
            windowSizeMinutes: 15,
            safetyMargin: 0.9
        }
    },
    discord: {
        token: process.env.DISCORD_BOT_TOKEN || '',
        clientId: process.env.DISCORD_CLIENT_ID || '',
        guildId: process.env.DISCORD_GUILD_ID || '',
        channels: {
            tweets: process.env.TWEETS_CHANNEL_ID || '',
            solana: process.env.SOLANA_CHANNEL_ID || '',
            vip: '1335773126708957186'  // VIP channel ID
        }
    },
    database: {
        path: path.join(process.cwd(), 'data', 'twitter-monitor.db'),
        logging: process.env.NODE_ENV === 'development'
    },
    monitoring: {
        interval: process.env.NODE_ENV === 'development' ? 15000 : parseInt(process.env.MONITORING_INTERVAL, 10) || 60000,
        excludeRetweets: true
    }
};

// Validate required configuration
function validateConfig() {
    console.info('Validating configuration...');
    
    const required = {
        twitter: ['apiKey', 'apiKeySecret', 'bearerToken', 'accessToken', 'accessTokenSecret'],
        discord: ['token', 'clientId', 'guildId', 'channels.tweets', 'channels.solana']
    };

    for (const [section, fields] of Object.entries(required)) {
        for (const field of fields) {
            const value = field.includes('.') 
                ? field.split('.').reduce((obj, key) => obj?.[key], config[section])
                : config[section][field];
            
            if (!value) {
                const error = `Missing required configuration: ${section}.${field}`;
                console.error(error);
                throw new Error(error);
            }
        }
    }

    console.info('Configuration validation successful');
    return true;
}

// Validate configuration in non-test environments
if (process.env.NODE_ENV !== 'test') {
    validateConfig();
}

module.exports = config; 