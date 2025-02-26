const TwitterMonitorBot = require('../../core/TwitterMonitorBot');
const RateLimitManager = require('../../core/RateLimitManager');
const HeliusService = require('../../core/HeliusService');
const DexScreenerService = require('../../core/DexScreenerService');
const BirdeyeService = require('../../core/BirdeyeService');
const config = require('../../config/config');
const sqlite3 = require('@vscode/sqlite3');

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
    destroy: jest.fn().mockResolvedValue(true)  // Add destroy mock
};

describe('Birdeye Token Commands Integration Tests', () => {
    let bot;
    let db;
    let birdeyeService;
    
    const TEST_TOKEN_ADDRESS = '7NsqJqm9K5qGzqe5Fz5CgFGpGJU9yLJmhEoYz6KX5DbK';

    beforeAll(async () => {
        // Create in-memory database
        db = new sqlite3.Database(':memory:', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);

        // Initialize BirdeyeService with mocks
        birdeyeService = new BirdeyeService();
        
        // Mock trending tokens with all required fields
        birdeyeService.getTrendingTokens = jest.fn().mockResolvedValue([
            {
                symbol: 'TEST1',
                price: 1.0,
                priceUsd: 1.0,
                volume24h: 1000000,
                marketCap: 5000000,
                liquidity: 500000,
                priceChange24h: 10,
                priceChange7d: 20,
                holders: 1000,
                txns: { h24: { buys: 100, sells: 50 } }
            },
            {
                symbol: 'TEST2',
                price: 2.0,
                priceUsd: 2.0,
                volume24h: 2000000,
                marketCap: 10000000,
                liquidity: 1000000,
                priceChange24h: 15,
                priceChange7d: 25,
                holders: 2000,
                txns: { h24: { buys: 200, sells: 100 } }
            }
        ]);

        // Mock gainers/losers with all required fields
        birdeyeService.getTopMovers = jest.fn().mockImplementation((timeframe, type) => {
            return Promise.resolve([
                {
                    symbol: 'TEST1',
                    priceUsd: 1.0,
                    priceChange: type === 'gainers' ? 50 : -50,
                    volume24h: 1000000,
                    marketCap: 5000000,
                    liquidity: 500000
                },
                {
                    symbol: 'TEST2',
                    priceUsd: 2.0,
                    priceChange: type === 'gainers' ? 30 : -30,
                    volume24h: 2000000,
                    marketCap: 10000000,
                    liquidity: 1000000
                }
            ]);
        });

        // Mock security data
        birdeyeService.getTokenSecurity = jest.fn().mockResolvedValue({
            mutableMetadata: false,
            freezeable: false,
            transferFeeEnable: false,
            isToken2022: false,
            jupStrictList: true,
            top10HolderPercent: 0.45,
            top10UserPercent: 0.35,
            totalSupply: '1000000000',
            creationTime: Date.now(),
            creatorAddress: 'Creator123'
        });

        // Mock metrics data
        birdeyeService.getTokenMetrics = jest.fn().mockResolvedValue({
            price: 1.0,
            priceUsd: 1.0,
            marketCap: 5000000,
            volume24h: 1000000,
            liquidity: 500000,
            priceChange24h: 10,
            priceChange7d: 20,
            holders: 1000,
            txns: { h24: { buys: 100, sells: 50 } }
        });

        // Mock holders data
        birdeyeService.getTokenHolders = jest.fn().mockResolvedValue([
            { owner: 'Holder1', amount: 100000 },
            { owner: 'Holder2', amount: 50000 }
        ]);

        // Mock top traders
        birdeyeService.getTokenTopTraders = jest.fn().mockResolvedValue([
            { owner: 'Trader1', volume: 100000, tradeBuy: 80000, trade: 100 },
            { owner: 'Trader2', volume: 50000, tradeBuy: 30000, trade: 50 }
        ]);

        // Create bot instance with mocked dependencies
        bot = new TwitterMonitorBot({
            rateLimitManager: new RateLimitManager({}),
            config,
            db,
            services: {
                helius: new HeliusService(config.helius.apiKey, db),
                dexscreener: new DexScreenerService(),
                birdeyeService: birdeyeService
            }
        });

        // Mock Discord client
        bot.client = mockDiscordClient;
    });

    afterAll(async () => {
        if (bot && bot.shutdown) {
            await bot.shutdown();
        }
        await new Promise((resolve) => db.close(resolve));
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Trending Command', () => {
        test('should display trending tokens', async () => {
            const mockInteraction = {
                commandName: 'trending',
                options: { _hoistedOptions: [] },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true)
            };

            await bot.handleTrendingCommand(mockInteraction);

            expect(mockInteraction.deferReply).toHaveBeenCalled();
            expect(mockInteraction.editReply).toHaveBeenCalled();
            expect(birdeyeService.getTrendingTokens).toHaveBeenCalled();

            const response = mockInteraction.editReply.mock.calls[0][0];
            expect(response.embeds[0]).toBeDefined();
            expect(response.embeds[0].title).toContain('Trending');
            expect(response.embeds[0].footer.text).toBe('built by keklabs');
        });
    });

    describe('Gainers Command', () => {
        test('should display top gainers', async () => {
            const mockInteraction = {
                commandName: 'gainers',
                options: {
                    getString: jest.fn().mockReturnValue('24h'),
                    _hoistedOptions: []
                },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true)
            };

            await bot.handleGainersCommand(mockInteraction);

            expect(mockInteraction.deferReply).toHaveBeenCalled();
            expect(mockInteraction.editReply).toHaveBeenCalled();
            expect(birdeyeService.getTopMovers).toHaveBeenCalledWith('24h', 'gainers');

            const response = mockInteraction.editReply.mock.calls[0][0];
            expect(response.embeds[0]).toBeDefined();
            expect(response.embeds[0].title).toContain('Gainers');
            expect(response.embeds[0].footer.text).toBe('built by keklabs');
        });
    });

    describe('Losers Command', () => {
        test('should display top losers', async () => {
            const mockInteraction = {
                commandName: 'losers',
                options: {
                    getString: jest.fn().mockReturnValue('24h'),
                    _hoistedOptions: []
                },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true)
            };

            await bot.handleLosersCommand(mockInteraction);

            expect(mockInteraction.deferReply).toHaveBeenCalled();
            expect(mockInteraction.editReply).toHaveBeenCalled();
            expect(birdeyeService.getTopMovers).toHaveBeenCalledWith('24h', 'losers');

            const response = mockInteraction.editReply.mock.calls[0][0];
            expect(response.embeds[0]).toBeDefined();
            expect(response.embeds[0].title).toContain('Losers');
            expect(response.embeds[0].footer.text).toBe('built by keklabs');
        });
    });

    describe('Security Command', () => {
        test('should display token security information', async () => {
            const mockInteraction = {
                commandName: 'security',
                options: {
                    getString: jest.fn().mockReturnValue(TEST_TOKEN_ADDRESS),
                    _hoistedOptions: []
                },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true)
            };

            await bot.handleSecurityCommand(mockInteraction);

            expect(mockInteraction.deferReply).toHaveBeenCalled();
            expect(mockInteraction.editReply).toHaveBeenCalled();
            expect(birdeyeService.getTokenSecurity).toHaveBeenCalledWith(TEST_TOKEN_ADDRESS);

            const response = mockInteraction.editReply.mock.calls[0][0];
            expect(response.embeds[0]).toBeDefined();
            expect(response.embeds[0].title).toContain('Security');
            expect(response.embeds[0].footer.text).toBe('built by keklabs');
        });
    });

    describe('Metrics Command', () => {
        test('should display token metrics', async () => {
            const mockInteraction = {
                commandName: 'metrics',
                options: {
                    getString: jest.fn().mockReturnValue(TEST_TOKEN_ADDRESS),
                    _hoistedOptions: []
                },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true)
            };

            await bot.handleMetricsCommand(mockInteraction);

            expect(mockInteraction.deferReply).toHaveBeenCalled();
            expect(mockInteraction.editReply).toHaveBeenCalled();
            expect(birdeyeService.getTokenMetrics).toHaveBeenCalledWith(TEST_TOKEN_ADDRESS);

            const response = mockInteraction.editReply.mock.calls[0][0];
            expect(response.embeds[0]).toBeDefined();
            expect(response.embeds[0].title).toContain('Metrics');
            expect(response.embeds[0].footer.text).toBe('built by keklabs');
        });
    });

    describe('Holders Command', () => {
        test('should display token holders information', async () => {
            const mockInteraction = {
                commandName: 'holders',
                options: {
                    getString: jest.fn().mockReturnValue(TEST_TOKEN_ADDRESS),
                    _hoistedOptions: []
                },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true)
            };

            await bot.handleHoldersCommand(mockInteraction);

            expect(mockInteraction.deferReply).toHaveBeenCalled();
            expect(mockInteraction.editReply).toHaveBeenCalled();
            expect(birdeyeService.getTokenHolders).toHaveBeenCalledWith(TEST_TOKEN_ADDRESS);
            expect(birdeyeService.getTokenTopTraders).toHaveBeenCalledWith(TEST_TOKEN_ADDRESS);

            const response = mockInteraction.editReply.mock.calls[0][0];
            expect(response.embeds[0]).toBeDefined();
            expect(response.embeds[0].title).toContain('Holders');
            expect(response.embeds[0].footer.text).toBe('built by keklabs');
        });
    });

    describe('Error Handling', () => {
        test('should handle API errors gracefully', async () => {
            // Mock API error
            birdeyeService.getTrendingTokens.mockRejectedValueOnce(new Error('API Error'));

            const mockInteraction = {
                commandName: 'trending',
                options: { _hoistedOptions: [] },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true),
                deferred: true,
                replied: false
            };

            await bot.handleTrendingCommand(mockInteraction);

            // Should have tried to edit reply
            expect(mockInteraction.editReply).toHaveBeenCalled();
            const response = mockInteraction.editReply.mock.calls[0][0];
            expect(response.embeds[0].color).toBe(0xFF0000); // Red color for error
            expect(response.embeds[0].description).toContain('❌ Failed to fetch trending tokens');
        });

        test('should handle empty data responses', async () => {
            // Mock empty response
            birdeyeService.getTrendingTokens.mockResolvedValueOnce([]);

            const mockInteraction = {
                commandName: 'trending',
                options: { _hoistedOptions: [] },
                deferReply: jest.fn().mockResolvedValue(true),
                editReply: jest.fn().mockResolvedValue(true),
                deferred: true,
                replied: false
            };

            await bot.handleTrendingCommand(mockInteraction);

            expect(mockInteraction.editReply).toHaveBeenCalled();
            const response = mockInteraction.editReply.mock.calls[0][0];
            expect(response.embeds[0].color).toBe(0xFF0000); // Red color for error
            expect(response.embeds[0].description).toContain('Could not fetch trending tokens at this time');
        });
    });
}); 