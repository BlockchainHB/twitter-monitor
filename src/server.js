const express = require('express');
const app = express();
const TwitterMonitorBot = require('./core/TwitterMonitorBot');

// Initialize bot
const bot = new TwitterMonitorBot();

// Startup logging
console.log('🚀 Starting server...');
console.log('📊 Environment:', {
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT
});

// Enable JSON parsing with increased limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Add CORS headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Add request logging
app.use((req, res, next) => {
    const start = Date.now();
    console.log(`📝 ${req.method} ${req.path} - Started`);
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`📝 ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
    });
    
    next();
});

// Options pre-flight
app.options('*', (req, res) => {
    res.status(200).end();
});

// Webhook endpoint
app.post('/api/wallet-webhook', async (req, res) => {
    try {
        console.log('📥 Webhook received');
        console.log('Headers:', req.headers);
        
        const webhook = req.body;
        console.log('📥 Webhook body:', JSON.stringify(webhook, null, 2));
        
        // Forward to bot's webhook handler
        await bot.handleWebhook(webhook);
        
        res.status(200).json({ status: 'received' });
    } catch (error) {
        console.error('❌ Error handling webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    console.log('💓 Health check requested');
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        env: process.env.NODE_ENV,
        memory: process.memoryUsage(),
        uptime: process.uptime()
    });
});

// Simple test endpoint
app.get('/test', (req, res) => {
    console.log('🧪 Test endpoint requested');
    res.send('Helius test webhook server is running!');
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server with proper error handling
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`✅ Server is running on port ${PORT}`);
    console.log(`📡 Webhook endpoint: https://${process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${PORT}`}/api/wallet-webhook`);
    console.log(`🏥 Health check: https://${process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${PORT}`}/health`);
    
    // Initialize bot
    try {
        await bot.setupBot();
        console.log('✅ Bot initialized successfully');
    } catch (error) {
        console.error('❌ Failed to initialize bot:', error);
        process.exit(1);
    }
});

// Handle server errors
server.on('error', (error) => {
    console.error('❌ Server error:', error);
});

// Keep the process alive
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
}); 