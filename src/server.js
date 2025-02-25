const express = require('express');
const app = express();

// Enable JSON parsing
app.use(express.json({ limit: '10mb' }));

// Webhook endpoint
app.post('/api/wallet-webhook', async (req, res) => {
    try {
        const webhook = req.body;
        console.log('📥 Received webhook:', JSON.stringify(webhook, null, 2));
        
        // Log specific transaction details if present
        if (webhook.events) {
            webhook.events.forEach((event, index) => {
                console.log(`🔍 Event ${index + 1}:`, {
                    type: event.type,
                    signature: event.signature,
                    timestamp: event.timestamp
                });
            });
        }
        
        res.status(200).json({ status: 'received' });
    } catch (error) {
        console.error('❌ Error handling webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

// Simple test endpoint
app.get('/test', (req, res) => {
    res.send('Helius test webhook server is running!');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Test webhook server running on port ${PORT}`);
    console.log(`📡 Webhook endpoint: http://localhost:${PORT}/api/wallet-webhook`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
}); 