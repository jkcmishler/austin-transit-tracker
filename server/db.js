import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { chicagoYmdFromEpochSec } from "./tz.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, "data.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Register chicago_day(epoch_sec) so SQL can group by DST-correct local date.
db.function("chicago_day", { deterministic: true }, (epochSec) =>
  chicagoYmdFromEpochSec(epochSec)
);

db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id TEXT NOT NULL,
    stop_id TEXT NOT NULL,
    scheduled_arrival INTEGER NOT NULL,
    value TEXT NOT NULL CHECK (value IN ('showed','missed')),
    device_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (trip_id, stop_id, scheduled_arrival, device_id)
  );

  CREATE INDEX IF NOT EXISTS idx_feedback_trip
    ON feedback (trip_id, stop_id, scheduled_arrival);

  CREATE TABLE IF NOT EXISTS delay_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at INTEGER NOT NULL,
    trip_id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    next_stop_id TEXT NOT NULL,
    scheduled_arrival INTEGER NOT NULL,
    delay_sec INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_route_time
    ON delay_snapshots (route_id, captured_at);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    device_id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    route_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS push_sent (
    trip_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (trip_id, device_id)
  );
`);
