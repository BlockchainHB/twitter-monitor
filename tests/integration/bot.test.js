const TwitterMonitorBot = require('../../src/core/TwitterMonitorBot');
const RateLimitManager = require('../../src/core/RateLimitManager');
const HeliusService = require('../../src/core/HeliusService');
const DexScreenerService = require('../../src/core/DexScreenerService');
const BirdeyeService = require('../../src/core/BirdeyeService');
const config = require('../../src/config/config');
const sqlite3 = require('sqlite3');
const { Client, GatewayIntentBits } = require('discord.js');

describe('TwitterMonitorBot Integration Tests', () => {
    let bot;
    let db;
    let rateLimitManager;
    let heliusService;
    let dexScreenerService;
    let birdeyeService;

    beforeAll(async () => {
        // Use in-memory SQLite database for testing
        db = new sqlite3.Database(':memory:', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
        
        // Initialize rate limit manager with test config
        rateLimitManager = new RateLimitManager({
            endpoints: config.twitter.rateLimit.endpoints,
            defaultLimit: config.twitter.rateLimit.defaultLimit,
            safetyMargin: config.twitter.rateLimit.safetyMargin,
            batchConfig: config.twitter.rateLimit.batchConfig
        });

        // Initialize services
        heliusService = new HeliusService(config.helius.apiKey, db);
        birdeyeService = new BirdeyeService();
        dexScreenerService = new DexScreenerService();

        // Create bot instance
        bot = new TwitterMonitorBot({
            rateLimitManager,
            config,
            db,
            services: {
                helius: heliusService,
                dexscreener: dexScreenerService,
                birdeye: birdeyeService
            }
        });

        // Initialize database schema
        await new Promise((resolve, reject) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS monitored_accounts (
                    twitter_id TEXT PRIMARY KEY,
                    last_tweet_id TEXT,
                    monitor_type TEXT,
                    is_vip INTEGER DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS monitored_wallets (
                    address TEXT PRIMARY KEY,
                    discord_user_id TEXT,
                    created_at INTEGER DEFAULT (strftime('%s', 'now'))
                );
                CREATE TABLE IF NOT EXISTS sms_subscribers (
                    discord_user_id TEXT PRIMARY KEY,
                    phone_number TEXT NOT NULL,
                    created_at INTEGER DEFAULT (strftime('%s', 'now')),
                    last_notification INTEGER DEFAULT NULL
                );
            `, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    });

    afterAll(async () => {
        await bot.shutdown();
        await new Promise((resolve) => db.close(resolve));
    });

    describe('Database Operations', () => {
        test('should execute basic database operations', async () => {
            // Test dbRun
            await expect(bot.dbRun(
                'INSERT INTO monitored_accounts (twitter_id, monitor_type) VALUES (?, ?)',
                ['testuser', 'tweet']
            )).resolves.not.toThrow();

            // Test dbGet
            const account = await bot.dbGet(
                'SELECT * FROM monitored_accounts WHERE twitter_id = ?',
                ['testuser']
            );
            expect(account).toBeDefined();
            expect(account.twitter_id).toBe('testuser');

            // Test dbAll
            const accounts = await bot.dbAll('SELECT * FROM monitored_accounts');
            expect(accounts).toHaveLength(1);

            // Test dbBatchRun
            const operations = [
                {
                    sql: 'INSERT INTO monitored_accounts (twitter_id, monitor_type) VALUES (?, ?)',
                    params: ['user1', 'solana']
                },
                {
                    sql: 'INSERT INTO monitored_accounts (twitter_id, monitor_type) VALUES (?, ?)',
                    params: ['user2', 'tweet']
                }
            ];
            await expect(bot.dbBatchRun(operations)).resolves.not.toThrow();
        });
    });

    describe('Twitter Monitoring', () => {
        test('should handle monitor commands', async () => {
            const mockInteraction = {
                commandName: 'monitor',
                options: {
                    getString: jest.fn().mockReturnValueOnce('testuser').mockReturnValueOnce('tweet'),
                    _hoistedOptions: []
                },
                reply: jest.fn(),
                user: { tag: 'test#1234' },
                guildId: config.discord.guildId
            };

            await expect(bot.handleMonitorCommand(mockInteraction)).resolves.not.toThrow();
            expect(mockInteraction.reply).toHaveBeenCalled();
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
                reply: jest.fn(),
                user: { id: '123', tag: 'test#1234' },
                guildId: config.discord.guildId
            };

            await expect(bot.handleTrackWalletCommand(mockInteraction)).resolves.not.toThrow();
            expect(mockInteraction.reply).toHaveBeenCalled();
        });
    });

    describe('Token Analysis', () => {
        test('should handle token commands', async () => {
            const mockInteraction = {
                commandName: 'trending',
                options: { _hoistedOptions: [] },
                reply: jest.fn(),
                user: { tag: 'test#1234' },
                guildId: config.discord.guildId
            };

            await expect(bot.handleTrendingCommand(mockInteraction)).resolves.not.toThrow();
            expect(mockInteraction.reply).toHaveBeenCalled();
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
                reply: jest.fn(),
                user: { id: '123', tag: 'test#1234' },
                guildId: config.discord.guildId
            };

            await expect(bot.handleSMSAlertCommand(mockInteraction)).resolves.not.toThrow();
            expect(mockInteraction.reply).toHaveBeenCalled();
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