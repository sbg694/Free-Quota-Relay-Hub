/**
 * 账本：SQLite（Node 24 内置 node:sqlite，无第三方依赖）
 *
 * 表结构与 docs/03 §5 对齐，但 v1 只落「流水 + 日额度」两张表：
 * pools / keys / aliases 暂驻 config.json（M2），M3 再迁进来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DDL = `
CREATE TABLE IF NOT EXISTS request_logs (
  request_id    TEXT PRIMARY KEY,
  ts            TEXT NOT NULL,
  endpoint      TEXT,
  pool_id       TEXT,
  key_id        TEXT,
  client_model  TEXT,
  upstream_model TEXT,
  status        INTEGER,
  error_kind    TEXT,
  first_token_ms INTEGER,
  total_ms      INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  estimated     INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON request_logs(ts);

CREATE TABLE IF NOT EXISTS quota_daily (
  day       TEXT NOT NULL,
  key_id    TEXT NOT NULL,
  requests  INTEGER DEFAULT 0,
  tokens    INTEGER DEFAULT 0,
  PRIMARY KEY (day, key_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id        TEXT PRIMARY KEY,
  ts        TEXT NOT NULL,
  level     TEXT,
  pool_id   TEXT,
  kind      TEXT,
  message   TEXT,
  delivered INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
`;

export function openLedger(dbPath = path.join('data', 'fqrh.db')) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(DDL);

  // 轻量迁移：老库补 endpoint 列
  const cols = db.prepare('PRAGMA table_info(request_logs)').all().map((c) => c.name);
  if (!cols.includes('endpoint')) db.exec('ALTER TABLE request_logs ADD COLUMN endpoint TEXT');

  const insLog = db.prepare(`
    INSERT OR REPLACE INTO request_logs
      (request_id, ts, endpoint, pool_id, key_id, client_model, upstream_model,
       status, error_kind, first_token_ms, total_ms, prompt_tokens, completion_tokens, estimated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertDaily = db.prepare(`
    INSERT INTO quota_daily (day, key_id, requests, tokens)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(day, key_id) DO UPDATE SET
      requests = requests + excluded.requests,
      tokens   = tokens   + excluded.tokens
  `);
  const qDaily = db.prepare('SELECT key_id, requests, tokens FROM quota_daily WHERE day = ? ORDER BY key_id');
  const qRecent = db.prepare('SELECT * FROM request_logs ORDER BY ts DESC LIMIT ?');
  const insAlert = db.prepare('INSERT OR REPLACE INTO alerts (id, ts, level, pool_id, kind, message, delivered) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const qAlerts = db.prepare('SELECT * FROM alerts ORDER BY ts DESC LIMIT ?');

  return {
    db,
    logRequest(row) {
      insLog.run(
        row.requestId, row.ts, row.endpoint ?? null, row.poolId ?? null, row.keyId ?? null,
        row.clientModel ?? null, row.upstreamModel ?? null,
        row.status ?? null, row.errorKind ?? null,
        row.firstTokenMs ?? null, row.totalMs ?? null,
        row.promptTokens ?? null, row.completionTokens ?? null,
        row.estimated ? 1 : 0,
      );
    },
    bumpDaily(day, keyId, requests, tokens) {
      upsertDaily.run(day, keyId, requests, tokens);
    },
    daily(day) {
      return qDaily.all(day);
    },
    recent(n = 20) {
      return qRecent.all(Math.max(1, Math.min(200, n)));
    },
    logAlert(a) {
      insAlert.run(a.id, a.ts, a.level ?? null, a.poolId ?? null, a.kind ?? null, a.message ?? null, a.delivered ? 1 : 0);
    },
    markAlertDelivered(id) {
      db.prepare('UPDATE alerts SET delivered = 1 WHERE id = ?').run(id);
    },
    alerts(n = 50) {
      return qAlerts.all(Math.max(1, Math.min(500, n)));
    },
    close() {
      db.close();
    },
  };
}
