const path = require('path');

// SQLite-specific configuration
const dialectOptions = {
    foreignKeys: true,
    mode: process.env.NODE_ENV === 'test' ? 'memory' : null,
    timeout: 60000,
    busyTimeout: 60000,
    // Journal mode
    journal_mode: 'WAL',
    // Synchronous setting for better performance
    synchronous: 'NORMAL',
    // Cache settings
    cache: 'shared'
};

// Pool configuration
const poolConfig = {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
};

// Database configuration
const config = {
    development: {
        dialect: 'sqlite',
        storage: path.join(process.cwd(), 'data', 'twitter-monitor.db'),
        logging: console.log,
        define: {
            timestamps: true,
            underscored: true,
            paranoid: true
        },
        dialectOptions,
        pool: poolConfig
    },
    test: {
        dialect: 'sqlite',
        storage: ':memory:',
        logging: false,
        define: {
            timestamps: true,
            underscored: true,
            paranoid: true
        },
        dialectOptions,
        pool: poolConfig
    },
    production: {
        dialect: 'sqlite',
        storage: path.join(process.cwd(), 'data', 'twitter-monitor.db'),
        logging: false,
        define: {
            timestamps: true,
            underscored: true,
            paranoid: true
        },
        dialectOptions,
        pool: poolConfig
    }
};

module.exports = config[process.env.NODE_ENV || 'development'];