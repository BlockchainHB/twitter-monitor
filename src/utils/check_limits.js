const { TwitterApi } = require('twitter-api-v2');
const config = require('./src/config/config');

async function checkRateLimits() {
    const client = new TwitterApi({
        appKey: config.twitter.apiKey,
        appSecret: config.twitter.apiKeySecret,
        accessToken: config.twitter.accessToken,
        accessSecret: config.twitter.accessTokenSecret,
    });

    try {
        // Check users/by/username endpoint
        const userLookup = await client.v2.userByUsername('twitter');
        console.log('\nUsers Lookup Rate Limits:');
        console.log('Response:', userLookup);
        console.log('Rate Limits:', userLookup.rateLimit);

        // Check users/tweets endpoint
        const userTweets = await client.v2.userTimeline('12');
        console.log('\nUser Tweets Rate Limits:');
        console.log('Response:', userTweets);
        console.log('Rate Limits:', userTweets.rateLimit);

        // Check tweets/search endpoint
        const search = await client.v2.search('test');
        console.log('\nTweets Search Rate Limits:');
        console.log('Response:', search);
        console.log('Rate Limits:', search.rateLimit);
    } catch (error) {
        if (error.code === 429) {
            console.log('Rate limit already hit. Reset time:', new Date(error.rateLimit.reset * 1000).toLocaleString());
        } else {
            console.error('Error:', error);
        }
    }
}

checkRateLimits(); 