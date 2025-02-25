const { Client } = require('discord.js');
const { TwitterApi } = require('twitter-api-v2');
const sqlite3 = require('sqlite3');
const TwitterMonitorBot = require('../core/TwitterMonitorBot');

// Mock external dependencies
jest.mock('discord.js');
jest.mock('twitter-api-v2');
jest.mock('sqlite3');

describe('TwitterMonitorBot', () => {
    let bot;
    let mockDb;
    let mockTwitter;
    let mockDiscord;

    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();

        // Setup mock implementations
        mockDb = {
            all: jest.fn(),
            run: jest.fn(),
            get: jest.fn()
        };
        sqlite3.Database.mockImplementation(() => mockDb);

        mockTwitter = {
            v2: {
                userTimeline: jest.fn(),
                user: jest.fn()
            }
        };
        TwitterApi.mockImplementation(() => mockTwitter);

        mockDiscord = {
            on: jest.fn(),
            channels: {
                cache: {
                    get: jest.fn()
                }
            }
        };
        Client.mockImplementation(() => mockDiscord);

        // Create bot instance
        bot = new TwitterMonitorBot();
    });

    describe('Core Functionality', () => {
        test('initializes with required components', () => {
            expect(bot.client).toBeDefined();
            expect(bot.db).toBeDefined();
            expect(bot.twitter).toBeDefined();
            expect(bot.channels).toBeDefined();
        });

        test('sets up Discord event handlers', async () => {
            await bot.setupBot();
            expect(bot.client.on).toHaveBeenCalledWith('interactionCreate', expect.any(Function));
            expect(bot.client.on).toHaveBeenCalledWith('error', expect.any(Function));
        });

        test('starts monitoring interval', () => {
            jest.useFakeTimers();
            bot.startMonitoring();
            expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 60000);
            jest.useRealTimers();
        });
    });

    describe('Account Monitoring', () => {
        test('retrieves monitored accounts from database', async () => {
            const mockAccounts = [
                { id: 1, twitter_id: '123', type: 'tweet' },
                { id: 2, twitter_id: '456', type: 'solana' }
            ];
            mockDb.all.mockImplementation((query, callback) => callback(null, mockAccounts));

            const accounts = await bot.getMonitoredAccounts();
            expect(accounts).toEqual(mockAccounts);
            expect(mockDb.all).toHaveBeenCalled();
        });

        test('checks account for new tweets', async () => {
            const mockAccount = { twitter_id: '123', type: 'tweet' };
            const mockTweets = [
                { id: '1', text: 'Test tweet 1' },
                { id: '2', text: 'Test tweet 2' }
            ];

            mockTwitter.v2.userTimeline.mockResolvedValue({ data: mockTweets });
            mockDb.get.mockImplementation((query, params, callback) => callback(null, { last_tweet_id: '0' }));

            await bot.checkAccount(mockAccount);

            expect(mockTwitter.v2.userTimeline).toHaveBeenCalledWith(mockAccount.twitter_id);
            expect(mockDb.run).toHaveBeenCalled(); // Should update last_tweet_id
        });

        test('handles rate limits gracefully', async () => {
            const mockAccount = { twitter_id: '123', type: 'tweet' };
            const rateLimitError = new Error('Rate limit exceeded');
            rateLimitError.code = 429;

            mockTwitter.v2.userTimeline.mockRejectedValue(rateLimitError);

            await expect(bot.checkAccount(mockAccount)).resolves.not.toThrow();
        });
    });

    describe('Discord Integration', () => {
        test('sends tweet notifications to correct channel', async () => {
            const mockChannel = {
                send: jest.fn()
            };
            bot.client.channels.cache.get.mockReturnValue(mockChannel);

            await bot.sendTweetNotification({
                id: '1',
                text: 'Test tweet',
                author_id: '123'
            });

            expect(mockChannel.send).toHaveBeenCalled();
        });

        test('sends Solana address notifications to correct channel', async () => {
            const mockChannel = {
                send: jest.fn()
            };
            bot.client.channels.cache.get.mockReturnValue(mockChannel);

            await bot.sendSolanaNotification({
                tweet_id: '1',
                address: 'solana123',
                author_id: '123'
            });

            expect(mockChannel.send).toHaveBeenCalled();
        });
    });

    describe('Error Handling', () => {
        test('handles database errors gracefully', async () => {
            const dbError = new Error('Database error');
            mockDb.all.mockImplementation((query, callback) => callback(dbError));

            await expect(bot.getMonitoredAccounts()).resolves.toEqual([]);
        });

        test('handles Twitter API errors gracefully', async () => {
            const mockAccount = { twitter_id: '123', type: 'tweet' };
            mockTwitter.v2.userTimeline.mockRejectedValue(new Error('API error'));

            await expect(bot.checkAccount(mockAccount)).resolves.not.toThrow();
        });

        test('handles Discord API errors gracefully', async () => {
            const mockChannel = {
                send: jest.fn().mockRejectedValue(new Error('Discord API error'))
            };
            bot.client.channels.cache.get.mockReturnValue(mockChannel);

            await expect(bot.sendTweetNotification({
                id: '1',
                text: 'Test tweet',
                author_id: '123'
            })).resolves.not.toThrow();
        });
    });
}); 