BEGIN TRANSACTION;

-- Check migration
SELECT CASE 
    WHEN EXISTS (SELECT 1 FROM migrations WHERE name = '003_enable_wal')
    THEN RAISE(IGNORE)
    ELSE (INSERT INTO migrations (name) VALUES ('003_enable_wal'))
END;

-- Enable WAL mode and optimize settings
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -2000; -- Use up to 2MB of memory for cache

COMMIT; 