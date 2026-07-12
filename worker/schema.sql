-- Tap Empire — D1 schema
-- Apply with: npx wrangler d1 execute tap_empire --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
    telegram_id      INTEGER PRIMARY KEY,
    username         TEXT,
    first_name       TEXT,
    -- game stats synced from the client (leaderboard / display only)
    game_balance     REAL    DEFAULT 0,
    total_earned     REAL    DEFAULT 0,
    total_taps       INTEGER DEFAULT 0,
    streak           INTEGER DEFAULT 0,
    -- real money, credited ONLY by verified Monetag postbacks
    usd_balance      REAL    DEFAULT 0,
    usd_lifetime     REAL    DEFAULT 0,
    verified_ads     INTEGER DEFAULT 0,
    -- misc
    ref_by           INTEGER,
    reminder_enabled INTEGER DEFAULT 1,
    bot_started      INTEGER DEFAULT 0,  -- 1 after /start (bot may DM them)
    created_at       INTEGER,
    last_seen        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_leaderboard ON users (total_earned DESC);

-- Raw Monetag postbacks; unique (ymid, event) makes crediting idempotent
CREATE TABLE IF NOT EXISTS postbacks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ymid            TEXT,
    telegram_id     INTEGER,
    event           TEXT,
    zone_id         TEXT,
    estimated_price REAL DEFAULT 0,
    request_var     TEXT,
    created_at      INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_postback_unique ON postbacks (ymid, event);

CREATE TABLE IF NOT EXISTS withdrawals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    amount_usd  REAL,
    wallet      TEXT,
    status      TEXT DEFAULT 'pending',   -- pending | paid | rejected
    created_at  INTEGER,
    paid_at     INTEGER
);
