const { PermissionsBitField } = require('discord.js');
const config = require('../config/config');
const winston = require('winston');

class SetChannelCommand {
    constructor(services) {
        this.name = 'setchannel';
        this.description = 'Set the current channel for all notifications';
        this.usage = `${config.discord.prefix}setchannel`;
        this.services = services;

        // Initialize logger
        this.logger = winston.createLogger({
            level: config.logging.level || 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            transports: [
                new winston.transports.File({ filename: 'error.log', level: 'error' }),
                new winston.transports.File({ filename: 'commands.log' })
            ]
        });

        if (process.env.NODE_ENV !== 'production') {
            this.logger.add(new winston.transports.Console({
                format: winston.format.simple()
            }));
        }
    }

    async execute(message, args) {
        try {
            this.logger.info('Executing setchannel command', {
                guildId: message.guild.id,
                channelId: message.channel.id,
                userId: message.author.id
            });

            // Verify bot permissions in the channel
            const permissions = message.channel.permissionsFor(message.guild.members.me);
            if (!permissions.has(['SendMessages', 'ViewChannel', 'EmbedLinks'])) {
                this.logger.warn('Missing bot permissions in channel', {
                    channelId: message.channel.id,
                    guildId: message.guild.id,
                    permissions: permissions.toArray()
                });

                await message.reply({
                    embeds: [{
                        title: '❌ Missing Permissions',
                        description: 'I need permissions to send messages, view, and embed links in this channel',
                        color: 0xFF0000
                    }]
                });
                return;
            }

            // Save the channel configuration for all types
            await Promise.all([
                this.services.configService.setGuildChannel(message.guild.id, 'tweets', message.channel.id),
                this.services.configService.setGuildChannel(message.guild.id, 'solana', message.channel.id),
                this.services.configService.setGuildChannel(message.guild.id, 'errors', message.channel.id)
            ]);

            this.logger.info('Channel configured successfully', {
                guildId: message.guild.id,
                channelId: message.channel.id,
                userId: message.author.id
            });

            // Send confirmation
            await message.reply({
                embeds: [{
                    title: '✅ Channel Configured',
                    description: `All notifications will now be sent to ${message.channel}`,
                    color: 0x00FF00,
                    footer: {
                        text: 'Run this command in another channel to change the notification channel'
                    }
                }]
            });

            // Send test message
            await message.channel.send({
                embeds: [{
                    title: '🔔 Channel Configuration Test',
                    description: 'This channel has been configured to receive all notifications:\n\n• Tweet notifications\n• Solana address notifications\n• Error notifications',
                    color: 0x00FF00,
                    footer: {
                        text: 'Run !setchannel in another channel to change the notification channel'
                    }
                }]
            });
        } catch (error) {
            this.logger.error('Error in setchannel command:', {
                error: error.message,
                stack: error.stack,
                guildId: message.guild.id,
                channelId: message.channel.id,
                userId: message.author.id
            });
            await message.reply('An error occurred while configuring the channel.');
        }
    }
}

module.exports = SetChannelCommand; 