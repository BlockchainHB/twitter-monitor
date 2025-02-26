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
            smsSubscribers: new Map(),
            channels: {
                tweets: null,
                solana: null,
                vip: null,
                wallets: null
            },
            guild: null,
            trackedWallets: new Map()
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
            
            // Step 1: Login and wait for ready
            console.log('🔄 Logging into Discord...');
            await this.client.login(this.config.discord.token);
            console.log('✅ Login successful');

            // Step 2: Wait for client to be fully ready
            await new Promise((resolve) => {
                if (this.client.isReady()) {
                    resolve();
                } else {
                    this.client.once('ready', () => resolve());
                }
            });
            console.log('✅ Discord client ready');

            // Step 3: Get guild
            this.state.guild = await this.client.guilds.fetch(this.config.discord.guildId);
            if (!this.state.guild) {
                throw new Error('Guild not found');
            }
            console.log('✅ Guild found');

            // Step 4: Store channel references
            this.state.channels = {
                tweets: this.config.discord.channels.tweets,
                solana: this.config.discord.channels.solana,
                vip: this.config.discord.channels.vip,
                wallets: this.config.discord.channels.wallets
            };
            console.log('✅ Channel references stored');

            // Step 5: Setup command handling first
            this.setupCommandHandling();
            console.log('✅ Command handling setup complete');

            // Step 6: Register commands
            try {
                console.log('🔄 Registering slash commands...');
                await this.registerCommands();
                console.log('✅ Commands registered successfully');
            } catch (cmdError) {
                console.error('❌ Error registering commands:', cmdError);
                throw cmdError;
            }

            // Step 7: Start monitoring if there are accounts to monitor
            const accounts = await this.getMonitoredAccounts();
            if (accounts.length > 0) {
                await this.startMonitoring();
                console.log(`✅ Monitoring started for ${accounts.length} accounts`);
            }

            // Step 8: Setup Helius webhook if needed
            await this.setupHeliusWebhook();
            console.log('✅ Helius webhook setup complete');

            console.log('✅ TwitterMonitorBot initialization complete');
        } catch (error) {
            console.error('❌ Error during initialization:', error);
            // Attempt to clean up if initialization fails
            if (this.client) {
                try {
                    await this.client.destroy();
                } catch (destroyError) {
                    console.error('Failed to destroy client during error cleanup:', destroyError);
                }
            }
            throw error;
        }
    }

    // Core data operations using in-memory storage
    async getMonitoredAccounts() {
        return Array.from(this.state.monitoredAccounts.values());
    }

    async addMonitoredAccount(account) {
        this.state.monitoredAccounts.set(account.twitter_id, {
            ...account,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });
    }

    async removeMonitoredAccount(twitterId) {
        return this.state.monitoredAccounts.delete(twitterId);
    }

    async updateLastTweetId(twitterId, lastTweetId) {
        const account = this.state.monitoredAccounts.get(twitterId);
        if (account) {
            account.last_tweet_id = lastTweetId;
            account.updated_at = new Date().toISOString();
            this.state.monitoredAccounts.set(twitterId, account);
        }
    }

    async isTweetProcessed(tweetId) {
        return this.state.processedTweets.has(tweetId);
    }

    async addProcessedTweet(tweet) {
        this.state.processedTweets.set(tweet.id, {
            ...tweet,
            processed_at: new Date().toISOString()
        });
    }

    async addTokenMention(tweetId, tokenAddress) {
        const key = `${tweetId}:${tokenAddress}`;
        if (!this.state.tokenMentions.has(key)) {
            this.state.tokenMentions.set(key, {
                tweet_id: tweetId,
                token_address: tokenAddress,
                created_at: new Date().toISOString()
            });
        }
    }

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
        const subscriber = this.state.smsSubscribers.get(discordUserId);
        if (subscriber) {
            subscriber.is_active = false;
            this.state.smsSubscribers.set(discordUserId, subscriber);
        }
    }

    async getSMSSubscriber(discordUserId) {
        return this.state.smsSubscribers.get(discordUserId);
    }

    async getActiveSMSSubscribers() {
        return Array.from(this.state.smsSubscribers.values())
            .filter(sub => sub.is_active);
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
            // Check if tweet is already processed
            if (await this.isTweetProcessed(tweet.id)) {
                return;
            }

            // Add to processed tweets
            await this.addProcessedTweet(tweet);

            // Extract any Solana addresses from the tweet text
            const addresses = this.extractSolanaAddresses(tweet.text);
            
            // If Solana addresses found, process them regardless of account type
            if (addresses.length > 0) {
                for (const address of addresses) {
                    await this.addTrackedToken(address, tweet.id);
                    await this.addTokenMention(tweet.id, address);
                    
                    // Get token info
                    const tokenInfo = await this.birdeyeService.getTokenInfo(address);
                    if (tokenInfo) {
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

            // Send regular tweet notification if account type is tweet or vip
            if (account.monitor_type === 'tweet' || account.monitor_type === 'vip') {
                await this.sendTweetNotification({
                    ...tweet,
                    includes,
                    is_vip: account.monitor_type === 'vip'
                });
            }

        } catch (error) {
            console.error('[ERROR] Error processing tweet:', error);
            throw error;
        }
    }

    async sendTweetNotification(tweet) {
        try {
            const author = this.state.monitoredAccounts.get(tweet.author_id);
            if (!author) {
                console.error(`Author not found for tweet ${tweet.id}`);
                return;
            }

            // Get appropriate channel based on VIP status
            const channelId = author.is_vip ? this.state.channels.vip : this.state.channels.tweets;
            const channel = this.state.guild.channels.cache.get(channelId);
            if (!channel) {
                console.error('Channel not found in guild');
                return;
            }

            const tweetUrl = `https://twitter.com/${author.username}/status/${tweet.id}`;
            const profileData = JSON.parse(author.profile_data);

            // Create tweet embed
            const tweetEmbed = {
                color: author.is_vip ? 0xFFD700 : 0x1DA1F2,
                description: tweet.text,
                author: {
                    name: `${profileData.name || author.username} (@${author.username})`,
                    icon_url: profileData.profile_image_url || null,
                    url: `https://twitter.com/${author.username}`
                },
                footer: {
                    text: "built by keklabs",
                    icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                },
                timestamp: new Date().toISOString()
            };

            // Check for media
            const imageUrl = this.getMediaUrl(tweet, tweet.includes);
            if (imageUrl) {
                tweetEmbed.image = { url: imageUrl };
            }

            // Check for Solana addresses in the tweet
            const addresses = this.extractSolanaAddresses(tweet.text);
            const embeds = [tweetEmbed];

            // If addresses found, add token embeds
            if (addresses.length > 0) {
                for (const address of addresses) {
                    const tokenInfo = await this.birdeyeService.getTokenInfo(address);
                    if (tokenInfo) {
                        const tokenEmbed = await this.birdeyeService.createTokenEmbed(tokenInfo.address, tokenInfo);
                        embeds.push(tokenEmbed);
                    }
                }
            }

            // Send notification with all embeds
            await channel.send({ 
                content: author.is_vip ? '@everyone New VIP Tweet! 🌟' : null,
                embeds: embeds,
                allowedMentions: { parse: ['everyone'] }
            });

            // Send SMS if enabled and VIP
            if (this.config.twilio.enabled && author.is_vip) {
                const subscribers = await this.getActiveSMSSubscribers();
                for (const subscriber of subscribers) {
                    let smsMessage = `🚨 VIP Tweet Alert!\n@${author.username}: ${tweet.text}\n\n${tweetUrl}`;
                    
                    // Add token info to SMS if present
                    if (addresses.length > 0) {
                        const tokenInfo = await this.birdeyeService.getTokenInfo(addresses[0]);
                        if (tokenInfo) {
                            smsMessage += `\n\nToken Info:\n` +
                                `${tokenInfo.symbol}\n` +
                                `Price: $${this.formatNumber(tokenInfo.priceUsd)}` +
                                (tokenInfo.marketCap ? `\nMC: $${this.formatNumber(tokenInfo.marketCap)}` : '');
                        }
                    }

                    await this.sendSMSAlert(
                        smsMessage,
                        subscriber.phone_number,
                        subscriber.discord_user_id
                    );
                }
            }

        } catch (error) {
            console.error('[ERROR] Error sending tweet notification:', error);
        }
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

            // Get author info from monitored accounts
            const author = this.state.monitoredAccounts.get(data.author_id);
            if (!author) {
                console.error(`Author not found for tweet ${data.tweet_id}`);
                return;
            }

            const profileData = JSON.parse(author.profile_data);
            const tweetUrl = `https://twitter.com/${author.username}/status/${data.tweet_id}`;

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
                    name: `${profileData.name || author.username || 'Unknown'} (@${author.username || 'unknown'})`,
                    url: `https://twitter.com/${author.username}`
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
                if (this.config.twilio.enabled) {
                    const subscribers = await this.getActiveSMSSubscribers();
                    for (const subscriber of subscribers) {
                        // Create a cleaner SMS message with only reliable stats
                        const smsMessage = `🚨 @${author.username} TWEETED A NEW TOKEN!\n\n` +
                            `${tokenInfo.symbol}\n` +
                            `Price: $${this.formatNumber(tokenInfo.priceUsd)}\n` +
                            (tokenInfo.marketCap ? `MC: $${this.formatNumber(tokenInfo.marketCap)}\n` : '') +
                            (tokenInfo.liquidity ? `LP: $${this.formatNumber(tokenInfo.liquidity)}\n` : '') +
                            (tokenInfo.holders ? `Holders: ${this.formatNumber(tokenInfo.holders)}\n` : '') +
                            `\n${tweetUrl}`;

                        await this.sendSMSAlert(
                            smsMessage,
                            subscriber.phone_number,
                            subscriber.discord_user_id
                        );
                    }
                }

            } catch (error) {
                console.error('[ERROR] Error creating token embed:', error);
                // Still send the tweet notification even if token info fails
                await channel.send({ 
                    content: 'New Solana address detected! 🔍',
                    embeds: [tweetEmbed],
                    allowedMentions: { parse: [] }
                });
            }

        } catch (error) {
            console.error('[ERROR] Error sending Solana notification:', error);
        }
    }

    formatNumber(num) {
        if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
        if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
        if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
        return num.toFixed(2);
    }

    setupCommandHandling() {
        console.log('🔄 Setting up command handling...');
        
        this.client.on('interactionCreate', async interaction => {
            if (!interaction.isCommand() || !interaction.guildId) return;
            
            try {
                const commandName = interaction.commandName;
                console.log(`[DEBUG] Received command: ${commandName}`);

                switch (commandName) {
                    case 'monitor':
                        if (!interaction.replied) {
                            await this.handleMonitorCommand(interaction).catch(err => {
                                console.error('[ERROR] Monitor command failed:', err);
                                throw err;
                            });
                        }
                        break;
                    case 'solanamonitor':
                        if (!interaction.replied) {
                            await this.handleSolanaMonitorCommand(interaction).catch(err => {
                                console.error('[ERROR] Solana monitor command failed:', err);
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
                    default:
                        if (!interaction.replied) {
                            await interaction.reply({
                                content: '❌ Unknown command',
                                ephemeral: true
                            });
                        }
                }
            } catch (error) {
                console.error('[ERROR] Command handling error:', error);
                if (!interaction.replied) {
                    await interaction.reply({
                        content: '❌ An error occurred while processing the command',
                        ephemeral: true
                    }).catch(console.error);
                }
            }
        });

        console.log('✅ Command handling setup complete');
    }

    async handleMonitorCommand(interaction) {
        try {
            await interaction.deferReply();
            
            const username = interaction.options.getString('twitter_id').toLowerCase().replace('@', '');

            // Get Twitter user info
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
                        color: 0xFF0000
                    }]
                });
            }

            if (!userInfo?.data) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ Error',
                        description: `Could not find Twitter account @${username}`,
                        color: 0xFF0000
                    }]
                });
            }

            // Check if already monitoring
            const existingAccount = Array.from(this.state.monitoredAccounts.values())
                .find(a => a.twitter_id === userInfo.data.id && a.monitor_type === 'tweets');

            if (existingAccount) {
                return await interaction.editReply({
                    embeds: [{
                        title: 'Already Monitoring',
                        description: `Already monitoring @${username} for tweets`,
                        color: 0x9945FF
                    }]
                });
            }

            // Add account to monitoring
            await this.addMonitoredAccount({
                twitter_id: userInfo.data.id,
                username,
                monitor_type: 'tweets',
                profile_data: JSON.stringify(userInfo.data)
            });

            // Start monitoring if not already running
            if (!this.state.monitoringInterval) {
                await this.startMonitoring();
            }

            return await interaction.editReply({
                embeds: [{
                    title: '✅ Tweet Monitoring Started',
                    description: `Successfully monitoring @${username} for tweets`,
                    color: 0x00FF00
                }]
            });

        } catch (error) {
            console.error('[ERROR] Tweet monitor command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ An error occurred while processing the command",
                    color: 0xFF0000
                }]
            });
        }
    }

    async handleStopMonitorCommand(interaction) {
        try {
            const username = interaction.options.getString('twitter_id').toLowerCase().replace('@', '');

            // Check if account is being monitored
            const account = Array.from(this.state.monitoredAccounts.values())
                .find(a => a.username.toLowerCase() === username);

            if (!account) {
                return await interaction.reply({
                    embeds: [{
                        title: '❌ Account Not Found',
                        description: `@${username} is not currently being monitored.`,
                        color: 0xFF0000
                    }]
                });
            }

            // Remove account from monitoring
            await this.removeMonitoredAccount(account.twitter_id);

            return await interaction.reply({
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
            
            if (!this.config.twilio.enabled) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ SMS Alerts Disabled',
                        description: 'SMS alerts are currently disabled on this bot.',
                        color: 0xFF0000
                    }]
                });
            }

            const phoneNumber = interaction.options.getString('phone');
            const discordUserId = interaction.user.id;

            // Check if user is already subscribed
            const existingSubscriber = this.state.smsSubscribers.get(discordUserId);
            if (existingSubscriber) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ Already Subscribed',
                        description: 'You are already subscribed to SMS alerts.',
                        color: 0xFF0000
                    }]
                });
            }

            // Format phone number - remove any non-numeric characters
            let formattedNumber = phoneNumber.replace(/\D/g, '');
            
            // Add country code if not present
            if (!formattedNumber.startsWith('1')) {
                formattedNumber = '1' + formattedNumber;
            }
            
            // Add + prefix if not present
            if (!formattedNumber.startsWith('+')) {
                formattedNumber = '+' + formattedNumber;
            }

            try {
                // Validate phone number with Twilio
                const validationResult = await this.twilioClient.lookups.v2
                    .phoneNumbers(formattedNumber)
                    .fetch();

                if (!validationResult.valid) {
                    return await interaction.editReply({
                        embeds: [{
                            title: '❌ Invalid Phone Number',
                            description: 'Please provide a valid phone number in E.164 format (e.g., +1XXXXXXXXXX).',
                            color: 0xFF0000
                        }]
                    });
                }

                // Add subscriber
                await this.addSMSSubscriber(discordUserId, formattedNumber);

                // Send test message
                await this.sendSMSAlert(
                    '🎉 Welcome to kek-monitor SMS alerts! You will now receive notifications for VIP tweets.',
                    formattedNumber,
                    discordUserId
                );

                return await interaction.editReply({
                    embeds: [{
                        title: '✅ SMS Alerts Enabled',
                        description: 'You have been successfully subscribed to SMS alerts!\n\nA test message has been sent to your phone.',
                        fields: [
                            {
                                name: 'Phone Number',
                                value: `\`${formattedNumber}\``,
                                inline: true
                            }
                        ],
                        color: 0x00FF00,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });

            } catch (error) {
                console.error('[ERROR] Phone validation error:', error);
                
                let errorMessage = 'Failed to validate phone number. Please try again.';
                if (error.code === 20404) {
                    errorMessage = 'Invalid phone number. Please check the number and try again.';
                } else if (error.code === 20003) {
                    errorMessage = 'Please provide a valid US/Canada phone number (+1XXXXXXXXXX).';
                }

                return await interaction.editReply({
                    embeds: [{
                        title: '❌ Error',
                        description: errorMessage,
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
            }

        } catch (error) {
            console.error('[ERROR] SMS alert command error:', error);
            if (!interaction.replied) {
                await interaction.editReply({
                    embeds: [{
                        title: '❌ Error',
                        description: 'An error occurred while processing your request. Please try again.',
                        color: 0xFF0000
                    }]
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
        try {
            console.log('🔄 Registering application commands...');
            
            const commands = [
                {
                    name: 'monitor',
                    description: 'Monitor a Twitter account for tweets',
                    options: [{
                        name: 'twitter_id',
                        description: 'Twitter username to monitor',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }]
                },
                {
                    name: 'solanamonitor',
                    description: 'Monitor a Twitter account for Solana addresses',
                    options: [{
                        name: 'twitter_id',
                        description: 'Twitter username to monitor for Solana addresses',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }]
                },
                {
                    name: 'vipmonitor',
                    description: 'Monitor a VIP Twitter account',
                    options: [{
                        name: 'twitter_id',
                        description: 'Twitter username to monitor as VIP',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }]
                },
                {
                    name: 'stopm',
                    description: 'Stop monitoring a Twitter account',
                    options: [{
                        name: 'twitter_id',
                        description: 'Twitter username to stop monitoring',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }]
                },
                {
                    name: 'list',
                    description: 'List all monitored accounts'
                },
                {
                    name: 'trackwallet',
                    description: 'Track a Solana wallet',
                    options: [{
                        name: 'address',
                        description: 'Solana wallet address to track',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }]
                },
                {
                    name: 'stopwallet',
                    description: 'Stop tracking a Solana wallet',
                    options: [{
                        name: 'address',
                        description: 'Solana wallet address to stop tracking',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }]
                },
                {
                    name: 'trending',
                    description: 'Get trending tokens',
                    options: [{
                        name: 'timeframe',
                        description: 'Timeframe for trending data',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: '1h', value: '1h' },
                            { name: '6h', value: '6h' },
                            { name: '24h', value: '24h' }
                        ]
                    }]
                },
                {
                    name: 'gainers',
                    description: 'Get top gainers',
                    options: [{
                        name: 'timeframe',
                        description: 'Timeframe for gainers data',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: '1h', value: '1h' },
                            { name: '6h', value: '6h' },
                            { name: '24h', value: '24h' }
                        ]
                    }]
                },
                {
                    name: 'losers',
                    description: 'Get top losers',
                    options: [{
                        name: 'timeframe',
                        description: 'Timeframe for losers data',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: '1h', value: '1h' },
                            { name: '6h', value: '6h' },
                            { name: '24h', value: '24h' }
                        ]
                    }]
                },
                {
                    name: 'newpairs',
                    description: 'Get new trading pairs',
                    options: [{
                        name: 'timeframe',
                        description: 'Timeframe for new pairs data',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: '1h', value: '1h' },
                            { name: '6h', value: '6h' },
                            { name: '24h', value: '24h' }
                        ]
                    }]
                },
                {
                    name: 'volume',
                    description: 'Get volume leaders',
                    options: [{
                        name: 'timeframe',
                        description: 'Timeframe for volume data',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: '1h', value: '1h' },
                            { name: '6h', value: '6h' },
                            { name: '24h', value: '24h' }
                        ]
                    }]
                },
                {
                    name: 'security',
                    description: 'Get token security info',
                    options: [{
                        name: 'address',
                        description: 'Token address to check',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }]
                },
                {
                    name: 'metrics',
                    description: 'Get token metrics',
                    options: [{
                        name: 'address',
                        description: 'Token address to check',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }]
                },
                {
                    name: 'holders',
                    description: 'Get token holder info',
                    options: [{
                        name: 'address',
                        description: 'Token address to check',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }]
                },
                {
                    name: 'smsalert',
                    description: 'Subscribe to SMS alerts',
                    options: [{
                        name: 'phone',
                        description: 'Phone number (E.164 format)',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }]
                },
                {
                    name: 'stopsms',
                    description: 'Unsubscribe from SMS alerts'
                },
                {
                    name: 'test',
                    description: 'Test notifications'
                },
                {
                    name: 'help',
                    description: 'Show help information'
                }
            ];

            // Register commands with Discord
            if (!this.state.guild) {
                throw new Error('Guild not found during command registration');
            }

            await this.state.guild.commands.set(commands);
            console.log('✅ Application commands registered successfully');
        } catch (error) {
            console.error('❌ Error registering commands:', error);
            throw error;
        }
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
            
            // Get all monitored wallets from state
            const wallets = Array.from(this.state.trackedWallets?.values() || []);
            const accountAddresses = wallets.map(w => w.wallet_address);
            
            if (accountAddresses.length === 0) {
                console.log('ℹ️ No wallets to monitor');
                return;
            }

            // Check for existing webhook
            const webhooks = await this.helius.listWebhooks();
            let webhook = webhooks.find(w => w.webhookURL === this.config.helius.webhookUrl);

            if (webhook) {
                // Update existing webhook with current wallet list
                console.log('📝 Updating existing webhook...');
                await this.helius.updateWebhook(webhook.webhookId, accountAddresses);
                // Store webhook info in state
                this.state.heliusWebhook = {
                    webhookId: webhook.webhookId,
                    webhookUrl: this.config.helius.webhookUrl
                };
            } else {
                // Create new webhook
                console.log('🆕 Creating new webhook...');
                webhook = await this.helius.createWebhook(this.config.helius.webhookUrl, accountAddresses);
                // Store webhook info in state
                this.state.heliusWebhook = {
                    webhookId: webhook.webhookId,
                    webhookUrl: this.config.helius.webhookUrl
                };
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
            
            const wallet = interaction.options.getString('address');
            const discordUserId = interaction.user.id;
            
            // Check if wallet is already being tracked
            const existingWallet = Array.from(this.state.trackedWallets.values())
                .find(w => w.address === wallet);
            
            if (existingWallet) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ Wallet Already Tracked',
                        description: `This wallet is already being tracked`,
                        color: 0xFF0000,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        }
                    }]
                });
            }
            
            // Add wallet to tracked wallets
            this.state.trackedWallets.set(wallet, {
                address: wallet,
                discord_user_id: discordUserId,
                added_at: new Date().toISOString()
            });
            
            // Sync updated wallet list with Helius
            try {
                await this.helius.syncWallets(this.config.helius.webhookUrl);
                
                await interaction.editReply({
                    embeds: [{
                        title: '✅ Wallet Tracking Started',
                        description: `Now tracking wallet:\n\`${wallet}\``,
                        color: 0x00FF00,
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        } catch (error) {
            console.error('[ERROR] Failed to sync wallets with Helius:', error);
            
            // Remove wallet if Helius sync fails
            this.state.trackedWallets.delete(wallet);
            
            await interaction.editReply({
                embeds: [{
                    title: '❌ Tracking Setup Failed',
                    description: 'Failed to set up wallet tracking. Please verify the wallet address and try again.',
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        }

    } catch (error) {
        console.error('[ERROR] Track wallet command error:', error);
        await interaction.editReply({
            embeds: [{
                title: '❌ Error',
                description: 'An error occurred while processing your request. Please try again.',
                color: 0xFF0000,
                footer: {
                    text: "built by keklabs",
                    icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                }
            }]
        });
    }
}

    // Handle webhook events from Helius
    async handleWebhook(data) {
        if (!data || !data.events || !Array.isArray(data.events)) {
            console.log('[DEBUG] Invalid webhook data received');
                    return;
                }

        console.log(`[DEBUG] Processing ${data.events.length} webhook events`);

        for (const event of data.events) {
            try {
                const swapData = this.helius.parseSwapTransaction(event);
                if (!swapData) continue;

                // Check if swap value meets minimum threshold
                if (swapData.usdValue < this.config.helius.minSwapValue) {
                    console.log(`[DEBUG] Skipping swap with value $${swapData.usdValue} (below minimum ${this.config.helius.minSwapValue})`);
                    continue;
                }

                await this.handleWalletNotification(swapData);
        } catch (error) {
                console.error('[ERROR] Error processing webhook event:', error);
            }
        }
    }

    async testNotifications(interaction) {
        try {
            await interaction.deferReply();

            // Test Discord channel access
            const channels = [
                { name: 'Tweets', id: this.state.channels.tweets },
                { name: 'Solana', id: this.state.channels.solana },
                { name: 'VIP', id: this.state.channels.vip },
                { name: 'Wallets', id: this.state.channels.wallets }
            ];

            const results = [];
            for (const channel of channels) {
                try {
                    const discordChannel = this.state.guild.channels.cache.get(channel.id);
                    if (!discordChannel) {
                        results.push(`❌ ${channel.name}: Channel not found`);
                        continue;
                    }

                    await discordChannel.send({
                        embeds: [{
                            title: '🧪 Test Message',
                            description: 'This is a test notification. If you can see this, notifications are working!',
                            color: 0x00FF00,
                            footer: {
                                text: "built by keklabs",
                                icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                            }
                        }]
                    });
                    results.push(`✅ ${channel.name}: Message sent successfully`);
                } catch (error) {
                    results.push(`❌ ${channel.name}: ${error.message}`);
                }
            }

            // Test SMS if enabled
            let smsResult = '⏭️ SMS: Not configured';
            if (this.config.twilio.enabled) {
                try {
                    const subscriber = await this.getSMSSubscriber(interaction.user.id);
                    if (subscriber) {
                        const sent = await this.sendSMSAlert(
                            'This is a test SMS notification from Twitter Monitor Bot.',
                            subscriber.phone_number,
                            interaction.user.id
                        );
                        smsResult = sent ? '✅ SMS: Test message sent' : '❌ SMS: Failed to send';
                    } else {
                        smsResult = '❌ SMS: No subscription found';
                    }
                } catch (error) {
                    smsResult = `❌ SMS: ${error.message}`;
                }
            }

            // Send test results
            await interaction.editReply({
                embeds: [{
                    title: '🧪 Test Results',
                    description: [...results, '', smsResult].join('\n'),
                    color: results.every(r => r.includes('✅')) ? 0x00FF00 : 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
        } catch (error) {
            console.error('[ERROR] Test command error:', error);
            await interaction.editReply({
                embeds: [{
                    title: "Test Failed",
                    description: `❌ Error running tests: ${error.message}`,
                    color: 0xFF0000,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });
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
                console.log('[DEBUG] Getting last tweet IDs for batch search...');
                const accountLastTweets = accounts.map(account => ({
                    last_tweet_id: account.last_tweet_id
                }));

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
                const now = new Date().toISOString();
                accounts.forEach(account => {
                    account.last_check_time = now;
                    this.state.monitoredAccounts.set(account.twitter_id, account);
                });

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

                    // Update last tweet IDs
                    console.log('[DEBUG] Updating last tweet IDs...');
                    for (const [authorId, authorTweets] of Object.entries(tweetsByAuthor)) {
                        if (authorTweets.length > 0) {
                            const newestTweet = authorTweets[authorTweets.length - 1];
                            await this.updateLastTweetId(authorId, newestTweet.id);
                        }
                    }
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
        }, this.config.monitoring.interval);

        console.log(`[DEBUG] Monitoring interval set to ${this.config.monitoring.interval}ms`);
        return true;
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

            for (const tweet of sortedTweets) {
                const account = accounts.find(a => a.twitter_id === tweet.author_id);
                if (!account) continue;

                console.log(`[DEBUG] Processing tweet ${tweet.id} from @${account.username}`);

                // Check if tweet already processed
                if (await this.isTweetProcessed(tweet.id)) {
                    console.log(`[DEBUG] Tweet ${tweet.id} already processed, skipping`);
                    continue;
                }

                // Add to processed tweets
                await this.addProcessedTweet({
                    ...tweet,
                    author: account,
                    type: this.getTweetType(tweet)
                });

                // Process notifications based on monitoring type
                if (account.monitor_type === 'solana' || account.monitor_type === 'vip') {
                    const addresses = this.extractSolanaAddresses(tweet.text);
                    if (addresses.length > 0) {
                        for (const address of addresses) {
                            await this.addTrackedToken(address, tweet.id);
                            await this.addTokenMention(tweet.id, address);
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

                if (account.monitor_type === 'tweet' || account.monitor_type === 'vip') {
                    await this.sendTweetNotification({
                        ...tweet,
                        includes,
                        is_vip: account.monitor_type === 'vip'
                    });
                }
            }

            console.log('[DEBUG] Tweet processing completed successfully');
            return true;

        } catch (error) {
            console.error('[ERROR] Error in batch tweet processing:', error);
            throw error;
        }
    }

    getTweetType(tweet) {
        if (tweet.referenced_tweets?.length > 0) {
            const refTweet = tweet.referenced_tweets[0];
            switch (refTweet.type) {
                case 'replied_to': return 'reply';
                case 'quoted': return 'quote';
                case 'retweeted': return 'retweet';
                default: return 'tweet';
            }
        }
        return 'tweet';
    }

    async handleSolanaMonitorCommand(interaction) {
        try {
            await interaction.deferReply();
            
            const username = interaction.options.getString('twitter_id').toLowerCase().replace('@', '');

            // Get Twitter user info
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
                        color: 0xFF0000
                    }]
                });
            }

            if (!userInfo?.data) {
                return await interaction.editReply({
                    embeds: [{
                        title: '❌ Error',
                        description: `Could not find Twitter account @${username}`,
                        color: 0xFF0000
                    }]
                });
            }

            // Check if already monitoring
            const existingAccount = Array.from(this.state.monitoredAccounts.values())
                .find(a => a.twitter_id === userInfo.data.id && a.monitor_type === 'solana');

            if (existingAccount) {
                return await interaction.editReply({
                    embeds: [{
                        title: 'Already Monitoring',
                        description: `Already monitoring @${username} for Solana addresses`,
                        color: 0x9945FF
                    }]
                });
            }

            // Add account to monitoring
            await this.addMonitoredAccount({
                twitter_id: userInfo.data.id,
                username,
                monitor_type: 'solana',
                profile_data: JSON.stringify(userInfo.data)
            });

            // Start monitoring if not already running
            if (!this.state.monitoringInterval) {
                await this.startMonitoring();
            }

            return await interaction.editReply({
                embeds: [{
                    title: '✅ Solana Address Monitoring Started',
                    description: `Successfully monitoring @${username} for Solana addresses`,
                    color: 0x00FF00,
                    footer: {
                        text: "built by keklabs",
                        icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                    }
                }]
            });

        } catch (error) {
            console.error('[ERROR] Solana monitor command error:', error);
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
} // End of class TwitterMonitorBot

module.exports = TwitterMonitorBot;