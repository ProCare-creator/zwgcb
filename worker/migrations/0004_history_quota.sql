-- Count all retained ciphertext, including histories created by the previous migration.
ALTER TABLE users ADD COLUMN history_rev INTEGER NOT NULL DEFAULT 0;
UPDATE users SET sync_bytes = sync_bytes + COALESCE((
  SELECT SUM(size) FROM history WHERE history.user_id = users.id
), 0);

CREATE TRIGGER history_delete AFTER DELETE ON history BEGIN
  UPDATE users SET sync_bytes = sync_bytes - OLD.size, history_rev = history_rev + 1 WHERE id = OLD.user_id;
END;

CREATE TRIGGER history_insert AFTER INSERT ON history BEGIN
  UPDATE users SET sync_bytes = sync_bytes + NEW.size, history_rev = history_rev + 1 WHERE id = NEW.user_id;
  DELETE FROM history WHERE user_id = NEW.user_id AND k = NEW.k
    AND saved_at < NEW.saved_at - 2592000000
    AND ver NOT IN (
      SELECT ver FROM history WHERE user_id = NEW.user_id AND k = NEW.k
      ORDER BY saved_at DESC, ver DESC LIMIT 10
    );
  -- A negative version is an independently archived offline edit.
  SELECT CASE WHEN NEW.ver < 0 AND NEW.size > 0 AND sync_bytes > quota_bytes
    THEN RAISE(ABORT, 'sync_quota') END FROM users WHERE id = NEW.user_id;
END;

DROP TRIGGER docs_update;
CREATE TRIGGER docs_update AFTER UPDATE ON docs BEGIN
  UPDATE users SET seq = NEW.seq, sync_bytes = sync_bytes + NEW.size - OLD.size,
    sync_count = sync_count + OLD.deleted - NEW.deleted WHERE id = NEW.user_id;
  INSERT INTO history(user_id,k,ver,body,size,saved_at)
    VALUES(OLD.user_id,OLD.k,OLD.ver,OLD.body,OLD.size,NEW.updated_at);
  -- Deletion only moves existing bytes to history, even after a quota reduction.
  SELECT CASE WHEN NEW.size > 0 AND sync_bytes > quota_bytes
    THEN RAISE(ABORT, 'sync_quota') END FROM users WHERE id = NEW.user_id;
END;
