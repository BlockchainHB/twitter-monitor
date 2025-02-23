// Set test environment
process.env.NODE_ENV = 'test';

const { Sequelize } = require('sequelize');
const winston = require('winston');

// Create test logger
const testLogger = winston.createLogger({
    level: 'debug',
    format: winston.format.simple(),
    transports: [
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

// Create test database
const testDb = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false
});

// Initialize test database
beforeAll(async () => {
    try {
        await testDb.authenticate();
        await testDb.sync({ force: true });
        testLogger.info('Test database initialized');
    } catch (error) {
        testLogger.error('Failed to initialize test database:', error);
        throw error;
    }
});

// Reset database before each test
beforeEach(async () => {
    try {
        await testDb.sync({ force: true });
        testLogger.info('Test database reset');
    } catch (error) {
        testLogger.error('Failed to reset test database:', error);
        throw error;
    }
});

// Close database connection after all tests
afterAll(async () => {
    try {
        await testDb.close();
        testLogger.info('Test database connection closed');
    } catch (error) {
        testLogger.error('Failed to close test database:', error);
        throw error;
    }
});

// Export test utilities
module.exports = {
    testDb,
    testLogger
}; 