const { Client, GatewayIntentBits } = require('discord.js');
const { TwitterApi } = require('twitter-api-v2');
const sqlite3 = require('sqlite3');
const { promisify } = require('util');
const config = require('../config/config');
const path = require('path');
const fs = require('fs/promises');
const RateLimitManager = require('./RateLimitManager');
const DexScreenerService = require('./DexScreenerService');

class TwitterMonitorBot {
    constructor() {
        // Essential Components
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,       // For commands
                GatewayIntentBits.GuildMessages // For sending messages
            ]
        });

        // Initialize rate limit manager
        this.rateLimitManager = new RateLimitManager();

        // Channel IDs for different alerts
        this.channels = config.discord.channels;

        // Core Services will be initialized in setupBot()
        this.db = null;
        this.twitter = new TwitterApi({
            appKey: config.twitter.apiKey,
            appSecret: config.twitter.apiKeySecret,
            accessToken: config.twitter.accessToken,
            accessSecret: config.twitter.accessTokenSecret
        });

        // Command processing flags
        this.processingCommands = new Set();

        // Initialize DexScreener service
        this.dexscreener = new DexScreenerService();
    }

    async setupBot() {
        try {
            // Initialize database first
            console.log('📊 Initializing database...');
            await this.initializeDatabase();

            // Login to Discord
            await this.client.login(config.discord.token);

            // Wait for client to be ready
            await new Promise(resolve => this.client.once('ready', resolve));
            console.log(`Bot logged in as ${this.client.user.tag}`);

            // Get the guild
            this.guild = this.client.guilds.cache.get(config.discord.guildId);
            if (!this.guild) {
                throw new Error(`Bot is not in the specified guild: ${config.discord.guildId}`);
            }
            console.log(`Found guild: ${this.guild.name} (${this.guild.id})`);

            // Log available channels
            console.log('\nAvailable channels in guild:');
            this.guild.channels.cache.forEach(channel => {
                if (channel.type === 0) { // 0 is text channel
                    console.log(`- #${channel.name} (${channel.id})`);
                }
            });

            // Verify channel access
            const tweetsChannel = this.guild.channels.cache.get(this.channels.tweets);
            const solanaChannel = this.guild.channels.cache.get(this.channels.solana);

            if (!tweetsChannel) {
                throw new Error(`Tweets channel not found: ${this.channels.tweets}`);
            }
            console.log(`\nConfigured tweets channel: #${tweetsChannel.name}`);

            if (!solanaChannel) {
                throw new Error(`Solana channel not found: ${this.channels.solana}`);
            }
            console.log(`Configured Solana channel: #${solanaChannel.name}`);

            // Test channel permissions
            const permissions = tweetsChannel.permissionsFor(this.client.user);
            if (!permissions.has(['SendMessages', 'ViewChannel', 'EmbedLinks'])) {
                throw new Error(`Missing required permissions in channel #${tweetsChannel.name}`);
            }

            // Command handling
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

            // Start monitoring
            await this.startMonitoring();

            console.log(`\nBot initialized successfully in ${this.guild.name}`);
            return true;
        } catch (error) {
            console.error('Setup error:', error);
            throw error;
        }
    }

    async initializeDatabase() {
        try {
            // Create data directory if it doesn't exist
            const dataDir = path.dirname(config.database.path);
            await fs.mkdir(dataDir, { recursive: true });

            // Close existing connection if any
            if (this.db) {
                await new Promise((resolve) => {
                    this.db.close(() => resolve());
                });
            }

            // Initialize database connection with immediate mode for better startup
            console.log('🔌 Connecting to database:', config.database.path);
            this.db = new sqlite3.Database(config.database.path, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);

            // Promisify database methods
            this.dbGet = promisify(this.db.get).bind(this.db);
            this.dbAll = promisify(this.db.all).bind(this.db);
            this.dbRun = promisify(this.db.run).bind(this.db);

            // Essential PRAGMA settings for performance and reliability
            await this.dbRun('PRAGMA journal_mode = WAL');
            await this.dbRun('PRAGMA synchronous = NORMAL');
            await this.dbRun('PRAGMA cache_size = -2000'); // 2MB cache
            await this.dbRun('PRAGMA temp_store = MEMORY');

            // Create minimal but sufficient table structure
            await this.dbRun(`
                CREATE TABLE IF NOT EXISTS monitored_accounts (
                    twitter_id TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    monitoring_type TEXT NOT NULL,
                    last_tweet_id TEXT,
                    last_check_time INTEGER DEFAULT 0,
                    profile_data TEXT,
                    is_vip INTEGER DEFAULT 0,
                    UNIQUE(username, monitoring_type)
                )
            `);

            // Create indexes for efficient querying
            await this.dbRun('CREATE INDEX IF NOT EXISTS idx_monitored_accounts_username ON monitored_accounts(username)');
            await this.dbRun('CREATE INDEX IF NOT EXISTS idx_monitored_accounts_last_check ON monitored_accounts(last_check_time)');

            // Update any existing records to have a last_check_time if they don't
            await this.dbRun('UPDATE monitored_accounts SET last_check_time = ? WHERE last_check_time IS NULL', [0]);

            console.log('✅ Database initialization complete');
            return true;
        } catch (error) {
            console.error('❌ Database initialization failed:', error);
            throw error;
        }
    }

    async startMonitoring() {
        console.log('[DEBUG] Starting monitoring interval...');
        
        // Clear any existing interval
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
        }

        // Start new monitoring interval
        this.monitoringInterval = setInterval(async () => {
            try {
                console.log('\n[DEBUG] Running monitoring check...');
                const accounts = await this.getMonitoredAccounts();
                if (accounts.length === 0) {
                    console.log('[DEBUG] No accounts to monitor');
                    return;
                }

                console.log(`[DEBUG] Found ${accounts.length} accounts to monitor:`, 
                    accounts.map(a => `${a.username} (${a.monitoring_type})`));
                
                // Build query for all accounts
                const query = accounts.map(a => `from:${a.username}`).join(' OR ');
                console.log(`[DEBUG] Query: ${query}`);

                // Get tweets for all accounts in one request
                const tweets = await this.rateLimitManager.scheduleRequest(
                    async () => {
                        const params = {
                            'query': `(${query}) -is:retweet`,
                            'tweet.fields': [
                                'author_id',
                                'created_at',
                                'text',
                                'attachments',
                                'referenced_tweets',
                                'in_reply_to_user_id'
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

                        // Get last tweet IDs for all accounts
                        const accountLastTweets = await Promise.all(accounts.map(account =>
                            this.dbGet('SELECT last_tweet_id FROM monitored_accounts WHERE twitter_id = ?', [account.twitter_id])
                        ));

                        // Find the most recent last_tweet_id to use as since_id
                        const validLastTweets = accountLastTweets.filter(lt => lt?.last_tweet_id);
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
                            dataLength: response.data?.length || 0,
                            sampleTweet: response.data?.[0],
                            rawResponse: response // Log the full response for debugging
                        });

                        // Ensure we properly access the tweets data
                        const tweets = response._realData?.data || response.data || [];
                        console.log(`[DEBUG] Extracted ${tweets.length} tweets from response`);
                        return { data: tweets, includes: response.includes, meta: response.meta, accountLastTweets };
                    },
                    'tweets/search/recent'
                );

                if (!tweets?.data?.length) {
                    console.log('[DEBUG] No new tweets found');
                    return;
                }

                console.log(`[DEBUG] Found ${tweets.data.length} new tweets total`);

                // Group tweets by author
                const tweetsByAuthor = tweets.data.reduce((acc, tweet) => {
                    if (!acc[tweet.author_id]) {
                        acc[tweet.author_id] = [];
                    }
                    acc[tweet.author_id].push(tweet);
                    return acc;
                }, {});

                // Process tweets for each account
                for (const account of accounts) {
                    const accountTweets = tweetsByAuthor[account.twitter_id] || [];
                    if (accountTweets.length > 0) {
                        console.log(`[DEBUG] Processing ${accountTweets.length} tweets for ${account.username}`);
                        
                        // Process tweets in chronological order (oldest first)
                        const sortedTweets = accountTweets.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                        
                        // If this is the first check, only process the 5 most recent tweets
                        const tweetsToProcess = tweets.accountLastTweets.some(t => t?.last_tweet_id) ? sortedTweets : sortedTweets.slice(-5);
                        console.log(`[DEBUG] Will process ${tweetsToProcess.length} tweets (${tweets.accountLastTweets.some(t => t?.last_tweet_id) ? 'subsequent check' : 'first check, limited to 5'})`);
                        
                        for (const tweet of tweetsToProcess) {
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
                                    }
                                }
                            }
                        }

                        // Update last tweet ID
                        const newestTweet = tweetsToProcess[tweetsToProcess.length - 1];
                        await this.dbRun(
                            'UPDATE monitored_accounts SET last_tweet_id = ? WHERE twitter_id = ?',
                            [newestTweet.id, account.twitter_id]
                        );
                    }
                }
            } catch (error) {
                console.error('[ERROR] Monitoring error:', error);
            }
        }, config.monitoring.interval);

        console.log(`[DEBUG] Monitoring interval set to ${config.monitoring.interval}ms`);
        return true;
    }

    async getMonitoredAccounts() {
        try {
            // Simplified query to get only necessary fields
            return await this.dbAll('SELECT twitter_id, username, monitoring_type, last_tweet_id FROM monitored_accounts');
        } catch (error) {
            console.error('Error getting monitored accounts:', error);
            return [];
        }
    }

    async checkAccount(account) {
        try {
            // Get last tweet ID
            const lastTweet = await this.dbGet(
                'SELECT last_tweet_id FROM monitored_accounts WHERE username = ?',
                [account.username]
            );
            console.log(`[DEBUG] Last tweet ID for ${account.username}: ${lastTweet?.last_tweet_id || 'none'}`);

            // Basic tier optimization: Use tweets/search/recent endpoint
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
                            'in_reply_to_user_id'
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
                        'exclude': ['retweets']
                    };
                    
                    // Only add since_id if we have a valid last tweet ID
                    if (lastTweet?.last_tweet_id) {
                        params.since_id = lastTweet.last_tweet_id;
                    }

                    // Use user_timeline endpoint which has better rate limits for Basic tier
                    return await this.twitter.v2.userTimeline(account.twitter_id, params);
                },
                'users/tweets' // Use correct endpoint identifier for Basic tier
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
        // Simple regex for Solana addresses (this is a basic example)
        const regex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
        return text.match(regex) || [];
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
                const tokenInfo = await this.dexscreener.getTokenInfo(addresses[0]);
                if (tokenInfo) {
                    const tokenEmbed = await this.createTokenEmbed(tokenInfo, 0xFF0000);
                    await channel.send({ embeds: [tweetEmbed, tokenEmbed] });
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

            // Get token information from DexScreener
            const tokenInfo = await this.dexscreener.getTokenInfo(data.address);
            if (!tokenInfo) {
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

            // Create the main tweet embed (matching tweet notification format exactly)
            const tweetEmbed = {
                color: 8388863,
                fields: [],
                footer: {
                    text: "built by keklabs",
                    icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png?ex=67ba8ab2&is=67b93932&hm=d70c81c89b11e25e050324cb10b42b3a5747452d86cc8409ea707f250e02e815&=&format=webp&quality=lossless&width=468&height=468"
                },
                description: `${data.tweet_text}\n\n[View Tweet](${tweetUrl})`,
                author: {
                    icon_url: profileData.profile_image_url || null,
                    name: `${profileData.name || author?.username || 'Unknown'} (@${author?.username || 'unknown'})`,
                    url: `https://twitter.com/${author?.username}`
                },
                timestamp: new Date().toISOString()
            };

            // Create token embed with red color
            const tokenEmbed = await this.createTokenEmbed(tokenInfo, 0xFF0000);

            // Send both embeds
            await channel.send({ embeds: [tweetEmbed, tokenEmbed] });
        } catch (error) {
            console.error('Error sending Solana notification:', error);
        }
    }

    async createTokenEmbed(tokenInfo, color = 0x9945FF) {
        const description = [
            `💰MC: $${this.formatNumber(tokenInfo.marketCap)}`,
            `📊VOL: $${this.formatNumber(tokenInfo.volume24h)}`,
            `💵PRICE: $${parseFloat(tokenInfo.priceUsd).toFixed(6)}`,
            `💧LIQ: $${this.formatNumber(tokenInfo.liquidity)}`,
            `\n[View on DexScreener](${tokenInfo.url})`
        ].join('\n');

        return {
            title: `${tokenInfo.symbol} (${tokenInfo.name})`,
            description: description,
            fields: [],
            author: {
                name: "A Token Was Detected",
                url: tokenInfo.url
            },
            color: color,
            thumbnail: {
                url: tokenInfo.logoUrl || "https://dexscreener.com/favicon.ico"  // Fallback to DexScreener icon if no logo
            }
        };
    }

    // Helper function to format large numbers
    formatNumber(num) {
        if (!num) return 'N/A';
        
        const value = parseFloat(num);
        if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
        if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
        if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
        return value.toFixed(2);
    }

    async handleMonitorCommand(interaction) {
        try {
            console.log('[DEBUG] Starting monitor command execution');
            const username = interaction.options.getString('twitter_id').toLowerCase().replace('@', '');
            const type = interaction.options.getString('type');
            console.log(`[DEBUG] Parameters - Twitter ID: ${username}, Type: ${type}`);

            // Send immediate confirmation
            await interaction.reply({
                embeds: [{
                    title: '⏳ Starting Monitor Setup',
                    description: `Setting up monitoring for @${username}\nType: ${type === 'solana' ? '🔍 Solana Addresses' : '📝 All Tweets'}`,
                    color: 0xFFA500,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png?ex=67ba8ab2&is=67b93932&hm=d70c81c89b11e25e050324cb10b42b3a5747452d86cc8409ea707f250e02e815&=&format=webp&quality=lossless&width=468&height=468'
                    }
                }]
            });

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
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png?ex=67ba8ab2&is=67b93932&hm=d70c81c89b11e25e050324cb10b42b3a5747452d86cc8409ea707f250e02e815&=&format=webp&quality=lossless&width=468&height=468'
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
                                icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png?ex=67ba8ab2&is=67b93932&hm=d70c81c89b11e25e050324cb10b42b3a5747452d86cc8409ea707f250e02e815&=&format=webp&quality=lossless&width=468&height=468'
                            }
                        }]
                    });
                }

                // Get latest tweet to set as starting point
                const tweets = await this.rateLimitManager.scheduleRequest(
                    async () => await this.twitter.v2.userTimeline(userInfo.data.id, {
                        max_results: 5,
                        'tweet.fields': ['created_at']
                    }),
                    'users/tweets'
                );

                // Add to monitoring list
                await this.dbRun(
                    'INSERT INTO monitored_accounts (username, twitter_id, monitoring_type, last_tweet_id, profile_data) VALUES (?, ?, ?, ?, ?)',
                    [
                        username,
                        userInfo.data.id,
                        type,
                        null, // Don't set initial last_tweet_id so we can catch recent tweets
                        JSON.stringify({
                            name: userInfo.data.name,
                            profile_image_url: userInfo.data.profile_image_url
                        })
                    ]
                );

                // Start monitoring if not already running
                if (!this.monitoringInterval) {
                    await this.startMonitoring();
                }

                // Send final success message
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
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png?ex=67ba8ab2&is=67b93932&hm=d70c81c89b11e25e050324cb10b42b3a5747452d86cc8409ea707f250e02e815&=&format=webp&quality=lossless&width=468&height=468'
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
                                icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png?ex=67ba8ab2&is=67b93932&hm=d70c81c89b11e25e050324cb10b42b3a5747452d86cc8409ea707f250e02e815&=&format=webp&quality=lossless&width=468&height=468'
                            }
                        }]
                    });
                }

                throw error;
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
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png?ex=67ba8ab2&is=67b93932&hm=d70c81c89b11e25e050324cb10b42b3a5747452d86cc8409ea707f250e02e815&=&format=webp&quality=lossless&width=468&height=468"
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
                            icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png?ex=67ba8ab2&is=67b93932&hm=d70c81c89b11e25e050324cb10b42b3a5747452d86cc8409ea707f250e02e815&=&format=webp&quality=lossless&width=468&height=468'
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
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png?ex=67ba8ab2&is=67b93932&hm=d70c81c89b11e25e050324cb10b42b3a5747452d86cc8409ea707f250e02e815&=&format=webp&quality=lossless&width=468&height=468"
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
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png?ex=67ba8ab2&is=67b93932&hm=d70c81c89b11e25e050324cb10b42b3a5747452d86cc8409ea707f250e02e815&=&format=webp&quality=lossless&width=468&height=468"
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
                const currentWindow = this.rateLimitManager.state.currentWindow;
                const timeInWindow = (Date.now() - currentWindow.startTime) / 1000;
                results.success.push(`✅ Rate Limit Manager: Active (${currentWindow.requestCount} requests in ${timeInWindow.toFixed(1)}s)`);
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
            console.log('[DEBUG] Starting VIP monitor command execution');
            const username = interaction.options.getString('twitter_id').toLowerCase().replace('@', '');
            
            // Send immediate confirmation
            await interaction.reply({
                embeds: [{
                    title: '⏳ Starting VIP Monitor Setup',
                    description: `Setting up VIP monitoring for @${username}`,
                    color: 0xFFA500,
                    footer: {
                        text: 'built by keklabs',
                        icon_url: 'https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png'
                    }
                }]
            });

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