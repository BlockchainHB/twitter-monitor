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
    }
};

// Sample test data
const sampleSwapTransaction = {
    type: 'SWAP',
    accountData: [{
        account: 'TestWallet123'
    }],
    tokenTransfers: [
        {
            mint: 'TokenA123',
            tokenAmount: 1000
        },
        {
            mint: 'TokenB456',
            tokenAmount: 500
        }
    ],
    timestamp: Date.now() / 1000,
    signature: 'test-signature-123',
    usdValue: 150 // Above minimum threshold
};

// Mock config with specific test values
const testConfig = {
    ...config,
    helius: {
        ...config.helius,
        minSwapValue: 100,
        minSmsSwapValue: 500
    },
    discord: {
        ...config.discord,
        channels: {
            ...config.discord.channels,
            wallets: 'test-channel'
        }
    }
};

describe('Wallet Tracking Integration Tests', () => {
    let bot;
    let db;
    let heliusService;
    let dexScreenerService;
    let birdeyeService;

    beforeAll(async () => {
        // Set up in-memory database
        db = new sqlite3.Database(':memory:', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
        
        // Initialize test schema
        await new Promise((resolve, reject) => {
            db.exec(`
                CREATE TABLE monitored_wallets (
                    wallet_address TEXT PRIMARY KEY,
                    name TEXT NOT NULL
                );

                CREATE TABLE sms_subscribers (
                    discord_user_id TEXT PRIMARY KEY,
                    phone_number TEXT NOT NULL,
                    last_notification INTEGER
                );

                -- Insert test wallet
                INSERT INTO monitored_wallets (wallet_address, name) 
                VALUES ('TestWallet123', 'Test Wallet');

                -- Insert test SMS subscriber
                INSERT INTO sms_subscribers (discord_user_id, phone_number)
                VALUES ('test-user-id', '+1234567890');
            `, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Initialize services with mocks
        heliusService = new HeliusService(config.helius.apiKey, db);
        heliusService.parseSwapTransaction = jest.fn().mockReturnValue({
            ...sampleSwapTransaction,
            tokenTransfers: sampleSwapTransaction.tokenTransfers
        });

        dexScreenerService = new DexScreenerService();
        dexScreenerService.getTokenInfo = jest.fn().mockResolvedValue({
            symbol: 'TEST',
            priceUsd: 1.0,
            marketCap: 1000000,
            volume: { h24: 100000 },
            liquidity: 50000,
            txns: { h24: { buys: 100, sells: 50 } },
            url: 'https://dexscreener.com/test'
        });

        birdeyeService = new BirdeyeService();
        birdeyeService.createTokenEmbed = jest.fn().mockReturnValue({
            title: 'Token Info',
            description: 'Test token information',
            color: 0xFF0000,
            fields: [
                { name: 'Price', value: '$1.00', inline: true },
                { name: 'Volume', value: '$100,000', inline: true }
            ]
        });
        birdeyeService.getTokenInfo = jest.fn().mockResolvedValue({
            symbol: 'TEST',
            priceUsd: 1.0,
            marketCap: 1000000,
            volume: { h24: 100000 },
            liquidity: 50000,
            txns: { h24: { buys: 100, sells: 50 } }
        });

        // Initialize bot with test config
        bot = new TwitterMonitorBot({
            rateLimitManager: new RateLimitManager({}),
            config: testConfig,
            db,
            services: {
                helius: heliusService,
                dexscreener: dexScreenerService,
                birdeyeService: birdeyeService
            }
        });

        // Mock Discord client
        bot.client = mockDiscordClient;

        // Mock handleWalletNotification to respect minSwapValue
        const originalHandler = bot.handleWalletNotification.bind(bot);
        bot.handleWalletNotification = async (transaction) => {
            if (transaction.usdValue < testConfig.helius.minSwapValue) {
                console.log(`Skipping notification for swap value ${transaction.usdValue} (below minimum ${testConfig.helius.minSwapValue})`);
                return;
            }
            await originalHandler(transaction);
        };

        // Set up webhook handling
        bot.setupWebhookHandling();
    });

    beforeEach(() => {
        // Clear all mocks before each test
        jest.clearAllMocks();
    });

    afterAll(async () => {
        await new Promise((resolve) => db.close(resolve));
    });

    describe('Webhook Handling', () => {
        test('should process valid swap transaction', async () => {
            const webhookData = {
                events: [sampleSwapTransaction]
            };

            await bot.handleWebhook(webhookData);

            // Verify Discord notification was sent
            expect(mockChannel.send).toHaveBeenCalled();
            const sentEmbed = mockChannel.send.mock.calls[0][0].embeds[0];
            
            // Verify embed structure
            expect(sentEmbed.title).toContain('Test Wallet');
            expect(sentEmbed.description).toContain('150'); // USD value
            expect(sentEmbed.fields).toHaveLength(2); // Sent and Received fields
        });

        test('should ignore transactions below minimum value', async () => {
            const lowValueTransaction = {
                ...sampleSwapTransaction,
                usdValue: 50 // Below minimum threshold
            };

            const webhookData = {
                events: [lowValueTransaction]
            };

            await bot.handleWebhook(webhookData);

            // Verify no Discord notification was sent
            expect(mockChannel.send).not.toHaveBeenCalled();
        });
    });

    describe('SMS Notifications', () => {
        beforeEach(async () => {
            // Add a test subscriber to the database
            await bot.dbRun(`
                INSERT OR REPLACE INTO sms_subscribers (discord_user_id, phone_number) 
                VALUES (?, ?)
            `, ['test-user', '+1234567890']);

            // Add a test wallet to the database
            await bot.dbRun(`
                INSERT OR REPLACE INTO monitored_wallets (wallet_address, name) 
                VALUES (?, ?)
            `, ['test-wallet-address', 'Test Wallet']);
        });

        test('should send SMS for high-value swaps', async () => {
            // Mock sendSMSAlert before creating the webhook data
            const sendSMSMock = jest.spyOn(bot, 'sendSMSAlert').mockResolvedValue(true);

            // Mock DexScreener service
            const getTokenInfoMock = jest.spyOn(bot.dexscreener, 'getTokenInfo').mockResolvedValue({
                symbol: 'TEST',
                priceUsd: 1.0,
                marketCap: 1000000,
                volume: { h24: 100000 },
                liquidity: 50000,
                txns: { h24: { buys: 100, sells: 50 } }
            });

            // Mock Helius service
            const parseSwapMock = jest.spyOn(bot.helius, 'parseSwapTransaction').mockImplementation((tx) => ({
                ...tx,
                signature: 'test-signature',
                timestamp: Math.floor(Date.now() / 1000),
                tokenTransfers: [
                    { tokenAmount: 100, mint: 'mint1' },
                    { tokenAmount: 200, mint: 'mint2' }
                ]
            }));

            const highValueTransaction = {
                type: 'SWAP',
                usdValue: 1000, // Above SMS threshold
                accountData: [
                    { account: 'test-wallet-address' }
                ]
            };

            const webhookData = {
                events: [highValueTransaction]
            };

            await bot.handleWebhook(webhookData);

            // Verify SMS was triggered
            expect(sendSMSMock).toHaveBeenCalled();
            const smsMessage = sendSMSMock.mock.calls[0][0];
            expect(smsMessage).toContain('1.00K'); // Check USD value in message (formatted with K suffix)
            expect(smsMessage).toContain('Test Wallet'); // Check wallet name
            expect(sendSMSMock.mock.calls[0][1]).toBe('+1234567890');

            // Clean up mocks
            sendSMSMock.mockRestore();
            getTokenInfoMock.mockRestore();
            parseSwapMock.mockRestore();
        });

        afterEach(async () => {
            // Clean up test data
            await bot.dbRun('DELETE FROM sms_subscribers WHERE discord_user_id = ?', ['test-user']);
            await bot.dbRun('DELETE FROM monitored_wallets WHERE wallet_address = ?', ['test-wallet-address']);
        });
    });

    describe('Wallet Management', () => {
        test('should load wallets from config', async () => {
            // Create temporary test config
            const testWallets = [
                { address: 'Wallet1', name: 'Test 1' },
                { address: 'Wallet2', name: 'Test 2' }
            ];

            // Mock fs.readFile
            const fsReadFileMock = jest.spyOn(require('fs').promises, 'readFile')
                .mockResolvedValue(JSON.stringify({ wallets: testWallets }));

            await bot.loadWalletsFromConfig();

            // Verify wallets were added to database
            const wallets = await new Promise((resolve, reject) => {
                db.all('SELECT * FROM monitored_wallets', (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });

            expect(wallets.length).toBeGreaterThan(0);
            expect(wallets.some(w => w.wallet_address === 'Wallet1')).toBe(true);

            fsReadFileMock.mockRestore();
        });
    });
}); 