const TwitterMonitorBot = require('./core/TwitterMonitorBot');
const config = require('./config/config');

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

async function main() {
    try {
        console.log('\n🚀 Starting Twitter Monitor Bot in DEBUG mode...\n');
        
        // Log environment
        console.log('📊 Environment Configuration:');
        console.log('- NODE_ENV:', process.env.NODE_ENV);
        console.log('- Database Path:', config.database.path);
        console.log('- Monitoring Interval:', config.monitoring.interval, 'ms');
        
        // Create bot instance
        console.log('\n🤖 Initializing Bot Instance...');
        const bot = new TwitterMonitorBot();

        // Set up periodic memory logging
        const memoryInterval = setInterval(logMemoryUsage, 60000);

        // Log startup phases
        console.log('\n📋 Starting Setup Sequence:');
        await bot.setupBot();
        console.log('\n✅ Bot is ready and monitoring!');
        logMemoryUsage();

        // Enhanced shutdown handling
        async function handleShutdown(signal) {
            console.log(`\n📴 Received ${signal} signal, initiating graceful shutdown...`);
            clearInterval(memoryInterval);
            
            try {
                await bot.shutdown();
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
        process.on('SIGUSR2', () => handleShutdown('SIGUSR2')); // nodemon restart

        // Log any Discord.js warnings
        bot.client.on('warn', info => console.log('⚠️ Discord Warning:', info));
        bot.client.on('error', error => console.error('❌ Discord Error:', error));
        bot.client.on('debug', info => console.log('🔍 Discord Debug:', info));

        // Rate limit monitoring
        bot.rateLimitManager.on('debug', info => console.log('📊 Rate Limit Debug:', info));

    } catch (error) {
        console.error('\n❌ Failed to start bot:', error);
        process.exit(1);
    }
}

// Start the bot with error handling
console.log('🔄 Initializing...');
main().catch(error => {
    console.error('❌ Fatal error during initialization:', error);
    process.exit(1);
}); 