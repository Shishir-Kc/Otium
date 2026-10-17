CREATE TABLE account (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_session (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_auth_session_account_id ON auth_session(account_id);
CREATE INDEX idx_auth_session_expiration ON auth_session(expires_at);

CREATE TABLE account_invite (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES account(id),
  account_role TEXT NOT NULL DEFAULT 'member' CHECK (account_role IN ('admin', 'member')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  redeemed_by TEXT REFERENCES account(id),
  redeemed_at TEXT
);

CREATE INDEX idx_account_invite_expiration ON account_invite(expires_at);

CREATE TABLE auth_login_attempt (
  client_hash TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  blocked_until TEXT
);

CREATE TABLE admin_bootstrap (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  consumed_at TEXT,
  consumed_by TEXT
);

INSERT INTO admin_bootstrap (id, consumed_at) VALUES (1, NULL);
