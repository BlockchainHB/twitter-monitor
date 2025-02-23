const TwitterMonitorBot = require('../core/TwitterMonitorBot');
const config = require('../config/config');
const fs = require('fs/promises');
const path = require('path');
const sqlite3 = require('sqlite3');

describe('TwitterMonitorBot Integration Tests', () => {
    let bot;
    const TEST_DB_PATH = path.join(process.cwd(), 'data', 'test-twitter-monitor.db');

    beforeAll(async () => {
        // Override config for testing
        config.database.path = TEST_DB_PATH;
    });

    beforeEach(async () => {
        bot = new TwitterMonitorBot();
        // Initialize database for each test
        await bot.initializeDatabase();
        // Clear any existing data
        await bot.dbRun('DELETE FROM monitored_accounts');
    });

    afterEach(async () => {
        if (bot) {
            // Clear any test data
            try {
                await bot.dbRun('DELETE FROM monitored_accounts');
            } catch (error) {
                // Ignore errors during cleanup
            }
            await bot.shutdown();
        }
    });

    afterAll(async () => {
        try {
            await fs.unlink(TEST_DB_PATH);
        } catch (error) {
            // Ignore if file doesn't exist
        }
    });

    describe('1. Database Initialization', () => {
        test('should create data directory if it doesn\'t exist', async () => {
            const dataDir = path.dirname(TEST_DB_PATH);
            try {
                await fs.rm(dataDir, { recursive: true });
            } catch (error) {
                // Ignore if directory doesn't exist
            }

            await bot.initializeDatabase();
            const dirExists = await fs.stat(dataDir).then(() => true).catch(() => false);
            expect(dirExists).toBe(true);
        });

        test('should create database with correct schema', async () => {
            await bot.initializeDatabase();
            
            // Verify table structure
            const db = new sqlite3.Database(TEST_DB_PATH);
            const tableInfo = await new Promise((resolve, reject) => {
                db.all("SELECT sql FROM sqlite_master WHERE type='table' AND name='monitored_accounts'", (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                });
            });
            
            expect(tableInfo[0].sql).toContain('twitter_id TEXT PRIMARY KEY');
            expect(tableInfo[0].sql).toContain('username TEXT NOT NULL');
            expect(tableInfo[0].sql).toContain('monitoring_type TEXT NOT NULL');
            expect(tableInfo[0].sql).toContain('last_tweet_id TEXT');
            
            db.close();
        });

        test('should handle database operations correctly', async () => {
            await bot.initializeDatabase();
            
            // Test insert
            await bot.dbRun(
                'INSERT INTO monitored_accounts (twitter_id, username, monitoring_type) VALUES (?, ?, ?)',
                ['123', 'testuser', 'tweet']
            );
            
            // Test select
            const account = await bot.dbGet('SELECT * FROM monitored_accounts WHERE twitter_id = ?', ['123']);
            expect(account.username).toBe('testuser');
            
            // Test update
            await bot.dbRun(
                'UPDATE monitored_accounts SET last_tweet_id = ? WHERE twitter_id = ?',
                ['tweet123', '123']
            );
            
            const updated = await bot.dbGet('SELECT * FROM monitored_accounts WHERE twitter_id = ?', ['123']);
            expect(updated.last_tweet_id).toBe('tweet123');
        });
    });

    describe('2. Twitter API Connection', () => {
        test('should initialize Twitter client with correct credentials', () => {
            expect(bot.twitter).toBeDefined();
            expect(bot.twitter.readWrite).toBeDefined();
            expect(bot.rateLimitManager).toBeDefined();
        });

        test('should handle rate limits correctly', async () => {
            const testApiCall = async () => ({ data: { text: 'Test successful' } });
            const result = await bot.rateLimitManager.scheduleRequest(testApiCall, 'test');
            expect(result.data.text).toBe('Test successful');
        });
    });

    describe('3. Discord Client Setup', () => {
        test('should initialize Discord client with correct intents', () => {
            expect(bot.client.options.intents).toContain('Guilds');
            expect(bot.client.options.intents).toContain('GuildMessages');
        });

        test('should have command handlers set up', () => {
            expect(typeof bot.handleMonitorCommand).toBe('function');
            expect(typeof bot.handleListCommand).toBe('function');
            expect(typeof bot.testNotifications).toBe('function');
        });
    });

    describe('4. Monitoring System', () => {
        test('should start and stop monitoring interval', async () => {
            await bot.startMonitoring();
            expect(bot.monitoringInterval).toBeDefined();
            
            await bot.shutdown();
            expect(bot.monitoringInterval).toBeNull();
        });

        test('should correctly process monitored accounts', async () => {
            await bot.initializeDatabase();
            
            // Add test account
            await bot.dbRun(
                'INSERT INTO monitored_accounts (twitter_id, username, monitoring_type) VALUES (?, ?, ?)',
                ['123', 'testuser', 'tweet']
            );
            
            const accounts = await bot.getMonitoredAccounts();
            expect(accounts).toHaveLength(1);
            expect(accounts[0].username).toBe('testuser');
        });
    });

    describe('5. End-to-End Command Flow', () => {
        test('should handle monitor command flow', async () => {
            await bot.initializeDatabase();
            
            const mockInteraction = {
                options: {
                    getString: jest.fn().mockImplementation(key => {
                        if (key === 'twitter_id') return 'testuser';
                        if (key === 'type') return 'tweet';
                        return null;
                    })
                },
                reply: jest.fn(),
                editReply: jest.fn(),
                replied: false,
                deferred: false
            };

            await bot.handleMonitorCommand(mockInteraction);
            expect(mockInteraction.reply).toHaveBeenCalled();
        });

        test('should handle list command flow', async () => {
            await bot.initializeDatabase();
            
            const mockInteraction = {
                deferReply: jest.fn(),
                editReply: jest.fn(),
                replied: false,
                deferred: false
            };

            await bot.handleListCommand(mockInteraction);
            expect(mockInteraction.deferReply).toHaveBeenCalled();
        });
    });
}); 