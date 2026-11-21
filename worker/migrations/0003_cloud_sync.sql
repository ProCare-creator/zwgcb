ALTER TABLE users ADD COLUMN sync_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN sync_count INTEGER NOT NULL DEFAULT 0;
CREATE TABLE docs (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 k TEXT NOT NULL, ver INTEGER NOT NULL, seq INTEGER NOT NULL, size INTEGER NOT NULL,
 mtime INTEGER NOT NULL, body BLOB, deleted INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,k)
);
CREATE UNIQUE INDEX docs_user_seq ON docs(user_id,seq);
CREATE TABLE history (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, k TEXT NOT NULL,
 ver INTEGER NOT NULL, body BLOB, size INTEGER NOT NULL, saved_at INTEGER NOT NULL,
 variant TEXT, PRIMARY KEY(user_id,k,ver), UNIQUE(user_id,k,variant)
);
CREATE TRIGGER docs_insert AFTER INSERT ON docs BEGIN
 UPDATE users SET seq=NEW.seq,sync_bytes=sync_bytes+NEW.size,sync_count=sync_count+1-NEW.deleted WHERE id=NEW.user_id;
 SELECT CASE WHEN NEW.size>0 AND sync_bytes>quota_bytes THEN RAISE(ABORT,'sync_quota') END FROM users WHERE id=NEW.user_id;
END;
CREATE TRIGGER docs_update AFTER UPDATE ON docs BEGIN
 UPDATE users SET seq=NEW.seq,sync_bytes=sync_bytes+NEW.size-OLD.size,sync_count=sync_count+OLD.deleted-NEW.deleted WHERE id=NEW.user_id;
 SELECT CASE WHEN NEW.size>OLD.size AND sync_bytes>quota_bytes THEN RAISE(ABORT,'sync_quota') END FROM users WHERE id=NEW.user_id;
 INSERT INTO history(user_id,k,ver,body,size,saved_at) VALUES(OLD.user_id,OLD.k,OLD.ver,OLD.body,OLD.size,NEW.updated_at);
 DELETE FROM history WHERE user_id=NEW.user_id AND k=NEW.k AND saved_at<NEW.updated_at-2592000000 AND ver NOT IN (SELECT ver FROM history WHERE user_id=NEW.user_id AND k=NEW.k ORDER BY saved_at DESC,ver DESC LIMIT 10);
END;
