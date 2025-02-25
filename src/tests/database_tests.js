const winston = require('winston');
const DatabaseManager = require('../core/DatabaseManager');

// Create logger for tests
const logger = winston.createLogger({
    level: 'debug',
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        })
    ]
});

async function runDatabaseTests() {
    let dbManager;
    try {
        // Initialize database manager
        dbManager = new DatabaseManager(logger);
        await dbManager.initialize();

        // Force sync database for tests
        await dbManager.sync({ force: true });

        // Test 1: Database Manager Initialization
        console.info('\nTest 1: Database Manager Initialization');
        if (!dbManager.isInitialized) {
            throw new Error('Database manager not initialized');
        }
        console.info('✅ Database manager initialized successfully');

        // Get model references
        const { MonitoredAccount, Tweet, SolanaAddress } = dbManager.models;

        // Test 2: Model Access
        console.info('\nTest 2: Model Access');
        if (!MonitoredAccount || !Tweet || !SolanaAddress) {
            throw new Error('Models not accessible');
        }
        console.info('✅ All models accessible');

        // Test 3: Basic CRUD Operations
        console.info('\nTest 3: Basic CRUD Operations');
        try {
            await dbManager.transaction(async (transaction) => {
                // Create test account
                const account = await MonitoredAccount.create({
                    account_id: '123456789',
                    monitoring_type: 'tweet',
                    is_active: true,
                    check_interval: 300,
                    error_count: 0,
                    metadata: { test: true }
                }, { transaction });

                // Create associated tweet
                const tweet = await Tweet.create({
                    tweet_id: '987654321',
                    monitored_account_id: account.id,
                    content: 'Test tweet',
                    published_at: new Date(),
                    metrics: {
                        likes: 0,
                        retweets: 0,
                        replies: 0,
                        quotes: 0,
                        impressions: 0
                    },
                    entities: { mentions: [] },
                    processed: false
                }, { transaction });

                // Read account
                const foundAccount = await MonitoredAccount.findByPk(account.id, { transaction });
                if (!foundAccount) throw new Error('Failed to find created account');

                // Update account
                await foundAccount.update({ check_interval: 600 }, { transaction });

                // Soft delete account and tweet
                await foundAccount.destroy({ transaction });
                await tweet.destroy({ transaction });
            });
            console.info('✅ CRUD operations successful');
        } catch (error) {
            console.error('❌ CRUD operations test failed:', error.message, { stack: error.stack });
            throw error;
        }

        // Test 4: Transaction Handling
        console.info('\nTest 4: Transaction Handling');
        try {
            await dbManager.transaction(async (transaction) => {
                // Create first account
                await MonitoredAccount.create({
                    account_id: 'duplicate',
                    monitoring_type: 'tweet',
                    is_active: true,
                    check_interval: 300,
                    error_count: 0,
                    metadata: { test: true }
                }, { transaction });

                // Try to create duplicate account - should fail
                await MonitoredAccount.create({
                    account_id: 'duplicate',
                    monitoring_type: 'tweet',
                    is_active: true,
                    check_interval: 300,
                    error_count: 0,
                    metadata: { test: true }
                }, { transaction });
            });
        } catch (error) {
            if (error.name === 'SequelizeUniqueConstraintError') {
                console.info('✅ Transaction rollback successful');
            } else {
                console.error('❌ Transaction handling test failed:', error.message, { stack: error.stack });
                throw error;
            }
        }

        // Test 5: Concurrent Operations
        console.info('\nTest 5: Concurrent Operations');
        try {
            const promises = Array.from({ length: 5 }, (_, i) => 
                dbManager.transaction(async (transaction) => {
                    const account = await MonitoredAccount.create({
                        account_id: `concurrent_${i}`,
                        monitoring_type: 'tweet',
                        is_active: true,
                        check_interval: 300,
                        error_count: 0,
                        metadata: { test: true }
                    }, { transaction });

                    if (i === 0) {
                        await Tweet.create({
                            tweet_id: `tweet_${i}`,
                            monitored_account_id: account.id,
                            content: 'Test concurrent tweet',
                            published_at: new Date(),
                            metrics: {
                                likes: 0,
                                retweets: 0,
                                replies: 0,
                                quotes: 0,
                                impressions: 0
                            },
                            entities: { mentions: [] },
                            processed: false
                        }, { transaction });
                    }
                })
            );

            await Promise.all(promises);
            console.info('✅ Concurrent operations successful');
        } catch (error) {
            console.error('❌ Concurrent operations test failed:', error.message, { stack: error.stack });
            throw error;
        }

        // Test 6: Model Associations
        console.info('\nTest 6: Model Associations');
        try {
            await dbManager.transaction(async (transaction) => {
                // Create test data with associations
                const account = await MonitoredAccount.create({
                    account_id: 'association-test-' + Date.now(),
                    monitoring_type: 'solana',
                    is_active: true,
                    check_interval: 300,
                    error_count: 0,
                    metadata: { test: true }
                }, { transaction });

                const tweet = await Tweet.create({
                    tweet_id: 'tweet-' + Date.now(),
                    monitored_account_id: account.id,
                    content: 'Test tweet with Solana address',
                    published_at: new Date(),
                    metrics: {
                        likes: 0,
                        retweets: 0,
                        replies: 0,
                        quotes: 0,
                        impressions: 0
                    },
                    entities: { mentions: [] },
                    processed: false
                }, { transaction });

                const address = await SolanaAddress.create({
                    address: '123456789abcdef',
                    monitored_account_id: account.id,
                    monitored_tweet_id: tweet.id,
                    verified: false
                }, { transaction });

                // Test eager loading
                const accountWithAssociations = await MonitoredAccount.findByPk(account.id, {
                    include: [
                        {
                            model: Tweet,
                            as: 'tweets',
                            include: [{
                                model: SolanaAddress,
                                as: 'solana_addresses'
                            }]
                        }
                    ],
                    transaction
                });

                if (!accountWithAssociations || !accountWithAssociations.tweets || !accountWithAssociations.tweets[0].solana_addresses) {
                    throw new Error('Failed to load associations');
                }

                console.info('✅ Model associations test successful');
            });
        } catch (error) {
            console.error('❌ Model associations test failed:', error.message, { stack: error.stack });
            throw error;
        }

    } catch (error) {
        console.error('\nDatabase tests failed:', error.message, { stack: error.stack });
        throw error;
    } finally {
        if (dbManager) {
            await dbManager.close();
            console.info('Database connection closed');
        }
    }
}

// Run the tests
runDatabaseTests().catch(error => {
    process.exit(1);
}); 