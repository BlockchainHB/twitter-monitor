const TwitterMonitorBot = require('../core/TwitterMonitorBot');
const RateLimitManager = require('../core/RateLimitManager');
const HeliusService = require('../core/HeliusService');
const DexScreenerService = require('../core/DexScreenerService');
const BirdeyeService = require('../core/BirdeyeService');
const config = require('../config/config');
const sqlite3 = require('@vscode/sqlite3');
const path = require('path');

// Mock Discord.js
const mockGuild = {
    id: 'mock-guild-id',
    channels: {
        cache: {
            get: jest.fn().mockReturnValue({
                send: jest.fn().mockResolvedValue(true)
            })
        }
    }
};

const mockDiscordClient = {
    login: jest.fn().mockResolvedValue(true),
    on: jest.fn(),
    once: jest.fn(),
    destroy: jest.fn().mockResolvedValue(true),
    user: { tag: 'TestBot#0000' },
    guilds: {
        cache: {
            get: jest.fn().mockReturnValue(mockGuild)
        }
    }
};

jest.mock('discord.js', () => ({
    Client: jest.fn().mockImplementation(() => mockDiscordClient),
    GatewayIntentBits: {
        Guilds: 1,
        GuildMessages: 2,
        MessageContent: 3
    }
}));

// Mock Twitter API
jest.mock('twitter-api-v2', () => ({
    TwitterApi: jest.fn().mockImplementation(() => ({
        v2: {
            userByUsername: jest.fn().mockResolvedValue({ 
                data: { 
                    id: '123',
                    username: 'testuser',
                    name: 'Test User',
                    profile_image_url: 'https://example.com/image.jpg'
                } 
            }),
            tweets: jest.fn().mockResolvedValue({ data: [] })
        }
    }))
}));

// Mock Twilio
jest.mock('twilio', () => jest.fn().mockImplementation(() => ({
    messages: {
        create: jest.fn().mockResolvedValue({ sid: 'test_sid' })
    }
})));

