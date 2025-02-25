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
        name: 'vipmonitor',
        description: 'Start monitoring a VIP Twitter account',
        options: [
            {
                name: 'twitter_id',
                description: 'Twitter username to monitor (without @)',
                type: 3, // STRING type
                required: true
            }
        ]
    },
    {
        name: 'list',
        description: 'List all monitored Twitter accounts'
    },
    {
        name: 'test',
        description: 'Run a test notification'
    },
    {
        name: 'trending',
        description: 'Show trending Solana memecoin gems (24H)'
    },
    {
        name: 'gainers',
        description: 'Show top gaining Solana tokens (24H)'
    },
    {
        name: 'holders',
        description: 'Show holder information for a token',
        options: [
            {
                name: 'address',
                description: 'Token address',
                type: 3, // STRING type
                required: true
            }
        ]
    },
    {
        name: 'security',
        description: 'Show security information for a token',
        options: [
            {
                name: 'address',
                description: 'Token address',
                type: 3, // STRING type
                required: true
            }
        ]
    },
    {
        name: 'metrics',
        description: 'Show detailed metrics for a token',
        options: [
            {
                name: 'address',
                description: 'Token address',
                type: 3, // STRING type
                required: true
            }
        ]
    },
    {
        name: 'volume',
        description: 'Show top volume Solana tokens (24H)'
    },
    {
        name: 'help',
        description: 'Show all available commands and their usage'
    },
    {
        name: 'smsalert',
        description: 'Register your phone number for Solana token notifications',
        options: [
            {
                name: 'phone',
                description: 'Phone number in international format (e.g., +1234567890)',
                type: 3,
                required: true
            }
        ]
    },
    {
        name: 'stopsms',
        description: 'Stop receiving SMS notifications'
    },
    {
        name: 'trackwallet',
        description: 'Track a Solana wallet',
        options: [
            {
                name: 'name',
                description: 'Name to identify this wallet',
                type: 3,
                required: true
            },
            {
                name: 'wallet',
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
                name: 'wallet',
                description: 'Solana wallet address to stop tracking',
                type: 3,
                required: true
            }
        ]
    }
];

// Create REST instance
const rest = new REST({ version: '10' }).setToken(config.discord.token);

async function registerCommands() {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
            { body: commands }
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

// Run if called directly
if (require.main === module) {
    registerCommands();
}

module.exports = { registerCommands }; 