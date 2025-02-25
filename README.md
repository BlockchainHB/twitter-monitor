# Helius Webhook Test Server

A minimal server for testing Helius webhooks integration.

## Endpoints

- `GET /test` - Simple endpoint to verify server is running
- `GET /health` - Health check endpoint
- `POST /api/wallet-webhook` - Helius webhook endpoint

## Development

```bash
npm install
npm start
```

## Deployment

Deploy as a web service on Railway:
1. Connect to this GitHub repository
2. Service Type: Web Service
3. Start Command: `npm start`
4. Environment Variables: None required

The webhook URL will be: `https://[your-railway-app].railway.app/api/wallet-webhook` 