describe('TwitterMonitorBot Integration Tests', () => {
    let bot;
    let db;
    let rateLimitManager;
    let heliusService;
    let dexScreenerService;
    let birdeyeService;

    beforeAll(async () => {
        // Use in-memory SQLite database for testing
        db = await new Promise((resolve, reject) => {
            const database = new sqlite3.Database(':memory:', (err) => {
                if (err) reject(err);
                else resolve(database);
            });
        });

        // Initialize minimal test schema
        const testSchema = `
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;

            -- Only create tables we need for tests
            CREATE TABLE IF NOT EXISTS monitored_accounts (
                twitter_id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                last_tweet_id TEXT,
                monitor_type TEXT NOT NULL,
                is_vip INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS monitored_wallets (
                wallet_address TEXT PRIMARY KEY,
                discord_user_id TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sms_subscribers (
                discord_user_id TEXT PRIMARY KEY,
                phone_number TEXT NOT NULL
            );

            -- Create minimal indexes
            CREATE INDEX IF NOT EXISTS idx_monitored_accounts_username ON monitored_accounts(username);
        `;

        // Execute test schema
        await new Promise((resolve, reject) => {
            db.exec(testSchema, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        // Initialize rate limit manager with test config
        rateLimitManager = new RateLimitManager({
            endpoints: config.twitter.rateLimit.endpoints,
            defaultLimit: config.twitter.rateLimit.defaultLimit,
            safetyMargin: config.twitter.rateLimit.safetyMargin,
            batchConfig: config.twitter.rateLimit.batchConfig
        });

        // Initialize services
        heliusService = new HeliusService(config.helius.apiKey, db);
        heliusService.isValidSolanaAddress = jest.fn().mockReturnValue(true);
        heliusService.createWebhook = jest.fn().mockResolvedValue({ webhookId: 'test-webhook' });
        heliusService.getWebhooks = jest.fn().mockResolvedValue([]);
        heliusService.deleteWebhook = jest.fn().mockResolvedValue(true);

        birdeyeService = new BirdeyeService();
        birdeyeService.getTrendingTokens = jest.fn().mockResolvedValue([
            { symbol: 'TEST1', price: 1.0, volume24h: 1000000 },
            { symbol: 'TEST2', price: 2.0, volume24h: 2000000 }
        ]);
        birdeyeService.createTrendingEmbed = jest.fn().mockReturnValue({
            title: 'Trending Tokens',
            description: 'Test trending tokens',
            fields: []
        });

        dexScreenerService = new DexScreenerService();

        // Create bot instance with dependencies
        bot = new TwitterMonitorBot({
            rateLimitManager,
            config,
            db,
            services: {
                helius: heliusService,
                dexscreener: dexScreenerService,
                birdeyeService: birdeyeService
            }
        });

        // Skip full initialization for tests
        bot.state.db = db;
    });

    afterAll(async () => {
        if (bot && bot.shutdown) {
            await bot.shutdown();
        }
        if (db) {
            await new Promise((resolve, reject) => {
                db.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }
    });

    describe('Database Operations', () => {
        test('should execute basic database operations', async () => {
            // Test dbRun
            await expect(bot.dbRun(
                'INSERT INTO monitored_accounts (twitter_id, username, monitor_type) VALUES (?, ?, ?)',
                ['123', 'testuser', 'tweet']
            )).resolves.not.toThrow();

            // Test dbGet
            const account = await bot.dbGet(
                'SELECT * FROM monitored_accounts WHERE twitter_id = ?',
                ['123']
            );
            expect(account).toBeDefined();
            expect(account.twitter_id).toBe('123');
            expect(account.username).toBe('testuser');

            // Test dbAll
            const accounts = await bot.dbAll('SELECT * FROM monitored_accounts');
            expect(accounts).toHaveLength(1);
        });
    });

    describe('Twitter Monitoring', () => {
        test('should handle monitor commands', async () => {
            const mockInteraction = {
                commandName: 'monitor',
                options: {
                    getString: jest.fn()
                        .mockReturnValueOnce('testuser')
                        .mockReturnValueOnce('tweet'),
                    _hoistedOptions: []
                },
                reply: jest.fn().mockResolvedValue(true),
                user: { tag: 'test#1234' },
                guildId: mockGuild.id,
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true)
            };

            await expect(bot.handleMonitorCommand(mockInteraction)).resolves.not.toThrow();
            expect(mockInteraction.editReply).toHaveBeenCalled();
        });
    });

    describe('Wallet Monitoring', () => {
        test('should handle wallet tracking commands', async () => {
            const mockInteraction = {
                commandName: 'trackwallet',
                options: {
                    getString: jest.fn().mockReturnValue('testwalletaddress'),
                    _hoistedOptions: []
                },
                user: { id: '123', tag: 'test#1234' },
                guildId: mockGuild.id,
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true)
            };

            await expect(bot.handleTrackWalletCommand(mockInteraction)).resolves.not.toThrow();
            expect(mockInteraction.editReply).toHaveBeenCalled();
        });
    });

    describe('Token Analysis', () => {
        test('should handle token commands', async () => {
            const mockInteraction = {
                commandName: 'trending',
                options: { _hoistedOptions: [] },
                user: { tag: 'test#1234' },
                guildId: mockGuild.id,
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true)
            };

            await expect(bot.handleTrendingCommand(mockInteraction)).resolves.not.toThrow();
            expect(mockInteraction.editReply).toHaveBeenCalled();
        });
    });

    describe('SMS Alerts', () => {
        test('should handle SMS subscription commands', async () => {
            const mockInteraction = {
                commandName: 'smsalert',
                options: {
                    getString: jest.fn().mockReturnValue('+1234567890'),
                    _hoistedOptions: []
                },
                user: { id: '123', tag: 'test#1234' },
                guildId: mockGuild.id,
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true)
            };

            await expect(bot.handleSMSAlertCommand(mockInteraction)).resolves.not.toThrow();
            expect(mockInteraction.editReply).toHaveBeenCalled();
        });
    });

    describe('Command Registration', () => {
        test('should register all commands', async () => {
            const mockClient = {
                application: {
                    commands: {
                        set: jest.fn().mockResolvedValue(true)
                    }
                }
            };

            await expect(bot.registerCommands(mockClient)).resolves.not.toThrow();
        });
    });
}); 