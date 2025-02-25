-- Create migrations table if it doesn't exist
CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    executed_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Start transaction
BEGIN TRANSACTION;

-- Check if this migration has been executed
INSERT OR IGNORE INTO migrations (name) VALUES ('001_sms_subscribers_update');

-- Backup existing SMS subscribers table
CREATE TABLE IF NOT EXISTS sms_subscribers_backup AS SELECT * FROM sms_subscribers;

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

-- Migrate existing data if the backup table exists
INSERT OR REPLACE INTO sms_subscribers (phone_number, created_at)
SELECT phone_number, created_at
FROM sms_subscribers_backup
WHERE phone_number IS NOT NULL;

-- Create new indexes
CREATE INDEX idx_sms_subscribers_phone ON sms_subscribers(phone_number);
CREATE INDEX idx_sms_subscribers_last_notification ON sms_subscribers(last_notification);

-- Drop backup table
DROP TABLE IF EXISTS sms_subscribers_backup;

-- Add new columns if they don't exist
ALTER TABLE sms_subscribers ADD COLUMN IF NOT EXISTS discord_user_id TEXT;
ALTER TABLE sms_subscribers ADD COLUMN IF NOT EXISTS last_notification INTEGER;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_sms_subscribers_phone ON sms_subscribers(phone_number);
CREATE INDEX IF NOT EXISTS idx_sms_subscribers_last_notification ON sms_subscribers(last_notification);

COMMIT; 