/**
 * 定时探活 + 告警（M4 运维面）
 *
 * 职责：
 *  - 按 monitor.probeIntervalSec 周期性跑探活（与业务同源，见 probe.mjs）
 *  - 连续失败 failThreshold 次 → critical 告警；恢复 → info 告警
 *  - key 进入 dead / missing → critical 告警（长冷却，避免刷屏）
 *  - 告警落 SQLite（alerts 表）+ 可选 Webhook 推送，冷却期内不重复推
 *
 * 告警只是"通知"，不自动改池状态：自动改状态会影响正在跑的流量，且难解释。
 */
import crypto from 'node:crypto';
import { probePool } from './probe.mjs';

export const ALERT_FORMATS = ['generic', 'feishu', 'dingtalk', 'slack'];

function payloadFor(format, a) {
  const text = `[FQRH][${a.level}] ${a.poolId} ${a.kind}：${a.message}`;
  if (format === 'feishu') return { msg_type: 'text', content: { text } };
  if (format === 'dingtalk') return { msgtype: 'text', text: { content: text } };
  if (format === 'slack') return { text };
  return { text, level: a.level, poolId: a.poolId, kind: a.kind, message: a.message, ts: a.ts };
}

export function createMonitor({ pool, config, ledger, log = console.log, now = () => Date.now(), probe = probePool }) {
  const cfg = {
    enabled: true,
    probeIntervalSec: 300,
    probeOnStartup: true,
    probeTimeoutMs: 15000,
    failThreshold: 2,
    alertCooldownSec: 1800,
    webhookUrl: '',
    webhookFormat: 'generic',
    ...(config.monitor || {}),
  };

  const consecutive = new Map();   // poolId → 连续失败次数
  const lastAlertAt = new Map();   // dedupeKey → 上次告警时间
  const counters = { probes: 0, alerts: 0, delivered: 0, failed: 0 };
  let timer = null;
  let running = false;
  let lastRunAt = null;
  let lastResults = [];

  function pickKey(provider) {
    return provider.keys.find((k) => k.state === 'active')
      || provider.keys.find((k) => k.state !== 'missing');
  }

  function raise(level, poolId, kind, message, dedupeKey = `${poolId}:${kind}`) {
    const last = lastAlertAt.get(dedupeKey) || 0;
    if (now() - last < cfg.alertCooldownSec * 1000) return null;
    lastAlertAt.set(dedupeKey, now());
    const alert = {
      id: crypto.randomUUID(),
      ts: new Date(now()).toISOString(),
      level, poolId, kind, message,
      delivered: null,
    };
    counters.alerts += 1;
    try { ledger.logAlert(alert); } catch { /* 账本不可用不应影响告警 */ }
    deliver(alert);
    log(`[monitor] ${level} ${poolId} ${kind}: ${message}`);
    return alert;
  }

  async function deliver(alert) {
    if (!cfg.webhookUrl) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payloadFor(cfg.webhookFormat, alert)),
        signal: ctrl.signal,
      });
      alert.delivered = res.ok ? true : `http_${res.status}`;
      if (res.ok) { counters.delivered += 1; ledger.markAlertDelivered(alert.id); }
      else counters.failed += 1;
    } catch (err) {
      alert.delivered = `error:${err.message}`;
      counters.failed += 1;
      log(`[monitor] webhook 推送失败：${err.message}`);
    } finally {
      clearTimeout(t);
    }
  }

  function evaluate(results) {
    for (const r of results) {
      if (r.skipped) continue;
      const prev = consecutive.get(r.poolId) || 0;
      if (r.ok) {
        if (prev >= cfg.failThreshold) {
          raise('info', r.poolId, 'probe_recovered', `探活恢复（此前连续失败 ${prev} 次，本次 ${r.latencyMs ?? '?'}ms）`);
        }
        consecutive.set(r.poolId, 0);
      } else {
        const next = prev + 1;
        consecutive.set(r.poolId, next);
        if (next >= cfg.failThreshold) {
          const detail = r.error || r.status || r.message || '';
          raise('critical', r.poolId, 'probe_failed', `探活连续 ${next} 次失败：${String(detail).slice(0, 160)}`);
        }
      }
    }

    // key 级：dead / missing 也要报（池探活可能因为还有别的 key 而是绿的）
    for (const p of pool.snapshot()) {
      for (const k of p.keys) {
        if (k.state === 'dead') {
          raise('critical', p.id, 'key_dead', `key ${k.id} 已被拉黑（${k.lastError?.kind || 'auth'}），需人工换 key 或恢复`, `${p.id}:key_dead:${k.id}`);
        } else if (k.state === 'missing') {
          raise('critical', p.id, 'key_missing', `key ${k.id} 未配置密钥（file/env 都没读到）`, `${p.id}:key_missing:${k.id}`);
        }
      }
    }
  }

  async function probeOnce(reason = 'scheduled') {
    if (running) return { skipped: 'already_running' };
    running = true;
    counters.probes += 1;
    try {
      const results = [];
      for (const provider of pool.providers) {
        if (!provider.enabled) {
          results.push({ poolId: provider.id, ok: true, skipped: 'disabled' });
          continue;
        }
        const key = pickKey(provider);
        if (!key) {
          results.push({ poolId: provider.id, ok: false, error: 'no usable key' });
          continue;
        }
        const t0 = now();
        let r;
        try {
          r = await probe({ provider, key, timeoutMs: cfg.probeTimeoutMs });
        } catch (err) {
          r = { ok: false, error: err.message };
        }
        results.push({
          poolId: provider.id,
          keyId: key.id,
          ...r,
          latencyMs: r.latencyMs ?? (now() - t0),
        });
      }
      lastRunAt = new Date(now()).toISOString();
      lastResults = results;
      evaluate(results);
      return { runAt: lastRunAt, reason, results };
    } finally {
      running = false;
    }
  }

  function start() {
    if (!cfg.enabled) { log('[monitor] 已禁用（config.monitor.enabled=false）'); return; }
    if (cfg.probeIntervalSec > 0 && !timer) {
      timer = setInterval(() => { probeOnce('scheduled').catch((e) => log(`[monitor] 周期探活异常：${e.message}`)); }, cfg.probeIntervalSec * 1000);
      timer.unref?.();
      log(`[monitor] 每 ${cfg.probeIntervalSec}s 探活一次（连续失败 ${cfg.failThreshold} 次告警，冷却 ${cfg.alertCooldownSec}s）`);
    }
    if (cfg.probeOnStartup) {
      setTimeout(() => { probeOnce('startup').catch(() => {}); }, 2000).unref?.();
      log('[monitor] 启动后 2s 做一次探活');
    }
    if (cfg.webhookUrl) log(`[monitor] 告警 Webhook：${cfg.webhookFormat} → ${cfg.webhookUrl}`);
    else log('[monitor] 未配置 Webhook，告警只落库（GET /__admin/alerts 可看）');
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function status() {
    return {
      enabled: cfg.enabled,
      intervalSec: cfg.probeIntervalSec,
      failThreshold: cfg.failThreshold,
      cooldownSec: cfg.alertCooldownSec,
      webhook: cfg.webhookUrl ? { url: cfg.webhookUrl, format: cfg.webhookFormat } : null,
      lastRunAt,
      lastResults,
      consecutive: Object.fromEntries(consecutive),
      counters,
      alerts: alertsView(20),
    };
  }

  function alertsView(n = 50) {
    let rows = [];
    try { rows = ledger.alerts(n); } catch { rows = []; }
    return rows.map((r) => ({
      ...r,
      delivered: r.delivered === 1 ? true : (cfg.webhookUrl ? false : null),
    }));
  }

  function testAlert() {
    return raise('info', 'selftest', 'manual_test', '这是一条测试告警：收到说明通道正常', `selftest:${now()}`);
  }

  return { probeOnce, start, stop, status, raise, testAlert, alertsView, cfg };
}
