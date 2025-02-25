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
            endpoints: {
                'users/by/username': {
                    requestsPerWindow: 900,
                    windowSizeMinutes: 15
                },
                'users/:id/tweets': {
                    requestsPerWindow: 1500,
                    windowSizeMinutes: 15
                },
                'tweets/search/recent': {
                    requestsPerWindow: 450,
                    windowSizeMinutes: 15,
                    maxBatchSize: 100,
                    maxAccountsPerBatch: 25
                },
                'users': {
                    requestsPerWindow: 900,
                    windowSizeMinutes: 15
                }
            },
            defaultLimit: {
                requestsPerWindow: 180,
                windowSizeMinutes: 15
            },
            safetyMargin: 0.9,
            batchConfig: {
                minIntervalMs: 5000,
                maxRetries: 3,
                retryDelayMs: 10000
            }
        }
    },
    discord: {
        token: process.env.DISCORD_BOT_TOKEN || '',
        clientId: process.env.DISCORD_CLIENT_ID || '',
        guildId: process.env.DISCORD_GUILD_ID || '',
        channels: {
            tweets: process.env.NODE_ENV === 'test' ? '1343425316210737265' : process.env.TWEETS_CHANNEL_ID || '',
            solana: process.env.NODE_ENV === 'test' ? '1343425316210737265' : process.env.SOLANA_CHANNEL_ID || '',
            vip: process.env.NODE_ENV === 'test' ? '1343425355125358592' : process.env.VIP_CHANNEL_ID || ''
        }
    },
    birdeye: {
        apiKey: process.env.BIRDEYE_API_KEY || '',
        rateLimit: {
            requestsPerWindow: 60,
            windowSizeMinutes: 1,
            safetyMargin: 0.9
        }
    },
    database: {
        path: process.env.NODE_ENV === 'production' 
            ? path.join(process.cwd(), 'twitter-monitor.db')
            : path.join(process.cwd(), 'data', 'twitter-monitor.db'),
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
        discord: ['token', 'clientId', 'guildId', 'channels.tweets', 'channels.solana'],
        birdeye: ['apiKey']
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