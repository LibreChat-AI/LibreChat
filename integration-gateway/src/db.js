'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');

let db;

function initDb() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, 'gateway.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_clients (
      client_id TEXT PRIMARY KEY,
      client_secret_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      lc_agent_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lc_user_mapping (
      client_id TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      lc_email TEXT NOT NULL,
      lc_password_enc TEXT NOT NULL,
      lc_api_key_enc TEXT NOT NULL,
      lc_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (client_id, external_user_id)
    );

    CREATE TABLE IF NOT EXISTS lc_conversation_mapping (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      lc_conversation_id TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conv_client_user
      ON lc_conversation_mapping (client_id, external_user_id);

    CREATE TABLE IF NOT EXISTS integration_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      client_id TEXT,
      ip TEXT,
      detail_json TEXT
    );
  `);

  migrateV2();
  seedDemoClient();
  return db;
}

module.exports = { initDb };
