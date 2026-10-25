/**
 * 日报：node scripts/report.mjs [--day 2026-10-22] [--days 7]
 *
 * 直接读 SQLite 账本，不需要网关在跑。
 * 输出：按 key 的请求数/Token、按端点的分布、失败类型、最近失败样例。
 */
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};

const dbPath = argOf('--db', path.join(ROOT, 'data', 'fqrh.db'));
if (!fs.existsSync(dbPath)) {
  console.error(`找不到账本：${dbPath}（网关跑过一次就会生成）`);
  process.exit(1);
}

const day = argOf('--day', localDay(new Date()));
const days = Number(argOf('--days', 7));

function localDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const db = new DatabaseSync(dbPath);
const pad = (s, n) => String(s ?? '').padEnd(n);
const padL = (s, n) => String(s ?? '').padStart(n);
// 账本里 ts 存 UTC ISO；报表一律按本机时区切天/显示，避免 0–8 点算到前一天
const DAY_EXPR = "date(ts, 'localtime')";
const fmtLocal = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

console.log(`\n===== FQRH 日报 ${day}（本地时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}）=====\n`);

const daily = db.prepare('SELECT key_id, requests, tokens FROM quota_daily WHERE day = ? ORDER BY tokens DESC').all(day);
if (!daily.length) {
  console.log('（该日没有账本记录）');
} else {
  console.log(`${pad('key', 22)}${padL('请求', 8)}${padL('Token', 12)}${padL('均 Token/次', 12)}`);
  let rq = 0; let tk = 0;
  for (const r of daily) {
    rq += r.requests; tk += r.tokens;
    console.log(`${pad(r.key_id, 22)}${padL(r.requests, 8)}${padL(r.tokens, 12)}${padL(r.requests ? Math.round(r.tokens / r.requests) : 0, 12)}`);
  }
  console.log(`${pad('合计', 22)}${padL(rq, 8)}${padL(tk, 12)}`);
}

const byEndpoint = db.prepare(`
  SELECT endpoint, COUNT(*) n, SUM(CASE WHEN error_kind IS NULL THEN 1 ELSE 0 END) ok
  FROM request_logs WHERE ${DAY_EXPR} = ? GROUP BY endpoint ORDER BY n DESC
`).all(day);
if (byEndpoint.length) {
  console.log('\n-- 端点分布 --');
  for (const r of byEndpoint) console.log(`  ${pad(r.endpoint || '(legacy)', 12)} 请求 ${padL(r.n, 5)}  成功 ${padL(r.ok, 5)}`);
}

const byError = db.prepare(`
  SELECT error_kind, COUNT(*) n FROM request_logs
  WHERE ${DAY_EXPR} = ? AND error_kind IS NOT NULL GROUP BY error_kind ORDER BY n DESC
`).all(day);
if (byError.length) {
  console.log('\n-- 失败类型 --');
  for (const r of byError) console.log(`  ${pad(r.error_kind, 20)} ${padL(r.n, 5)}`);
}

const recentFails = db.prepare(`
  SELECT ts, pool_id, key_id, endpoint, client_model, status, error_kind, total_ms
  FROM request_logs WHERE error_kind IS NOT NULL ORDER BY ts DESC LIMIT 10
`).all();
if (recentFails.length) {
  console.log('\n-- 最近 10 条失败 --');
  for (const r of recentFails) {
    console.log(`  ${fmtLocal(r.ts)} ${pad(r.endpoint, 10)} ${pad(r.pool_id, 10)} ${pad(r.key_id, 10)} ${r.status ?? ''} ${pad(r.error_kind, 18)} ${r.total_ms ?? ''}ms`);
  }
}

const since = localDay(new Date(Date.now() - days * 86400000));
const trend = db.prepare(`
  SELECT ${DAY_EXPR} d, COUNT(*) n, SUM(CASE WHEN error_kind IS NULL THEN 1 ELSE 0 END) ok
  FROM request_logs WHERE ${DAY_EXPR} >= ? GROUP BY d ORDER BY d
`).all(since);
if (trend.length) {
  console.log(`\n-- 最近 ${days} 天趋势 --`);
  for (const r of trend) {
    const fail = r.n - r.ok;
    console.log(`  ${r.d}  请求 ${padL(r.n, 4)}  成功 ${padL(r.ok, 4)}  失败 ${padL(fail, 3)}  成功率 ${r.n ? Math.round((r.ok / r.n) * 100) : 0}%`);
  }
}
console.log('');
db.close();
