const path = require('path');
const fs = require('fs').promises;
const sqlite3 = require('sqlite3').verbose();
const config = require('../config/config');

async function initializeDatabase() {
    // For testing, use in-memory database
    if (process.env.NODE_ENV === 'test') {
        return {
            dbFile: ':memory:',
            db: new sqlite3.Database(':memory:', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)
        };
    }

    // For production, use persistent database
    const dbDir = path.dirname(config.database.path);
    
    // Ensure database directory exists
    await fs.mkdir(dbDir, { recursive: true });
    
    console.log(`Initializing database at ${config.database.path}`);
    
    return {
        dbFile: config.database.path,
        db: new sqlite3.Database(config.database.path, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)
    };
}

module.exports = { initializeDatabase }; 