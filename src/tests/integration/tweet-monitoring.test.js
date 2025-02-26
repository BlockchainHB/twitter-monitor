const TwitterMonitorBot = require('../../core/TwitterMonitorBot');
const RateLimitManager = require('../../core/RateLimitManager');
const HeliusService = require('../../core/HeliusService');
const DexScreenerService = require('../../core/DexScreenerService');
const BirdeyeService = require('../../core/BirdeyeService');
const config = require('../../config/config');
const sqlite3 = require('@vscode/sqlite3');
const path = require('path');

// Mock Discord.js
const mockChannel = {
    send: jest.fn().mockResolvedValue(true)
};

const mockGuild = {
    channels: {
        cache: {
            get: jest.fn().mockReturnValue(mockChannel)
        }
    }
};

const mockDiscordClient = {
    channels: {
        fetch: jest.fn().mockResolvedValue(mockChannel)
    },
    guilds: {
        cache: {
            get: jest.fn().mockReturnValue(mockGuild)
        }
    },
    destroy: jest.fn().mockResolvedValue(true)
};

// Sample test data
const sampleTweet = {
    id: '123456789',
    text: 'Test tweet with Solana address: 7NsqJqm9K5qGzqe5Fz5CgFGpGJU9yLJmhEoYz6KX5DbK',
    author_id: '987654321',
    created_at: '2024-03-20T12:00:00.000Z'
};

const sampleAuthor = {
    id: '987654321',
    username: 'testuser',
    name: 'Test User',
    profile_image_url: 'https://example.com/avatar.jpg'
};

