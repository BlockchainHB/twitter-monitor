// Load environment variables for testing
require('dotenv').config();

// Set test environment
process.env.NODE_ENV = 'test';

// Increase timeout for integration tests
jest.setTimeout(30000);

// Mock Discord.js client
jest.mock('discord.js', () => ({
    Client: jest.fn().mockImplementation(() => ({
        login: jest.fn().mockResolvedValue(true),
        destroy: jest.fn().mockResolvedValue(true),
        options: {
            intents: ['Guilds', 'GuildMessages']
        }
    })),
    GatewayIntentBits: {
        Guilds: 'Guilds',
        GuildMessages: 'GuildMessages'
    }
}));

// Mock Twitter API
jest.mock('twitter-api-v2', () => ({
    TwitterApi: jest.fn().mockImplementation(() => ({
        v2: {
            userByUsername: jest.fn().mockResolvedValue({ 
                data: { 
                    id: '123', 
                    username: 'testuser',
                    name: 'Test User',
                    profile_image_url: 'https://example.com/image.jpg'
                } 
            }),
            userTimeline: jest.fn().mockResolvedValue({ data: [] }),
            user: jest.fn().mockResolvedValue({
                data: {
                    id: '123',
                    username: 'testuser',
                    name: 'Test User',
                    profile_image_url: 'https://example.com/image.jpg',
                    public_metrics: {}
                }
            })
        },
        readWrite: true
    }))
})); 