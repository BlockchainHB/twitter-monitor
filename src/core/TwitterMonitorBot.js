const { Client, GatewayIntentBits } = require('discord.js');
const { TwitterApi } = require('twitter-api-v2');
const sqlite3 = require('sqlite3');
const { promisify } = require('util');
const config = require('../config/config');
const path = require('path');
const fs = require('fs/promises');
const RateLimitManager = require('./RateLimitManager');
const DexScreenerService = require('./DexScreenerService');
const BirdeyeService = require('./BirdeyeService');

class TwitterMonitorBot {
    constructor() {
        // Initialize Discord client with required intents
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildIntegrations
            ]
        });

        // Add error event handler
        this.client.on('error', error => {
            console.error('Discord client error:', error);
        });

        // Add debug event handler
        this.client.on('debug', info => {
            console.log('Discord debug:', info);
        });

        // Initialize Twitter client
        this.twitter = new TwitterApi({
            appKey: config.twitter.apiKey,
            appSecret: config.twitter.apiKeySecret,
            accessToken: config.twitter.accessToken,
            accessSecret: config.twitter.accessTokenSecret
        });

        // Initialize rate limit manager
        this.rateLimitManager = new RateLimitManager(config.twitter.rateLimit);

        // Initialize services
        this.birdeyeService = new BirdeyeService();
        this.dexscreener = new DexScreenerService();

        // Initialize database connection
        this.db = new sqlite3.Database(config.database.path, 
            sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
            (err) => {
                if (err) {
                    console.error('❌ Database connection error:', err);
                    throw err;
                }
            }
        );

        // Set up database for better performance
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA synchronous = NORMAL');
        this.db.run('PRAGMA foreign_keys = ON');
        
        // Initialize monitoring state
        this.monitoringInterval = null;
        this.isShuttingDown = false;

        // Channel IDs for different alerts
        this.channels = config.discord.channels;

        // Command processing flags
        this.processingCommands = new Set();
    }

    async setupBot() {
        try {
            // Initialize database first
            console.log('📊 Initializing database...');
            try {
                await this.initializeDatabase();
            } catch (error) {
                console.error('❌ Database initialization failed:', error);
                throw error;
            }

            // Set up ready event handler first
            const readyPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Discord client ready timeout after 60 seconds'));
                }, 60000);
                
                this.client.once('ready', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });

            // Login to Discord
            console.log('🔄 Logging into Discord...');
            try {
                await this.client.login(config.discord.token);
            } catch (error) {
                console.error('❌ Discord login failed:', error);
                throw error;
            }

            // Wait for client to be ready
            console.log('⏳ Waiting for Discord client to be ready...');
            try {
                await readyPromise;
                console.log(`✅ Bot logged in as ${this.client.user.tag}`);
            } catch (error) {
                console.error('❌ Discord client ready timeout:', error);
                throw error;
            }

            // Get the guild
            console.log('🔍 Looking for configured guild...');
            this.guild = this.client.guilds.cache.get(config.discord.guildId);
            if (!this.guild) {
                const error = new Error(`Bot is not in the specified guild: ${config.discord.guildId}`);
                console.error('❌ Guild not found:', error);
                throw error;
            }
            console.log(`✅ Found guild: ${this.guild.name} (${this.guild.id})`);

            // Log available channels
            console.log('\n📋 Available channels in guild:');
            this.guild.channels.cache.forEach(channel => {
                if (channel.type === 0) { // 0 is text channel
                    console.log(`- #${channel.name} (${channel.id})`);
                }
            });

            // Verify channel access
            console.log('\n🔍 Verifying channel access...');
            const tweetsChannel = this.guild.channels.cache.get(this.channels.tweets);
            const solanaChannel = this.guild.channels.cache.get(this.channels.solana);

            if (!tweetsChannel) {
                const error = new Error(`Tweets channel not found: ${this.channels.tweets}`);
                console.error('❌ Tweets channel not found:', error);
                throw error;
            }
            console.log(`✅ Found tweets channel: #${tweetsChannel.name}`);

            if (!solanaChannel) {
                const error = new Error(`Solana channel not found: ${this.channels.solana}`);
                console.error('❌ Solana channel not found:', error);
                throw error;
            }
            console.log(`✅ Found Solana channel: #${solanaChannel.name}`);

            // Test channel permissions
            console.log('\n🔍 Checking channel permissions...');
            const permissions = tweetsChannel.permissionsFor(this.client.user);
            if (!permissions.has(['SendMessages', 'ViewChannel', 'EmbedLinks'])) {
                const error = new Error(`Missing required permissions in channel #${tweetsChannel.name}`);
                console.error('❌ Missing permissions:', error);
                throw error;
            }
            console.log('✅ Channel permissions verified');

            // Set up command handling
            this.setupCommandHandling();

            // Start monitoring
            console.log('\n🔄 Starting monitoring system...');
            try {
                await this.startMonitoring();
                console.log('✅ Monitoring system started');
            } catch (error) {
                console.error('❌ Failed to start monitoring:', error);
                throw error;
            }

            console.log(`\n✅ Bot initialized successfully in ${this.guild.name}`);
            return true;
        } catch (error) {
            console.error('❌ Setup error:', error);
            throw error;
        }
    }

    async initializeDatabase() {
        try {
            console.log('📊 Initializing database...');
            const dataDir = path.dirname(config.database.path);
            
            // Create data directory if it doesn't exist
            try {
                if (process.env.NODE_ENV === 'production') {
                    // In production (Railways), /data should already exist and be writable
                    console.log('Production environment detected, using /data directory');
                    await fs.access(dataDir, fs.constants.W_OK);
                    console.log(`✅ Production data directory ${dataDir} is accessible and writable`);
                } else {
                    // In development, create the directory if needed
                    await fs.mkdir(dataDir, { recursive: true });
                    console.log(`✅ Development data directory created/verified: ${dataDir}`);
                }
            } catch (error) {
                console.error(`❌ Data directory error: ${error.message}`);
                throw error; // In production, we want to fail if /data is not accessible
            }
            
            console.log('🔌 Connecting to database:', config.database.path);

            // Initialize database with proper permissions
            this.db = new sqlite3.Database(config.database.path, 
                sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
                (err) => {
                    if (err) {
                        console.error('❌ Database connection error:', err);
                        throw err;
                    }
                    console.log('✅ Database connection established');
                }
            );

            // Enable foreign keys and WAL mode for better performance
            await this.dbRun('PRAGMA foreign_keys = ON');
            await this.dbRun('PRAGMA journal_mode = WAL');
            
            // Create tables with proper indexes and constraints
            await this.dbRun(`
                CREATE TABLE IF NOT EXISTS monitored_accounts (
                    twitter_id TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    monitoring_type TEXT NOT NULL CHECK (monitoring_type IN ('tweet', 'solana', 'vip')),
                    last_tweet_id TEXT,
                    profile_data TEXT,
                    is_vip INTEGER DEFAULT 0,
                    last_check_time INTEGER,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            await this.dbRun(`
                CREATE TABLE IF NOT EXISTS processed_tweets (
                    tweet_id TEXT PRIMARY KEY,
                    twitter_id TEXT NOT NULL,
                    conversation_id TEXT,
                    referenced_tweet_id TEXT,
                    tweet_type TEXT CHECK (tweet_type IN ('tweet', 'reply', 'quote', 'retweet')),
                    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (twitter_id) REFERENCES monitored_accounts(twitter_id) ON DELETE CASCADE
                )
            `);

            await this.dbRun(`
                CREATE TABLE IF NOT EXISTS tracked_tokens (
                    address TEXT PRIMARY KEY,
                    symbol TEXT,
                    name TEXT,
                    first_seen_tweet_id TEXT NULL,
                    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_price REAL,
                    last_updated DATETIME,
                    FOREIGN KEY (first_seen_tweet_id) REFERENCES processed_tweets(tweet_id) ON DELETE SET NULL
                )
            `);

            await this.dbRun(`
                CREATE TABLE IF NOT EXISTS token_mentions (
                    tweet_id TEXT,
                    token_address TEXT,
                    mentioned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (tweet_id, token_address),
                    FOREIGN KEY (tweet_id) REFERENCES processed_tweets(tweet_id) ON DELETE CASCADE,
                    FOREIGN KEY (token_address) REFERENCES tracked_tokens(address) ON DELETE CASCADE
                )
            `);

            await this.dbRun(`
                CREATE TABLE IF NOT EXISTS rate_limits (
                    endpoint TEXT PRIMARY KEY,
                    remaining INTEGER NOT NULL,
                    reset_at DATETIME NOT NULL,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Create indexes for better query performance
            await this.dbRun('CREATE INDEX IF NOT EXISTS idx_monitored_accounts_username ON monitored_accounts(username)');
            await this.dbRun('CREATE INDEX IF NOT EXISTS idx_monitored_accounts_type ON monitored_accounts(monitoring_type)');
            await this.dbRun('CREATE INDEX IF NOT EXISTS idx_processed_tweets_twitter_id ON processed_tweets(twitter_id)');
            await this.dbRun('CREATE INDEX IF NOT EXISTS idx_processed_tweets_conversation ON processed_tweets(conversation_id)');
            await this.dbRun('CREATE INDEX IF NOT EXISTS idx_token_mentions_token ON token_mentions(token_address)');
            await this.dbRun('CREATE INDEX IF NOT EXISTS idx_tracked_tokens_symbol ON tracked_tokens(symbol)');

            // Create trigger to update the updated_at timestamp
            await this.dbRun(`
                CREATE TRIGGER IF NOT EXISTS update_account_timestamp 
                AFTER UPDATE ON monitored_accounts
                BEGIN
                    UPDATE monitored_accounts 
                    SET updated_at = CURRENT_TIMESTAMP 
                    WHERE twitter_id = NEW.twitter_id;
                END
            `);

            console.log('✅ Database initialization complete');
        } catch (error) {
            console.error('❌ Database initialization error:', error);
            throw error;
        }
    }

    async dbRun(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) {
                    console.error('Database error:', err);
                    reject(err);
                } else {
                    resolve(this);
                }
            });
        });
    }

    async dbGet(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    console.error('Database error:', err);
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    async dbAll(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    console.error('Database error:', err);
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
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

            // First transaction: Insert tweets
            await this.dbRun('BEGIN TRANSACTION');
            try {
                for (const tweet of tweets) {
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
        
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
        }

        this.monitoringInterval = setInterval(async () => {
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
                monitoring_type, 
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
                if (account.monitoring_type === 'tweet') {
                    await this.sendTweetNotification(tweet);
                    console.log(`[DEBUG] Sent tweet notification for ${tweet.id}`);
                } else if (account.monitoring_type === 'solana') {
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
        // Match base58 encoded strings that could be Solana addresses
        const regex = /[1-9A-HJ-NP-Za-km-z]{44}/g;
        const potentialAddresses = text.match(regex) || [];
        
        // Only filter by length and valid base58 characters
        return potentialAddresses.filter(address => {
            // Must be exactly 44 characters for token addresses
            if (address.length !== 44) return false;
            
            // Check for valid base58 characters
            if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) return false;
            
            return true;
        });
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

                // Insert into processed_tweets
                await this.dbRun(
                    `INSERT OR IGNORE INTO processed_tweets 
                    (tweet_id, twitter_id, conversation_id, referenced_tweet_id, tweet_type) 
                    VALUES (?, ?, ?, ?, ?)`,
                    [tweet.id, account.twitter_id, tweet.conversation_id, referencedTweetId, tweetType]
                );

                // Process Solana addresses if found
                if (account.monitoring_type === 'solana' || account.monitoring_type === 'vip') {
                    const addresses = this.extractSolanaAddresses(tweet.text);
                    if (addresses.length > 0) {
                        for (const address of addresses) {
                            // Insert or update token info
                            await this.dbRun(
                                `INSERT OR IGNORE INTO tracked_tokens 
                                (address, first_seen_tweet_id, first_seen_at) 
                                VALUES (?, ?, CURRENT_TIMESTAMP)`,
                                [address, tweet.id]
                            );

                            // Record token mention
                            await this.dbRun(
                                `INSERT OR IGNORE INTO token_mentions 
                                (tweet_id, token_address) 
                                VALUES (?, ?)`,
                                [tweet.id, address]
                            );

                            // Send notification
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

                // Send tweet notification based on type
                if (account.monitoring_type === 'tweet' || account.monitoring_type === 'vip') {
                    await this.sendTweetNotification({
                        ...tweet,
                        includes,
                        is_vip: account.monitoring_type === 'vip'
                    });
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
            const channelId = author?.is_vip ? this.channels.vip : this.channels.tweets;
            const channel = this.guild.channels.cache.get(channelId);
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
                color: 8388863,
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

    async sendSolanaNotification(data) {
        try {
            const channel = this.guild.channels.cache.get(this.channels.solana);
            if (!channel) {
                console.error('Solana channel not found in guild');
                return;
            }

            // Get token information from both services
            console.log(`[DEBUG] Fetching token info for address: ${data.address}`);
            const tokenInfo = await this.dexscreener.getTokenInfo(data.address);
            console.log(`[DEBUG] Token info response:`, {
                hasDexScreenerData: !!tokenInfo,
                hasBirdeyeData: !!(tokenInfo?.birdeye),
                symbol: tokenInfo?.symbol,
                name: tokenInfo?.name
            });

            if (!tokenInfo) {
                console.log(`[DEBUG] No token info found for address: ${data.address}`);
                return; // Skip if no token info found
            }

            // Get author info and tweet data for context
            const author = await this.dbGet(
                'SELECT username, profile_data FROM monitored_accounts WHERE twitter_id = ?',
                [data.author_id]
            );

            const profileData = author?.profile_data ? JSON.parse(author.profile_data) : {};

            // Create tweet URL
            const tweetUrl = `https://twitter.com/${author?.username}/status/${data.tweet_id}`;

            // Create the main tweet embed
            const tweetEmbed = {
                color: 8388863,
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
                // Create token embed with red color
                console.log('[DEBUG] Creating token embed...');
                const tokenEmbed = await this.dexscreener.createTokenEmbed(tokenInfo, 0xFF0000);
                console.log('[DEBUG] Token embed created successfully');

                // Send both embeds
                console.log('[DEBUG] Sending notification with embeds...');
                await channel.send({ 
                    content: '@everyone New token detected! 🚨',
                    embeds: [tweetEmbed, tokenEmbed],
                    allowedMentions: { parse: ['everyone'] }
                });
                console.log('[DEBUG] Notification sent successfully');
            } catch (embedError) {
                console.error('[ERROR] Error creating or sending token embed:', embedError);
                // Still send the tweet embed if token embed fails
                await channel.send({ embeds: [tweetEmbed] });
            }
        } catch (error) {
            console.error('Error sending Solana notification:', error);
            if (error.response) {
                console.error('API Response:', {
                    status: error.response.status,
                    data: error.response.data
                });
            }
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
                            await this.handleVipMonitorCommand(interaction);
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
        });

        // Basic error handling
        this.client.on('error', error => {
            console.error('Discord error:', error);
        });

        console.log('✅ Command handling setup complete');
    }

    async handleMonitorCommand(interaction) {
        try {
            // Defer the reply immediately to prevent timeout
            await interaction.deferReply();
            
            console.log('[DEBUG] Starting monitor command execution');
            const username = interaction.options.getString('twitter_id').toLowerCase().replace('@', '');
            const type = interaction.options.getString('type');
            console.log(`[DEBUG] Parameters - Twitter ID: ${username}, Type: ${type}`);

            // Check if already monitoring
            const existingAccount = await this.dbGet(
                'SELECT * FROM monitored_accounts WHERE username = ? AND monitoring_type = ?',
                [username, type]
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

            try {
                // Get user info using users/lookup endpoint (900 requests/15min)
                const userInfo = await this.rateLimitManager.scheduleRequest(
                    async () => await this.twitter.v2.userByUsername(username, {
                        'user.fields': ['id', 'username', 'name', 'profile_image_url']
                    }),
                    'users/by/username'
                );

                if (!userInfo.data) {
                    return await interaction.editReply({
                        embeds: [{
                            title: '❌ Invalid Twitter Account',
                            description: `Could not find Twitter account: @${username}`,
                            color: 0xFF0000,
                            footer: {
                                text: 'built by keklabs',
                                icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                            }
                        }]
                    });
                }

                // Get initial tweets using userTimeline endpoint (180 requests/15min)
                const initialTweets = await this.rateLimitManager.scheduleRequest(
                    async () => await this.twitter.v2.userTimeline(userInfo.data.id, {
                        max_results: 5,
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
                        'user.fields': ['profile_image_url', 'name', 'username']
                    }, {
                        'endpoint': 'users/:id/tweets',  // Use correct endpoint
                        'path': `/2/users/${userInfo.data.id}/tweets`  // Explicitly set the path
                    }),
                    'users/:id/tweets'  // Use correct endpoint identifier
                );

                // Begin transaction for database operations
                await this.dbRun('BEGIN TRANSACTION');

                try {
                    // Add to monitoring list with proper type handling
                    const isVip = type === 'vip';
                    const monitoringType = isVip ? 'tweet' : type;

                    await this.dbRun(
                        `INSERT INTO monitored_accounts 
                        (username, twitter_id, monitoring_type, profile_data, is_vip, last_check_time) 
                        VALUES (?, ?, ?, ?, ?, ?)`,
                        [
                            username,
                            userInfo.data.id,
                            monitoringType,
                            JSON.stringify({
                                name: userInfo.data.name,
                                profile_image_url: userInfo.data.profile_image_url
                            }),
                            isVip ? 1 : 0,
                            Date.now()
                        ]
                    );

                    // Process initial tweets
                    if (initialTweets?.data?.length) {
                        const tweets = initialTweets.data.reverse();
                        for (const tweet of tweets) {
                            await this.processTweet(tweet, {
                                twitter_id: userInfo.data.id,
                                username,
                                monitoring_type: monitoringType,
                                is_vip: isVip
                            }, initialTweets.includes);
                        }

                        // Update last tweet ID
                        const newestTweet = tweets[tweets.length - 1];
                        await this.dbRun(
                            'UPDATE monitored_accounts SET last_tweet_id = ? WHERE twitter_id = ?',
                            [newestTweet.id, userInfo.data.id]
                        );
                    }

                    // Commit transaction
                    await this.dbRun('COMMIT');

                    // Start monitoring if not already running
                    if (!this.monitoringInterval) {
                        await this.startMonitoring();
                    }

                    // Send success message
                    return await interaction.editReply({
                        embeds: [{
                            title: `✅ Tweet Tracker Started For @${username}`,
                            description: `Successfully monitoring @${username} for ${type === 'solana' ? 'Solana addresses' : 'tweets'}`,
                            fields: [
                                {
                                    name: 'Account Name',
                                    value: userInfo.data.name,
                                    inline: true
                                },
                                {
                                    name: 'Monitoring Type',
                                    value: type === 'solana' ? '🔍 Solana Addresses' : '📝 All Tweets',
                                    inline: true
                                },
                                {
                                    name: 'Notifications Channel',
                                    value: `<#${type === 'solana' ? this.channels.solana : this.channels.tweets}>`,
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
                    // Rollback transaction on error
                    await this.dbRun('ROLLBACK');
                    throw error;
                }

            } catch (error) {
                console.error('[ERROR] Monitor command error:', error);
                
                let errorMessage;
                let errorTitle;
                
                if (error.code === 'RATE_LIMIT') {
                    errorTitle = '⏳ Rate Limit Reached';
                    errorMessage = `Twitter API rate limit reached for ${error.endpoint}. Please try again in a few minutes.`;
                } else if (error.code === 'TWITTER_API_ERROR') {
                    errorTitle = '❌ Twitter API Error';
                    errorMessage = "Failed to fetch Twitter account information. Please try again later.";
                } else {
                    errorTitle = '❌ Error';
                    errorMessage = "An unexpected error occurred while processing the command.";
                }

                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        embeds: [{
                            title: errorTitle,
                            description: errorMessage,
                            color: 0xFF0000,
                            footer: {
                                text: "built by keklabs",
                                icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                            }
                        }]
                    });
                } else {
                    await interaction.editReply({
                        embeds: [{
                            title: errorTitle,
                            description: errorMessage,
                            color: 0xFF0000,
                            footer: {
                                text: "built by keklabs",
                                icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                            }
                        }]
                    });
                }
            }
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
    }

    async handleListCommand(interaction) {
        try {
            // Defer the reply since we'll be making API calls
            await interaction.deferReply();

            const accounts = await this.getMonitoredAccounts();
            
            if (accounts.length === 0) {
                return await interaction.editReply({
                    embeds: [{
                        title: '📋 Monitored Accounts',
                        description: 'No accounts are currently being monitored.',
                        color: 0x1DA1F2,
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            }

            // Get Twitter usernames and latest info
            const accountDetails = await Promise.all(
                accounts.map(async (account) => {
                    try {
                        const userInfo = await this.rateLimitManager.scheduleRequest(
                            async () => await this.twitter.v2.user(account.twitter_id || account.username, {
                                'user.fields': ['id', 'username', 'name', 'profile_image_url', 'public_metrics']
                            }),
                            'users/by/username'
                        );

                        const profileData = account.profile_data ? JSON.parse(account.profile_data) : {};
                        
                        return {
                            ...account,
                            username: userInfo.data?.username || account.username,
                            name: userInfo.data?.name || profileData.name || account.username,
                            profile_image_url: userInfo.data?.profile_image_url || profileData.profile_image_url,
                            metrics: userInfo.data?.public_metrics
                        };
                    } catch (error) {
                        console.error(`Error fetching info for ${account.username}:`, error);
                        const profileData = account.profile_data ? JSON.parse(account.profile_data) : {};
                        return {
                            ...account,
                            username: account.username,
                            name: profileData.name || account.username,
                            profile_image_url: profileData.profile_image_url
                        };
                    }
                })
            );

            // Group accounts by monitoring type
            const tweetAccounts = accountDetails.filter(a => a.monitoring_type === 'tweet' && !a.is_vip);
            const solanaAccounts = accountDetails.filter(a => a.monitoring_type === 'solana');
            const vipAccounts = accountDetails.filter(a => a.is_vip);

            const embed = {
                title: '📋 Monitored Accounts',
                description: 'Currently monitoring the following Twitter accounts:',
                fields: [],
                color: 0x1DA1F2,
                footer: {
                    text: `Total accounts: ${accounts.length} | built by keklabs`,
                    icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                }
            };

            if (vipAccounts.length > 0) {
                embed.fields.push({
                    name: '⭐ VIP Accounts',
                    value: vipAccounts.map(a => 
                        `• [@${a.username}](https://twitter.com/${a.username})${a.name !== a.username ? ` - ${a.name}` : ''}`
                    ).join('\n') || 'None',
                    inline: false
                });
            }

            if (tweetAccounts.length > 0) {
                embed.fields.push({
                    name: '📝 Tweet Monitoring',
                    value: tweetAccounts.map(a => 
                        `• [@${a.username}](https://twitter.com/${a.username})${a.name !== a.username ? ` - ${a.name}` : ''}`
                    ).join('\n') || 'None',
                    inline: false
                });
            }

            if (solanaAccounts.length > 0) {
                embed.fields.push({
                    name: '🔍 Solana Address Monitoring',
                    value: solanaAccounts.map(a => 
                        `• [@${a.username}](https://twitter.com/${a.username})${a.name !== a.username ? ` - ${a.name}` : ''}`
                    ).join('\n') || 'None',
                    inline: false
                });
            }

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Error in list command:', error);
            
            const errorMessage = error.code === 429
                ? "Twitter API rate limit reached. Please try again in a few minutes."
                : "Failed to list monitored accounts. Please try again later.";

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
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
            } else {
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
        }
    }

    async testNotifications(interaction) {
        try {
            console.log('[DEBUG] Starting step-by-step test...');
            await interaction.reply({
                embeds: [{
                    title: '🔄 Starting Component Tests',
                    description: 'Testing each component in sequence...',
                    color: 0xFFA500
                }]
            });

            const results = {
                success: [],
                failed: []
            };

            // 1. Test Discord Permissions
            try {
                console.log('[DEBUG] Testing Discord permissions...');
                const tweetsChannel = this.guild.channels.cache.get(this.channels.tweets);
                const solanaChannel = this.guild.channels.cache.get(this.channels.solana);
                
                if (!tweetsChannel || !solanaChannel) {
                    throw new Error('Channel not found');
                }

                const permissions = tweetsChannel.permissionsFor(this.client.user);
                if (!permissions.has(['SendMessages', 'ViewChannel', 'EmbedLinks'])) {
                    throw new Error('Missing required permissions');
                }

                results.success.push('✅ Discord Permissions: All required permissions granted');
            } catch (error) {
                results.failed.push(`❌ Discord Permissions: ${error.message}`);
            }

            // 2. Test Database Connection
            try {
                console.log('[DEBUG] Testing database connection...');
                await this.dbRun('SELECT 1');
                const tables = await this.dbAll("SELECT name FROM sqlite_master WHERE type='table'");
                results.success.push(`✅ Database: Connected and found ${tables.length} tables`);
            } catch (error) {
                results.failed.push(`❌ Database: ${error.message}`);
            }

            // 3. Test Twitter API
            try {
                console.log('[DEBUG] Testing Twitter API connection...');
                const testApiCall = async () => {
                    const response = await this.twitter.v2.user('1234567890');
                    return response;
                };
                
                await this.rateLimitManager.scheduleRequest(testApiCall, 'test');
                results.success.push('✅ Twitter API: Connection successful');
            } catch (error) {
                const message = error.code === 429 ? 'Rate limit reached' : error.message;
                results.failed.push(`❌ Twitter API: ${message}`);
            }

            // 4. Test Rate Limit Manager
            try {
                console.log('[DEBUG] Testing rate limit manager...');
                if (!this.rateLimitManager) {
                    throw new Error('Rate limit manager not initialized');
                }
                results.success.push('✅ Rate Limit Manager: Initialized and ready');
            } catch (error) {
                results.failed.push(`❌ Rate Limit Manager: ${error.message}`);
            }

            // 5. Test Notifications
            try {
                console.log('[DEBUG] Testing notification delivery...');
                const testMessage = {
                    embeds: [{
                        title: '🧪 Test Message',
                        description: 'This is a test notification',
                        color: 0x1DA1F2
                    }]
                };

                await this.guild.channels.cache.get(this.channels.tweets).send(testMessage);
                results.success.push('✅ Notifications: Message delivered successfully');
            } catch (error) {
                results.failed.push(`❌ Notifications: ${error.message}`);
            }

            // Send final results
            const statusEmbed = {
                title: results.failed.length === 0 ? '✅ All Tests Passed' : '⚠️ Some Tests Failed',
                description: 'Component Test Results:',
                fields: [
                    {
                        name: '✅ Successful Tests',
                        value: results.success.join('\n') || 'None',
                        inline: false
                    }
                ],
                color: results.failed.length === 0 ? 0x00FF00 : 0xFF0000,
                footer: {
                    text: 'built by keklabs',
                    icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png?ex=67ba8ab2&is=67b93932&hm=d70c81c89b11e25e050324cb10b42b3a5747452d86cc8409ea707f250e02e815&=&format=webp&quality=lossless&width=468&height=468'
                }
            };

            if (results.failed.length > 0) {
                statusEmbed.fields.push({
                    name: '❌ Failed Tests',
                    value: results.failed.join('\n'),
                    inline: false
                });
            }

            await interaction.editReply({ embeds: [statusEmbed] });
            console.log('[DEBUG] Component tests completed');

        } catch (error) {
            console.error('[ERROR] Test failed:', error);
            await interaction.editReply({
                embeds: [{
                    title: '❌ Test Failed',
                    description: 'An unexpected error occurred during testing:',
                    fields: [{
                        name: 'Error Details',
                        value: error.message || 'Unknown error',
                        inline: false
                    }],
                    color: 0xFF0000,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png?ex=67ba8ab2&is=67b93932&hm=d70c81c89b11e25e050324cb10b42b3a5747452d86cc8409ea707f250e02e815&=&format=webp&quality=lossless&width=468&height=468'
                    }
                }]
            });
        }
    }

    async handleVipMonitorCommand(interaction) {
        try {
            // Defer the reply immediately to prevent timeout
            await interaction.deferReply();
            
            console.log('[DEBUG] Starting VIP monitor command execution');
            const username = interaction.options.getString('twitter_id').toLowerCase().replace('@', '');
            
            // Check if already monitoring
            const existingAccount = await this.dbGet(
                'SELECT * FROM monitored_accounts WHERE username = ? AND monitoring_type = ? AND is_vip = 1',
                [username, 'tweet']
            );

            if (existingAccount) {
                return await interaction.editReply({
                    embeds: [{
                        title: 'Already Monitoring',
                        description: `Already monitoring @${username} as a VIP`,
                        color: 0x9945FF,
                        footer: {
                            text: 'built by keklabs',
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                        }
                    }]
                });
            }

            // Validate Twitter account exists
            try {
                const userInfo = await this.rateLimitManager.scheduleRequest(
                    async () => await this.twitter.v2.userByUsername(username, {
                        'user.fields': ['id', 'username', 'name', 'profile_image_url', 'public_metrics', 'description']
                    }),
                    'users/by/username'
                );

                if (!userInfo.data) {
                    return await interaction.editReply({
                        embeds: [{
                            title: '❌ Invalid Twitter Account',
                            description: `Could not find Twitter account: @${username}`,
                            color: 0xFF0000,
                            footer: {
                                text: 'built by keklabs',
                                icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                            }
                        }]
                    });
                }

                // Add to monitoring list with VIP flag
                await this.dbRun(
                    'INSERT INTO monitored_accounts (username, twitter_id, monitoring_type, last_tweet_id, profile_data, is_vip) VALUES (?, ?, ?, ?, ?, ?)',
                    [
                        username,
                        userInfo.data.id,
                        'tweet',
                        null,
                        JSON.stringify({
                            name: userInfo.data.name,
                            profile_image_url: userInfo.data.profile_image_url
                        }),
                        1 // VIP flag
                    ]
                );

                // Get initial tweets for new VIP
                const initialTweets = await this.rateLimitManager.scheduleRequest(
                    async () => await this.twitter.v2.userTimeline(userInfo.data.id, {
                        max_results: 5,
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
                            'referenced_tweets.id.author_id',
                            'in_reply_to_user_id'
                        ],
                        'media.fields': ['url', 'preview_image_url', 'type'],
                        'user.fields': ['profile_image_url', 'name', 'username']
                    }, {
                        'endpoint': 'users/:id/tweets',  // Use correct endpoint
                        'path': `/2/users/${userInfo.data.id}/tweets`  // Explicitly set the path
                    }),
                    'users/:id/tweets'  // Use correct endpoint identifier
                );

                // Process initial tweets if any
                if (initialTweets?.data?.length) {
                    console.log(`[DEBUG] Processing ${initialTweets.data.length} initial tweets for VIP ${username}`);
                    for (const tweet of initialTweets.data.reverse()) {
                        await this.processTweet(tweet, {
                            twitter_id: userInfo.data.id,
                            username,
                            monitoring_type: 'tweet',
                            is_vip: true
                        }, initialTweets.includes);
                    }

                    // Update last tweet ID after processing initial tweets
                    const newestTweet = initialTweets.data[initialTweets.data.length - 1];
                    await this.dbRun(
                        'UPDATE monitored_accounts SET last_tweet_id = ? WHERE twitter_id = ?',
                        [newestTweet.id, userInfo.data.id]
                    );
                }

                // Start monitoring if not already running
                if (!this.monitoringInterval) {
                    await this.startMonitoring();
                }

                // Send final success message
                return await interaction.editReply({
                    embeds: [{
                        title: `✅ VIP Tweet Tracker Started For @${username}`,
                        description: `Successfully monitoring @${username} as a VIP user`,
                        fields: [
                            {
                                name: 'Account Name',
                                value: userInfo.data.name,
                                inline: true
                            },
                            {
                                name: 'Monitoring Type',
                                value: '📝 VIP Tweets',
                                inline: true
                            },
                            {
                                name: 'Notifications Channel',
                                value: `<#${this.channels.vip}>`,
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
                if (error.code === 429) {
                    return await interaction.editReply({
                        embeds: [{
                            title: '❌ Rate Limit Reached',
                            description: 'Twitter API rate limit reached. Please try again in a few minutes.',
                            color: 0xFF0000,
                            footer: {
                                text: 'built by keklabs',
                                icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                            }
                        }]
                    });
                }

                throw error;
            }
        } catch (error) {
            console.error('[ERROR] VIP Monitor command error:', error);
            
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
            // First defer the reply since we'll be making external API calls
            await interaction.deferReply();

            // Get trending tokens
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
            if (!tokens.length) {
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
            if (!tokens.length) {
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
                        name: '⚙️ Utility',
                        value: `
\`/help\` - Show this help message
\`/test\` - Test bot functionality`,
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
}

module.exports = TwitterMonitorBot;