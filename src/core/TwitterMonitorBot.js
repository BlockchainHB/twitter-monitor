const { TwitterApi } = require('twitter-api-v2');
const { Client, GatewayIntentBits, ApplicationCommandOptionType } = require('discord.js');
const RateLimitManager = require('./RateLimitManager');
const DexScreenerService = require('./DexScreenerService');
const BirdeyeService = require('./BirdeyeService');
const twilio = require('twilio');
const HeliusService = require('./HeliusService');

class TwitterMonitorBot {
    constructor(dependencies) {
        this.validateDependencies(dependencies);
        
        // Store dependencies
        this.rateLimitManager = dependencies.rateLimitManager;
        this.config = dependencies.config || require('../config/config');
        
        // Store service instances
        this.dexscreener = dependencies.services.dexscreener;
        this.birdeyeService = dependencies.services.birdeye;
        this.helius = dependencies.services.helius;
        
        // Initialize state with in-memory storage
        this.state = {
            isMonitoring: false,
            monitoringInterval: null,
            isChecking: false,
            // In-memory data storage
            monitoredAccounts: new Map(),
            processedTweets: new Map(),
            tokenMentions: new Map(),
            trackedTokens: new Map(),
            smsSubscribers: new Map()
        };
        
        // Initialize clients
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        this.twitter = new TwitterApi(this.config.twitter.bearerToken);
        
        if (this.config.twilio.enabled) {
            this.twilio = twilio(
                this.config.twilio.accountSid,
                this.config.twilio.authToken
            );
        }
    }

    validateDependencies(deps) {
        if (!deps.rateLimitManager) throw new Error('RateLimitManager required');
        if (!deps.config) console.warn('No config provided, using default');
        if (!deps.services) throw new Error('Services required');
        if (!deps.services.dexscreener) throw new Error('DexScreenerService required');
        if (!deps.services.birdeye) throw new Error('BirdeyeService required');
        if (!deps.services.helius) throw new Error('HeliusService required');
    }

    async initialize() {
        try {
            console.log('🚀 Initializing TwitterMonitorBot...');
            
            // Set up command handling
            this.setupCommandHandling();

            // Register commands if client is ready
            if (this.client.isReady()) {
                await this.registerCommands();
            } else {
                this.client.once('ready', async () => {
                    await this.registerCommands();
                });
            }

            console.log('✅ Bot initialization complete');
            return true;
        } catch (error) {
            console.error('❌ Error during initialization:', error);
            throw error;
        }
    }

    // Get all monitored accounts
    async getMonitoredAccounts() {
        return Array.from(this.state.monitoredAccounts.values());
    }

    // Add a monitored account
    async addMonitoredAccount(account) {
        this.state.monitoredAccounts.set(account.twitter_id, {
            ...account,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });
    }

    // Remove a monitored account
    async removeMonitoredAccount(twitterId) {
        return this.state.monitoredAccounts.delete(twitterId);
    }

    // Update last tweet ID for an account
    async updateLastTweetId(twitterId, lastTweetId) {
        const account = this.state.monitoredAccounts.get(twitterId);
        if (account) {
            account.last_tweet_id = lastTweetId;
            account.updated_at = new Date().toISOString();
            this.state.monitoredAccounts.set(twitterId, account);
        }
    }

    // Check if tweet is already processed
    async isTweetProcessed(tweetId) {
        return this.state.processedTweets.has(tweetId);
    }

    // Add processed tweet
    async addProcessedTweet(tweet) {
        this.state.processedTweets.set(tweet.id, {
            ...tweet,
            processed_at: new Date().toISOString()
        });
    }

    // Add token mention
    async addTokenMention(tweetId, tokenAddress) {
        const mentions = this.state.tokenMentions.get(tweetId) || [];
        if (!mentions.includes(tokenAddress)) {
            mentions.push(tokenAddress);
            this.state.tokenMentions.set(tweetId, mentions);
        }
    }

    // Add tracked token
    async addTrackedToken(address, tweetId) {
        if (!this.state.trackedTokens.has(address)) {
            this.state.trackedTokens.set(address, {
                address,
                first_seen_tweet_id: tweetId,
                created_at: new Date().toISOString()
            });
        }
    }

    // SMS subscriber management
    async addSMSSubscriber(discordUserId, phoneNumber) {
        this.state.smsSubscribers.set(discordUserId, {
            phone_number: phoneNumber,
            is_active: true,
            created_at: new Date().toISOString(),
            last_notification: new Date().toISOString()
        });
    }

    async removeSMSSubscriber(discordUserId) {
        return this.state.smsSubscribers.delete(discordUserId);
    }

    async getSMSSubscriber(discordUserId) {
        return this.state.smsSubscribers.get(discordUserId);
    }

    async getActiveSMSSubscribers() {
        return Array.from(this.state.smsSubscribers.values())
            .filter(sub => sub.is_active);
    }

    // ... rest of existing code without database operations ...
} // End of class TwitterMonitorBot

module.exports = TwitterMonitorBot;