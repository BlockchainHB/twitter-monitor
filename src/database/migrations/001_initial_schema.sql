BEGIN TRANSACTION;

-- Check migration
SELECT CASE 
    WHEN EXISTS (SELECT 1 FROM migrations WHERE name = '001_initial_schema')
    THEN RAISE(IGNORE)
    ELSE (INSERT INTO migrations (name) VALUES ('001_initial_schema'))
END;

-- Create tables
CREATE TABLE IF NOT EXISTS monitored_accounts (
    twitter_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    monitor_type TEXT NOT NULL,
    is_vip INTEGER DEFAULT 0,
    last_tweet_id TEXT,
    profile_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processed_tweets (
    tweet_id TEXT PRIMARY KEY,
    twitter_id TEXT NOT NULL,
    tweet_data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (twitter_id) REFERENCES monitored_accounts(twitter_id)
);

CREATE TABLE IF NOT EXISTS tracked_tokens (
    address TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    decimals INTEGER NOT NULL,
    first_seen_tweet_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (first_seen_tweet_id) REFERENCES processed_tweets(tweet_id)
);

CREATE TABLE IF NOT EXISTS sms_subscribers (
    discord_user_id TEXT PRIMARY KEY,
    phone_number TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_monitored_accounts_username ON monitored_accounts(username);
CREATE INDEX IF NOT EXISTS idx_processed_tweets_twitter_id ON processed_tweets(twitter_id);
CREATE INDEX IF NOT EXISTS idx_tracked_tokens_symbol ON tracked_tokens(symbol);

COMMIT; 