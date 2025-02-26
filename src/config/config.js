require('dotenv').config({
    path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env'
});
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
            tweets: process.env.TWEETS_CHANNEL_ID || '',
            solana: process.env.SOLANA_CHANNEL_ID || '',
            vip: process.env.VIP_CHANNEL_ID || '',
            wallets: process.env.WALLETS_CHANNEL_ID || ''
        }
    },
    helius: {
        apiKey: process.env.HELIUS_API_KEY || '',
        webhookUrl: process.env.HELIUS_WEBHOOK_URL || '',
        minSwapValue: 100, // Minimum USD value for Discord notifications
        minSmsSwapValue: 1000, // Minimum USD value for SMS notifications
    },
    twilio: {
        accountSid: process.env.TWILIO_ACCOUNT_SID || '',
        authToken: process.env.TWILIO_AUTH_TOKEN || '',
        phoneNumber: process.env.TWILIO_PHONE_NUMBER || ''
    },
    database: {
        path: process.env.NODE_ENV === 'production' 
            ? '/app/data/twitter-monitor.db'
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
        discord: ['token', 'clientId', 'guildId'],
        helius: ['apiKey', 'webhookUrl']
    };

    // Optional Twilio validation only if any Twilio config is present
    if (config.twilio.accountSid || config.twilio.authToken || config.twilio.phoneNumber) {
        required.twilio = ['accountSid', 'authToken', 'phoneNumber'];
    }

    for (const [section, fields] of Object.entries(required)) {
        for (const field of fields) {
            const value = field.includes('.') 
                ? field.split('.').reduce((obj, key) => obj?.[key], config[section])
                : config[section][field];
            
            if (!value) {
                const error = `Missing required configuration: ${section}.${field}`;
                console.error(error);
                throw error;
            }
        }
    }

    console.info('Configuration validation successful');
    return true;
}

// Validate configuration in production
if (process.env.NODE_ENV === 'production') {
    validateConfig();
}

module.exports = config; 