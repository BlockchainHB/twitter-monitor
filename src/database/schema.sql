-- Monitored wallets table
CREATE TABLE IF NOT EXISTS monitored_wallets (
    wallet_address TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    last_tx_time INTEGER DEFAULT NULL
);

-- SMS subscribers table
CREATE TABLE IF NOT EXISTS sms_subscribers (
    discord_user_id TEXT PRIMARY KEY,
    phone_number TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    last_notification INTEGER DEFAULT NULL
);

-- Helius webhooks table
CREATE TABLE IF NOT EXISTS helius_webhooks (
    webhook_id TEXT PRIMARY KEY,
    webhook_url TEXT NOT NULL,
    active BOOLEAN DEFAULT true,
    last_synced INTEGER DEFAULT (strftime('%s', 'now')),
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    last_updated INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_monitored_wallets_last_tx_time ON monitored_wallets(last_tx_time);
CREATE INDEX IF NOT EXISTS idx_helius_webhooks_active ON helius_webhooks(active);
CREATE INDEX IF NOT EXISTS idx_helius_webhooks_last_synced ON helius_webhooks(last_synced);
CREATE INDEX IF NOT EXISTS idx_sms_subscribers_phone ON sms_subscribers(phone_number);
CREATE INDEX IF NOT EXISTS idx_sms_subscribers_last_notification ON sms_subscribers(last_notification); 