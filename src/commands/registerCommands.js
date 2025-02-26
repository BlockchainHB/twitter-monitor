const { REST, Routes } = require('discord.js');
const config = require('../config/config');

// Command definitions
const commands = [
    {
        name: 'monitor',
        description: 'Start monitoring a Twitter account',
        options: [
            {
                name: 'twitter_id',
                description: 'Twitter username to monitor (without @)',
                type: 3, // STRING type
                required: true
            },
            {
                name: 'type',
                description: 'What to monitor for',
                type: 3, // STRING type
                required: true,
                choices: [
                    {
                        name: 'All Tweets',
                        value: 'tweet'
                    },
                    {
                        name: 'Solana Addresses',
                        value: 'solana'
                    }
                ]
            }
        ]
    },
    {
        name: 'stopm',
        description: 'Stop monitoring a Twitter account',
        options: [
            {
                name: 'twitter_id',
                description: 'Twitter username to stop monitoring (without @)',
                type: 3, // STRING type
                required: true
            }
        ]
    },
    {
        name: 'list',
        description: 'List all monitored accounts and wallets'
    },
    {
        name: 'test',
        description: 'Test bot functionality and permissions'
    },
    {
        name: 'help',
        description: 'Show available commands and their usage'
    },
    {
        name: 'vipmonitor',
        description: 'Start monitoring a VIP Twitter account',
        options: [
            {
                name: 'twitter_id',
                description: 'Twitter username to monitor (without @)',
                type: 3,
                required: true
            }
        ]
    },
    {
        name: 'trackwallet',
        description: 'Track a Solana wallet\'s transactions',
        options: [
            {
                name: 'address',
                description: 'Solana wallet address to track',
                type: 3,
                required: true
            }
        ]
    },
    {
        name: 'stopwallet',
        description: 'Stop tracking a wallet',
        options: [
            {
                name: 'address',
                description: 'Solana wallet address to stop tracking',
                type: 3,
                required: true
            }
        ]
    },
    {
        name: 'trending',
        description: 'Show trending tokens'
    },
    {
        name: 'gainers',
        description: 'Show top gainers'
    },
    {
        name: 'losers',
        description: 'Show top losers'
    },
    {
        name: 'newpairs',
        description: 'Show new trading pairs'
    },
    {
        name: 'volume',
        description: 'Show top volume tokens'
    },
    {
        name: 'security',
        description: 'Show token security information',
        options: [
            {
                name: 'address',
                description: 'Token address to check',
                type: 3,
                required: true
            }
        ]
    },
    {
        name: 'metrics',
        description: 'Show token metrics',
        options: [
            {
                name: 'address',
                description: 'Token address to check',
                type: 3,
                required: true
            }
        ]
    },
    {
        name: 'holders',
        description: 'Show token holders information',
        options: [
            {
                name: 'address',
                description: 'Token address to check',
                type: 3,
                required: true
            }
        ]
    },
    {
        name: 'smsalert',
        description: 'Subscribe to SMS alerts',
        options: [
            {
                name: 'phone',
                description: 'Phone number (with country code)',
                type: 3,
                required: true
            }
        ]
    },
    {
        name: 'stopsms',
        description: 'Unsubscribe from SMS alerts'
    }
];

async function registerCommands(client = null) {
    try {
        console.log('Started refreshing application (/) commands.');

        // Use provided client or create new REST instance
        const rest = client ? client.rest : new REST({ version: '10' }).setToken(config.discord.token);

        await rest.put(
            Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
            { body: commands }
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
        throw error;
    }
}

// Run if called directly
if (require.main === module) {
    const { Client, GatewayIntentBits } = require('discord.js');
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    
    client.login(config.discord.token)
        .then(() => registerCommands(client))
        .then(() => process.exit(0))
        .catch(error => {
            console.error('Failed to register commands:', error);
            process.exit(1);
        });
}

module.exports = { registerCommands }; 