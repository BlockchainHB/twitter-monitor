# Twitter Monitor Discord Bot

A Discord bot that monitors Twitter accounts and sends real-time notifications for new tweets with rich embeds.

## Features

- Real-time Twitter monitoring for multiple accounts
- Rich Discord embeds including:
  - Tweet content
  - Author profile information
  - Media attachments (images)
  - Direct links to tweets
  - Timestamps
- Rate limit aware monitoring system
- Discord slash commands for easy management
- SQLite database for persistent storage

## Commands

- `/monitor <twitter_username>` - Start monitoring a Twitter account
- `/unmonitor <twitter_username>` - Stop monitoring a Twitter account
- `/list` - List all monitored accounts
- `/help` - Display help information

## Setup

1. Clone the repository
```bash
git clone https://github.com/blockchainhb/TwitterBotV2.git
cd TwitterBotV2
```

2. Install dependencies
```bash
npm install
```

3. Create a `.env` file with your credentials:
```env
DISCORD_TOKEN=your_discord_bot_token
TWITTER_BEARER_TOKEN=your_twitter_bearer_token
```

4. Start the bot
```bash
npm start
```

For development:
```bash
DEBUG=twitter-monitor*,discord* NODE_ENV=development node --trace-warnings src/index.js
```

## Requirements

- Node.js 16.x or higher
- Discord Bot Token
- Twitter API Bearer Token (v2)

## Architecture

The bot is built with a focus on rate limit management and reliability:
- Central rate limit management system
- Modular component structure
- Efficient queue management
- Comprehensive error handling
- State persistence

## License

MIT License - See LICENSE file for details

## Credits
Created by HB from KEK Labs

## Support
For support, please open an issue in the repository or contact HB from KEK Labs. 