# Twitter Monitor Discord Bot

Discord bot for monitoring Twitter accounts and Solana wallets.

## Required Environment Variables

### Twitter API
- `TWITTER_API_KEY`
- `TWITTER_API_KEY_SECRET`
- `TWITTER_BEARER_TOKEN`
- `TWITTER_ACCESS_TOKEN`
- `TWITTER_ACCESS_TOKEN_SECRET`

### Discord Configuration
- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `TWEETS_CHANNEL_ID`
- `SOLANA_CHANNEL_ID`
- `VIP_CHANNEL_ID`
- `WALLETS_CHANNEL_ID`

### Helius Configuration
- `HELIUS_API_KEY`
- `HELIUS_WEBHOOK_URL`

### Optional Configuration
- `NODE_ENV` - Set to 'production' for deployment
- `MONITORING_INTERVAL` - Interval in milliseconds (default: 60000)

### Optional SMS Alerts (Twilio)
If you want to enable SMS alerts, set all of these:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`

## Deployment

1. Set all required environment variables in Railway
2. The bot will automatically:
   - Initialize the database
   - Register Discord commands
   - Start monitoring configured wallets and Twitter accounts

## Features

- Monitor Twitter accounts for new tweets
- Track Solana wallet transactions
- SMS notifications for large swaps (≥ $1000) - *requires Twilio configuration*
- Discord notifications for all swaps (≥ $100)
- Token security and metrics analysis
- Trending/gainers/volume tracking 