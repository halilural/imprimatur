-- Imprimatur sync (#61): every pushed field change, in arrival order.
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL,
  entity TEXT NOT NULL,
  key TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_seq ON changes(seq);
