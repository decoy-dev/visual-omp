CREATE TABLE daily_counts (
  day TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (day, version, platform, arch)
) WITHOUT ROWID;
