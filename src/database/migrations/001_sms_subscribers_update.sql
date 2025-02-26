-- Create migrations table if it doesn't exist
CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    executed_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Start transaction
BEGIN TRANSACTION;

-- Check if migration has already been executed
SELECT CASE 
    WHEN EXISTS (SELECT 1 FROM migrations WHERE name = '001_sms_subscribers_update.sql')
    THEN RAISE(IGNORE)
    ELSE (
        -- Insert migration record
        INSERT INTO migrations (name) VALUES ('001_sms_subscribers_update.sql')
    )
END;

-- Backup existing SMS subscribers table if it exists
CREATE TABLE IF NOT EXISTS sms_subscribers_backup AS 
SELECT * FROM sms_subscribers WHERE EXISTS (
    SELECT 1 FROM sqlite_master WHERE type='table' AND name='sms_subscribers'
);

-- Drop existing indexes if they exist
DROP INDEX IF EXISTS idx_sms_subscribers_phone;
DROP INDEX IF EXISTS idx_sms_subscribers_last_notification;

-- Drop and recreate SMS subscribers table with new schema
DROP TABLE IF EXISTS sms_subscribers;
CREATE TABLE sms_subscribers (
    discord_user_id TEXT PRIMARY KEY,
    phone_number TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    last_notification INTEGER DEFAULT NULL
);

-- Migrate existing data if the backup table exists and has data
INSERT OR REPLACE INTO sms_subscribers (discord_user_id, phone_number, created_at, last_notification)
SELECT 
    COALESCE(discord_user_id, phone_number) as discord_user_id,
    phone_number,
    COALESCE(created_at, strftime('%s', 'now')) as created_at,
    last_notification
FROM sms_subscribers_backup
WHERE phone_number IS NOT NULL
AND EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='sms_subscribers_backup');

-- Create new indexes
CREATE INDEX idx_sms_subscribers_phone ON sms_subscribers(phone_number);
CREATE INDEX idx_sms_subscribers_last_notification ON sms_subscribers(last_notification);

-- Drop backup table if it exists
DROP TABLE IF EXISTS sms_subscribers_backup;

COMMIT; 