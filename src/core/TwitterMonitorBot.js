const { TwitterApi } = require('twitter-api-v2');
const sqlite3 = require('@vscode/sqlite3');
const { promisify } = require('util');
const config = require('../config/config');
const path = require('path');
const fs = require('fs').promises;
const { Client, GatewayIntentBits } = require('discord.js');
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
        this.birdeyeService = dependencies.services.birdeyeService;
        this.helius = dependencies.services.helius;
        
        // Initialize state
        this.state = this.initializeState();
        
        // Store provided database if any
        if (dependencies.db) {
            this.state.db = dependencies.db;
        }
        
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
        if (!deps.services.birdeyeService) throw new Error('BirdeyeService required');
        if (!deps.services.helius) throw new Error('HeliusService required');
    }

    initializeState() {
        return {
            isMonitoring: false,
            monitoringInterval: null,
            lastCheckTimes: new Map(),
            db: null,
            guild: null,
            channels: null
        };
    }

    async initialize() {
        try {
            console.log('🔄 Setting up bot...');
            
            // Only initialize database if not provided in constructor
            if (!this.state.db) {
                console.log('📊 Initializing in-memory database...');
                
                // Always use in-memory database for testing
                this.state.db = await new Promise((resolve, reject) => {
                    const db = new sqlite3.Database(':memory:', (err) => {
                        if (err) reject(err);
                        else resolve(db);
                    });
                });
                console.log('✅ Database connection established');
            } else {
                console.log('Using provided database connection');
            }

            // Set pragmas for better performance
            await this.dbRun('PRAGMA journal_mode = WAL');
            await this.dbRun('PRAGMA synchronous = NORMAL');
            await this.dbRun('PRAGMA foreign_keys = ON');
            
            // Initialize minimal schema
            const schema = `
                -- Set pragmas
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;
                PRAGMA foreign_keys = ON;

                -- Create tables
                CREATE TABLE IF NOT EXISTS monitored_accounts (
                    twitter_id TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    last_tweet_id TEXT,
                    monitor_type TEXT NOT NULL,
                    is_vip INTEGER DEFAULT 0,
                    profile_data TEXT,
                    created_at INTEGER DEFAULT (strftime('%s', 'now'))
                );

                CREATE TABLE IF NOT EXISTS monitored_wallets (
                    wallet_address TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    discord_user_id TEXT NOT NULL,
                    created_at INTEGER DEFAULT (strftime('%s', 'now'))
                );

                CREATE TABLE IF NOT EXISTS sms_subscribers (
                    discord_user_id TEXT PRIMARY KEY,
                    phone_number TEXT NOT NULL,
                    created_at INTEGER DEFAULT (strftime('%s', 'now')),
                    notification_count INTEGER DEFAULT 0,
                    is_active INTEGER DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS helius_webhooks (
                    webhook_id TEXT PRIMARY KEY,
                    webhook_url TEXT NOT NULL,
                    active INTEGER DEFAULT 1,
                    created_at INTEGER DEFAULT (strftime('%s', 'now')),
                    last_check INTEGER DEFAULT NULL
                );

                -- Create minimal indexes
                CREATE INDEX IF NOT EXISTS idx_monitored_accounts_username ON monitored_accounts(username);
                CREATE INDEX IF NOT EXISTS idx_monitored_wallets_discord_user ON monitored_wallets(discord_user_id);
                CREATE INDEX IF NOT EXISTS idx_helius_webhooks_active ON helius_webhooks(active);
            `;
            
            // Execute schema
            try {
                const statements = schema
                    .split(';')
                    .map(stmt => stmt.trim())
                    .filter(stmt => stmt && !stmt.startsWith('--'));
                
                for (const statement of statements) {
                    if (statement) {
                        await this.dbRun(statement);
                    }
                }
                console.log('✅ Schema initialized successfully');
            } catch (error) {
                console.error('❌ Error executing schema:', error);
                throw error;
            }
            
            // Set up Discord client
            await this.client.login(this.config.discord.token);
            
            // Get guild and cache channels
            this.state.guild = this.client.guilds.cache.get(this.config.discord.guildId);
            if (!this.state.guild) {
                throw new Error('Could not find configured guild');
            }
            
            // Cache channel IDs
            this.state.channels = {
                tweets: this.config.discord.channels.tweets,
                solana: this.config.discord.channels.solana,
                vip: this.config.discord.channels.vip,
                wallets: this.config.discord.channels.wallets
            };
            
            // Set up command handling
            this.setupCommandHandling();
            
            // Set up webhook handling
            this.setupWebhookHandling();
            
            // Load wallets from config file
            try {
                console.log('🔄 Loading wallets from config file...');
                await this.loadWalletsFromConfig();
                console.log('✅ Wallets loaded from config');
            } catch (error) {
                console.error('⚠️ Error loading wallets from config:', error);
                // Continue setup - we can still work with existing wallets in DB
            }
            
            // Sync wallets with Helius
            try {
                console.log('🔄 Syncing wallets with Helius...');
                await this.helius.syncWallets(this.config.helius.webhookUrl);
                console.log('✅ Helius wallet sync completed');
            } catch (error) {
                // Log error but don't fail setup - we can retry sync later
                console.error('⚠️ Helius wallet sync failed:', error);
                if (error.response) {
                    console.error('Response data:', error.response.data);
                    console.error('Response status:', error.response.status);
                }
            }
            
            console.log('✅ Bot setup completed successfully');
            
        } catch (error) {
            console.error('❌ Bot initialization failed:', error);
            throw error;
        }
    }

    // Helper method to promisify db.run
    async dbRun(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.state.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });
    }

    async setupBot() {
        try {
            console.log('🔄 Setting up bot...');
            
            // Initialize database
            await this.initialize();
            
            // Set up Discord client
            await this.client.login(this.config.discord.token);
            
            // Get guild and cache channels
            this.state.guild = this.client.guilds.cache.get(this.config.discord.guildId);
            if (!this.state.guild) {
                throw new Error('Could not find configured guild');
            }
            
            // Cache channel IDs
            this.state.channels = {
                tweets: this.config.discord.channels.tweets,
                solana: this.config.discord.channels.solana,
                vip: this.config.discord.channels.vip,
                wallets: this.config.discord.channels.wallets
            };
            
            // Set up command handling
            this.setupCommandHandling();
            
            // Load wallets from config file
            try {
                console.log('🔄 Loading wallets from config file...');
                await this.loadWalletsFromConfig();
                console.log('✅ Wallets loaded from config');
                } catch (error) {
                console.error('⚠️ Error loading wallets from config:', error);
                // Continue setup - we can still work with existing wallets in DB
            }
            
            // Sync wallets with Helius
            try {
                console.log('🔄 Syncing wallets with Helius...');
                await this.helius.syncWallets(this.config.helius.webhookUrl);
                console.log('✅ Helius wallet sync completed');
                } catch (error) {
                // Log error but don't fail setup - we can retry sync later
                console.error('⚠️ Helius wallet sync failed:', error);
                if (error.response) {
                    console.error('Response data:', error.response.data);
                    console.error('Response status:', error.response.status);
                }
            }
            
            console.log('✅ Bot setup completed successfully');
            
            } catch (error) {
            console.error('❌ Bot setup failed:', error);
                throw error;
            }
    }

    async dbGet(sql, params = [], maxRetries = 3) {
        let lastError;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await new Promise((resolve, reject) => {
                    this.state.db.get(sql, params, (err, row) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(row);
                        }
                    });
                });
            } catch (error) {
                lastError = error;
                if (error.code === 'SQLITE_BUSY') {
                    console.log(`Database busy, retrying... (attempt ${attempt + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                    continue;
                }
                throw error;
            }
        }
        throw lastError;
    }

    async dbAll(sql, params = [], maxRetries = 3) {
        let lastError;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await new Promise((resolve, reject) => {
                    this.state.db.all(sql, params, (err, rows) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(rows);
                        }
                    });
                });
            } catch (error) {
                lastError = error;
                if (error.code === 'SQLITE_BUSY') {
                    console.log(`Database busy, retrying... (attempt ${attempt + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                    continue;
                }
                throw error;
            }
        }
        throw lastError;
    }

    async dbBatchRun(operations, batchSize = 50) {
        try {
            // Start transaction
            await this.dbRun('BEGIN TRANSACTION');

            // Process operations in batches
            for (let i = 0; i < operations.length; i += batchSize) {
                const batch = operations.slice(i, i + batchSize);
                await Promise.all(batch.map(op => this.dbRun(op.sql, op.params)));
            }

            // Commit transaction
            await this.dbRun('COMMIT');
        } catch (error) {
            await this.dbRun('ROLLBACK');
            throw error;
        }
    }

    async updateLastCheckTimes(accounts) {
        if (!accounts?.length) return;
        
        const now = Math.floor(Date.now() / 1000); // Store as seconds, not milliseconds
        const operations = accounts.map(account => ({
            sql: 'UPDATE monitored_accounts SET last_check_time = ? WHERE twitter_id = ?',
            params: [now, account.twitter_id]
        }));

        await this.dbBatchRun(operations);
    }

    async batchProcessTweets(tweets, accounts, includes) {
        if (!tweets?.length) return;

        try {
            console.log(`[DEBUG] Starting batch processing of ${tweets.length} tweets...`);

            // Sort tweets by ID (chronological order, oldest first)
            const sortedTweets = [...tweets].sort((a, b) => {
                const diff = BigInt(a.id) - BigInt(b.id); // Compare in ascending order
                return diff > 0n ? 1 : diff < 0n ? -1 : 0;
            });

            // First transaction: Insert tweets
            await this.dbRun('BEGIN TRANSACTION');
            try {
                for (const tweet of sortedTweets) {
                    const account = accounts.find(a => a.twitter_id === tweet.author_id);
                    if (!account) continue;

                    console.log(`[DEBUG] Processing tweet ${tweet.id} from @${account.username}`);

                    let tweetType = 'tweet';
                    let referencedTweetId = null;
                    if (tweet.referenced_tweets?.length > 0) {
                        const refTweet = tweet.referenced_tweets[0];
                        switch (refTweet.type) {
                            case 'replied_to':
                                tweetType = 'reply';
                                break;
                            case 'quoted':
                                tweetType = 'quote';
                                break;
                            case 'retweeted':
                                tweetType = 'retweet';
                                break;
                            default:
                                tweetType = 'tweet';
                        }
                        referencedTweetId = refTweet.id;
                    }

                    // Check if tweet already exists before inserting
                    const existingTweet = await this.dbGet(
                        'SELECT 1 FROM processed_tweets WHERE tweet_id = ?',
                        [tweet.id]
                    );

                    if (!existingTweet) {
                        await this.dbRun(
                            `INSERT INTO processed_tweets 
                            (tweet_id, twitter_id, conversation_id, referenced_tweet_id, tweet_type) 
                            VALUES (?, ?, ?, ?, ?)`,
                            [tweet.id, account.twitter_id, tweet.conversation_id, referencedTweetId, tweetType]
                        );

                        // Only process notifications for newly inserted tweets
                        if (account.monitoring_type === 'solana' || account.monitoring_type === 'vip') {
                            const addresses = this.extractSolanaAddresses(tweet.text);
                            if (addresses.length > 0) {
                                for (const address of addresses) {
                                    await this.sendSolanaNotification({
                                        tweet_id: tweet.id,
                                        address,
                                        author_id: tweet.author_id,
                                        tweet_text: tweet.text,
                                        includes
                                    });
                                }
                            }
                        }

                        if (account.monitoring_type === 'tweet' || account.monitoring_type === 'vip') {
                            await this.sendTweetNotification({
                                ...tweet,
                                includes,
                                is_vip: account.monitoring_type === 'vip'
                            });
                        }
                    }
                }
                await this.dbRun('COMMIT');
                console.log('[DEBUG] Tweet processing completed successfully');
                return true;

            } catch (error) {
                await this.dbRun('ROLLBACK');
                throw error;
            }

        } catch (error) {
            console.error('[ERROR] Error in batch tweet processing:', error);
            throw error;
        }
    }

    async updateLastTweetIds(tweetsByAuthor) {
        if (!tweetsByAuthor) return;

        const operations = [];
        const now = Math.floor(Date.now() / 1000); // Store as seconds, not milliseconds

        for (const [authorId, tweets] of Object.entries(tweetsByAuthor)) {
            if (!tweets.length) continue;
            
            // Get newest tweet for this author
            const newestTweet = tweets[tweets.length - 1];
            
            operations.push({
                sql: 'UPDATE monitored_accounts SET last_tweet_id = ?, last_check_time = ? WHERE twitter_id = ?',
                params: [newestTweet.id, now, authorId]
            });
        }

        if (operations.length > 0) {
            await this.dbBatchRun(operations);
        }
    }

    async startMonitoring() {
        console.log('[DEBUG] Starting monitoring interval...');
        
        if (this.state.monitoringInterval) {
            clearInterval(this.state.monitoringInterval);
        }

        this.state.monitoringInterval = setInterval(async () => {
            try {
                console.log('\n[DEBUG] Running monitoring check...');
                const accounts = await this.getMonitoredAccounts();
                if (accounts.length === 0) {
                    console.log('[DEBUG] No accounts to monitor');
                    return;
                }

                console.log(`[DEBUG] Found ${accounts.length} accounts to monitor`);
                
                // Build query for all accounts
                const query = accounts.map(a => `from:${a.username}`).join(' OR ');
                console.log(`[DEBUG] Query: ${query}`);

                // Get last tweet IDs for all accounts
                console.log('[DEBUG] Fetching last tweet IDs for batch search...');
                const accountLastTweets = await Promise.all(accounts.map(account =>
                    this.dbGet('SELECT last_tweet_id FROM monitored_accounts WHERE twitter_id = ?', [account.twitter_id])
                ));

                // Find the most recent last_tweet_id to use as since_id
                const validLastTweets = accountLastTweets.filter(lt => lt?.last_tweet_id);
                const params = {
                    'query': `(${query}) -is:retweet`,
                    'tweet.fields': [
                        'author_id',
                        'created_at',
                        'text',
                        'attachments',
                        'referenced_tweets',
                        'in_reply_to_user_id',
                        'conversation_id'
                    ],
                    'expansions': [
                        'attachments.media_keys',
                        'author_id',
                        'referenced_tweets.id',
                        'referenced_tweets.id.author_id'
                    ],
                    'media.fields': ['url', 'preview_image_url', 'type'],
                    'user.fields': ['profile_image_url', 'name', 'username'],
                    'max_results': 100,
                    'sort_order': 'recency'
                };

                if (validLastTweets.length > 0) {
                    // Sort by tweet ID (which are chronological) to get the most recent one
                    const mostRecentTweetId = validLastTweets
                        .map(t => t.last_tweet_id)
                        .sort()
                        .pop();
                    params.since_id = mostRecentTweetId;
                    console.log(`[DEBUG] Using since_id: ${mostRecentTweetId}`);
                } else {
                    // If this is the first check, request minimum required by API but we'll limit processing
                    params.max_results = 10;
                    console.log('[DEBUG] First check for account(s), requesting 10 tweets but will process only 5 most recent');
                }

                // Update last check time for all accounts
                await Promise.all(accounts.map(account => 
                    this.dbRun(
                        'UPDATE monitored_accounts SET last_check_time = ? WHERE twitter_id = ?',
                        [Date.now(), account.twitter_id]
                    )
                ));

                // Make the API request
                console.log(`[DEBUG] Making Twitter API request with params:`, params);
                const response = await this.twitter.v2.search(params);
                console.log(`[DEBUG] Twitter API response:`, {
                    meta: response.meta,
                    includes: response.includes,
                    errors: response.errors,
                    dataLength: response.data?.length || 0
                });

                // Ensure we properly access the tweets data
                const tweets = response._realData?.data || response.data || [];
                console.log(`[DEBUG] Extracted ${tweets.length} tweets from response`);

                // Group tweets by author
                console.log('[DEBUG] Grouping tweets by author for batch processing...');
                const tweetsByAuthor = tweets?.length ? tweets.reduce((acc, tweet) => {
                    if (!acc[tweet.author_id]) {
                        acc[tweet.author_id] = [];
                    }
                    acc[tweet.author_id].push(tweet);
                    return acc;
                }, {}) : {};

                console.log('[DEBUG] Tweet distribution by author:');
                for (const [authorId, authorTweets] of Object.entries(tweetsByAuthor)) {
                    const account = accounts.find(a => a.twitter_id === authorId);
                    console.log(`[DEBUG] @${account?.username}: ${authorTweets.length} tweets`);
                }

                // Only process tweets if we have any
                if (tweets?.length) {
                    console.log('[DEBUG] Starting batch tweet processing...');
                    await this.batchProcessTweets(tweets, accounts, response.includes);
                    console.log('[DEBUG] Batch tweet processing completed');

                    // Update last tweet IDs in batch
                    console.log('[DEBUG] Updating last tweet IDs in batch...');
                    await this.updateLastTweetIds(tweetsByAuthor);
                    console.log('[DEBUG] Last tweet IDs updated successfully');
                } else {
                    console.log('[DEBUG] No new tweets to process');
                }

            } catch (error) {
                if (error.code === 'RATE_LIMIT') {
                    console.log('[DEBUG] Rate limit hit, will retry next interval');
                    return;
                }
                console.error('[ERROR] Error processing tweets:', error);
            }
        }, config.monitoring.interval);

        console.log(`[DEBUG] Monitoring interval set to ${config.monitoring.interval}ms`);
        return true;
    }

    async getMonitoredAccounts() {
        return await this.dbAll(
            `SELECT 
                twitter_id, 
                username, 
                monitor_type, 
                last_tweet_id,
                profile_data,
                is_vip,
                last_check_time
            FROM monitored_accounts
            ORDER BY last_check_time ASC NULLS FIRST`
        );
    }

    async checkAccount(account) {
        try {
            // Get last tweet ID
            const lastTweet = await this.dbGet(
                'SELECT last_tweet_id FROM monitored_accounts WHERE username = ?',
                [account.username]
            );
            console.log(`[DEBUG] Last tweet ID for ${account.username}: ${lastTweet?.last_tweet_id || 'none'}`);

            // Use optimized endpoint
            console.log(`[DEBUG] Fetching tweets for ${account.username}...`);
            const tweets = await this.rateLimitManager.scheduleRequest(
                async () => {
                    const params = {
                        'tweet.fields': [
                            'author_id',
                            'created_at',
                            'text',
                            'attachments',
                            'referenced_tweets',
                            'in_reply_to_user_id',
                            'conversation_id'
                        ],
                        'expansions': [
                            'attachments.media_keys',
                            'author_id',
                            'referenced_tweets.id',
                            'in_reply_to_user_id'
                        ],
                        'media.fields': ['url', 'preview_image_url', 'type'],
                        'user.fields': ['profile_image_url', 'name', 'username'],
                        'max_results': 100
                    };
                    
                    if (lastTweet?.last_tweet_id) {
                        params.since_id = lastTweet.last_tweet_id;
                    }

                    return await this.twitter.v2.userTimeline(account.twitter_id, params, {
                        'endpoint': 'users/:id/tweets'  // Use correct endpoint
                    });
                },
                'users/:id/tweets'  // Use correct endpoint identifier
            );

            if (!tweets?.data?.length) {
                console.log(`[DEBUG] No new tweets found for ${account.username}`);
                return;
            }

            console.log(`[DEBUG] Found ${tweets.data.length} new tweets for ${account.username}`);

            // Process tweets in order (newest to oldest)
            for (const tweet of tweets.data.reverse()) {
                console.log(`[DEBUG] Processing tweet ${tweet.id} from ${account.username}...`);
                if (account.monitor_type === 'tweet') {
                    await this.sendTweetNotification(tweet);
                    console.log(`[DEBUG] Sent tweet notification for ${tweet.id}`);
                } else if (account.monitor_type === 'solana') {
                    const addresses = this.extractSolanaAddresses(tweet.text);
                    if (addresses.length > 0) {
                        console.log(`[DEBUG] Found ${addresses.length} Solana addresses in tweet ${tweet.id}`);
                        for (const address of addresses) {
                            await this.sendSolanaNotification({
                                tweet_id: tweet.id,
                                address,
                                author_id: tweet.author_id,
                                tweet_text: tweet.text
                            });
                            console.log(`[DEBUG] Sent Solana notification for address ${address}`);
                        }
                    }
                }
            }

            // Update last tweet ID with the newest tweet
            const newestTweetId = tweets.data[0]?.id;
            if (newestTweetId) {
                console.log(`[DEBUG] Updating last tweet ID for ${account.username} to ${newestTweetId}`);
                await this.dbRun(
                    'UPDATE monitored_accounts SET last_tweet_id = ? WHERE username = ?',
                    [newestTweetId, account.username]
                );
            }

        } catch (error) {
            if (error.code === 429) {
                console.log(`[DEBUG] Rate limit hit for ${account.username}, will retry next interval`);
                return;
            }
            console.error(`[ERROR] Error checking account ${account.username}:`, error);
        }
    }

    extractSolanaAddresses(text) {
        // Just extract anything that looks like it could be an address
        const regex = /\S{30,50}/g;
        return text.match(regex) || [];
    }

    async processTweet(tweet, account, includes) {
        try {
            await this.dbRun('BEGIN TRANSACTION');

            try {
                // Determine tweet type
                let tweetType = 'tweet';
                let referencedTweetId = null;
                if (tweet.referenced_tweets?.length > 0) {
                    const refTweet = tweet.referenced_tweets[0];
                    switch (refTweet.type) {
                        case 'replied_to':
                            tweetType = 'reply';
                            break;
                        case 'quoted':
                            tweetType = 'quote';
                            break;
                        case 'retweeted':
                            tweetType = 'retweet';
                            break;
                        default:
                            tweetType = 'tweet';
                    }
                    referencedTweetId = refTweet.id;
                }

                // Check if tweet already exists
                const existingTweet = await this.dbGet(
                    'SELECT 1 FROM processed_tweets WHERE tweet_id = ?',
                    [tweet.id]
                );

                if (!existingTweet) {
                    // Insert into processed_tweets
                    await this.dbRun(
                        `INSERT INTO processed_tweets 
                        (tweet_id, twitter_id, tweet_data, conversation_id, referenced_tweet_id, tweet_type) 
                        VALUES (?, ?, ?, ?, ?, ?)`,
                        [tweet.id, account.twitter_id, JSON.stringify(tweet), tweet.conversation_id, referencedTweetId, tweetType]
                    );

                    // Process Solana addresses if found
                    if (account.monitoring_type === 'solana' || account.monitoring_type === 'vip') {
                        const addresses = this.extractSolanaAddresses(tweet.text);
                        if (addresses.length > 0) {
                            for (const address of addresses) {
                                // Check if this token mention already exists
                                const existingMention = await this.dbGet(
                                    'SELECT 1 FROM token_mentions WHERE tweet_id = ? AND token_address = ?',
                                    [tweet.id, address]
                                );

                                if (!existingMention) {
                                    // Get token info from Birdeye
                                    const tokenInfo = await this.birdeyeService.getTokenInfo(address);
                                    if (tokenInfo) {
                                        // Insert or update token info
                                        await this.dbRun(
                                            `INSERT OR IGNORE INTO tracked_tokens 
                                            (address, first_seen_tweet_id) 
                                            VALUES (?, ?)`,
                                            [address, tweet.id]
                                        );

                                        // Record token mention
                                        await this.dbRun(
                                            `INSERT OR IGNORE INTO token_mentions 
                                            (tweet_id, token_address) 
                                            VALUES (?, ?)`,
                                            [tweet.id, address]
                                        );

                                        // Send notification only for new mentions
                                        await this.sendSolanaNotification({
                                            tweet_id: tweet.id,
                                            address,
                                            author_id: tweet.author_id,
                                            tweet_text: tweet.text,
                                            includes,
                                            tokenInfo
                                        });
                                    }
                                }
                            }
                        }
                    }

                    // Send tweet notification based on type
                    if (account.monitoring_type === 'tweet' || account.monitoring_type === 'vip') {
                        await this.sendTweetNotification({
                            ...tweet,
                            includes,
                            is_vip: account.monitoring_type === 'vip'
                        });
                    }
                }

                await this.dbRun('COMMIT');
            } catch (error) {
                await this.dbRun('ROLLBACK');
                throw error;
            }
        } catch (error) {
            console.error(`[ERROR] Error processing tweet ${tweet.id}:`, error);
        }
    }

    async sendTweetNotification(tweet) {
        try {
            // Get author info from database
            const author = await this.dbGet(
                'SELECT username, profile_data, is_vip FROM monitored_accounts WHERE twitter_id = ?',
                [tweet.author_id]
            );

            // Determine which channel to use
            const channelId = author?.is_vip ? this.state.channels.vip : this.state.channels.tweets;
            const channel = this.state.guild.channels.cache.get(channelId);
            if (!channel) {
                console.error('Channel not found in guild');
                return;
            }

            const profileData = author?.profile_data ? JSON.parse(author.profile_data) : {};

            // Get media URL if tweet has an image
            let imageUrl = null;
            if (tweet.attachments && tweet.includes?.media) {
                const media = tweet.includes.media.find(m => m.type === 'photo');
                if (media) {
                    imageUrl = media.url || media.preview_image_url;
                }
            }

            // Create tweet URL
            const tweetUrl = `https://twitter.com/${author?.username}/status/${tweet.id}`;

            // Check if this is a reply and get parent tweet info
            let embedTitle = `New Tweet from @${author?.username}`;
            let description = tweet.text;

            if (tweet.referenced_tweets?.some(ref => ref.type === 'replied_to')) {
                const parentTweetRef = tweet.referenced_tweets.find(ref => ref.type === 'replied_to');
                const parentTweet = tweet.includes?.tweets?.find(t => t.id === parentTweetRef.id);
                const parentAuthor = tweet.includes?.users?.find(u => u.id === parentTweet?.author_id);

                if (parentTweet && parentAuthor) {
                    embedTitle = `@${author?.username} replied to @${parentAuthor.username}`;
                    description = `${tweet.text}\n\n───────────────\n\n`;
                    description += `**[@${parentAuthor.username}](https://twitter.com/${parentAuthor.username})**`;
                    if (parentAuthor.name !== parentAuthor.username) {
                        description += ` • ${parentAuthor.name}`;
                    }
                    description += `\n${parentTweet.text}`;
                }
            }

            description += `\n\n[View Tweet](${tweetUrl})`;

            // Create the main tweet embed
            const tweetEmbed = {
                color: 0x800080, // Purple color for tweet embeds
                title: embedTitle,
                fields: [],
                footer: {
                    text: "built by keklabs",
                    icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                },
                description: description,
                author: {
                    icon_url: profileData.profile_image_url || null,
                    name: `${profileData.name || author?.username || 'Unknown'} (@${author?.username || 'unknown'})`,
                    url: `https://twitter.com/${author?.username}`
                },
                timestamp: new Date(tweet.created_at).toISOString(),
                image: imageUrl ? { url: imageUrl } : null
            };

            // Check for Solana addresses in the tweet
            const addresses = this.extractSolanaAddresses(tweet.text);
            if (addresses.length > 0) {
                console.log(`[DEBUG] Found ${addresses.length} valid Solana addresses in tweet ${tweet.id}`);
                // Process the first valid token we find
                const tokenEmbed = await this.processTokenInfo(addresses[0]);
                if (tokenEmbed) {
                    await channel.send({ 
                        content: '@everyone New token detected! 🚨',
                        embeds: [tweetEmbed, tokenEmbed],
                        allowedMentions: { parse: ['everyone'] }
                    });
                    return;
                }
            }

            await channel.send({ embeds: [tweetEmbed] });
        } catch (error) {
            console.error('Error sending tweet notification:', error);
        }
    }

    // Add formatNumber function
    formatNumber(num) {
        if (!num && num !== 0) return 'N/A';
        
        const value = parseFloat(num);
        if (isNaN(value)) return 'N/A';
        
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

    async sendSolanaNotification(data) {
        try {
            const channel = this.state.guild.channels.cache.get(this.state.channels.solana);
            if (!channel) {
                console.error('Solana channel not found in guild');
                return;
            }

            // Get token information from both services
            const tokenInfo = data.tokenInfo || await this.birdeyeService.getTokenInfo(data.address);
            if (!tokenInfo) return;

            // Get author info and tweet data for context
            const author = await this.dbGet(
                'SELECT username, profile_data FROM monitored_accounts WHERE twitter_id = ?',
                [data.author_id]
            );

            const profileData = author?.profile_data ? JSON.parse(author.profile_data) : {};
            const tweetUrl = `https://twitter.com/${author?.username}/status/${data.tweet_id}`;

            // Create the main tweet embed
            const tweetEmbed = {
                color: 0x800080, // Purple color for tweet embeds
                fields: [],
                footer: {
                    text: "built by keklabs",
                    icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                },
                description: `${data.tweet_text}\n\n[View Tweet](${tweetUrl})`,
                author: {
                    icon_url: profileData.profile_image_url || null,
                    name: `${profileData.name || author?.username || 'Unknown'} (@${author?.username || 'unknown'})`,
                    url: `https://twitter.com/${author?.username}`
                },
                timestamp: new Date().toISOString()
            };

            try {
                // Create token embed
                const tokenEmbed = await this.birdeyeService.createTokenEmbed(tokenInfo.address, tokenInfo);

                // Send Discord notification
                await channel.send({ 
                    content: '@everyone New token detected! 🚨',
                    embeds: [tweetEmbed, tokenEmbed],
                    allowedMentions: { parse: ['everyone'] }
                });

                // Send SMS notifications for new tokens
                const subscribers = await this.dbAll('SELECT phone_number FROM sms_subscribers WHERE is_active = 1');
                if (subscribers.length > 0) {
                    // Create a cleaner SMS message with only reliable stats
                    const smsMessage = `🚨 @${author?.username} TWEETED A NEW TOKEN!\n\n` +
                        `${tokenInfo.symbol}\n` +
                        `Price: $${this.formatNumber(tokenInfo.priceUsd)}\n` +
                        (tokenInfo.marketCap ? `MC: $${this.formatNumber(tokenInfo.marketCap)}\n` : '') +
                        (tokenInfo.liquidity ? `LP: $${this.formatNumber(tokenInfo.liquidity)}\n` : '') +
                        (tokenInfo.holders ? `Holders: ${this.formatNumber(tokenInfo.holders)}\n` : '') +
                        `\n${tweetUrl}`;
                    
                    for (const subscriber of subscribers) {
                        await this.sendSMSAlert(smsMessage, subscriber.phone_number);
                    }
                }
            } catch (embedError) {
                console.error('[ERROR] Error creating or sending token embed:', embedError);
                // Still send the tweet embed if token embed fails
                await channel.send({ embeds: [tweetEmbed] });
            }
        } catch (error) {
            console.error('Error sending Solana notification:', error);
        }
    }

    setupCommandHandling() {
        console.log('🔄 Setting up command handling...');
        
        this.client.on('interactionCreate', async interaction => {
            // Only handle slash commands from our guild
            if (!interaction.isCommand() || interaction.guildId !== config.discord.guildId) return;

            // Simple command handling
            try {
                const command = interaction.commandName;
                console.log(`[DEBUG] Received command: ${command} from ${interaction.user.tag}`);

                // Add debug logging for command handling
                console.log(`[DEBUG] Processing command with options:`, interaction.options?._hoistedOptions);

                switch (command) {
                    case 'monitor':
                        if (!interaction.replied) {
                            await this.handleMonitorCommand(interaction).catch(err => {
                                console.error('[ERROR] Monitor command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'stopm':
                        if (!interaction.replied) {
                            await this.handleStopMonitorCommand(interaction).catch(err => {
                                console.error('[ERROR] Stop monitor command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'list':
                        if (!interaction.replied) {
                            await this.handleListCommand(interaction).catch(err => {
                                console.error('[ERROR] List command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'test':
                        if (!interaction.replied) {
                            await this.testNotifications(interaction).catch(err => {
                                console.error('[ERROR] Test command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'help':
                        if (!interaction.replied) {
                            await this.handleHelpCommand(interaction).catch(err => {
                                console.error('[ERROR] Help command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'vipmonitor':
                        if (!interaction.replied) {
                            await this.handleVipMonitorCommand(interaction).catch(err => {
                                console.error('[ERROR] VIP monitor command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'trackwallet':
                        if (!interaction.replied) {
                            await this.handleTrackWalletCommand(interaction).catch(err => {
                                console.error('[ERROR] Track wallet command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'stopwallet':
                        if (!interaction.replied) {
                            await this.handleStopWalletCommand(interaction).catch(err => {
                                console.error('[ERROR] Stop wallet command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'trending':
                        if (!interaction.replied) {
                            await this.handleTrendingCommand(interaction).catch(err => {
                                console.error('[ERROR] Trending command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'gainers':
                        if (!interaction.replied) {
                            await this.handleGainersCommand(interaction).catch(err => {
                                console.error('[ERROR] Gainers command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'losers':
                        if (!interaction.replied) {
                            await this.handleLosersCommand(interaction).catch(err => {
                                console.error('[ERROR] Losers command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'newpairs':
                        if (!interaction.replied) {
                            await this.handleNewPairsCommand(interaction).catch(err => {
                                console.error('[ERROR] New pairs command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'volume':
                        if (!interaction.replied) {
                            await this.handleVolumeCommand(interaction).catch(err => {
                                console.error('[ERROR] Volume command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'security':
                        if (!interaction.replied) {
                            await this.handleSecurityCommand(interaction).catch(err => {
                                console.error('[ERROR] Security command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'metrics':
                        if (!interaction.replied) {
                            await this.handleMetricsCommand(interaction).catch(err => {
                                console.error('[ERROR] Metrics command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'holders':
                        if (!interaction.replied) {
                            await this.handleHoldersCommand(interaction).catch(err => {
                                console.error('[ERROR] Holders command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'smsalert':
                        if (!interaction.replied) {
                            await this.handleSMSAlertCommand(interaction).catch(err => {
                                console.error('[ERROR] SMS alert command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'stopsms':
                        if (!interaction.replied) {
                            await this.handleStopSMSCommand(interaction).catch(err => {
                                console.error('[ERROR] Stop SMS command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    default:
                        if (!interaction.replied) {
                            console.log(`[DEBUG] Unknown command received: ${command}`);
                            await interaction.reply({ 
                                content: 'Unknown command. Use `/help` to see available commands.',
                                ephemeral: true 
                            });
                        }
                }
            } catch (error) {
                console.error('[ERROR] Command handling error:', error);
                // If we haven't replied yet, send an error message
                if (!interaction.replied && !interaction.deferred) {
                    try {
                    await interaction.reply({
                        embeds: [{
                            title: "Error",
                                description: `❌ Command failed to execute: ${error.message}`,
                            color: 0xFF0000
                            }],
                            ephemeral: true
                    });
                    } catch (replyError) {
                        console.error('[ERROR] Failed to send error reply:', replyError);
                    }
                }
            }
        });
    }

    async handleMonitorCommand(interaction) {
        try {
            // Defer the reply immediately to prevent timeout
            await interaction.deferReply();
            
            console.log('[DEBUG] Starting monitor command execution');
            const username = interaction.options.getString('twitter_id').toLowerCase().replace('@', '');
            const type = interaction.options.getString('type');
            const isVip = interaction.isVip || false;
            console.log(`[DEBUG] Parameters - Twitter ID: ${username}, Type: ${type}, VIP: ${isVip}`);

            // Get Twitter user info using bot.twitter (not twitterClient)
            let userInfo;
            try {
                userInfo = await this.twitter.v2.userByUsername(username, {
                    'user.fields': ['id', 'username', 'name', 'profile_image_url']
                });
            } catch (error) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ Error',
                        description: `Could not find Twitter account @${username}`,
                        color: 0xFF0000,
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            }

            if (!userInfo?.data) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ Error',
                        description: `Could not find Twitter account @${username}`,
                        color: 0xFF0000,
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            }

            try {
                // Check if already monitoring by username and type
                const existingAccount = await this.dbGet(
                    'SELECT * FROM monitored_accounts WHERE twitter_id = ? AND monitor_type = ?',
                    [userInfo.data.id, type]
                );

                if (existingAccount) {
                    return await interaction.editReply({
                        embeds: [{
                            title: 'Already Monitoring',
                            description: `Already monitoring @${username} for ${type === 'solana' ? 'Solana addresses' : 'tweets'}`,
                            color: 0x9945FF,
                            footer: {
                                text: 'built by keklabs',
                                icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                            }
                        }]
                    });
                }

                // Add account to database
                await this.dbRun(
                    'INSERT INTO monitored_accounts (twitter_id, username, monitor_type, is_vip, profile_data) VALUES (?, ?, ?, ?, ?)',
                    [
                        userInfo.data.id,
                        username,
                        type,
                        isVip ? 1 : 0,
                        JSON.stringify(userInfo.data)
                    ]
                );

                // Start monitoring if not already running
                if (!this.state.monitoringInterval) {
                    await this.startMonitoring();
                }

                // Send success message
                return await interaction.editReply({
                    embeds: [{
                        title: `✅ ${isVip ? 'VIP ' : ''}${type === 'solana' ? 'Solana Address' : 'Tweet'} Tracker Started For @${username}`,
                        description: `Successfully monitoring @${username}${isVip ? ' as a VIP user' : ''}`,
                        fields: [
                            {
                                name: 'Account Name',
                                value: userInfo.data.name,
                                inline: true
                            },
                            {
                                name: 'Monitoring Type',
                                value: isVip ? '📝 VIP Tweets' : type === 'solana' ? '🔍 Solana Addresses' : '📝 Regular Tweets',
                                inline: true
                            },
                            {
                                name: 'Notifications Channel',
                                value: `<#${isVip ? this.state.channels.vip : type === 'solana' ? this.state.channels.solana : this.state.channels.tweets}>`,
                                inline: true
                            }
                        ],
                        color: 0x00FF00,
                        thumbnail: {
                            url: userInfo.data.profile_image_url
                        },
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            } catch (error) {
                console.error('[ERROR] Monitor command error:', error);
                
                const errorMessage = error.code === 'TWITTER_API_ERROR' 
                    ? "Failed to fetch Twitter account information. Please try again later."
                    : "An error occurred while processing the command";

                await interaction.editReply({
                    embeds: [{
                        title: "Command Error",
                        description: `❌ ${errorMessage}`,
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
            }
        } catch (error) {
            console.error('[ERROR] Monitor command error:', error);
            
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ An error occurred while processing the command",
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        }
    }

    async handleStopMonitorCommand(interaction) {
        try {
            console.log('[DEBUG] Starting stop monitor command execution');
            const username = interaction.options.getString('twitter_id').toLowerCase().replace('@', '');

            // Send immediate confirmation that we're processing
            await interaction.reply({
                embeds: [{
                    title: '⏳ Processing Stop Monitor Request',
                    description: `Attempting to stop monitoring @${username}`,
                    color: 0xFFA500,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });

            // Check if account is being monitored
            const account = await this.dbGet(
                'SELECT * FROM monitored_accounts WHERE username = ?',
                [username]
            );

            if (!account) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ Account Not Found',
                        description: `@${username} is not currently being monitored.`,
                        color: 0xFF0000,
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            }

            // Remove account from monitoring
            await this.dbRun(
                'DELETE FROM monitored_accounts WHERE username = ?',
                [username]
            );

            // Send success message
            return await interaction.editReply({
                embeds: [{
                    title: '✅ Monitoring Stopped',
                    description: `Successfully stopped monitoring @${username}`,
                    fields: [
                        {
                            name: 'Account Type',
                            value: account.is_vip ? '⭐ VIP Account' : account.monitoring_type === 'solana' ? '🔍 Solana Monitor' : '📝 Tweet Monitor',
                            inline: true
                        }
                    ],
                    color: 0x00FF00,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });

        } catch (error) {
            console.error('[ERROR] Stop monitor command error:', error);
            
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: `❌ An error occurred while stopping the monitor`,
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        }
    }

    async handleTrendingCommand(interaction) {
        try {
            await interaction.deferReply();
            
            console.log('[DEBUG] Fetching trending tokens...');
            const tokens = await this.birdeyeService.getTrendingTokens();
            
            if (!tokens || tokens.length === 0) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch trending tokens at this time.',
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
            }

            console.log(`[DEBUG] Found ${tokens.length} trending tokens`);
            const embed = this.birdeyeService.createTrendingEmbed(tokens);
            return await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('[ERROR] Trending command error:', error);
            
            // Handle the reply based on the interaction state
            try {
                const errorEmbed = {
                    title: "Command Error",
                    description: "❌ Failed to fetch trending tokens",
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                };

                if (!interaction.deferred && !interaction.replied) {
                    await interaction.reply({ embeds: [errorEmbed] });
                } else {
                    await interaction.editReply({ embeds: [errorEmbed] });
                }
            } catch (replyError) {
                console.error('[ERROR] Failed to send error message:', replyError);
            }
        }
    }

    async handleGainersCommand(interaction) {
        try {
            await interaction.deferReply();
            const timeframe = interaction.options.getString('timeframe') || '24h';
            
            const tokens = await this.birdeyeService.getTopMovers(timeframe, 'gainers');
            if (!tokens || tokens.length === 0) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch top gainers at this time.',
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createMoversEmbed(tokens, 'gainers');
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Gainers command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch top gainers",
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        }
    }

    async handleLosersCommand(interaction) {
        try {
            await interaction.deferReply();
            const timeframe = interaction.options.getString('timeframe') || '24h';
            
            const tokens = await this.birdeyeService.getTopMovers(timeframe, 'losers');
            if (!tokens || tokens.length === 0) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch top losers at this time.',
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createMoversEmbed(tokens, 'losers');
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Losers command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch top losers",
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        }
    }

    async handleNewPairsCommand(interaction) {
        try {
            await interaction.deferReply();
            const hours = interaction.options.getInteger('hours') || 24;
            
            const pairs = await this.birdeyeService.getNewPairs(hours);
            if (!pairs.length) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch new pairs at this time.',
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createNewPairsEmbed(pairs);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] New pairs command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch new pairs",
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        }
    }

    async handleVolumeCommand(interaction) {
        try {
            await interaction.deferReply();
            const timeframe = interaction.options.getString('timeframe') || '24h';
            
            const tokens = await this.birdeyeService.getVolumeLeaders(timeframe);
            if (!tokens.length) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch volume leaders at this time.',
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createVolumeEmbed(tokens);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Volume command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch volume leaders",
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        }
    }

    async handleHelpCommand(interaction) {
        try {
            const embed = {
                title: '🐈‍⬛ kek-monitor by keklabs',
                description: 'Available commands:',
                color: 0x9945FF,
                fields: [
                    {
                        name: '📱 Twitter Monitoring',
                        value: `
\`/monitor\` - Start monitoring a Twitter account
\`/stopm\` - Stop monitoring a Twitter account
\`/vipmonitor\` - Start monitoring a VIP Twitter account
\`/list\` - List all monitored accounts`,
                        inline: false
                    },
                    {
                        name: '👛 Wallet Tracking',
                        value: `
\`/trackwallet\` - Track a Solana wallet's transactions
\`/stopwallet\` - Stop tracking a wallet
\`/list\` - List all tracked wallets`,
                        inline: false
                    },
                    {
                        name: '📊 Market Data',
                        value: `
\`/trending\` - Show trending tokens
\`/gainers\` - Show top gainers
\`/volume\` - Show top volume tokens`,
                        inline: false
                    },
                    {
                        name: '🔍 Token Analysis',
                        value: `
\`/metrics\` - Show detailed token metrics
\`/holders\` - Show holder information
\`/security\` - Show security analysis`,
                        inline: false
                    },
                    {
                        name: '📲 Notifications',
                        value: `
\`/smsalert\` - Register phone for SMS alerts
\`/stopsms\` - Unsubscribe from SMS alerts
\`/test\` - Test notifications`,
                        inline: false
                    }
                ],
                footer: {
                    text: "built by keklabs",
                    icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                },
                timestamp: new Date().toISOString()
            };

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Help command error:', error);
            await interaction.reply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to display help information",
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        }
    }

    async handleSecurityCommand(interaction) {
        try {
            await interaction.deferReply();
            const address = interaction.options.getString('address');
            
            const securityData = await this.birdeyeService.getTokenSecurity(address);
            if (!securityData) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch security information for this token.',
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createSecurityEmbed(address, securityData);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Security command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch security information",
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        }
    }

    async handleMetricsCommand(interaction) {
        try {
            await interaction.deferReply();
            const address = interaction.options.getString('address');
            
            const metricsData = await this.birdeyeService.getTokenMetrics(address);
            if (!metricsData) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch metrics information for this token.',
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createMetricsEmbed(address, metricsData);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Metrics command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch metrics information",
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        }
    }

    async handleHoldersCommand(interaction) {
        try {
            await interaction.deferReply();
            const address = interaction.options.getString('address');
            
            // Fetch both holders and traders data concurrently
            const [holders, traders] = await Promise.all([
                this.birdeyeService.getTokenHolders(address),
                this.birdeyeService.getTokenTopTraders(address)
            ]);

            if (!holders) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ No Data Available',
                        description: 'Could not fetch holder information for this token.',
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
            }

            const embed = this.birdeyeService.createHoldersEmbed(address, holders, traders);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Holders command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to fetch holder information",
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        }
    }

    async handleSMSAlertCommand(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });
            const phone = interaction.options.getString('phone');
            
            // Validate Twilio configuration
            if (!this.config.twilio.accountSid || !this.config.twilio.authToken || !this.config.twilio.phoneNumber) {
                return await interaction.editReply({
                    content: '❌ SMS notifications are not configured on this bot instance.',
                    ephemeral: true
                });
            }

            // Enhanced phone number validation
            if (!phone.match(/^\+[1-9]\d{1,14}$/)) {
                return await interaction.editReply({
                    content: '❌ Invalid phone number format. Please use international format (e.g., +1234567890)',
                    ephemeral: true
                });
            }

            try {
                // Check if user already has a different phone number registered
                const existingUser = await this.dbGet(
                    'SELECT phone_number FROM sms_subscribers WHERE discord_user_id = ?',
                    [interaction.user.id]
                );

                if (existingUser && existingUser.phone_number !== phone) {
                    // Delete old registration if phone number is different
                    await this.dbRun(
                        'DELETE FROM sms_subscribers WHERE discord_user_id = ?',
                        [interaction.user.id]
                    );
                }

                // Check if phone is registered to another user
                const existingPhone = await this.dbGet(
                    'SELECT discord_user_id FROM sms_subscribers WHERE phone_number = ? AND discord_user_id != ?',
                    [phone, interaction.user.id]
                );

                if (existingPhone) {
                    return await interaction.editReply({
                        content: '❌ This phone number is already registered to another user.',
                        ephemeral: true
                    });
                }

                // Verify phone number with Twilio first
                const lookup = await this.twilioClient.lookups.v2.phoneNumbers(phone).fetch();
                if (!lookup.valid) {
                    return await interaction.editReply({
                        content: '❌ Invalid phone number. Please check the number and try again.',
                        ephemeral: true
                    });
                }

                // Send test message to verify delivery
                const testResult = await this.sendSMSAlert(
                    'Welcome to Twitter Monitor Bot! This is a test message to verify your phone number. Reply STOP to unsubscribe.',
                    phone,
                    interaction.user.id
                );

                if (!testResult) {
                    return await interaction.editReply({
                        content: '❌ Failed to send test message to your phone. Please verify the number and try again.',
                        ephemeral: true
                    });
                }

                // Save to database using discord_user_id as primary key
                await this.dbRun(
                    'INSERT OR REPLACE INTO sms_subscribers (discord_user_id, phone_number, created_at, last_notification) VALUES (?, ?, ?, ?)',
                    [interaction.user.id, phone, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)]
                );

                return await interaction.editReply({
                    content: '✅ Successfully registered for SMS notifications! A test message has been sent to your phone.',
                    ephemeral: true
                });
            } catch (error) {
                console.error('SMS registration error:', error);
                if (error.code === 60200) { // Invalid phone number
                    return await interaction.editReply({
                        content: '❌ Invalid phone number. Please check the number and try again.',
                        ephemeral: true
                    });
                }
                return await interaction.editReply({
                    content: '❌ Failed to register phone number. Please try again later.',
                    ephemeral: true
                });
            }
        } catch (error) {
            console.error('SMS alert command error:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ An error occurred while processing your request.',
                    ephemeral: true
                });
            } else {
                await interaction.editReply({
                    content: '❌ An error occurred while processing your request.',
                    ephemeral: true
                });
            }
        }
    }

    async sendSMSAlert(message, phone, discord_user_id = null) {
        try {
            console.log(`[DEBUG] Sending SMS to ${this.maskPhoneNumber(phone)}`);
            
            // Validate Twilio configuration
            if (!this.config.twilio.accountSid || !this.config.twilio.authToken || !this.config.twilio.phoneNumber) {
                throw new Error('Missing Twilio configuration');
            }

            // Check rate limits (one message per minute per user)
            let subscriber;
            if (discord_user_id) {
                subscriber = await this.dbGet(
                    'SELECT last_notification FROM sms_subscribers WHERE discord_user_id = ?',
                    [discord_user_id]
                );
            } else {
                subscriber = await this.dbGet(
                    'SELECT last_notification FROM sms_subscribers WHERE phone_number = ?',
                    [phone]
                );
            }

            if (subscriber && subscriber.last_notification) {
                const timeSinceLastNotification = Math.floor(Date.now() / 1000) - subscriber.last_notification;
                if (timeSinceLastNotification < 60) { // 1 minute cooldown
                    console.log(`[DEBUG] Rate limit hit for ${this.maskPhoneNumber(phone)}, skipping notification`);
                    return false;
                }
            }

            // Send message
            const result = await this.twilioClient.messages.create({
                body: message,
                from: this.config.twilio.phoneNumber,
                to: phone
            });

            // Update last notification time using discord_user_id if available
            if (discord_user_id) {
                await this.dbRun(
                    'UPDATE sms_subscribers SET last_notification = ? WHERE discord_user_id = ?',
                    [Math.floor(Date.now() / 1000), discord_user_id]
                );
            } else {
                await this.dbRun(
                    'UPDATE sms_subscribers SET last_notification = ? WHERE phone_number = ?',
                    [Math.floor(Date.now() / 1000), phone]
                );
            }

            console.log(`[DEBUG] SMS sent successfully to ${this.maskPhoneNumber(phone)}, SID: ${result.sid}`);
            return true;
        } catch (error) {
            console.error(`[ERROR] Failed to send SMS to ${this.maskPhoneNumber(phone)}:`, {
                error: error.message,
                code: error.code,
                status: error.status,
                moreInfo: error.moreInfo
            });
            return false;
        }
    }

    async handleStopSMSCommand(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });
            
            await this.dbRun(
                'DELETE FROM sms_subscribers WHERE discord_user_id = ?',
                [interaction.user.id]
            );

            return await interaction.editReply({
                content: '✅ Successfully unsubscribed from SMS notifications.',
                ephemeral: true
            });
        } catch (error) {
            console.error('Stop SMS command error:', error);
            return await interaction.editReply({
                content: '❌ Failed to unsubscribe. Please try again.',
                ephemeral: true
            });
        }
    }

    async shutdown() {
        try {
            // Clear monitoring interval
            if (this.monitoringInterval) {
                clearInterval(this.monitoringInterval);
                this.monitoringInterval = null;
            }

            // Close database connection if open
            if (this.db) {
                try {
                    await new Promise((resolve, reject) => {
                        this.db.close(err => {
                            if (err && err.code !== 'SQLITE_MISUSE') {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    });
                } catch (error) {
                    if (error.code !== 'SQLITE_MISUSE') {
                        throw error;
                    }
                }
                this.db = null;
            }

            // Destroy Discord client
            if (this.client) {
                await this.client.destroy();
            }

            console.log('Bot shutdown complete');
        } catch (error) {
            console.error('Error during shutdown:', error);
            throw error;
        }
    }

    async registerCommands() {
        // ... existing code ...
        await this.client.application?.commands.create({
            name: 'trackwallet',
            description: 'Track a Solana wallet',
            options: [
                {
                    name: 'name',
                    description: 'Name to identify this wallet',
                    type: 3,
                    required: true
                },
                {
                    name: 'wallet',
                    description: 'Solana wallet address to track',
                    type: 3,
                    required: true
                }
            ]
        });

        await this.client.application?.commands.create({
            name: 'stopwallet',
            description: 'Stop tracking a wallet',
            options: [
                {
                    name: 'wallet',
                    description: 'Solana wallet address to stop tracking',
                    type: 3,
                    required: true
                }
            ]
        });
        // ... existing code ...
    }

    async handleCommand(interaction) {
        // Only handle slash commands from our guild
        if (!interaction.isCommand() || interaction.guildId !== config.discord.guildId) return;

        // Simple command handling
        try {
            const command = interaction.commandName;
            console.log(`[DEBUG] Received command: ${command} from ${interaction.user.tag}`);

            switch (command) {
                case 'monitor':
                    if (!interaction.replied) {
                        await this.handleMonitorCommand(interaction);
                    }
                    break;
                case 'stopm':
                    if (!interaction.replied) {
                        await this.handleStopMonitorCommand(interaction);
                    }
                    break;
                case 'list':
                    if (!interaction.replied) {
                        await this.handleListCommand(interaction);
                    }
                    break;
                case 'test':
                    if (!interaction.replied) {
                        await this.testNotifications(interaction);
                    }
                    break;
                case 'vipmonitor':
                    if (!interaction.replied) {
                        await this.handleVipMonitorCommand(interaction).catch(err => {
                            console.error('[ERROR] VIP monitor command failed:', err);
                            throw err;
                        });
                    }
                    break;
                case 'trending':
                    if (!interaction.replied) {
                        await this.handleTrendingCommand(interaction);
                    }
                    break;
                case 'gainers':
                    if (!interaction.replied) {
                        await this.handleGainersCommand(interaction);
                    }
                    break;
                case 'losers':
                    if (!interaction.replied) {
                        await this.handleLosersCommand(interaction);
                    }
                    break;
                case 'newpairs':
                    if (!interaction.replied) {
                        await this.handleNewPairsCommand(interaction);
                    }
                    break;
                case 'volume':
                    if (!interaction.replied) {
                        await this.handleVolumeCommand(interaction);
                    }
                    break;
                case 'help':
                    if (!interaction.replied) {
                        await this.handleHelpCommand(interaction);
                    }
                    break;
                case 'security':
                    if (!interaction.replied) {
                        await this.handleSecurityCommand(interaction);
                    }
                    break;
                case 'metrics':
                    if (!interaction.replied) {
                        await this.handleMetricsCommand(interaction);
                    }
                    break;
                case 'holders':
                    if (!interaction.replied) {
                        await this.handleHoldersCommand(interaction);
                    }
                    break;
                case 'smsalert':
                    if (!interaction.replied) {
                        await this.handleSMSAlertCommand(interaction);
                    }
                    break;
                case 'stopsms':
                    if (!interaction.replied) {
                        await this.handleStopSMSCommand(interaction);
                    }
                    break;
                case 'trackwallet':
                    if (!interaction.replied) {
                        await this.handleTrackWalletCommand(interaction);
                    }
                    break;
                case 'stopwallet':
                    if (!interaction.replied) {
                        await this.handleStopWalletCommand(interaction);
                    }
                    break;
                default:
                    if (!interaction.replied) {
                        await interaction.reply('Unknown command');
                    }
            }
        } catch (error) {
            console.error('Command error:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    embeds: [{
                        title: "Error",
                        description: "❌ Command failed to execute",
                        color: 0xFF0000
                    }]
                });
            }
        }
    }

    async setupHeliusWebhook() {
        try {
            console.log('🔄 Setting up Helius webhook...');
            
            // Get all monitored wallets
            const wallets = await this.dbAll('SELECT wallet_address FROM monitored_wallets');
            const accountAddresses = wallets.map(w => w.wallet_address);
            
            if (accountAddresses.length === 0) {
                console.log('ℹ️ No wallets to monitor');
                return;
            }

            // Check for existing webhook
            const webhooks = await this.helius.listWebhooks();
            let webhook = webhooks.find(w => w.webhookURL === config.helius.webhookUrl);

            if (webhook) {
                // Update existing webhook with current wallet list
                console.log('📝 Updating existing webhook...');
                await this.helius.updateWebhook(webhook.webhookId, accountAddresses);
                await this.dbRun(
                    'INSERT OR REPLACE INTO helius_webhooks (webhook_id, webhook_url) VALUES (?, ?)',
                    [webhook.webhookId, config.helius.webhookUrl]
                );
            } else {
                // Create new webhook
                console.log('🆕 Creating new webhook...');
                webhook = await this.helius.createWebhook(config.helius.webhookUrl, accountAddresses);
                await this.dbRun(
                    'INSERT INTO helius_webhooks (webhook_id, webhook_url) VALUES (?, ?)',
                    [webhook.webhookId, config.helius.webhookUrl]
                );
            }

            console.log('✅ Helius webhook setup complete');
        } catch (error) {
            console.error('❌ Error setting up Helius webhook:', error);
            throw error;
        }
    }

    // Remove the polling-based monitorWallets method since we're using webhooks now
    startWalletMonitoring() {
        // No need for polling interval anymore as we're using webhooks
        console.log('✅ Wallet monitoring active via Helius webhooks');
    }

    async start() {
        // ... existing code ...
        this.startWalletMonitoring();
        // ... existing code ...
    }

    async handleTrackWalletCommand(interaction) {
        try {
            await interaction.deferReply();
            
            const name = interaction.options.getString('name');
            const wallet = interaction.options.getString('wallet');
            const discordUserId = interaction.user.id;
            
            // Validate wallet address
            if (!this.helius.isValidSolanaAddress(wallet)) {
                await interaction.editReply({
                    embeds: [{
                        title: '❌ Invalid Wallet Address',
                        description: 'The provided address is not a valid Solana wallet address.',
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
                return;
            }

            // Check if wallet is already being tracked
            const existingWallet = await this.dbGet(
                'SELECT * FROM monitored_wallets WHERE wallet_address = ?',
                [wallet]
            );

            if (existingWallet) {
                await interaction.editReply({
                    embeds: [{
                        title: '❌ Wallet Already Tracked',
                        description: `This wallet is already being tracked as "${existingWallet.name}"`,
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
                return;
            }
            
            // Add wallet to database
            await this.dbRun(
                'INSERT INTO monitored_wallets (wallet_address, name, discord_user_id) VALUES (?, ?, ?)',
                [wallet, name, discordUserId]
            );
            
            // Sync updated wallet list with Helius
            try {
                await this.helius.syncWallets(this.config.helius.webhookUrl);
                
                await interaction.editReply({
                    embeds: [{
                        title: '✅ Wallet Tracking Started',
                        description: `Now tracking wallet: ${name}\n\`${wallet}\``,
                        color: 0x00FF00,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
            } catch (error) {
                console.error('[ERROR] Failed to sync wallets with Helius:', error);
                
                // Remove wallet from database if Helius sync fails
                await this.dbRun(
                    'DELETE FROM monitored_wallets WHERE wallet_address = ?',
                    [wallet]
                );
                
                await interaction.editReply({
                    embeds: [{
                        title: '❌ Tracking Setup Failed',
                        description: 'Failed to set up wallet tracking. Please try again later.',
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
            }
            
        } catch (error) {
            console.error('[ERROR] Error handling track wallet command:', error);
            await interaction.editReply({
                embeds: [{
                    title: '❌ Command Error',
                    description: 'Failed to track wallet. Please try again.',
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        }
    }
} // End of class TwitterMonitorBot

module.exports = TwitterMonitorBot;