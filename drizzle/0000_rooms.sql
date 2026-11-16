CREATE TABLE rooms (
  room_code TEXT PRIMARY KEY,
  host_hash TEXT NOT NULL,
  state_json TEXT NOT NULL,
  bank_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX rooms_updated_at_idx ON rooms(updated_at);
