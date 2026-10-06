-- What the curator decided for each work: 1 = on the wall, 0 = off it.
CREATE TABLE decisions (
  key TEXT PRIMARY KEY,
  verdict INTEGER NOT NULL CHECK (verdict IN (0, 1)),
  decided_at INTEGER NOT NULL
);

CREATE TABLE settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Until a work has been reviewed, it hangs on the wall.
INSERT INTO settings (name, value) VALUES ('showUnreviewed', 'true');
