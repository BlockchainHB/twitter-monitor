const fs = require('fs').promises;
const path = require('path');

async function initializeDatabase() {
    const isProduction = process.env.NODE_ENV === 'production';
    
    // Check for Railway volume mount
    const railwayVolume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    const dbPath = railwayVolume || (isProduction ? '/app/data' : path.join(process.cwd(), 'data'));
    const dbFile = path.join(dbPath, 'twitter-monitor.db');

    try {
        console.log('📁 Creating database directory:', dbPath);
        
        // Ensure the database directory exists with proper permissions
        await fs.mkdir(dbPath, { 
            recursive: true,
            mode: 0o777 // Full permissions for Railway environment
        });
        
        // Check if directory is writable by attempting to write a temp file
        const testFile = path.join(dbPath, '.write-test');
        try {
            await fs.writeFile(testFile, 'test');
            await fs.unlink(testFile);
            console.log('✅ Database directory is writable');
        } catch (error) {
            console.error('❌ Directory write test failed:', error);
            
            // Try to fix permissions
            try {
                await fs.chmod(dbPath, 0o777);
                console.log('✅ Updated directory permissions');
                
                // Test again
                await fs.writeFile(testFile, 'test');
                await fs.unlink(testFile);
                console.log('✅ Directory is now writable after permission update');
            } catch (chmodError) {
                console.error('❌ Failed to update directory permissions:', chmodError);
                throw chmodError;
            }
        }
        
        // Ensure database file is writable if it exists
        try {
            await fs.access(dbFile, fs.constants.W_OK);
            console.log('✅ Existing database file is writable');
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('Database file does not exist yet, will be created');
            } else {
                console.log('Attempting to set database file permissions...');
                try {
                    await fs.chmod(dbFile, 0o666);
                    console.log('✅ Updated database file permissions');
                } catch (chmodError) {
                    if (chmodError.code !== 'ENOENT') {
                        console.error('❌ Failed to update database file permissions:', chmodError);
                        throw chmodError;
                    }
                }
            }
        }
        
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