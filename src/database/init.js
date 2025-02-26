const fs = require('fs').promises;
const path = require('path');

async function initializeDatabase() {
    const isProduction = process.env.NODE_ENV === 'production';
    const dbPath = isProduction ? '/app/data' : path.join(process.cwd(), 'data');
    const dbFile = path.join(dbPath, 'twitter-monitor.db');

    try {
        // Ensure the database directory exists
        await fs.mkdir(dbPath, { recursive: true });
        
        // Check if directory is writable by attempting to write a temp file
        const testFile = path.join(dbPath, '.write-test');
        await fs.writeFile(testFile, 'test');
        await fs.unlink(testFile);
        
        console.log('✅ Database directory created and writable:', dbPath);
        
        return {
            dbPath,
            dbFile
        };
    } catch (error) {
        console.error('❌ Failed to initialize database directory:', error);
        throw error;
    }
}

module.exports = { initializeDatabase }; 