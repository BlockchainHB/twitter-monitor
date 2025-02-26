const sqlite3 = require('sqlite3').verbose();

async function initializeDatabase() {
    return {
        dbFile: ':memory:',
        db: new sqlite3.Database(':memory:', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)
    };
}

module.exports = { initializeDatabase }; 