require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const TwitterMonitorBot = require('./core/TwitterMonitorBot');
const BirdeyeService = require('./core/BirdeyeService');
const HeliusService = require('./core/HeliusService');

async function main() {
    try {
        console.log('🚀 Starting Twitter Monitor Bot...');
        console.log('Environment:', process.env.NODE_ENV);

        // Initialize Discord client with required intents
        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        // Initialize services
        const birdeyeService = new BirdeyeService(process.env.BIRDEYE_API_KEY);
        const heliusService = new HeliusService(process.env.HELIUS_API_KEY, birdeyeService);

        // Initialize bot with dependencies
        const bot = new TwitterMonitorBot({
            client,  // Pass the Discord client
            heliusService,
            birdeyeService,
            config: {
                twitterApiKey: process.env.TWITTER_API_KEY,
                twitterApiSecret: process.env.TWITTER_API_KEY_SECRET,
                twitterAccessToken: process.env.TWITTER_ACCESS_TOKEN,
                twitterAccessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
                discordToken: process.env.DISCORD_BOT_TOKEN,
                clientId: process.env.DISCORD_CLIENT_ID,
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