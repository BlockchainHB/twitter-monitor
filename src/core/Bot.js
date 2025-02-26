const { initializeDatabase } = require('../database/init');

class Bot {
    constructor() {
        // ... existing code ...
    }

    async initialize() {
        try {
            console.log('🔄 Setting up bot...');
            
            // Initialize database directory first
            console.log('📊 Initializing database...');
            await initializeDatabase();
            
            // ... rest of initialization code ...
            
        } catch (error) {
            console.error('❌ Bot initialization failed:', error);
            throw error;
        }
    }
    
    // ... existing code ...
} 