describe('Tweet Monitoring Integration Tests', () => {
    let bot;
    let db;
    let rateLimitManager;
    let heliusService;
    let dexScreenerService;
    let birdeyeService;

    beforeAll(async () => {
        // Create in-memory database
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
                is_vip INTEGER DEFAULT 0,
                profile_data TEXT
            );

            CREATE TABLE IF NOT EXISTS processed_tweets (
                tweet_id TEXT PRIMARY KEY,
                twitter_id TEXT NOT NULL,
                tweet_data TEXT NOT NULL,
                conversation_id TEXT,
                referenced_tweet_id TEXT,
                tweet_type TEXT,
                processed_at INTEGER DEFAULT (strftime('%s', 'now'))
            );

            CREATE TABLE IF NOT EXISTS tracked_tokens (
                address TEXT PRIMARY KEY,
                symbol TEXT NOT NULL,
                name TEXT NOT NULL,
                decimals INTEGER NOT NULL,
                first_seen_tweet_id TEXT
            );

            CREATE TABLE IF NOT EXISTS token_mentions (
                tweet_id TEXT,
                token_address TEXT,
                PRIMARY KEY (tweet_id, token_address)
            );

            CREATE TABLE IF NOT EXISTS sms_subscribers (
                discord_user_id TEXT PRIMARY KEY,
                phone_number TEXT NOT NULL,
                last_notification INTEGER
            );
        `;

        // Execute test schema
        await new Promise((resolve, reject) => {
            db.exec(testSchema, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        // Initialize services with mocks
        heliusService = new HeliusService(config.helius.apiKey, db);
        heliusService.isValidSolanaAddress = jest.fn().mockReturnValue(true);

        dexScreenerService = new DexScreenerService();
        dexScreenerService.getTokenInfo = jest.fn().mockImplementation((address) => Promise.resolve({
            address,
            symbol: 'TEST',
            priceUsd: 1.0,
            marketCap: 1000000,
            volume: { h24: 100000 },
            liquidity: 50000,
            txns: { h24: { buys: 100, sells: 50 } }
        }));

        birdeyeService = new BirdeyeService();
        birdeyeService.createTokenEmbed = jest.fn().mockImplementation((address, tokenInfo) => ({
            title: `Token Info: ${tokenInfo.symbol}`,
            description: `Token Address: ${address}\nTest token information`,
            color: 0xFF0000,
            fields: [
                { name: 'Price', value: `$${tokenInfo.priceUsd}`, inline: true },
                { name: 'Volume', value: `$${tokenInfo.volume.h24}`, inline: true }
            ]
        }));
        birdeyeService.getTokenInfo = jest.fn().mockResolvedValue({
            symbol: 'TEST',
            priceUsd: 1.0,
            marketCap: 1000000,
            volume: { h24: 100000 },
            liquidity: 50000,
            txns: { h24: { buys: 100, sells: 50 } }
        });

        // Initialize rate limit manager
        rateLimitManager = new RateLimitManager({
            endpoints: config.twitter.rateLimit.endpoints,
            defaultLimit: config.twitter.rateLimit.defaultLimit
        });

        // Create bot instance with mocked dependencies
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

        // Mock Discord client
        bot.client = mockDiscordClient;

        // Mock Twitter API
        bot.twitter = {
            v2: {
                userByUsername: jest.fn((username) => {
                    if (username === 'nonexistentuser') {
                        throw new Error('User not found');
                    }
                    return {
                        data: {
                            id: username === 'newuser' ? '123456789' : 
                                 username === 'solanauser' ? '987654321' : 
                                 username === 'vipuser' ? '456789123' : '111111111',
                            username: username,
                            name: `Test ${username}`,
                            profile_image_url: 'https://example.com/avatar.jpg'
                        }
                    };
                })
            }
        };

        // Initialize bot state
        bot.state = {
            ...bot.initializeState(),
            db,
            ready: true,
            monitoring: true,
            guild: mockGuild,
            channels: {
                tweets: 'tweets-channel-id',
                solana: 'solana-channel-id',
                vip: 'vip-channel-id'
            }
        };
    });

    beforeEach(async () => {
        // Clear all mocks before each test
        jest.clearAllMocks();

        // Reset database state - clear ALL data
        await Promise.all([
            new Promise((resolve, reject) => {
                db.run('DELETE FROM monitored_accounts', [], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            }),
            new Promise((resolve, reject) => {
                db.run('DELETE FROM processed_tweets', [], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            }),
            new Promise((resolve, reject) => {
                db.run('DELETE FROM tracked_tokens', [], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            }),
            new Promise((resolve, reject) => {
                db.run('DELETE FROM token_mentions', [], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            })
        ]);
    });

    afterEach(async () => {
        // Clean up any test data
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM monitored_accounts WHERE twitter_id != ?', ['987654321'], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    });

    afterAll(async () => {
        // Clean up bot instance
        if (bot && bot.shutdown) {
            await bot.shutdown();
        }

        // Close database connection
        await new Promise((resolve) => {
            if (!db) resolve();
            db.close((err) => {
                if (err) console.error('Error closing database:', err);
                resolve();
            });
        });
    });

    describe('Monitor Commands', () => {
        beforeEach(() => {
            // Set up Twitter API mock for each test
            bot.twitter = {
                v2: {
                    userByUsername: jest.fn((username) => {
                        if (username === 'nonexistentuser') {
                            throw new Error('User not found');
                        }
                        return {
                            data: {
                                id: username === 'newuser' ? '123456789' : 
                                     username === 'solanauser' ? '987654321' : 
                                     username === 'vipuser' ? '456789123' : '111111111',
                                username: username,
                                name: `Test ${username}`,
                                profile_image_url: 'https://example.com/avatar.jpg'
                            }
                        };
                    })
                }
            };
        });

        test('should handle /monitor all tweets command', async () => {
            const mockInteraction = {
                commandName: 'monitor',
                options: {
                    getString: jest.fn()
                        .mockReturnValueOnce('newuser')  // twitter_id
                        .mockReturnValueOnce('tweet'),   // type
                    _hoistedOptions: []
                },
                user: { id: 'test-user', tag: 'test#1234' },
                guildId: mockGuild.id,
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true)
            };

            await bot.handleMonitorCommand(mockInteraction);

            // Verify the command was handled correctly
            expect(mockInteraction.editReply).toHaveBeenCalled();
            expect(mockInteraction.editReply.mock.calls[0][0]).toMatchObject({
                embeds: [
                    {
                        title: expect.stringContaining('Tweet Tracker'),
                        description: expect.stringContaining('Successfully monitoring @newuser'),
                        color: 0x00FF00
                    }
                ]
            });
            
            // Verify account was added to database
            await new Promise((resolve) => setTimeout(resolve, 100)); // Wait for DB operation to complete
            const account = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT * FROM monitored_accounts WHERE username = ?',
                    ['newuser'],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });
            expect(account).toBeDefined();
            expect(account.monitor_type).toBe('tweet');
            expect(account.is_vip).toBe(0);
        });

        test('should handle /monitor solana command', async () => {
            const mockInteraction = {
                commandName: 'monitor',
                options: {
                    getString: jest.fn()
                        .mockReturnValueOnce('solanauser')  // twitter_id
                        .mockReturnValueOnce('solana'),     // type
                    _hoistedOptions: []
                },
                user: { id: 'test-user', tag: 'test#1234' },
                guildId: mockGuild.id,
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true)
            };

            await bot.handleMonitorCommand(mockInteraction);

            // Verify the command was handled correctly
            expect(mockInteraction.editReply).toHaveBeenCalled();
            expect(mockInteraction.editReply.mock.calls[0][0]).toMatchObject({
                embeds: [
                    {
                        title: expect.stringContaining('Solana Address Tracker'),
                        description: expect.stringContaining('Successfully monitoring @solanauser'),
                        color: 0x00FF00
                    }
                ]
            });
            
            // Verify account was added to database
            await new Promise((resolve) => setTimeout(resolve, 100)); // Wait for DB operation to complete
            const account = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT * FROM monitored_accounts WHERE username = ?',
                    ['solanauser'],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });
            expect(account).toBeDefined();
            expect(account.monitor_type).toBe('solana');
            expect(account.is_vip).toBe(0);
        });

        test('should handle /vipmonitor command', async () => {
            const mockInteraction = {
                commandName: 'vipmonitor',
                options: {
                    getString: jest.fn().mockReturnValue('vipuser'),
                },
                deferReply: jest.fn().mockResolvedValue(),
                editReply: jest.fn().mockResolvedValue(),
                replied: false
            };

            await bot.handleVipMonitorCommand(mockInteraction);

            // Verify the command was handled correctly
            expect(mockInteraction.editReply).toHaveBeenCalled();
            expect(mockInteraction.editReply.mock.calls[0][0]).toMatchObject({
                embeds: [
                    {
                        title: expect.stringContaining('VIP Tweet Tracker'),
                        description: expect.stringContaining('Successfully monitoring @vipuser'),
                        color: 0x00FF00,
                        fields: expect.arrayContaining([
                            expect.objectContaining({
                                name: 'Monitoring Type',
                                value: '📝 VIP Tweets'
                            }),
                            expect.objectContaining({
                                name: 'Notifications Channel',
                                value: expect.stringContaining(bot.state.channels.vip)
                            })
                        ])
                    }
                ]
            });
            
            // Verify account was added to database with VIP flag
            await new Promise((resolve) => setTimeout(resolve, 100)); // Wait for DB operation
            const account = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT * FROM monitored_accounts WHERE username = ?',
                    ['vipuser'],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });
            expect(account).toBeDefined();
            expect(account.monitor_type).toBe('tweet');
            expect(account.is_vip).toBe(1);
        });

        test('should handle invalid Twitter usernames', async () => {
            const mockInteraction = {
                commandName: 'monitor',
                options: {
                    getString: jest.fn()
                        .mockReturnValueOnce('nonexistentuser')  // twitter_id
                        .mockReturnValueOnce('tweet'),           // type
                    _hoistedOptions: []
                },
                user: { id: 'test-user', tag: 'test#1234' },
                guildId: mockGuild.id,
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true)
            };

            // Mock Twitter API to throw error for nonexistent user
            bot.twitter.v2.userByUsername.mockRejectedValueOnce(new Error('User not found'));

            await bot.handleMonitorCommand(mockInteraction);

            // Verify error was handled correctly
            expect(mockInteraction.editReply).toHaveBeenCalled();
            expect(mockInteraction.editReply.mock.calls[0][0]).toMatchObject({
                embeds: [
                    {
                        title: expect.stringContaining('Error'),
                        description: expect.stringContaining('Could not find Twitter account'),
                        color: 0xFF0000
                    }
                ]
            });
        });
    });

    describe('Tweet Processing', () => {
        beforeEach(async () => {
            // Clear mocks
            mockChannel.send.mockClear();

            // Insert test accounts before processing tweets
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT OR REPLACE INTO monitored_accounts (twitter_id, username, monitor_type, is_vip) VALUES (?, ?, ?, ?)',
                    ['123456789', 'testuser', 'tweet', 0],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT OR REPLACE INTO monitored_accounts (twitter_id, username, monitor_type, is_vip) VALUES (?, ?, ?, ?)',
                    ['987654321', 'solanauser', 'solana', 0],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT OR REPLACE INTO monitored_accounts (twitter_id, username, monitor_type, is_vip) VALUES (?, ?, ?, ?)',
                    ['555555555', 'vipuser', 'tweet', 1],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });

            // Insert test token
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT OR REPLACE INTO tracked_tokens (address, symbol, name, decimals) VALUES (?, ?, ?, ?)',
                    ['7NsqJqm9K5qGzqe5Fz5CgFGpGJU9yLJmhEoYz6KX5DbK', 'TEST', 'Test Token', 9],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });

            // Insert test SMS subscriber
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT OR REPLACE INTO sms_subscribers (discord_user_id, phone_number) VALUES (?, ?)',
                    ['test-user-id', '+1234567890'],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });

            // Mock sendSMSAlert
            bot.sendSMSAlert = jest.fn().mockResolvedValue(true);
        });

        test('should process regular tweets', async () => {
            const tweet = {
                id: '123456789',
                author_id: '123456789',
                text: 'Regular test tweet',
                created_at: new Date().toISOString()
            };

            await bot.processTweet(tweet, {
                twitter_id: '123456789',
                username: 'testuser',
                monitoring_type: 'tweet',
                is_vip: false
            }, {});

            // Verify Discord notification was sent
            expect(mockChannel.send).toHaveBeenCalled();
            const sentEmbed = mockChannel.send.mock.calls[0][0].embeds[0];
            expect(sentEmbed.description).toContain('Regular test tweet');
            expect(sentEmbed.color).toBe(0x800080); // Purple color for regular tweets
        });

        test('should process tweets with Solana addresses', async () => {
            const tweet = {
                id: '123456789',
                author_id: '987654321',
                text: 'Check out this Solana address: 7NsqJqm9K5qGzqe5Fz5CgFGpGJU9yLJmhEoYz6KX5DbK',
                created_at: new Date().toISOString()
            };

            await bot.processTweet(tweet, {
                twitter_id: '987654321',
                username: 'solanauser',
                monitoring_type: 'solana',
                is_vip: false
            }, {});

            // Verify Discord notification was sent with both embeds
            expect(mockChannel.send).toHaveBeenCalled();
            const sentEmbeds = mockChannel.send.mock.calls[0][0].embeds;
            
            // First embed should be the tweet in purple
            expect(sentEmbeds[0].description).toContain('Check out this Solana address');
            expect(sentEmbeds[0].color).toBe(0x800080); // Purple color for tweet
            
            // Second embed should be the Solana info in red
            expect(sentEmbeds[1].description).toContain('7NsqJqm9K5qGzqe5Fz5CgFGpGJU9yLJmhEoYz6KX5DbK');
            expect(sentEmbeds[1].color).toBe(0xFF0000); // Red color for Solana info
            expect(sentEmbeds[1].fields).toBeDefined(); // Should have token info fields
        });

        test('should process VIP tweets with priority', async () => {
            const tweet = {
                id: '123456789',
                author_id: '555555555',
                text: 'VIP test tweet',
                created_at: new Date().toISOString()
            };

            await bot.processTweet(tweet, {
                twitter_id: '555555555',
                username: 'vipuser',
                monitoring_type: 'tweet',
                is_vip: true
            }, {});

            // Verify Discord notification was sent with VIP formatting
            expect(mockChannel.send).toHaveBeenCalled();
            const sentEmbed = mockChannel.send.mock.calls[0][0].embeds[0];
            expect(sentEmbed.description).toContain('VIP test tweet');
            expect(sentEmbed.color).toBe(0x800080); // Purple color for VIP tweets
        });

        test('should send SMS notifications for new Solana tokens', async () => {
            const tweet = {
                id: '123456789',
                author_id: '987654321',
                text: 'New token alert: 7NsqJqm9K5qGzqe5Fz5CgFGpGJU9yLJmhEoYz6KX5DbK',
                created_at: new Date().toISOString()
            };

            await bot.processTweet(tweet, {
                twitter_id: '987654321',
                username: 'solanauser',
                monitoring_type: 'solana',
                is_vip: false
            }, {});

            // Verify Discord notification was sent
            expect(mockChannel.send).toHaveBeenCalled();
            
            // Verify SMS notification was sent
            expect(bot.sendSMSAlert).toHaveBeenCalled();
            const smsMessage = bot.sendSMSAlert.mock.calls[0][0];
            expect(smsMessage).toContain('TEST'); // Token symbol
            expect(smsMessage).toContain('@solanauser'); // Twitter username
            expect(smsMessage).toContain('twitter.com'); // Tweet URL
            expect(bot.sendSMSAlert.mock.calls[0][1]).toBe('+1234567890'); // Phone number
        });
    });
}); 