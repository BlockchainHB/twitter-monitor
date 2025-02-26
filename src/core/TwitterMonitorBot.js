const { TwitterApi } = require('twitter-api-v2');
const { Client, GatewayIntentBits, ApplicationCommandOptionType, ChannelType } = require('discord.js');
const RateLimitManager = require('./RateLimitManager');
const DexScreenerService = require('./DexScreenerService');
const BirdeyeService = require('./BirdeyeService');
const twilio = require('twilio');
const HeliusService = require('./HeliusService');
const path = require('path');
const fs = require('fs');

class TwitterMonitorBot {
    constructor(dependencies) {
        this.validateDependencies(dependencies);
        
        // Store core dependencies
        this.client = dependencies.client;
        this.heliusService = dependencies.heliusService;
        this.birdeyeService = dependencies.birdeyeService;
        
        // Initialize in-memory state
        this.monitoredAccounts = new Map();
        this.trackedWallets = new Map();
        this.smsSubscribers = new Map();
        this.processedTweets = new Set();

        // Initialize Twilio if credentials exist
        if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
            const twilio = require('twilio');
            this.twilioClient = twilio(
                process.env.TWILIO_ACCOUNT_SID,
                process.env.TWILIO_AUTH_TOKEN
            );
            console.debug('Twilio client initialized');
        }

        // Store config
        this.config = dependencies.config;
        
