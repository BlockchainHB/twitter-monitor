const { Sequelize } = require('sequelize');
const winston = require('winston');
const path = require('path');
const sqlite3 = require('sqlite3');
const { promisify } = require('util');
const fs = require('fs').promises;
const config = require('../config');

// Test logger setup
const testLogger = winston.createLogger({
    level: 'debug',
    transports: [
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

async function setupTestDatabase() {
    // Create data directory if it doesn't exist
    const dataDir = path.dirname(config.database.path);
    await fs.mkdir(dataDir, { recursive: true });

    // Remove existing database if it exists
    try {
        await fs.unlink(config.database.path);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    // Create new database
    const db = new sqlite3.Database(config.database.path);
    const dbRun = promisify(db.run.bind(db));

    // Enable foreign keys and WAL mode
    await dbRun('PRAGMA foreign_keys = ON');
    await dbRun('PRAGMA journal_mode = WAL');

    // Create tables
    await dbRun(`
        CREATE TABLE IF NOT EXISTS monitored_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            twitter_id TEXT,
            monitoring_type TEXT NOT NULL,
            is_active BOOLEAN DEFAULT 1,
            last_tweet_id TEXT,
            profile_data TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create indexes
    await dbRun('CREATE INDEX IF NOT EXISTS idx_monitored_accounts_username ON monitored_accounts(username)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_monitored_accounts_type ON monitored_accounts(monitoring_type)');
    await dbRun('CREATE UNIQUE INDEX IF NOT EXISTS idx_monitored_accounts_unique ON monitored_accounts(username, monitoring_type)');

    return db;
}

async function cleanupTestDatabase() {
    try {
        await fs.unlink(config.database.path);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

module.exports = {
    setupTestDatabase,
    cleanupTestDatabase,
    testLogger
}; 