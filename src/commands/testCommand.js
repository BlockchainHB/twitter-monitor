const TwitterMonitorBot = require('../TwitterMonitorBot');
const fs = require('fs').promises;
const path = require('path');
const { Sequelize } = require('sequelize');
const { MonitoredAccountModel, TweetModel, SolanaAddressModel } = require('../models');

// Use a dedicated test database file
const TEST_DB_PATH = path.join(process.cwd(), 'data', 'test.db');

async function setupTestEnvironment() {
    console.log('\n🔧 Setting up test environment...');
    
    // Create data directory if it doesn't exist
    const dataDir = path.join(process.cwd(), 'data');
    try {
        await fs.mkdir(dataDir, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }

    // Remove existing test database if it exists
    try {
        await fs.unlink(TEST_DB_PATH);
        console.log('Cleaned up existing test database');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    // Initialize Sequelize
    const sequelize = new Sequelize({
        dialect: 'sqlite',
        storage: TEST_DB_PATH,
        logging: false
    });

    // Initialize models
    MonitoredAccountModel.init(sequelize);
    TweetModel.init(sequelize);
    SolanaAddressModel.init(sequelize);

    // Set up associations
    MonitoredAccountModel.associate({ 
        Tweet: TweetModel, 
        SolanaAddress: SolanaAddressModel 
    });
    TweetModel.associate({ 
        MonitoredAccount: MonitoredAccountModel, 
        SolanaAddress: SolanaAddressModel 
    });
    SolanaAddressModel.associate({ 
        MonitoredAccount: MonitoredAccountModel, 
        Tweet: TweetModel 
    });

    // Sync database
    await sequelize.sync({ force: true });

    // Override database path for testing
    process.env.DATABASE_PATH = TEST_DB_PATH;
    console.log('✅ Test environment ready');
}

async function simulateCommand(bot, commandName, options = {}) {
    console.log(`\n🔍 Testing command: ${commandName}`);
    
    // Simulate Discord interaction
    const interaction = {
        commandName,
        options: {
            getString: (key) => options[key]
        },
        user: {
            tag: 'TestUser#0000',
            id: '123456789'
        },
        channel: {
            name: 'twitter-tracker',
            id: '1341473064893943828',
            send: async (message) => {
                console.log('📨 Channel notification:', message.embeds?.[0] || message);
                return true;
            }
        },
        guildId: '1335773124851142656',
        reply: async (message) => {
            if (typeof message === 'string') {
                console.log('Response:', message);
            } else {
                console.log('Response:', message.embeds?.[0] || message);
            }
            return true;
        },
        replied: false,
        deferred: false,
        deferReply: async () => {
            interaction.deferred = true;
            return true;
        },
        editReply: async (message) => {
            console.log('Edit Response:', message.embeds?.[0] || message);
            return true;
        }
    };

    try {
        await bot.handleCommand(interaction);
        console.log('✅ Command executed successfully');
        return true;
    } catch (error) {
        console.error('❌ Command failed:', error.message);
        return false;
    }
}

async function waitForNotifications(duration = 5000) {
    console.log(`\n⏳ Waiting ${duration/1000} seconds for notifications...`);
    await new Promise(resolve => setTimeout(resolve, duration));
}

async function simulateTweetWithAddress(bot, accountId, tweetContent) {
    console.log(`\n🔄 Simulating tweet from ${accountId}:`);
    console.log(tweetContent);
    
    // Simulate tweet processing
    try {
        const tweet = {
            id: Date.now().toString(),
            text: tweetContent,
            created_at: new Date().toISOString(),
            author_id: accountId
        };

        await bot.processTweet(accountId, tweet);
        console.log('✅ Tweet processed');
    } catch (error) {
        console.error('❌ Tweet processing failed:', error);
    }
}

async function runSolanaTests() {
    console.log('🚀 Starting Solana address verification tests...\n');
    
    // Set up test environment
    await setupTestEnvironment();
    
    const bot = new TwitterMonitorBot();
    await bot.setupBot();

    // Monitor a test account for Solana addresses
    await simulateCommand(bot, 'monitor', {
        twitter_id: 'solana',
        type: 'solana'
    });

    // Test valid Solana address
    await simulateTweetWithAddress(
        bot,
        '951329744804392960', // Solana's Twitter ID
        'Check out this Solana address: 7Nw66LmJB6YzHsgEGQ8oDSSsJ4YzMkgqmenRnZx11RVD'
    );
    await waitForNotifications();

    // Test multiple addresses in one tweet
    await simulateTweetWithAddress(
        bot,
        '951329744804392960',
        'Multiple addresses test:\n' +
        '1. 7Nw66LmJB6YzHsgEGQ8oDSSsJ4YzMkgqmenRnZx11RVD\n' +
        '2. 2TxPS4SvwdhqwgZJx6QHWUvYdyGLspW3BfmfmUZL6deX'
    );
    await waitForNotifications();

    // Test invalid address format
    await simulateTweetWithAddress(
        bot,
        '951329744804392960',
        'Invalid address test: NOT_A_SOLANA_ADDRESS_123'
    );
    await waitForNotifications();

    // Test address with context
    await simulateTweetWithAddress(
        bot,
        '951329744804392960',
        '🚨 Important: Send contributions to 7Nw66LmJB6YzHsgEGQ8oDSSsJ4YzMkgqmenRnZx11RVD for the community fund'
    );
    await waitForNotifications();

    // Check verification status
    await simulateCommand(bot, 'list');

    console.log('\n✨ Solana address verification tests complete!');
}

// Run tests if called directly
if (require.main === module) {
    runSolanaTests()
        .then(() => process.exit(0))
        .catch(error => {
            console.error('Test error:', error);
            process.exit(1);
        });
}

module.exports = {
    simulateCommand,
    runSolanaTests
}; 