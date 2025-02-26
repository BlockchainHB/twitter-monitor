BEGIN TRANSACTION;

-- Check migration
SELECT CASE 
    WHEN EXISTS (SELECT 1 FROM migrations WHERE name = '002_cleanup_schema')
    THEN RAISE(IGNORE)
    ELSE (INSERT INTO migrations (name) VALUES ('002_cleanup_schema'))
END;

-- Ensure monitored_accounts has correct columns
CREATE TABLE IF NOT EXISTS monitored_accounts_new (
    twitter_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    monitor_type TEXT NOT NULL,
    is_vip INTEGER DEFAULT 0,
    last_tweet_id TEXT,
    profile_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Copy data from old table if it exists
INSERT OR IGNORE INTO monitored_accounts_new 
SELECT twitter_id, username, monitor_type, is_vip, last_tweet_id, profile_data, created_at, updated_at
FROM monitored_accounts;

-- Drop old table and rename new one
DROP TABLE IF EXISTS monitored_accounts;
ALTER TABLE monitored_accounts_new RENAME TO monitored_accounts;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_monitored_accounts_username ON monitored_accounts(username);

COMMIT; 