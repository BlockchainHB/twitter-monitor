require('dotenv').config({ path: '.env.test' });
const TwitterMonitorBot = require('./src/core/TwitterMonitorBot');
const { registerCommands } = require('./src/commands/registerCommands');

async function startTestBot() {
    try {
        console.log('🧪 Starting bot in TEST mode...');
        
        // Register commands in test guild
        console.log('📝 Registering commands in test guild...');
        try {
            await registerCommands();
            console.log('✅ Commands registered successfully');
        } catch (error) {
            console.error('❌ Failed to register commands:', error);
            throw error;
        }
        
        // Initialize bot
        console.log('🤖 Initializing bot instance...');
        const bot = new TwitterMonitorBot();
        
        console.log('🔄 Setting up bot...');
        try {
            await bot.setupBot();
            console.log('✅ Bot setup completed successfully');
        } catch (error) {
            console.error('❌ Bot setup failed:', error);
            if (error.response) {
                console.error('API Response:', {
                    status: error.response.status,
                    data: error.response.data,
                    headers: error.response.headers
                });
            }
            throw error;
        }
        
        console.log('✅ Test bot is running!');
        console.log('📌 Press Ctrl+C to shutdown');
        
        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\n🛑 Shutting down test bot...');
            try {
                await bot.shutdown();
                console.log('✅ Bot shutdown completed');
                process.exit(0);
            } catch (error) {
                console.error('❌ Shutdown error:', error);
                process.exit(1);
            }
        });

        // Add error event handlers
        bot.client.on('error', error => {
            console.error('❌ Discord client error:', error);
        });

        bot.client.on('warn', warning => {
            console.warn('⚠️ Discord client warning:', warning);
        });

        process.on('unhandledRejection', (error) => {
            console.error('❌ Unhandled promise rejection:', error);
        });

    } catch (error) {
        console.error('❌ Test bot startup failed:', error);
        process.exit(1);
    }
}

// Start the bot
startTestBot(); 