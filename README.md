# Twitter Solana Monitor Bot

A comprehensive Discord bot that monitors Twitter accounts for Solana token mentions and tracks wallet transactions in real-time. Perfect for crypto trading communities and DeFi enthusiasts.

## 🚀 Features

### Twitter Monitoring
- **Real-time Tweet Tracking**: Monitor multiple Twitter accounts for new tweets
- **VIP Account Support**: Special notifications for high-priority accounts
- **Solana Address Detection**: Automatically detect and analyze Solana token addresses in tweets
- **Rate Limit Management**: Intelligent handling of Twitter API rate limits

### Wallet Tracking
- **Transaction Monitoring**: Track Solana wallet transactions via Helius webhooks
- **Value Filtering**: Configurable minimum transaction values for notifications
- **SMS Alerts**: Optional SMS notifications for high-value transactions (via Twilio)
- **Real-time Analysis**: Instant token metrics and security analysis

### Token Analysis
- **Market Data**: Real-time price, market cap, and volume information
- **Security Analysis**: Token security metrics and risk assessment
- **Holder Analytics**: Top holders and trading activity
- **Trending Tokens**: Track trending and gaining tokens
- **Chart Integration**: Direct links to DEX Screener charts

## 🛠️ Technology Stack

- **Node.js** (≥18.0.0)
- **Discord.js** v14 - Discord bot framework
- **Twitter API v2** - Twitter data access
- **Helius API** - Solana blockchain data
- **Birdeye API** - Token metrics and analysis
- **Twilio** (Optional) - SMS notifications

## 📦 Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/BlockchainHB/twitter-solana-monitor.git
   cd twitter-solana-monitor
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your API credentials
   ```

4. **Set up wallet tracking** (Optional)
   ```bash
   # Edit src/config/wallets.json with wallet addresses to track
   npm run configure-webhook
   ```

## ⚙️ Configuration

### Required Environment Variables

#### Twitter API
Get these from [Twitter Developer Portal](https://developer.twitter.com/):
```env
TWITTER_API_KEY=your_twitter_api_key
TWITTER_API_KEY_SECRET=your_twitter_api_key_secret
TWITTER_BEARER_TOKEN=your_twitter_bearer_token
TWITTER_ACCESS_TOKEN=your_twitter_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_twitter_access_token_secret
```

#### Discord Bot
Create a bot at [Discord Developer Portal](https://discord.com/developers/applications):
```env
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_GUILD_ID=your_discord_guild_id
DISCORD_TWEETS_CHANNEL_ID=your_tweets_channel_id
DISCORD_SOLANA_CHANNEL_ID=your_solana_channel_id
DISCORD_VIP_CHANNEL_ID=your_vip_channel_id
DISCORD_WALLETS_CHANNEL_ID=your_wallets_channel_id
```

#### API Services
```env
HELIUS_API_KEY=your_helius_api_key
HELIUS_WEBHOOK_URL=your_webhook_endpoint_url
BIRDEYE_API_KEY=your_birdeye_api_key
```

### Optional Configuration

#### SMS Alerts (Twilio)
```env
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=your_twilio_phone_number
```

#### General Settings
```env
NODE_ENV=production
MONITORING_INTERVAL=60000
HELIUS_MIN_SWAP_VALUE=100
HELIUS_MIN_SMS_SWAP_VALUE=1000
```

## 🤖 Discord Commands

### Twitter Monitoring
- `/monitor <username>` - Start monitoring a Twitter account
- `/vipmonitor <username>` - Monitor account with VIP notifications
- `/solanamonitor <username>` - Monitor for Solana token mentions only
- `/stopm <username>` - Stop monitoring an account
- `/list` - List all monitored accounts

### Wallet Tracking
- `/trackwallet <address> [name]` - Track a Solana wallet
- `/stopwallet <address>` - Stop tracking a wallet

### Market Data
- `/trending [timeframe]` - Show trending tokens
- `/gainers [timeframe]` - Show top gaining tokens
- `/losers [timeframe]` - Show top losing tokens
- `/volume [timeframe]` - Show high volume tokens
- `/newpairs [hours]` - Show recently created trading pairs

### Token Analysis
- `/security <address>` - Get token security analysis
- `/metrics <address>` - Get detailed token metrics
- `/holders <address>` - Get holder information

### Notifications
- `/smsalert <phone>` - Subscribe to SMS alerts
- `/stopsms` - Unsubscribe from SMS alerts
- `/test` - Test notification systems

## 🚀 Deployment

### Railway (Recommended)
1. Fork this repository
2. Connect to [Railway](https://railway.app)
3. Set environment variables in Railway dashboard
4. Deploy automatically

### Local Development
```bash
npm run dev
```

### Production
```bash
npm start
```

## 📊 How It Works

1. **Twitter Monitoring**: The bot continuously polls monitored Twitter accounts for new tweets
2. **Address Detection**: Uses regex patterns to identify Solana addresses in tweet content
3. **Token Analysis**: Fetches real-time data from Birdeye API for any detected tokens
4. **Wallet Tracking**: Helius webhooks provide instant notifications for tracked wallet activity
5. **Discord Integration**: All events are formatted as rich embeds and sent to designated channels
6. **SMS Alerts**: High-value transactions trigger SMS notifications to subscribed users

## 🔧 API Integration

### Supported APIs
- **Twitter API v2**: Tweet monitoring and user data
- **Helius**: Solana blockchain data and webhooks
- **Birdeye**: Token metrics, security, and market data
- **DexScreener**: Chart data and trading pairs
- **Twilio**: SMS notifications (optional)

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## ⚠️ Security Notice

- Never commit real API keys or tokens to the repository
- Use environment variables for all sensitive configuration
- The `.env.test` file contains placeholder values only
- Always review code for hardcoded credentials before deployment

## 📞 Support

- Create an issue for bug reports or feature requests
- Join our Discord community for real-time support
- Check the [Wiki](../../wiki) for detailed setup guides

## 🔮 Roadmap

- [ ] Add support for multiple blockchains
- [ ] Implement advanced filtering and alerts
- [ ] Add web dashboard for configuration
- [ ] Enhanced analytics and reporting
- [ ] Mobile app companion

---

Built with ❤️ for the crypto community