        // Initialize channel properties as null
        this.tweetsChannel = null;
        this.vipChannel = null;
        this.walletsChannel = null;
        this.solanaChannel = null;
    }

    validateDependencies(deps) {
        if (!deps.client) throw new Error('Discord client required');
        if (!deps.heliusService) throw new Error('HeliusService required');
        if (!deps.birdeyeService) throw new Error('BirdeyeService required');
        if (!deps.config) throw new Error('Config required');
    }

    async start() {
        try {
            console.log('Starting Twitter Monitor Bot...');
            
            // Login to Discord
            await this.client.login(this.config.discordToken);
            console.log('✅ Logged into Discord');

            // Set up commands
            await this.setupCommandHandling();
            await this.registerCommands();
            console.log('✅ Commands registered');

            // Load tracked wallets from file
            await this.loadTrackedWallets();
            console.log('✅ Tracked wallets loaded');

            // Test channel access
            await this.testChannelAccess();
            console.log('✅ Channel access verified');

            // Start monitoring systems
            await this.startMonitoring();
            console.log('✅ Monitoring systems started');

            console.log('🤖 Bot is ready!');
        } catch (error) {
            console.error('Failed to start bot:', error);
            throw error;
        }
    }

    async testChannelAccess() {
        try {
            const guild = await this.client.guilds.fetch(this.config.guildId);
            
            this.tweetsChannel = await guild.channels.fetch(this.config.tweetsChannelId);
            this.vipChannel = await guild.channels.fetch(this.config.vipChannelId);
            this.walletsChannel = await guild.channels.fetch(this.config.walletsChannelId);
            this.solanaChannel = await guild.channels.fetch(this.config.solanaChannelId);
            
            console.log('All channels accessed successfully');
        } catch (error) {
            console.error('Failed to access channels:', error);
            throw new Error('Channel access failed - please check channel IDs and bot permissions');
        }
    }

    async initialize() {
        try {
            console.log('🚀 Initializing TwitterMonitorBot...');
            
            // Load wallets first
            await this.heliusService.loadWalletsFromJson();
            
            console.log('🔄 Logging into Discord...');
            await this.client.login(process.env.DISCORD_TOKEN);
            
            console.log('🔄 Starting initialization process...');
            
            // Set up commands first
            await this.setupCommandHandling();
            await this.registerCommands();

            // Then validate channel access
            await this.testChannelAccess();

            // Load wallets and setup webhook
            console.log('[DEBUG] Loading tracked wallets...');
            await this.loadTrackedWallets();
            
            if (this.state.trackedWallets.size > 0) {
                console.log('[DEBUG] Setting up Helius webhook...');
                await this.setupHeliusWebhook();
                console.log(`[DEBUG] Helius webhook configured for ${this.state.trackedWallets.size} wallets`);
            }

            // Start monitoring systems
            this.startMonitoring();
            this.startWalletMonitoring();

            console.log('[DEBUG] Initialization complete');
        } catch (error) {
            console.error('❌ Error during initialization:', error);
            throw error;
        }
    }

    async getMonitoredAccounts() {
        return Array.from(this.state.monitoredAccounts.values());
    }

    async addMonitoredAccount(account) {
        this.state.monitoredAccounts.set(account.id, {
            ...account,
            lastTweetId: null,
            isVIP: false
        });
        return true;
    }

    async removeMonitoredAccount(twitterId) {
        return this.state.monitoredAccounts.delete(twitterId);
    }

    async updateLastTweetId(twitterId, lastTweetId) {
        const account = this.state.monitoredAccounts.get(twitterId);
        if (account) {
            account.lastTweetId = lastTweetId;
            this.state.monitoredAccounts.set(twitterId, account);
        }
    }

    async isTweetProcessed(tweetId) {
        return this.state.processedTweets.has(tweetId);
    }

    async addProcessedTweet(tweet) {
        this.state.processedTweets.add(tweet.id);
    }

    async addTokenMention(tweetId, tokenAddress) {
        if (!this.state.tokenMentions) {
            this.state.tokenMentions = new Map();
        }
        this.state.tokenMentions.set(tweetId, tokenAddress);
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

    async addSMSSubscriber(discordUserId, phoneNumber) {
        this.state.smsSubscribers.set(discordUserId, {
            phone: phoneNumber,
            discord_user_id: discordUserId
        });
        return true;
    }

    async removeSMSSubscriber(discordUserId) {
        return this.state.smsSubscribers.delete(discordUserId);
    }

    async getSMSSubscriber(discordUserId) {
        return this.state.smsSubscribers.get(discordUserId);
    }

    async getActiveSMSSubscribers() {
        return Array.from(this.state.smsSubscribers.values());
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
            // Check if tweet was already processed
            if (await this.isTweetProcessed(tweet.id)) {
                return;
            }

            // Extract Solana addresses from tweet text
            const solanaAddresses = this.extractSolanaAddresses(tweet.text);
            let contractFound = false;

            // Process Solana contracts if found
            if (solanaAddresses.length > 0) {
                for (const address of solanaAddresses) {
                    try {
                        // Let Birdeye validate and get token info
                                    const tokenInfo = await this.birdeyeService.getTokenInfo(address);
                                    if (tokenInfo) {
                            contractFound = true;
                            // Store token mention
                            await this.addTokenMention(tweet.id, address);
                            
                            // Send contract notification with token info
                                await this.sendSolanaNotification({
                                tweet,
                                account,
                                            includes,
                                tokenInfo,
                                address
                            });

                            // Send SMS alerts for contract detection
                            const smsSubscribers = await this.getActiveSMSSubscribers();
                            for (const subscriber of smsSubscribers) {
                                await this.sendSMSAlert(
                                    `🔔 New Solana contract detected in tweet from ${account.username}!\n${tokenInfo.symbol}: $${this.formatNumber(tokenInfo.price)}`,
                                    subscriber.phone,
                                    subscriber.discord_user_id
                                );
                            }
                        }
                    } catch (error) {
                        console.error(`Error processing Solana address ${address}:`, error);
                    }
                }
            }

            // Send regular tweet notification
            await this.sendTweetNotification(tweet, account, includes);

            // Send SMS for VIP tweets
            if (account.isVIP) {
                const smsSubscribers = await this.getActiveSMSSubscribers();
                for (const subscriber of smsSubscribers) {
                    await this.sendSMSAlert(
                        `🔔 New VIP tweet from ${account.username}!`,
                        subscriber.phone,
                        subscriber.discord_user_id
                    );
                }
            }

            // Mark tweet as processed and update last tweet ID
            await this.addProcessedTweet(tweet);
            await this.updateLastTweetId(account.id, tweet.id);

            } catch (error) {
            console.error('Error processing tweet:', error);
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
        const { tweet, account, includes, tokenInfo, address } = data;

        const embed = {
            title: '🔥 Solana Contract Detected',
            description: `Contract mentioned by ${account.username}`,
            fields: [
                {
                    name: '💰 Token Info',
                    value: [
                        `Symbol: ${tokenInfo.symbol}`,
                        `Price: $${this.formatNumber(tokenInfo.price)}`,
                        `Market Cap: $${this.formatNumber(tokenInfo.marketCap)}`,
                        `Liquidity: $${this.formatNumber(tokenInfo.liquidity)}`,
                        `Holders: ${this.formatNumber(tokenInfo.holders)}`,
                        `\n[📈 View Chart](https://dexscreener.com/solana/${address})`
                    ].join('\n'),
                    inline: false
                },
                {
                    name: '🔗 Links',
                    value: `[Tweet](https://twitter.com/${account.username}/status/${tweet.id})\n[Contract](https://solscan.io/token/${address})`,
                    inline: false
                }
            ],
            color: 0xFF0000,
                timestamp: new Date().toISOString()
            };

        // Send to appropriate channels with @everyone for contract detection
        if (this.channels.solana) {
            await this.channels.solana.send({
                content: '@everyone New Solana contract detected! 🚨',
                embeds: [embed],
                    allowedMentions: { parse: ['everyone'] }
                });
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
                            await this.handleVIPMonitorCommand(interaction).catch(err => {
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
            const username = interaction.options.getString('username');
            if (!username) {
                await interaction.reply('Please provide a Twitter username to monitor.');
                return;
            }

            await interaction.deferReply();
            
            const account = await this.twitterRateLimitManager.scheduleRequest(
                async () => {
                    const user = await this.twitter.v2.userByUsername(username);
                    return user.data;
                },
                'users/by/username'
            );

            if (!account) {
                await interaction.editReply('Could not find that Twitter account.');
                return;
            }

            // Add to monitored accounts and perform initial tweet fetch
            await this.addMonitoredAccount(account);

            await interaction.editReply(`✅ Now monitoring @${account.username}'s tweets!`);
        } catch (error) {
            console.error('Error handling monitor command:', error);
            await interaction.editReply('Failed to set up monitoring for that account.');
        }
    }

    async handleSolanaMonitorCommand(interaction) {
        try {
            await interaction.deferReply();
            const account = interaction.options.getString('account');

            // Validate account
            const accountData = await this.checkAccount(account);
            if (!accountData) {
                await interaction.editReply('❌ Invalid Twitter account. Please check the username and try again.');
                return;
            }

            // Store account with type 'solana'
            await this.addMonitoredAccount({
                id: accountData.id,
                username: accountData.username,
                monitor_type: 'solana',
                last_tweet_id: null
            });

            await interaction.editReply(`✅ Now monitoring Solana-related tweets from @${accountData.username}`);
            console.log(`[DEBUG] Added monitored account: ${accountData.username} (type: solana)`);

        } catch (error) {
            console.error('[ERROR] Solana monitor command error:', error);
            await interaction.editReply('❌ Failed to start monitoring. Please try again.');
        }
    }

    async handleVIPMonitorCommand(interaction) {
        try {
            const username = interaction.options.getString('username');
            if (!username) {
                await interaction.reply('Please provide a Twitter username to monitor.');
                return;
            }

            await interaction.deferReply();

            const account = await this.twitterRateLimitManager.scheduleRequest(
                async () => {
                    const user = await this.twitter.v2.userByUsername(username);
                    return user.data;
                },
                'users/by/username'
            );

            if (!account) {
                await interaction.editReply('Could not find that Twitter account.');
                return;
            }

            // Add to monitored accounts with VIP flag
            await this.addMonitoredAccount({
                ...account,
                isVIP: true
            });

            await interaction.editReply(`✅ Now monitoring @${account.username}'s tweets as VIP!`);
        } catch (error) {
            console.error('Error handling VIP monitor command:', error);
            await interaction.editReply('Failed to set up VIP monitoring for that account.');
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
            
            if (!this.twilio || !this.twilioPhone) {
                await interaction.editReply('❌ SMS alerts are not configured. Please contact the administrator.');
                return;
            }

            const phone = interaction.options.getString('phone');
            const userId = interaction.user.id;

            // Store in memory
            this.state.smsSubscribers.set(userId, {
                phone: phone,
                discord_id: userId
            });

            // Send test message
            await this.sendSMSAlert('🔔 SMS alerts configured successfully! You will now receive notifications for high-value transactions.', phone);

            await interaction.editReply('✅ SMS alerts configured successfully! You should receive a test message shortly.');
            console.log(`[DEBUG] Added SMS subscriber: ${userId} with phone: ${phone}`);

        } catch (error) {
            console.error('[ERROR] SMS alert command error:', error);
            await interaction.editReply('❌ Failed to configure SMS alerts. Please try again.');
        }
    }

    async handleStopSMSCommand(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });
            const phone = interaction.options.getString('phone');

            // Remove from in-memory state
            let removed = false;
            for (const [userId, data] of this.state.smsSubscribers.entries()) {
                if (data.phone === phone) {
                    this.state.smsSubscribers.delete(userId);
                    removed = true;
                    break;
                }
            }

            if (removed) {
                await interaction.editReply('✅ Successfully unsubscribed from SMS alerts.');
                console.log(`[DEBUG] Removed SMS subscription for phone: ${phone}`);
            } else {
                await interaction.editReply('❌ No SMS subscription found for this phone number.');
            }

        } catch (error) {
            console.error('[ERROR] Stop SMS command error:', error);
            await interaction.editReply('❌ Failed to unsubscribe from SMS alerts. Please try again.');
        }
    }

    async testNotifications(interaction) {
        try {
            await interaction.deferReply();
            
            // Test services status
            const services = [];
            
            // Test Discord
            services.push('💬 Discord: Connected');
            
            // Test SMS
            if (this.twilio && this.twilioPhone) {
                services.push('📱 SMS: Configured');
            } else {
                services.push('📱 SMS: Not configured');
            }

            // Format response
            const response = [
                '📊 Services:',
                ...services
            ].join('\n');

            await interaction.editReply(response);

        } catch (error) {
            console.error('[ERROR] Test notification error:', error);
            await interaction.editReply('❌ Error testing notifications');
        }
    }

    async sendSMSAlert(message, phone, discord_user_id = null) {
        try {
            if (!this.twilio || !this.twilioPhone) {
                console.error('[ERROR] Twilio not configured');
                    return false;
            }

            await this.twilio.messages.create({
                body: message,
                from: this.twilioPhone,
                to: phone
            });

            console.log(`[DEBUG] SMS alert sent to ${phone}`);
            return true;
        } catch (error) {
            console.error('[ERROR] Failed to send SMS alert:', error);
            return false;
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
                        await this.handleVIPMonitorCommand(interaction).catch(err => {
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
            console.log('[DEBUG] Setting up Helius webhook...');

            // Get all tracked wallets
            const walletAddresses = Array.from(this.state.trackedWallets.keys());
            if (walletAddresses.length === 0) {
                console.log('[DEBUG] No wallets to track, skipping webhook setup');
                return;
            }

            console.log(`[DEBUG] Found ${walletAddresses.length} wallets to track`);

            // Get existing webhooks
            const webhooks = await this.helius.getWebhooks();
            console.log('[DEBUG] Current webhooks:', JSON.stringify(webhooks, null, 2));

            let webhook = webhooks.find(w => w.webhookURL === this.config.helius.webhookUrl);

            if (webhook) {
                console.log('[DEBUG] Updating existing webhook...');
                webhook = await this.helius.updateWebhook({
                    webhookID: webhook.webhookID,
                    accountAddresses: walletAddresses,
                    transactionTypes: ['ANY'],
                    webhookURL: this.config.helius.webhookUrl,
                    authHeader: this.config.helius.authHeader
                });
            } else {
                console.log('[DEBUG] Creating new webhook...');
                webhook = await this.helius.createWebhook({
                    accountAddresses: walletAddresses,
                    transactionTypes: ['ANY'],
                    webhookURL: this.config.helius.webhookUrl,
                    authHeader: this.config.helius.authHeader
                });
            }

            console.log('[DEBUG] Webhook setup complete:', JSON.stringify(webhook, null, 2));

            // Verify webhook is active
            const activeWebhooks = await this.helius.getWebhooks();
            const isActive = activeWebhooks.some(w => w.webhookID === webhook.webhookID && w.active);
            
            if (!isActive) {
                throw new Error('Webhook was created but is not active');
            }

            console.log('[SUCCESS] Helius webhook is active and monitoring wallets');
            return webhook;

        } catch (error) {
            console.error('[ERROR] Failed to setup Helius webhook:', error);
            throw error;
        }
    }

    // Remove the polling-based monitorWallets method since we're using webhooks now
    startWalletMonitoring() {
        const walletCount = this.state.trackedWallets.size;
        console.log(`[DEBUG] Wallet monitoring active - ${walletCount} wallets configured`);
        console.log('[DEBUG] Webhook endpoint ready for Helius notifications');
    }

    async handleTrackWalletCommand(interaction) {
        try {
            const address = interaction.options.getString('address');
            const name = interaction.options.getString('name');

            if (!this.heliusService.isValidSolanaAddress(address)) {
                await interaction.reply('Please provide a valid Solana wallet address.');
                return;
            }

            // Store in memory
            this.state.trackedWallets.set(address, {
                address,
                name: name || address.slice(0, 4) + '...' + address.slice(-4),
                added_by: interaction.user.id
            });

            // Update Helius service wallet name mapping
            this.heliusService.setWalletName(address, name || address.slice(0, 4) + '...' + address.slice(-4));

            await interaction.reply(`✅ Now tracking wallet: ${name || address}`);
        } catch (error) {
            console.error('Error handling track wallet command:', error);
            await interaction.reply('Failed to track wallet.');
        }
    }

    async handleStopWalletCommand(interaction) {
        try {
            const address = interaction.options.getString('address');

            if (!this.state.trackedWallets.has(address)) {
                await interaction.reply('This wallet is not being tracked.');
                return;
            }

            // Remove from memory
            this.state.trackedWallets.delete(address);

            await interaction.reply(`✅ Stopped tracking wallet: ${address}`);
        } catch (error) {
            console.error('Error handling stop wallet command:', error);
            await interaction.reply('Failed to stop tracking wallet.');
        }
    }

    // Handle webhook events from Helius
    async handleWebhook(data) {
        try {
            console.log('[DEBUG] Received Helius webhook data:', JSON.stringify(data, null, 2));

            // Get the wallet channel
            const channel = this.state.channels.wallets;
            if (!channel) {
                console.error('[ERROR] Wallet notification channel not found');
                    return;
                }

            // Process each transaction
            for (const transaction of data) {
                try {
                    // Get wallet info from tracked wallets
                    const wallet = this.state.trackedWallets.get(transaction.accountData.account);
                    if (!wallet) {
                        console.log('[DEBUG] Transaction for untracked wallet:', transaction.accountData.account);
                        continue;
                    }

                    // Calculate total USD value
                    let totalUsdValue = 0;
                    let isStablecoinPurchase = false;
                    
                    // Add SOL value if present
                    if (transaction.amount && transaction.nativeTransfers) {
                        const solPrice = await this.helius.getSolanaPrice();
                        totalUsdValue += transaction.amount * solPrice;
                    }

                    // Add token transfer value if present
                    if (transaction.tokenTransfers?.length > 0) {
                        for (const transfer of transaction.tokenTransfers) {
                            if (transfer.tokenPrice) {
                                totalUsdValue += transfer.tokenAmount * transfer.tokenPrice;
                            }
                            
                            // Check if this is a stablecoin purchase
                            const stablecoins = ['USDC', 'USDT', 'DAI', 'BUSD'];
                            if (stablecoins.includes(transfer.tokenSymbol?.toUpperCase())) {
                                isStablecoinPurchase = true;
                            }
                        }
                    }

                    // Skip if it's a stablecoin purchase
                    if (isStablecoinPurchase) {
                        console.log('[DEBUG] Skipping stablecoin purchase transaction');
                    continue;
                }

                    // Skip if value is under $100 (unless it's a VIP wallet) - removed for testing
                    /*if (totalUsdValue < 100 && !wallet.is_vip) {
                        console.log('[DEBUG] Skipping low value transaction: $' + totalUsdValue);
                        continue;
                    }*/

                    // Create transaction embed
                    const embed = {
                        title: totalUsdValue >= 1000 ? '🔥 High Value Transaction' : '🔔 New Transaction',
                        description: `Activity detected for wallet:\n\`${transaction.accountData.account}\``,
                        color: totalUsdValue >= 1000 ? 0xFF0000 : 0x9945FF,
                        fields: [
                            {
                                name: 'Transaction Type',
                                value: transaction.type || 'Unknown',
                                inline: true
                            }
                        ],
                        footer: {
                            text: "built by keklabs",
                            icon_url: "https://media.discordapp.net/attachments/1337565019218378864/1342687517719269489/ddd006d6-fef8-46c4-83eb-5faa63887089.png"
                        },
                        timestamp: new Date().toISOString()
                    };

                    // Add SOL amount if present
                    if (transaction.amount) {
                        embed.fields.push({
                            name: 'SOL Amount',
                            value: `${this.formatNumber(transaction.amount)} SOL`,
                            inline: true
                        });
                    }

                    // Add USD value
                    embed.fields.push({
                        name: 'Estimated Value',
                        value: `$${this.formatNumber(totalUsdValue)}`,
                        inline: true
                    });

                    // Add transaction URL
                    if (transaction.signature) {
                        embed.description += `\n\n[View Transaction](https://solscan.io/tx/${transaction.signature})`;
                    }

                    // Add token info if available
                    if (transaction.tokenTransfers?.length > 0) {
                        const tokenTransfer = transaction.tokenTransfers[0];
                        
                        // Get enhanced token info from Birdeye
                        let tokenInfo = null;
                        try {
                            tokenInfo = await this.birdeyeService.getTokenInfo(tokenTransfer.mint);
                        } catch (error) {
                            console.error('[ERROR] Failed to fetch Birdeye data:', error);
                        }
                        
                        // Add token info fields
                        const tokenFields = [
                            {
                                name: 'Token',
                                value: tokenTransfer.tokenName || 'Unknown Token',
                                inline: true
                            },
                            {
                                name: 'Token Amount',
                                value: `${this.formatNumber(tokenTransfer.tokenAmount)} ${tokenTransfer.tokenSymbol || ''}`,
                                inline: true
                            }
                        ];
                        
                        // Add Birdeye metrics if available
                        if (tokenInfo) {
                            if (tokenInfo.marketCap) tokenFields.push({
                                name: 'Market Cap',
                                value: `$${this.formatNumber(tokenInfo.marketCap)}`,
                                inline: true
                            });
                            if (tokenInfo.liquidity) tokenFields.push({
                                name: 'Liquidity',
                                value: `$${this.formatNumber(tokenInfo.liquidity)}`,
                                inline: true
                            });
                            if (tokenInfo.holders) tokenFields.push({
                                name: 'Holders',
                                value: this.formatNumber(tokenInfo.holders),
                                inline: true
                            });
                            if (tokenInfo.volume24h) tokenFields.push({
                                name: '24h Volume',
                                value: `$${this.formatNumber(tokenInfo.volume24h)}`,
                                inline: true
                            });
                            
                            // Add price change metrics
                            if (tokenInfo.priceChange1h) tokenFields.push({
                                name: '1h Change',
                                value: `${tokenInfo.priceChange1h > 0 ? '📈' : '📉'} ${tokenInfo.priceChange1h.toFixed(2)}%`,
                                inline: true
                            });
                            if (tokenInfo.priceChange24h) tokenFields.push({
                                name: '24h Change',
                                value: `${tokenInfo.priceChange24h > 0 ? '📈' : '📉'} ${tokenInfo.priceChange24h.toFixed(2)}%`,
                                inline: true
                            });
                            
                            // Add trading activity metrics
                            if (tokenInfo.trades24h && tokenInfo.buys24h) {
                                const buyRatio = ((tokenInfo.buys24h / tokenInfo.trades24h) * 100).toFixed(1);
                                tokenFields.push({
                                    name: 'Buy Pressure',
                                    value: `${buyRatio}% (${tokenInfo.buys24h}/${tokenInfo.trades24h} trades)`,
                                    inline: true
                                });
                            
                            // Add unique wallet activity
                            if (tokenInfo.uniqueWallets24h) tokenFields.push({
                                name: 'Active Wallets 24h',
                                value: this.formatNumber(tokenInfo.uniqueWallets24h),
                                inline: true
                            });
                        }
                        
                        embed.fields.push(...tokenFields);
                    }

                    // Send notification to Discord
                    await channel.send({ embeds: [embed] });

                    // Send SMS only if value is over $1000 and SMS is enabled
                    if (totalUsdValue >= 1000 && this.config.twilio.enabled && wallet.discord_user_id) {
                        const subscriber = await this.getSMSSubscriber(wallet.discord_user_id);
                        if (subscriber) {
                            const smsMessage = `🔥 High Value Transaction ($${this.formatNumber(totalUsdValue)})!\n` +
                                `Type: ${transaction.type || 'Unknown'}\n` +
                                (transaction.amount ? `SOL Amount: ${this.formatNumber(transaction.amount)} SOL\n` : '') +
                                (transaction.tokenTransfers?.[0] ? `Token: ${transaction.tokenTransfers[0].tokenSymbol}\n` : '') +
                                (transaction.signature ? `\nhttps://solscan.io/tx/${transaction.signature}` : '');

                            await this.sendSMSAlert(
                                smsMessage,
                                subscriber.phone_number,
                                wallet.discord_user_id
                            );
                        }
                        }
                    }

                } catch (txError) {
                    console.error('[ERROR] Error processing transaction:', txError);
                    continue;
                }
            }

        } catch (error) {
            console.error('[ERROR] Error handling webhook:', error);
        }
    }

    async startMonitoring() {
        try {
            console.log('🔄 Starting Twitter monitoring...');
            
            // Schedule periodic monitoring with rate limit awareness
            const monitorAccounts = async () => {
                try {
                    const accounts = await this.getMonitoredAccounts();
                    if (accounts.length === 0) {
                        console.log('No accounts to monitor');
                        return;
                    }

                    // Process accounts in batches to respect rate limits
                    const BATCH_SIZE = 5;
                    for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
                        const batch = accounts.slice(i, i + BATCH_SIZE);
                        await this.batchProcessTweets(batch);
                    }
                } catch (error) {
                    if (error.code === 429) {
                        await this.handleRateLimit(error);
                    } else {
                        console.error('Error in monitor loop:', error);
                        await this.handleError(error);
                    }
                }
            };

            // Start the monitoring interval
            this.monitoringInterval = setInterval(monitorAccounts, this.config.monitoring.interval);
            console.log('✅ Twitter monitoring started');
        } catch (error) {
            console.error('Failed to start monitoring:', error);
            throw error;
        }
    }

    async batchProcessTweets(accounts) {
        try {
            for (const account of accounts) {
                const lastCheck = this.lastSearchTime.get(account.id) || 0;
                const now = Date.now();
                const lastTweetId = this.state.monitoredAccounts.get(account.id)?.lastTweetId;

                // Only check if enough time has passed
                if (now - lastCheck < this.monitoringInterval) {
                    continue;
                }

                await this.twitterRateLimitManager.scheduleRequest(
                    async () => {
                        const params = {
                            ...this.searchConfig,
                            since_id: lastTweetId
                        };

                        const tweets = await this.twitter.v2.userTimeline(account.id, params);
                        if (tweets.data) {
                            // Process tweets in chronological order
                            for (const tweet of tweets.data.reverse()) {
                                await this.processTweet(tweet, account, tweets.includes);
                            }
                        }
                    },
                    'users/:id/tweets'
                );

                this.lastSearchTime.set(account.id, now);
            }
        } catch (error) {
            if (error.code === 'RATE_LIMIT') {
                console.log('Rate limit hit, will retry on next interval');
                return;
            }
            console.error('Error processing tweets batch:', error);
            throw error; // Propagate error to be handled by the monitoring loop
        }
    }

    async handleSolanaMonitorCommand(interaction) {
        try {
            await interaction.deferReply();
            const account = interaction.options.getString('account');

            // Validate account
            const accountData = await this.checkAccount(account);
            if (!accountData) {
                await interaction.editReply('❌ Invalid Twitter account. Please check the username and try again.');
                return;
            }

            // Store account with type 'solana'
            await this.addMonitoredAccount({
                id: accountData.id,
                username: accountData.username,
                monitor_type: 'solana',
                last_tweet_id: null
            });

            await interaction.editReply(`✅ Now monitoring Solana-related tweets from @${accountData.username}`);
            console.log(`[DEBUG] Added monitored account: ${accountData.username} (type: solana)`);

        } catch (error) {
            console.error('[ERROR] Solana monitor command error:', error);
            await interaction.editReply('❌ Failed to start monitoring. Please try again.');
        }
    }

    async loadTrackedWallets() {
        // Initialize wallet tracking state if not exists
        if (!this.trackedWallets) {
            this.trackedWallets = new Map();
        }
        return Array.from(this.trackedWallets.values());
    }
}

module.exports = TwitterMonitorBot;