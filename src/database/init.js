const path = require('path');
const fs = require('fs').promises;
const sqlite3 = require('sqlite3').verbose();

async function initializeDatabase() {
    // For testing, use in-memory database
    if (process.env.NODE_ENV === 'test') {
        return {
            dbFile: ':memory:',
            db: new sqlite3.Database(':memory:', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)
        };
    }

    // For production, also use in-memory database since we're not persisting data
    return {
        dbFile: ':memory:',
        db: new sqlite3.Database(':memory:', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)
    };
}

module.exports = { initializeDatabase }; 