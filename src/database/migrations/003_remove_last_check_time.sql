BEGIN TRANSACTION;

-- Check migration
SELECT CASE 
    WHEN EXISTS (SELECT 1 FROM migrations WHERE name = '003_remove_last_check_time')
    THEN RAISE(IGNORE)
    ELSE (INSERT INTO migrations (name) VALUES ('003_remove_last_check_time'))
END;

-- Create a new table without last_check_time
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

-- Copy data from old table
INSERT OR IGNORE INTO monitored_accounts_new 
SELECT twitter_id, username, monitor_type, is_vip, last_tweet_id, profile_data, created_at, updated_at
FROM monitored_accounts;

-- Drop old table and rename new one
DROP TABLE IF EXISTS monitored_accounts;
ALTER TABLE monitored_accounts_new RENAME TO monitored_accounts;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_monitored_accounts_username ON monitored_accounts(username);

-- Verify the table structure
SELECT CASE 
    WHEN EXISTS (
        SELECT 1 
        FROM sqlite_master 
        WHERE type = 'table' 
        AND name = 'monitored_accounts' 
        AND sql LIKE '%last_check_time%'
    )
    THEN RAISE(FAIL, 'last_check_time column still exists')
    ELSE NULL
END;

COMMIT; 