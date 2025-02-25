const { TwitterApi } = require('twitter-api-v2');
const { Client } = require('discord.js');
const sqlite3 = require('sqlite3');
const config = require('../config/config');

async function testTwitterCredentials() {
    console.log('\n🔍 Testing Twitter credentials...');
    try {
        const twitter = new TwitterApi({
            appKey: config.twitter.apiKey,
            appSecret: config.twitter.apiKeySecret,
            accessToken: config.twitter.accessToken,
            accessSecret: config.twitter.accessTokenSecret
        });

        // Test API access
        const me = await twitter.v2.me();
        console.log('✅ Twitter credentials working!');
        console.log(`   Connected as: ${me.data.username}`);
        return true;
    } catch (error) {
        console.error('❌ Twitter credentials failed:', error.message);
        console.log('   Check your Twitter API credentials in .env');
        return false;
    }
}

async function testDiscordConnection() {
    console.log('\n🔍 Testing Discord connection...');
    try {
        const client = new Client({
            intents: ['Guilds', 'GuildMessages']
        });

        await client.login(config.discord.token);
        console.log('✅ Discord connection working!');
        console.log(`   Connected as: ${client.user.tag}`);

        // Log available guilds
        console.log('\n   Available servers:');
        client.guilds.cache.forEach(guild => {
            console.log(`   - ${guild.name} (${guild.id})`);
            
            // Log available channels in this guild
            console.log('     Channels:');
            guild.channels.cache.forEach(channel => {
                if (channel.type === 0) { // 0 is text channel
                    console.log(`     - #${channel.name} (${channel.id})`);
                }
            });
        });

        // Test channel access
        const tweetsChannel = client.channels.cache.get(config.discord.channels.tweets);
        const solanaChannel = client.channels.cache.get(config.discord.channels.solana);

        console.log('\n   Channel checks:');
        if (tweetsChannel) {
            console.log(`✅ Tweets channel found: #${tweetsChannel.name}`);
            // Test sending a message
            try {
                await tweetsChannel.send('🔍 Bot test message - tweets channel');
                console.log('   ✅ Can send messages to tweets channel');
            } catch (error) {
                console.log('   ❌ Cannot send messages to tweets channel:', error.message);
            }
        } else {
            console.log(`❌ Tweets channel not found. ID: ${config.discord.channels.tweets}`);
            console.log('   Make sure this channel exists and the bot has access to it');
        }

        if (solanaChannel) {
            console.log(`✅ Solana channel found: #${solanaChannel.name}`);
            // Test sending a message
            try {
                await solanaChannel.send('🔍 Bot test message - solana channel');
                console.log('   ✅ Can send messages to solana channel');
            } catch (error) {
                console.log('   ❌ Cannot send messages to solana channel:', error.message);
            }
        } else {
            console.log(`❌ Solana channel not found. ID: ${config.discord.channels.solana}`);
            console.log('   Make sure this channel exists and the bot has access to it');
        }

        await client.destroy();
        return tweetsChannel && solanaChannel;
    } catch (error) {
        console.error('❌ Discord connection failed:', error.message);
        console.log('   Check your Discord bot token in .env');
        return false;
    }
}

async function testDatabase() {
    console.log('\n🔍 Testing database setup...');
    try {
        // Use test database file
        const testDbPath = 'test_monitor.db';
        const db = new sqlite3.Database(testDbPath);
        
        // Promisify database methods
        const dbRun = (sql) => new Promise((resolve, reject) => {
            db.run(sql, (err) => err ? reject(err) : resolve());
        });

        // Test schema creation
        await dbRun(`
            CREATE TABLE IF NOT EXISTS monitored_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                twitter_id TEXT NOT NULL,
                type TEXT NOT NULL,
                last_tweet_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await dbRun(`
            CREATE TABLE IF NOT EXISTS tweets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tweet_id TEXT NOT NULL,
                account_id INTEGER,
                content TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (account_id) REFERENCES monitored_accounts(id)
            )
        `);

        // Test data insertion
        await dbRun(`
            INSERT INTO monitored_accounts (twitter_id, type)
            VALUES ('test_account', 'tweet')
        `);

        console.log('✅ Database setup working!');
        
        // Cleanup
        db.close();
        require('fs').unlinkSync(testDbPath);
        return true;
    } catch (error) {
        console.error('❌ Database setup failed:', error.message);
        return false;
    }
}

async function testTwitterFetch() {
    console.log('\n🔍 Testing Twitter API fetch...');
    try {
        const twitter = new TwitterApi({
            appKey: config.twitter.apiKey,
            appSecret: config.twitter.apiKeySecret,
            accessToken: config.twitter.accessToken,
            accessSecret: config.twitter.accessTokenSecret
        });

        // First get user ID for a public account
        const user = await twitter.v2.userByUsername('elonmusk');
        if (!user.data) {
            console.log('❌ Could not find test Twitter user');
            return false;
        }

        // Test fetching tweets using the user ID
        const tweets = await twitter.v2.userTimeline(user.data.id, {
            max_results: 5,
            'tweet.fields': ['created_at', 'author_id']
        });

        if (tweets.data && tweets.data.length > 0) {
            console.log('✅ Twitter API fetch working!');
            console.log(`   Successfully fetched ${tweets.data.length} tweets from @${user.data.username}`);
            return true;
        } else {
            console.log('❌ No tweets found in the response');
            return false;
        }
    } catch (error) {
        console.error('❌ Twitter API fetch failed:', error.message);
        return false;
    }
}

async function runTests() {
    console.log('🚀 Starting local setup tests...\n');

    const results = {
        twitter: await testTwitterCredentials(),
        discord: await testDiscordConnection(),
        database: await testDatabase(),
        twitterFetch: await testTwitterFetch()
    };

    console.log('\n📊 Test Results Summary:');
    Object.entries(results).forEach(([test, passed]) => {
        console.log(`${passed ? '✅' : '❌'} ${test}`);
    });

    const allPassed = Object.values(results).every(result => result);
    console.log(`\n${allPassed ? '🎉 All tests passed!' : '⚠️ Some tests failed.'}`);

    if (!allPassed) {
        console.log('\n🔧 Troubleshooting Tips:');
        console.log('1. Check that all environment variables are set correctly in .env');
        console.log('2. Verify your Twitter API credentials and rate limits');
        console.log('3. Ensure the Discord bot is in the server and has correct permissions');
        console.log('4. Check that the channel IDs in .env are correct');
    }

    return allPassed;
}

// Run tests if called directly
if (require.main === module) {
    runTests()
        .then(passed => process.exit(passed ? 0 : 1))
        .catch(error => {
            console.error('Test script error:', error);
            process.exit(1);
        });
}

module.exports = {
    testTwitterCredentials,
    testDiscordConnection,
    testDatabase,
    testTwitterFetch,
    runTests
}; 