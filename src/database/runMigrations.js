const sqlite3 = require('sqlite3');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config/config');

async function runMigrations() {
    console.log('🔄 Running database migrations...');

    // Create database directory if it doesn't exist
    const dbDir = path.dirname(config.database.path);
    await fs.mkdir(dbDir, { recursive: true });

    // Connect to database with better error handling
    const db = new sqlite3.Database(config.database.path, (err) => {
        if (err) {
            console.error('❌ Failed to connect to database:', err);
            throw err;
        }
    });

    // Enable foreign keys and WAL mode
    await new Promise((resolve, reject) => {
        db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;', (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    // Promisify database operations
    const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });

    const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });

    const dbExec = (sql) => new Promise((resolve, reject) => {
        db.exec(sql, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    try {
        // Get list of migration files
        const migrationsDir = path.join(__dirname, 'migrations');
        const files = await fs.readdir(migrationsDir);
        const migrationFiles = files
            .filter(f => f.endsWith('.sql'))
            .sort();

        // Create migrations table if it doesn't exist
        await dbExec(`
            CREATE TABLE IF NOT EXISTS migrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                executed_at INTEGER DEFAULT (strftime('%s', 'now'))
            )
        `);

        // Get executed migrations
        const executed = await dbAll('SELECT name FROM migrations');
        const executedNames = new Set(executed.map(m => m.name));

        // Run pending migrations
        for (const file of migrationFiles) {
            if (!executedNames.has(file)) {
                console.log(`📦 Running migration: ${file}`);
                
                try {
                    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
                    
                    // Execute migration in a transaction
                    await dbExec('BEGIN TRANSACTION');
                    
                    try {
                        await dbExec(sql);
                        await dbRun('INSERT INTO migrations (name) VALUES (?)', [file]);
                        await dbExec('COMMIT');
                        console.log(`✅ Migration ${file} completed successfully`);
                    } catch (error) {
                        await dbExec('ROLLBACK');
                        throw error;
                    }
                } catch (error) {
                    console.error(`❌ Error in migration ${file}:`, error);
                    throw error;
                }
            } else {
                console.log(`⏭️ Skipping already executed migration: ${file}`);
            }
        }

        console.log('✅ All migrations completed successfully');
    } catch (error) {
        console.error('❌ Migration error:', error);
        throw error;
    } finally {
        // Close database connection
        await new Promise((resolve) => {
            db.close((err) => {
                if (err) console.error('Warning: Error closing database:', err);
                resolve();
            });
        });
    }
}

// Run migrations if called directly
if (require.main === module) {
    runMigrations()
        .then(() => {
            console.log('✅ Migrations completed successfully');
            process.exit(0);
        })
        .catch(error => {
            console.error('❌ Migration failed:', error);
            process.exit(1);
        });
}

module.exports = { runMigrations }; 