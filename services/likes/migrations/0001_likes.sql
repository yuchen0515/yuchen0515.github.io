CREATE TABLE IF NOT EXISTS likes (
  page_path TEXT NOT NULL,
  visitor_hash TEXT NOT NULL CHECK(length(visitor_hash) = 64),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_path, visitor_hash)
) WITHOUT ROWID;

-- Short-lived per-article throttles. No raw IP or browser identifier is stored.
CREATE TABLE IF NOT EXISTS rate_limits (
  key_hash TEXT NOT NULL CHECK(length(key_hash) = 64),
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL CHECK(hits > 0),
  PRIMARY KEY (key_hash, window_start)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(window_start);
