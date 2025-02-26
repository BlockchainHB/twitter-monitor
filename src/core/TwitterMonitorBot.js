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

    setupCommandHandling() {
        console.log('🔄 Setting up command handling...');
        
        this.client.on('interactionCreate', async interaction => {
            // Only handle slash commands from our guild
            if (!interaction.isCommand() || interaction.guildId !== this.config.discord.guildId) return;

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
                    case 'help':
                        if (!interaction.replied) {
                            await this.handleHelpCommand(interaction);
                        }
                        break;
                    default:
                        if (!interaction.replied) {
                            await interaction.reply({ 
                                content: 'Unknown command. Use `/help` to see available commands.',
                                ephemeral: true 
                            });
                        }
                }
            } catch (error) {
                console.error('[ERROR] Command handling error:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        embeds: [{
                            title: "Error",
                            description: `❌ Command failed to execute: ${error.message}`,
                            color: 0xFF0000
                        }],
                        ephemeral: true
                    });
                }
            }
        });
    }

    // Command handlers
    async handleMonitorCommand(interaction) {
        try {
            await interaction.deferReply();
            
            const username = interaction.options.getString('twitter_id').toLowerCase().replace('@', '');
            const type = interaction.options.getString('type');
            
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
                .find(a => a.twitter_id === userInfo.data.id && a.monitor_type === type);

            if (existingAccount) {
                return await interaction.editReply({
                    embeds: [{
                        title: 'Already Monitoring',
                        description: `Already monitoring @${username} for ${type === 'solana' ? 'Solana addresses' : 'tweets'}`,
                        color: 0x9945FF
                    }]
                });
            }

            // Add account to monitoring
            await this.addMonitoredAccount({
                twitter_id: userInfo.data.id,
                username,
                monitor_type: type,
                profile_data: JSON.stringify(userInfo.data)
            });

            // Start monitoring if not already running
            if (!this.state.monitoringInterval) {
                await this.startMonitoring();
            }

            return await interaction.editReply({
                embeds: [{
                    title: `✅ ${type === 'solana' ? 'Solana Address' : 'Tweet'} Tracker Started`,
                    description: `Successfully monitoring @${username}`,
                    color: 0x00FF00
                }]
            });

        } catch (error) {
            console.error('[ERROR] Monitor command error:', error);
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
                .find(a => a.username === username);

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
                    color: 0x00FF00
                }]
            });

        } catch (error) {
            console.error('[ERROR] Stop monitor command error:', error);
            await interaction.reply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ An error occurred while stopping the monitor",
                    color: 0xFF0000
                }]
            });
        }
    }

    async handleListCommand(interaction) {
        try {
            const accounts = await this.getMonitoredAccounts();
            
            if (accounts.length === 0) {
                return await interaction.reply({
                    embeds: [{
                        title: 'No Monitored Accounts',
                        description: 'Not currently monitoring any accounts.',
                        color: 0x9945FF
                    }]
                });
            }

            const accountList = accounts.map(account => 
                `• @${account.username} (${account.monitor_type})`
            ).join('\n');

            return await interaction.reply({
                embeds: [{
                    title: '📋 Monitored Accounts',
                    description: accountList,
                    color: 0x9945FF
                }]
            });

        } catch (error) {
            console.error('[ERROR] List command error:', error);
            await interaction.reply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ An error occurred while listing accounts",
                    color: 0xFF0000
                }]
            });
        }
    }

    async handleHelpCommand(interaction) {
        try {
            const embed = {
                title: '🐈‍⬛ Twitter Monitor Bot',
                description: 'Available commands:',
                color: 0x9945FF,
                fields: [
                    {
                        name: '📱 Twitter Monitoring',
                        value: `
\`/monitor\` - Start monitoring a Twitter account
\`/stopm\` - Stop monitoring a Twitter account
\`/list\` - List all monitored accounts`,
                        inline: false
                    }
                ]
            };

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('[ERROR] Help command error:', error);
            await interaction.reply({
                embeds: [{
                    title: "Command Error",
                    description: "❌ Failed to display help information",
                    color: 0xFF0000
                }]
            });
        }
    }

    async testNotifications(interaction) {
        try {
            await interaction.reply({
                embeds: [{
                    title: '🧪 Test Message',
                    description: 'This is a test notification. If you can see this, notifications are working!',
                    color: 0x00FF00
                }]
            });
        } catch (error) {
            console.error('[ERROR] Test command error:', error);
            await interaction.reply({
                embeds: [{
                    title: "Test Failed",
                    description: `❌ Error running tests: ${error.message}`,
                    color: 0xFF0000
                }]
            });
        }
    }

} // End of class TwitterMonitorBot

module.exports = TwitterMonitorBot;