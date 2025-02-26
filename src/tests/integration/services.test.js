const TwitterMonitorBot = require('../../core/TwitterMonitorBot');
const RateLimitManager = require('../../core/RateLimitManager');
const HeliusService = require('../../core/HeliusService');
const DexScreenerService = require('../../core/DexScreenerService');
const BirdeyeService = require('../../core/BirdeyeService');
const config = require('../../config/config');
const sqlite3 = require('@vscode/sqlite3');

describe('Services Integration Tests', () => {
    let bot;
    let db;
    let rateLimitManager;
    let heliusService;
    let dexScreenerService;
    let birdeyeService;

    const TEST_TOKEN_ADDRESS = '7NsqJqm9K5qGzqe5Fz5CgFGpGJU9yLJmhEoYz6KX5DbK';
    const TEST_WALLET_ADDRESS = 'TestWallet123';
    const TEST_TWITTER_ID = 'testuser';
    const TEST_DISCORD_USER = 'test-discord-user';

    beforeAll(async () => {
        // Create in-memory database
        db = new sqlite3.Database(':memory:', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);

        // Initialize test schema
        await new Promise((resolve, reject) => {
            db.exec(`
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS monitored_accounts (
                    twitter_id TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    last_tweet_id TEXT,
                    monitor_type TEXT NOT NULL,
                    is_vip INTEGER DEFAULT 0,
                    profile_data TEXT
                );

                CREATE TABLE IF NOT EXISTS monitored_wallets (
                    wallet_address TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    discord_user_id TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS processed_tweets (
                    tweet_id TEXT PRIMARY KEY,
                    twitter_id TEXT NOT NULL,
                    tweet_data TEXT,
                    conversation_id TEXT,
                    referenced_tweet_id TEXT,
                    tweet_type TEXT
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

                CREATE TABLE IF NOT EXISTS helius_webhooks (
                    webhook_id TEXT PRIMARY KEY,
                    webhook_url TEXT NOT NULL,
                    active INTEGER DEFAULT 1
                );
            `, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Initialize services
        rateLimitManager = new RateLimitManager({
            endpoints: config.twitter.rateLimit.endpoints,
            defaultLimit: config.twitter.rateLimit.defaultLimit,
            safetyMargin: 0.9
        });

        heliusService = new HeliusService(config.helius.apiKey, db);
        heliusService.isValidSolanaAddress = jest.fn().mockReturnValue(true);
        heliusService.createWebhook = jest.fn().mockResolvedValue({ webhookId: 'test-webhook' });
        heliusService.listWebhooks = jest.fn().mockResolvedValue([]);
        heliusService.syncWallets = jest.fn().mockResolvedValue(true);

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
        birdeyeService.getTrendingTokens = jest.fn().mockResolvedValue([
            {
                symbol: 'TEST1',
                name: 'Test Token 1',
                price: 1.0,
                priceUsd: 1.0,
                volume24h: 1000000,
                marketCap: 5000000,
                liquidity: 500000,
                priceChange24h: 10
            }
        ]);

        // Mock Birdeye metrics
        birdeyeService.getTokenMetrics = jest.fn().mockResolvedValue({
            price: 1.0,
            price_change_24h_percent: 10,
            price_change_1h_percent: 5,
            volume_24h_usd: 1000000,
            volume_1h_usd: 100000,
            trade_24h: 1000,
            trade_1h: 100,
            buy_24h: 600,
            buy_1h: 60,
            sell_24h: 400,
            sell_1h: 40,
            holder: 1000,
            market: 5
        });

        // Mock Discord client
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

        // Create bot instance with in-memory database
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

        // Initialize bot state with in-memory database
        bot.state = {
            ...bot.initializeState(),
            db, // Assign the in-memory database
            channels: {
                tweets: 'test-tweets-channel',
                solana: 'test-solana-channel',
                vip: 'test-vip-channel',
                wallets: 'test-wallets-channel'
            },
            guild: mockGuild,
            isMonitoring: false,
            monitoringInterval: null,
            lastCheckTimes: new Map()
        };

        bot.client = {
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

        // Mock Twitter client
        bot.twitter = {
            v2: {
                userByUsername: jest.fn().mockImplementation((username) => {
                    if (username === 'nonexistentuser') {
                        throw new Error('User not found');
                    }
                    return {
                        data: {
                            id: username === TEST_TWITTER_ID ? '123456789' : '987654321',
                            username: username,
                            name: `Test ${username}`,
                            profile_image_url: 'https://example.com/avatar.jpg'
                        }
                    };
                })
            }
        };

        // Initialize webhook handling
        bot.setupWebhookHandling();
    });

    afterAll(async () => {
        await bot.shutdown();
        await new Promise((resolve) => db.close(resolve));
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        // Clear all tables
        await Promise.all([
            'monitored_accounts',
            'monitored_wallets',
            'processed_tweets',
            'tracked_tokens',
            'token_mentions',
            'sms_subscribers',
            'helius_webhooks'
        ].map(table => 
            new Promise((resolve, reject) => {
                db.run(`DELETE FROM ${table}`, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            })
        ));
    });

    describe('Service Integration', () => {
        test('should handle complete monitoring flow', async () => {
            // 1. Add Twitter account to monitor
            const monitorInteraction = {
                commandName: 'monitor',
                options: {
                    getString: jest.fn()
                        .mockReturnValueOnce(TEST_TWITTER_ID)
                        .mockReturnValueOnce('solana'),
                    _hoistedOptions: []
                },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true),
                user: { id: TEST_DISCORD_USER }
            };

            await bot.handleMonitorCommand(monitorInteraction);
            expect(monitorInteraction.editReply).toHaveBeenCalled();

            // 2. Add wallet to track
            const trackWalletInteraction = {
                commandName: 'trackwallet',
                options: {
                    getString: jest.fn()
                        .mockReturnValueOnce('Test Wallet')
                        .mockReturnValueOnce(TEST_WALLET_ADDRESS),
                    _hoistedOptions: []
                },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true),
                user: { id: TEST_DISCORD_USER }
            };

            await bot.handleTrackWalletCommand(trackWalletInteraction);
            expect(trackWalletInteraction.editReply).toHaveBeenCalled();
            expect(heliusService.syncWallets).toHaveBeenCalled();

            // 3. Check token info
            const metricsInteraction = {
                commandName: 'metrics',
                options: {
                    getString: jest.fn().mockReturnValue(TEST_TOKEN_ADDRESS),
                    _hoistedOptions: []
                },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true),
                user: { id: TEST_DISCORD_USER }
            };

            await bot.handleMetricsCommand(metricsInteraction);
            expect(metricsInteraction.editReply).toHaveBeenCalled();

            // 4. Process webhook notification
            const webhookData = {
                events: [{
                    type: 'SWAP',
                    accountData: [{
                        account: TEST_WALLET_ADDRESS
                    }],
                    tokenTransfers: [
                        { mint: 'TokenA', tokenAmount: 1000 },
                        { mint: 'TokenB', tokenAmount: 500 }
                    ],
                    timestamp: Math.floor(Date.now() / 1000),
                    signature: 'test-signature',
                    usdValue: 1000, // Above minimum threshold
                    events: {
                        swap: {
                            tokenTransfers: [
                                { mint: 'TokenA', tokenAmount: 1000 },
                                { mint: 'TokenB', tokenAmount: 500 }
                            ],
                            usdValue: 1000
                        }
                    }
                }]
            };

            await bot.handleWebhook(webhookData);
            expect(bot.client.channels.fetch).toHaveBeenCalled();

            // 5. Check database state
            const accounts = await new Promise((resolve, reject) => {
                db.all('SELECT * FROM monitored_accounts', (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });
            expect(accounts.length).toBe(1);
            expect(accounts[0].username).toBe(TEST_TWITTER_ID);

            const wallets = await new Promise((resolve, reject) => {
                db.all('SELECT * FROM monitored_wallets', (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });
            expect(wallets.length).toBe(1);
            expect(wallets[0].wallet_address).toBe(TEST_WALLET_ADDRESS);
        });

        test('should handle error cases gracefully', async () => {
            // 1. Test non-existent Twitter user
            const badMonitorInteraction = {
                commandName: 'monitor',
                options: {
                    getString: jest.fn()
                        .mockReturnValueOnce('nonexistentuser')
                        .mockReturnValueOnce('solana'),
                    _hoistedOptions: []
                },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true),
                user: { id: TEST_DISCORD_USER }
            };

            await bot.handleMonitorCommand(badMonitorInteraction);
            expect(badMonitorInteraction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    embeds: expect.arrayContaining([
                        expect.objectContaining({
                            title: expect.stringContaining('Error'),
                            color: 0xFF0000
                        })
                    ])
                })
            );

            // 2. Test invalid wallet address
            heliusService.isValidSolanaAddress.mockReturnValueOnce(false);
            const badWalletInteraction = {
                commandName: 'trackwallet',
                options: {
                    getString: jest.fn()
                        .mockReturnValueOnce('Bad Wallet')
                        .mockReturnValueOnce('invalid-address'),
                    _hoistedOptions: []
                },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true),
                user: { id: TEST_DISCORD_USER }
            };

            await bot.handleTrackWalletCommand(badWalletInteraction);
            expect(badWalletInteraction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('Invalid Solana wallet address')
            );

            // 3. Test API error handling
            birdeyeService.getTrendingTokens.mockRejectedValueOnce(new Error('API Error'));
            const trendingInteraction = {
                commandName: 'trending',
                options: { _hoistedOptions: [] },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true),
                deferred: true,
                replied: false,
                user: { id: TEST_DISCORD_USER }
            };

            await bot.handleTrendingCommand(trendingInteraction);
            expect(trendingInteraction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    embeds: expect.arrayContaining([
                        expect.objectContaining({
                            description: expect.stringContaining('Failed to fetch trending tokens'),
                            color: 0xFF0000
                        })
                    ])
                })
            );
        });

        test('should handle rate limiting correctly', async () => {
            const rateLimitError = new Error('Rate limit exceeded');
            rateLimitError.code = 429;
            bot.twitter.v2.userByUsername.mockRejectedValueOnce(rateLimitError);

            const interaction = {
                commandName: 'monitor',
                options: {
                    getString: jest.fn()
                        .mockReturnValueOnce(TEST_TWITTER_ID)
                        .mockReturnValueOnce('tweet'),
                    _hoistedOptions: []
                },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true),
                user: { id: TEST_DISCORD_USER }
            };

            await bot.handleMonitorCommand(interaction);
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    embeds: expect.arrayContaining([
                        expect.objectContaining({
                            title: expect.stringContaining('Error'),
                            color: 0xFF0000
                        })
                    ])
                })
            );
        });
    });
}); 