CREATE TABLE users(
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL DEFAULT '',
 role TEXT NOT NULL CHECK(role IN ('admin','user')), kdf_salt BLOB NOT NULL, auth_hash BLOB NOT NULL,
 wrapped_keys BLOB NOT NULL,recovery_wrapped BLOB NOT NULL,recovery_hash BLOB NOT NULL,
 seq INTEGER NOT NULL DEFAULT 0, quota_bytes INTEGER NOT NULL DEFAULT 52428800,
 disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,
 invite_hash BLOB UNIQUE
);
CREATE UNIQUE INDEX only_one_admin ON users(role) WHERE role='admin';
CREATE TABLE invites(code_hash BLOB PRIMARY KEY,id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,used_by TEXT,revoked INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER consume_invite AFTER INSERT ON users WHEN NEW.invite_hash IS NOT NULL BEGIN
 UPDATE invites SET used_by=NEW.username WHERE code_hash=NEW.invite_hash AND used_by IS NULL AND revoked=0;
END;
CREATE TABLE sessions(token_hash BLOB PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,expires_at INTEGER NOT NULL,device TEXT);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE resets(token_hash BLOB PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
CREATE INDEX resets_user ON resets(user_id);
CREATE TABLE auth_fail(key TEXT PRIMARY KEY,count INTEGER NOT NULL,first_at INTEGER NOT NULL,locked_until INTEGER NOT NULL DEFAULT 0);
