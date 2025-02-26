const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

async function runMigrations() {
    console.log('📦 Starting database migrations...');
    
    // Ensure database directory exists
    const dbDir = path.dirname(config.database.path);
    await fs.mkdir(dbDir, { recursive: true });
    
    let db;
    try {
        // Open database connection with WAL mode
        db = await open({
            filename: config.database.path,
            driver: sqlite3.Database
        });
        
        // Enable foreign keys and WAL mode
        await db.exec('PRAGMA foreign_keys = ON;');
        await db.exec('PRAGMA journal_mode = WAL;');
        
        // Get list of migration files
        const migrationsDir = path.join(__dirname, 'migrations');
        const files = await fs.readdir(migrationsDir);
        const migrationFiles = files
            .filter(f => f.endsWith('.sql'))
            .sort();
            
        // Run each migration in a transaction
        for (const file of migrationFiles) {
            const migrationPath = path.join(migrationsDir, file);
            console.log(`📦 Running migration: ${file}`);
            
            try {
                // Read migration SQL
                const sql = await fs.readFile(migrationPath, 'utf8');
                
                // Execute migration
                await db.exec(sql);
                console.log(`✅ Successfully applied migration: ${file}`);
                
            } catch (error) {
                console.error(`❌ Error in migration ${file}:`, error);
                
                // Attempt rollback if transaction is active
                try {
                    await db.exec('ROLLBACK;');
                } catch (rollbackError) {
                    // Ignore rollback errors
                }
                
                throw error;
            }
        }
        
        console.log('✅ All migrations completed successfully');
        
    } catch (error) {
        console.error('❌ Migration error:', error);
        throw error;
        
    } finally {
        if (db) {
            await db.close();
        }
    }
}

// Run migrations if called directly
if (require.main === module) {
    runMigrations()
        .catch(error => {
            console.error('Migration failed:', error);
            process.exit(1);
        });
}

module.exports = runMigrations; 