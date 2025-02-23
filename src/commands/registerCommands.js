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