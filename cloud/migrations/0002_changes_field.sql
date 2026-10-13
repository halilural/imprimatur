-- Imprimatur sync (#89): compaction finds a field's newer rows through this index.
CREATE INDEX IF NOT EXISTS changes_field ON changes(entity, key, field, at, device, seq);
