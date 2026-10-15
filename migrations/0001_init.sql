-- Migration number: 0001 	 2026-10-14T08:45:58.805Z
--
--
CREATE TABLE playlist (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  playlist_image_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE song (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_url TEXT NOT NULL UNIQUE,
  image_url TEXT,
  audio TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE playlist_song (
  playlist_id TEXT NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
  song_id TEXT NOT NULL REFERENCES song(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (playlist_id, song_id)
);

CREATE INDEX idx_playlist_song_song_id ON playlist_song(song_id);
