const sqlite3 = require('sqlite3');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config/config');

async function runMigrations() {
    console.log('🔄 Running database migrations...');

    // Create database directory if it doesn't exist
    const dbDir = path.dirname(config.database.path);
    await fs.mkdir(dbDir, { recursive: true });

    // Connect to database
    const db = new sqlite3.Database(config.database.path);
    const dbRun = (sql) => new Promise((resolve, reject) => {
        db.run(sql, (err) => err ? reject(err) : resolve());
    });
    const dbAll = (sql) => new Promise((resolve, reject) => {
        db.all(sql, (err, rows) => err ? reject(err) : resolve(rows));
    });

    try {
        // Get list of migration files
        const migrationsDir = path.join(__dirname, 'migrations');
        const files = await fs.readdir(migrationsDir);
        const migrationFiles = files
            .filter(f => f.endsWith('.sql'))
            .sort(); // Ensure order by filename

        // Create migrations table if it doesn't exist
        await dbRun(`
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
                    await dbRun('BEGIN TRANSACTION');
                    await dbRun(sql);
                    await dbRun(`INSERT INTO migrations (name) VALUES (?)`, [file]);
                    await dbRun('COMMIT');
                    console.log(`✅ Migration ${file} completed successfully`);
                } catch (error) {
                    console.error(`❌ Error in migration ${file}:`, error);
                    await dbRun('ROLLBACK');
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
        await new Promise((resolve, reject) => {
            db.close(err => err ? reject(err) : resolve());
        });
    }
}

// Run migrations if called directly
if (require.main === module) {
    runMigrations()
        .then(() => process.exit(0))
        .catch(error => {
            console.error('Migration failed:', error);
            process.exit(1);
        });
}

module.exports = { runMigrations }; 