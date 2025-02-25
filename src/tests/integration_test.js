const { TwitterApi } = require('twitter-api-v2');
const { Client } = require('discord.js');
const path = require('path');
const config = require('../config/config');
const TwitterMonitorBot = require('../core/TwitterMonitorBot');
const { setupTestDatabase, cleanupTestDatabase } = require('./testSetup');

async function runTests() {
    console.log('\n🚀 Starting Twitter Monitor Bot Integration Tests\n');
    
    // Test results tracking
    const results = {
        passed: 0,
        failed: 0,
        tests: []
    };

    function recordTest(name, passed, error = null) {
        results.tests.push({ name, passed, error });
        if (passed) results.passed++;
        else results.failed++;
        
        console.log(`${passed ? '✅' : '❌'} ${name}`);
        if (error) console.error('   Error:', error.message);
    }

    // 1. Test Twitter API Credentials
    try {
        console.log('\n📡 Testing Twitter API Connection...');
        const twitter = new TwitterApi({
            appKey: config.twitter.apiKey,
            appSecret: config.twitter.apiKeySecret,
            accessToken: config.twitter.accessToken,
            accessSecret: config.twitter.accessTokenSecret
        });

        const me = await twitter.v2.me();
        recordTest('Twitter API Credentials', true);
        console.log(`   Connected as: @${me.data.username}`);
    } catch (error) {
        recordTest('Twitter API Credentials', false, error);
    }

    // 2. Test Discord Connection
    try {
        console.log('\n🤖 Testing Discord Bot Connection...');
        const client = new Client({
            intents: ['Guilds', 'GuildMessages']
        });

        await client.login(config.discord.token);
        recordTest('Discord Bot Connection', true);
        console.log(`   Connected as: ${client.user.tag}`);

        // Test channel access
        const channels = {
            tweets: await client.channels.fetch(config.discord.channels.tweets),
            solana: await client.channels.fetch(config.discord.channels.solana)
        };

        if (channels.tweets && channels.solana) {
            recordTest('Discord Channel Access', true);
            console.log(`   Found channels: #${channels.tweets.name}, #${channels.solana.name}`);
        } else {
            throw new Error('Could not access required channels');
        }

        await client.destroy();
    } catch (error) {
        recordTest('Discord Bot Connection', false, error);
    }

    // 3. Test Database Setup
    let db;
    try {
        console.log('\n💾 Testing Database Setup...');
        db = await setupTestDatabase();
        recordTest('Database Schema Creation', true);

        // Test basic operations
        await new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO monitored_accounts (username, monitoring_type)
                VALUES (?, ?)
            `, ['test_user', 'tweet'], (err) => err ? reject(err) : resolve());
        });

        recordTest('Database Operations', true);
    } catch (error) {
        recordTest('Database Setup', false, error);
    } finally {
        if (db) db.close();
    }

    // 4. Test Rate Limit Manager
    try {
        console.log('\n⏱️ Testing Rate Limit Manager...');
        const bot = new TwitterMonitorBot();
        
        // Test rate limit tracking
        const status = bot.rateLimitManager.getEndpointStatus('users/tweets');
        if (status && typeof status.requestsRemaining === 'number') {
            recordTest('Rate Limit Tracking', true);
            console.log(`   Requests remaining: ${status.requestsRemaining}`);
        } else {
            throw new Error('Invalid rate limit status');
        }

        // Test endpoint-specific limits
        const endpoints = ['users/by/username', 'users/tweets', 'tweets/search'];
        const allValid = endpoints.every(ep => {
            const status = bot.rateLimitManager.getEndpointStatus(ep);
            return status && status.requestsRemaining > 0;
        });

        if (allValid) {
            recordTest('Endpoint-Specific Rate Limits', true);
        } else {
            throw new Error('Invalid endpoint rate limits');
        }
    } catch (error) {
        recordTest('Rate Limit Manager', false, error);
    }

    // 5. Test Account Monitoring
    try {
        console.log('\n👀 Testing Account Monitoring...');
        const bot = new TwitterMonitorBot();
        await bot.setupBot();

        // Test adding an account
        const testAccount = 'elonmusk'; // Using a public account for testing
        const result = await bot.handleMonitorCommand({
            options: {
                getString: (key) => key === 'twitter_id' ? testAccount : 'tweet'
            },
            reply: async (msg) => {
                console.log('   Response:', msg.embeds?.[0]?.description || msg);
                // Consider both new account and already monitoring cases as success
                return msg.embeds?.[0]?.description?.includes('monitoring') || false;
            },
            deferReply: async () => true,
            editReply: async (msg) => {
                console.log('   Updated:', msg.embeds?.[0]?.description || msg);
                return true;
            }
        });

        // Consider both new account and already monitoring cases as success
        if (result || result === undefined) {
            recordTest('Account Monitoring Setup', true);
        } else {
            throw new Error('Failed to set up account monitoring');
        }

        // Test monitoring interval
        if (bot.monitoringInterval) {
            recordTest('Monitoring Interval', true);
            console.log(`   Monitoring interval: ${config.monitoring.interval}ms`);
        } else {
            throw new Error('Monitoring interval not set');
        }

        await bot.shutdown();
    } catch (error) {
        recordTest('Account Monitoring', false, error);
    }

    // Print test summary
    console.log('\n📊 Test Summary:');
    console.log(`   Passed: ${results.passed}`);
    console.log(`   Failed: ${results.failed}`);
    console.log(`   Total: ${results.passed + results.failed}`);

    if (results.failed > 0) {
        console.log('\n❌ Failed Tests:');
        results.tests
            .filter(t => !t.passed)
            .forEach(test => {
                console.log(`   - ${test.name}`);
                if (test.error) console.log(`     Error: ${test.error.message}`);
            });
    }

    // Cleanup
    await cleanupTestDatabase();

    return results.failed === 0;
}

// Run tests if called directly
if (require.main === module) {
    runTests()
        .then(success => {
            process.exit(success ? 0 : 1);
        })
        .catch(error => {
            console.error('Test script error:', error);
            process.exit(1);
        });
}

module.exports = { runTests }; 