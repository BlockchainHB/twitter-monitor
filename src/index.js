const TwitterMonitorBot = require('./core/TwitterMonitorBot');
const config = require('./config/config');
const RateLimitManager = require('./core/RateLimitManager');
const HeliusService = require('./core/HeliusService');
const DexScreenerService = require('./core/DexScreenerService');
const BirdeyeService = require('./core/BirdeyeService');
const { Client, GatewayIntentBits } = require('discord.js');

// Set production environment if not set
if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'production';
}

// Debug logging setup
process.env.DEBUG = '*';
process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('🚨 Uncaught Exception:', error);
});

// Memory usage monitoring
function logMemoryUsage() {
    const used = process.memoryUsage();
    console.log('🔧 Memory Usage:');
    for (let key in used) {
        console.log(`${key}: ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB`);
    }
}

async function initializeBot() {
    try {
        console.log('Environment:', process.env.NODE_ENV);

        // Initialize services
        const rateLimitManager = new RateLimitManager(config.twitter.rateLimit);
        const heliusService = new HeliusService(config.helius.apiKey);
        const birdeyeService = new BirdeyeService();
        const dexScreenerService = new DexScreenerService();

        // Create Discord client
        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        // Initialize bot
        const bot = new TwitterMonitorBot({
            client,
            config,
            rateLimitManager,
            services: {
                helius: heliusService,
                birdeye: birdeyeService,
                dexscreener: dexScreenerService
            }
        });

        // Initialize bot and start monitoring
        await bot.initialize();
        console.log('Bot initialization complete');

        // Log memory usage
        logMemoryUsage();

        return bot;
    } catch (error) {
        console.error('Bot initialization failed:', error);
        throw error;
    }
}

async function setupEventHandlers(bot, memoryInterval) {
    // Enhanced shutdown handling
    async function handleShutdown(signal) {
        console.log(`\n📴 Received ${signal} signal, initiating graceful shutdown...`);
        clearInterval(memoryInterval);
        
        try {
            if (bot && bot.shutdown) {
                await bot.shutdown();
            }
            console.log('✅ Shutdown completed successfully');
            process.exit(0);
        } catch (error) {
            console.error('❌ Error during shutdown:', error);
            process.exit(1);
        }
    }

    // Handle various shutdown signals
    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('SIGUSR2', () => handleShutdown('SIGUSR2'));

    // Discord.js event handlers
    if (bot.client) {
        bot.client.on('warn', info => console.log('⚠️ Discord Warning:', info));
        bot.client.on('error', error => console.error('❌ Discord Error:', error));
        bot.client.on('debug', info => console.log('🔍 Discord Debug:', info));
    }

    // Rate limit monitoring
    if (bot.rateLimitManager) {
        bot.rateLimitManager.on('debug', info => console.log('📊 Rate Limit Debug:', info));
    }
}

async function main() {
    try {
        console.log('\n🚀 Starting Twitter Monitor Bot in DEBUG mode...\n');
        
        // Log environment
        console.log('📊 Environment Configuration:');
        console.log('- NODE_ENV:', process.env.NODE_ENV);
        console.log('- Monitoring Interval:', config.monitoring.interval, 'ms');
        
        // Initialize bot with dependencies
        const bot = await initializeBot();
        if (!bot) {
            throw new Error('Failed to create bot instance');
        }

        // Set up memory monitoring
        const memoryInterval = setInterval(logMemoryUsage, 60000);

        // Set up event handlers
        await setupEventHandlers(bot, memoryInterval);

        console.log('\n✅ Bot is ready and monitoring!');
        logMemoryUsage();

    } catch (error) {
        console.error('\n❌ Fatal error during bot initialization:', error);
        process.exit(1);
    }
}

// Start the bot
console.log('🔄 Starting initialization process...');
main().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
}); 