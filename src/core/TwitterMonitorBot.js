const { Client, GatewayIntentBits } = require('discord.js');
const { TwitterApi } = require('twitter-api-v2');
const sqlite3 = require('sqlite3');
const { promisify } = require('util');
const config = require('../config/config');
const path = require('path');
const fs = require('fs').promises;
const RateLimitManager = require('./RateLimitManager');
const DexScreenerService = require('./DexScreenerService');
const BirdeyeService = require('./BirdeyeService');
const twilio = require('twilio');
const HeliusService = require('./HeliusService');

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

        // Initialize Twilio client
        this.twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);

        // Initialize Helius service
        this.helius = new HeliusService(config.helius.apiKey, {
            all: this.dbAll.bind(this),
            get: this.dbGet.bind(this),
            run: this.dbRun.bind(this)
        });

        // Set up webhook handling
        this.setupWebhookHandling();
    }

    async setupBot() {
        try {
            console.log('🔄 Setting up bot...');
            
            // Initialize database
            await this.initializeDatabase();
            
            // Set up Discord client
            await this.client.login(config.discord.token);
            
            // Get guild and cache channels
            this.guild = this.client.guilds.cache.get(config.discord.guildId);
            if (!this.guild) {
                throw new Error('Could not find configured guild');
            }
            
            // Cache channel IDs
            this.channels = {
                tweets: config.discord.channels.tweets,
                solana: config.discord.channels.solana,
                vip: config.discord.channels.vip,
                wallets: config.discord.channels.wallets
            };
            
            // Set up command handling
            this.setupCommandHandling();
            
            // Sync wallets with Helius
            await this.helius.syncWallets(config.helius.webhookUrl);
            
            console.log('✅ Bot setup completed successfully');
            
        } catch (error) {
            console.error('❌ Error during bot setup:', error);
            throw error;
        }
    }

    async initializeDatabase() {
        try {
            console.log('📊 Initializing database...');
            
            // Create data directory if it doesn't exist
            const dataDir = path.dirname(this.config.database.path);
            await fs.mkdir(dataDir, { recursive: true });
            
            // Connect to database
            this.db = new sqlite3.Database(this.config.database.path);
            
            // Initialize schema
            const schemaPath = path.join(process.cwd(), 'src', 'database', 'schema.sql');
            const schema = await fs.readFile(schemaPath, 'utf8');
            
            // Execute schema
            await this.dbRun('BEGIN TRANSACTION');
            try {
                const statements = schema.split(';').filter(stmt => stmt.trim());
                for (const statement of statements) {
                    if (statement.trim()) {
                        await this.dbRun(statement);
                    }
                }
                await this.dbRun('COMMIT');
                console.log('✅ Schema initialized successfully');
            } catch (error) {
                await this.dbRun('ROLLBACK');
                throw error;
            }

            console.log('✅ Database initialization complete');
        } catch (error) {
            console.error('❌ Database initialization failed:', error);
            throw error;
        }
    }

    async dbRun(sql, params = [], maxRetries = 3) {
        let lastError;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await new Promise((resolve, reject) => {
                    this.db.run(sql, params, function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(this);
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

    async dbGet(sql, params = [], maxRetries = 3) {
        let lastError;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await new Promise((resolve, reject) => {
                    this.db.get(sql, params, (err, row) => {
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
                    this.db.all(sql, params, (err, rows) => {
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

            // Sort tweets by ID (chronological order, newest first)
            const sortedTweets = [...tweets].sort((a, b) => {
                const diff = BigInt(b.id) - BigInt(a.id); // Reversed comparison for descending order
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
                            // Check if this token mention already exists
                            const existingMention = await this.dbGet(
                                'SELECT 1 FROM token_mentions WHERE tweet_id = ? AND token_address = ?',
                                [tweet.id, address]
                            );

                            if (!existingMention) {
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

                                // Send notification only for new mentions
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
            const channel = this.guild.channels.cache.get(this.channels.solana);
            if (!channel) {
                console.error('Solana channel not found in guild');
                return;
            }

            // Get token information from both services
            const tokenInfo = await this.dexscreener.getTokenInfo(data.address);
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
                // Create token embed
                const tokenEmbed = await this.dexscreener.createTokenEmbed(tokenInfo, 0xFF0000);

                // Send Discord notification
                await channel.send({ 
                    content: '@everyone New token detected! 🚨',
                    embeds: [tweetEmbed, tokenEmbed],
                    allowedMentions: { parse: ['everyone'] }
                });

                // Send SMS notifications for new tokens
                const subscribers = await this.dbAll('SELECT phone_number FROM sms_subscribers');
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
                        // Don't reverse the order - process from oldest to newest
                        for (const tweet of initialTweets.data) {
                            // Check if tweet was already processed
                            const existingTweet = await this.dbGet(
                                'SELECT 1 FROM processed_tweets WHERE tweet_id = ?',
                                [tweet.id]
                            );

                            if (!existingTweet) {
                                await this.processTweet(tweet, {
                                    twitter_id: userInfo.data.id,
                                    username,
                                    monitoring_type: monitoringType,
                                    is_vip: isVip
                                }, initialTweets.includes);
                            }
                        }

                        // Update last tweet ID with the newest tweet
                        const newestTweet = initialTweets.data[0];
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

            // 3. Test SMS Functionality
            try {
                console.log('[DEBUG] Testing SMS functionality...');
                
                // First check Twilio configuration
                if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
                    throw new Error('Missing Twilio configuration in environment variables');
                }

                // Check SMS subscribers table
                const subscribers = await this.dbAll('SELECT discord_user_id, phone_number FROM sms_subscribers');
                
                if (subscribers.length === 0) {
                    results.failed.push('❌ SMS: No subscribers found. Use /smsalert to register.');
                } else {
                    // Test SMS for the requesting user
                    const userSubscription = subscribers.find(s => s.discord_user_id === interaction.user.id);
                    
                    if (userSubscription) {
                        const testMessage = `🧪 Test SMS Alert from KEK Monitor Bot\nThis is a test message to verify SMS notifications are working.`;
                        try {
                            await this.sendSMSAlert(testMessage, userSubscription.phone_number);
                            results.success.push(`✅ SMS: Test message sent to ${this.maskPhoneNumber(userSubscription.phone_number)}`);
                        } catch (smsError) {
                            results.failed.push(`❌ SMS Send Failed: ${smsError.message}`);
                        }
                    } else {
                        results.failed.push('❌ SMS: You have not registered for SMS alerts. Use /smsalert to register.');
                    }

                    results.success.push(`✅ SMS System: Found ${subscribers.length} total subscriber(s)`);
                }
            } catch (error) {
                results.failed.push(`❌ SMS Test: ${error.message}`);
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
                    icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                },
                timestamp: new Date().toISOString()
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
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });
        }
    }

    // Helper function to mask phone numbers for privacy
    maskPhoneNumber(phone) {
        return phone.slice(0, 2) + '*'.repeat(phone.length - 6) + phone.slice(-4);
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
                    // Don't reverse the order - process from oldest to newest
                    for (const tweet of initialTweets.data) {
                        // Check if tweet was already processed
                        const existingTweet = await this.dbGet(
                            'SELECT 1 FROM processed_tweets WHERE tweet_id = ?',
                            [tweet.id]
                        );

                        if (!existingTweet) {
                            await this.processTweet(tweet, {
                                twitter_id: userInfo.data.id,
                                username,
                                monitoring_type: 'tweet',
                                is_vip: true
                            }, initialTweets.includes);
                        }
                    }

                    // Update last tweet ID with the newest tweet
                    const newestTweet = initialTweets.data[0];
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
            
            // Basic phone number validation
            if (!phone.match(/^\+[1-9]\d{1,14}$/)) {
                return await interaction.editReply({
                    content: '❌ Invalid phone number format. Please use international format (e.g., +1234567890)',
                    ephemeral: true
                });
            }

            try {
                await this.dbRun(
                    'INSERT OR REPLACE INTO sms_subscribers (discord_user_id, phone_number) VALUES (?, ?)',
                    [interaction.user.id, phone]
                );

                return await interaction.editReply({
                    content: '✅ Successfully registered for SMS notifications!',
                    ephemeral: true
                });
            } catch (error) {
                console.error('Database error:', error);
                return await interaction.editReply({
                    content: '❌ Failed to register phone number. Please try again.',
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

    async sendSMSAlert(message, phone) {
        try {
            console.log(`[DEBUG] Sending SMS to ${this.maskPhoneNumber(phone)}`);
            console.log(`[DEBUG] Using Twilio config:`, {
                accountSid: this.maskString(process.env.TWILIO_ACCOUNT_SID || ''),
                fromNumber: process.env.TWILIO_PHONE_NUMBER || '',
                messageLength: message.length
            });

            if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
                throw new Error('Missing Twilio configuration in environment variables');
            }

            const result = await this.twilioClient.messages.create({
                body: message,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: phone
            });

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

    // Helper to mask sensitive data in logs
    maskString(str) {
        if (!str) return '';
        if (str.length <= 8) return '*'.repeat(str.length);
        return str.slice(0, 4) + '*'.repeat(str.length - 8) + str.slice(-4);
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
            
            // Validate wallet address
            if (!this.helius.isValidSolanaAddress(wallet)) {
                await interaction.editReply('❌ Invalid Solana wallet address');
                return;
            }
            
            // Add wallet to database
            await this.dbRun(
                'INSERT INTO monitored_wallets (wallet_address, name) VALUES (?, ?)',
                [wallet, name]
            );
            
            // Sync updated wallet list with Helius
            await this.helius.syncWallets(config.helius.webhookUrl);
            
            await interaction.editReply(`✅ Now tracking wallet: ${name} (${wallet})`);
            
        } catch (error) {
            console.error('Error handling track wallet command:', error);
            await interaction.editReply('❌ Failed to track wallet. Please try again.');
        }
    }

    async handleStopWalletCommand(interaction) {
        try {
            await interaction.deferReply();
            
            const wallet = interaction.options.getString('wallet');
            
            // Remove wallet from database
            const result = await this.dbRun(
                'DELETE FROM monitored_wallets WHERE wallet_address = ?',
                [wallet]
            );
            
            if (result.changes === 0) {
                await interaction.editReply('❌ Wallet not found in tracking list');
                return;
            }
            
            // Sync updated wallet list with Helius
            await this.helius.syncWallets(config.helius.webhookUrl);
            
            await interaction.editReply(`✅ Stopped tracking wallet: ${wallet}`);
            
        } catch (error) {
            console.error('Error handling stop wallet command:', error);
            await interaction.editReply('❌ Failed to stop tracking wallet. Please try again.');
        }
    }

    async loadWalletsFromConfig() {
        try {
            console.log('📝 Loading wallets from configuration...');
            const walletsPath = path.join(process.cwd(), 'wallets.json');
            
            try {
                const walletsData = await fs.readFile(walletsPath, 'utf8');
                const { wallets } = JSON.parse(walletsData);
                
                if (!Array.isArray(wallets)) {
                    console.log('❌ No wallets found in configuration file');
                    return;
                }

                console.log(`Found ${wallets.length} wallets in configuration`);

                // Begin transaction for bulk insert
                await this.dbRun('BEGIN TRANSACTION');

                try {
                    for (const wallet of wallets) {
                        // Check if wallet already exists
                        const existing = await this.dbGet(
                            'SELECT 1 FROM monitored_wallets WHERE wallet_address = ?',
                            [wallet.address]
                        );

                        if (!existing) {
                            await this.dbRun(
                                'INSERT INTO monitored_wallets (wallet_address, name) VALUES (?, ?)',
                                [wallet.address, wallet.name]
                            );
                            console.log(`✅ Added wallet: ${wallet.name} (${wallet.address})`);
                        } else {
                            console.log(`ℹ️ Wallet already exists: ${wallet.name} (${wallet.address})`);
                        }
                    }

                    await this.dbRun('COMMIT');
                    console.log('✅ Successfully loaded all wallets from configuration');

                } catch (error) {
                    await this.dbRun('ROLLBACK');
                    throw error;
                }

            } catch (error) {
                if (error.code === 'ENOENT') {
                    console.log('ℹ️ No wallets.json file found - skipping wallet initialization');
                    return;
                }
                throw error;
            }

        } catch (error) {
            console.error('❌ Error loading wallets from configuration:', error);
        }
    }

    async handleWalletNotification(transaction) {
        try {
            // Parse the swap transaction
            const swap = this.helius.parseSwapTransaction(transaction);
            if (!swap || !swap.tokenTransfers || swap.tokenTransfers.length < 2) {
                console.log('Invalid swap transaction:', transaction);
                return;
            }

            // Check minimum value for Discord notification
            if (swap.usdValue < this.config.helius.minSwapValue) {
                console.log(`Swap value ($${swap.usdValue}) below minimum threshold ($${this.config.helius.minSwapValue}), skipping Discord notification`);
                return;
            }

            // Get wallet name from database
            const wallet = await this.dbGet(
                'SELECT name FROM monitored_wallets WHERE wallet_address = ?',
                [transaction.accountData[0].account]
            );

            if (!wallet) {
                console.log('Wallet not found in database:', transaction.accountData[0].account);
                return;
            }

            // Get token information for both tokens in the swap
            const [sentToken, receivedToken] = await Promise.all([
                this.dexscreener.getTokenInfo(swap.tokenTransfers[0].mint),
                this.dexscreener.getTokenInfo(swap.tokenTransfers[1].mint)
            ]);

            // Create embed
            const embed = {
                title: `🔄 Swap by ${wallet.name}`,
                description: `Wallet: \`${transaction.accountData[0].account}\`\nValue: $${this.dexscreener.formatNumber(swap.usdValue)}\nTX: [View on Solscan](https://solscan.io/tx/${swap.signature})`,
                color: 0x00ff00,
                fields: [
                    {
                        name: '📤 Sent',
                        value: [
                            `Amount: ${this.dexscreener.formatNumber(swap.tokenTransfers[0].tokenAmount)} ${sentToken?.symbol || 'UNKNOWN'}`,
                            `Price: $${this.dexscreener.formatNumber(sentToken?.priceUsd || 0)}`,
                            `MC: $${this.dexscreener.formatNumber(sentToken?.marketCap || 0)}`,
                            `24h Vol: $${this.dexscreener.formatNumber(sentToken?.volume?.h24 || 0)}`,
                            `LP: $${this.dexscreener.formatNumber(sentToken?.liquidity || 0)}`,
                            `24h Txns: 📈${this.dexscreener.formatNumber(sentToken?.txns?.h24?.buys || 0)} 📉${this.dexscreener.formatNumber(sentToken?.txns?.h24?.sells || 0)}`,
                            sentToken?.url ? `[View Chart](${sentToken.url})` : ''
                        ].join('\n'),
                        inline: true
                    },
                    {
                        name: '📥 Received',
                        value: [
                            `Amount: ${this.dexscreener.formatNumber(swap.tokenTransfers[1].tokenAmount)} ${receivedToken?.symbol || 'UNKNOWN'}`,
                            `Price: $${this.dexscreener.formatNumber(receivedToken?.priceUsd || 0)}`,
                            `MC: $${this.dexscreener.formatNumber(receivedToken?.marketCap || 0)}`,
                            `24h Vol: $${this.dexscreener.formatNumber(receivedToken?.volume?.h24 || 0)}`,
                            `LP: $${this.dexscreener.formatNumber(receivedToken?.liquidity || 0)}`,
                            `24h Txns: 📈${this.dexscreener.formatNumber(receivedToken?.txns?.h24?.buys || 0)} 📉${this.dexscreener.formatNumber(receivedToken?.txns?.h24?.sells || 0)}`,
                            receivedToken?.url ? `[View Chart](${receivedToken.url})` : ''
                        ].join('\n'),
                        inline: true
                    }
                ],
                footer: {
                    text: "built by keklabs",
                    icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                },
                timestamp: new Date(swap.timestamp * 1000).toISOString()
            };

            // Send notification to Discord
            const channel = await this.client.channels.fetch(this.config.discord.channels.wallets);
            if (channel) {
                await channel.send({ embeds: [embed] });
                console.log('Sent wallet notification for:', wallet.name);
            }

            // Check if swap value meets SMS threshold
            if (swap.usdValue >= this.config.helius.minSmsSwapValue) {
                // Send SMS notification if enabled
                const subscribers = await this.dbAll('SELECT phone_number FROM sms_subscribers');
                if (subscribers.length > 0) {
                    const smsMessage = `🔄 ${wallet.name} swapped ${this.dexscreener.formatNumber(swap.tokenTransfers[0].tokenAmount)} ${sentToken?.symbol || 'UNKNOWN'} ($${this.dexscreener.formatNumber(swap.usdValue)}) for ${this.dexscreener.formatNumber(swap.tokenTransfers[1].tokenAmount)} ${receivedToken?.symbol || 'UNKNOWN'}`;
                    
                    for (const subscriber of subscribers) {
                        await this.sendSMSAlert(smsMessage, subscriber.phone_number);
                    }
                }
            } else {
                console.log(`Swap value ($${swap.usdValue}) below SMS threshold ($${this.config.helius.minSmsSwapValue}), skipping SMS notification`);
            }

        } catch (error) {
            console.error('Error handling wallet notification:', error);
        }
    }

    setupWebhookHandling() {
        // This will be called by the webhook endpoint
        this.handleWebhook = async (webhookData) => {
            if (!webhookData || !Array.isArray(webhookData.events)) {
                console.log('Invalid webhook data received');
                return;
            }

            for (const event of webhookData.events) {
                if (event.type === 'SWAP') {
                    await this.handleWalletNotification(event);
                }
            }
        };
    }
}

module.exports = TwitterMonitorBot;