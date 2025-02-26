require('dotenv').config();

const TwitterMonitorBot = require('./core/TwitterMonitorBot');
const BirdeyeService = require('./core/BirdeyeService');
const HeliusService = require('./core/HeliusService');

async function main() {
    try {
        console.log('🚀 Starting Twitter Monitor Bot...');
        console.log('Environment:', process.env.NODE_ENV);

        // Initialize services
        const birdeyeService = new BirdeyeService(process.env.BIRDEYE_API_KEY);
        const heliusService = new HeliusService(process.env.HELIUS_API_KEY, birdeyeService);

        // Initialize bot with dependencies
        const bot = new TwitterMonitorBot({
            heliusService,
            birdeyeService,
            config: {
                twitterApiKey: process.env.TWITTER_API_KEY,
                twitterApiSecret: process.env.TWITTER_API_KEY_SECRET,
                twitterAccessToken: process.env.TWITTER_ACCESS_TOKEN,
                twitterAccessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
                discordToken: process.env.DISCORD_BOT_TOKEN,
                guildId: process.env.DISCORD_GUILD_ID,
                tweetsChannelId: process.env.DISCORD_TWEETS_CHANNEL,
                vipChannelId: process.env.DISCORD_VIP_CHANNEL,
                walletsChannelId: process.env.DISCORD_WALLETS_CHANNEL,
                solanaChannelId: process.env.DISCORD_SOLANA_CHANNEL
            }
        });

        // Start the bot
        await bot.start();

    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

main(); 