CREATE TABLE IF NOT EXISTS payment_sessions(id TEXT PRIMARY KEY,provider TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS payment_sessions_state ON payment_sessions(state,created);
