/**
 * 池与密钥状态机 + 选路（docs/03 §3）
 *
 * score = weight × health × quotaFactor × loadFactor
 * 状态：active | cooling（429 退避）| dead（401/403）| exhausted（402/额度）
 */
import { today } from './config.mjs';

const HEALTH_WINDOW = 20;

export function createPool(config) {
  const providers = config.providers.map((p) => ({
    ...p,
    keys: p.keys.map((k) => ({
      ...k,
      state: k.missing ? 'missing' : 'active',
      coolingUntil: 0,
      deadAt: 0,
      inflight: 0,
      health: 1,
      outcomes: [], // true=成功
      day: today(),
      dayRequests: 0,
      dayTokens: 0,
      lastError: null,
    })),
  }));

  const find = (poolId, keyId) =>
    providers.find((p) => p.id === poolId)?.keys.find((k) => k.id === keyId) || null;

  function rollDay(key) {
    const d = today();
    if (key.day !== d) {
      key.day = d;
      key.dayRequests = 0;
      key.dayTokens = 0;
    }
  }

  function eligible(pool, key, now = Date.now()) {
    if (!pool.enabled) return false;
    if (key.state === 'missing' || key.state === 'dead') return false;
    if (key.state === 'cooling' && key.coolingUntil > now) return false;
    if (key.state === 'exhausted' && key.day === today()) return false;
    rollDay(key);
    if (key.dailyQuota > 0 && key.dayTokens >= key.dailyQuota) return false;
    if (key.inflight >= key.maxConcurrency) return false;
    return true;
  }

  function score(key) {
    const quotaFactor = key.dailyQuota > 0 ? Math.max(0, 1 - key.dayTokens / key.dailyQuota) : 1;
    const loadFactor = 1 - key.inflight / Math.max(1, key.maxConcurrency);
    return key.weight * key.health * quotaFactor * Math.max(0.05, loadFactor);
  }

  function supports(pool, model, upstreamModel) {
    const names = [model, upstreamModel].filter(Boolean);
    if (pool.models.includes('*')) return true;
    return names.some((n) => pool.models.includes(n));
  }

  /**
   * 返回排好序的候选列表（provider + key），供 failover 依次尝试。
   * endpoint 用于筛掉「这个池不支持该端点」的情况（例如只允许 chat 的池不接 /v1/messages）。
   */
  function candidates(model, upstreamModel, aliasPriority = [], endpoint = null) {
    const now = Date.now();
    const out = [];
    for (const pool of providers) {
      if (endpoint && !(pool.endpoints || []).includes(endpoint)) continue;
      if (!supports(pool, model, upstreamModel)) continue;
      for (const key of pool.keys) {
        if (!eligible(pool, key, now)) continue;
        out.push({ pool, key, score: score(key), priorityRank: aliasPriority.indexOf(pool.id) });
      }
    }
    out.sort((a, b) => {
      const pa = a.priorityRank < 0 ? 999 : a.priorityRank;
      const pb = b.priorityRank < 0 ? 999 : b.priorityRank;
      if (pa !== pb) return pa - pb;
      if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
      return String(a.key.id).localeCompare(String(b.key.id));
    });
    return out;
  }

  function record(key, ok) {
    key.outcomes.push(ok);
    if (key.outcomes.length > HEALTH_WINDOW) key.outcomes.shift();
    const wins = key.outcomes.filter(Boolean).length;
    key.health = Math.max(0.05, wins / key.outcomes.length);
  }

  function markSuccess(key, tokens) {
    key.inflight = Math.max(0, key.inflight - 1);
    key.state = 'active';
    key.coolingUntil = 0;
    rollDay(key);
    key.dayRequests += 1;
    key.dayTokens += tokens || 0;
    record(key, true);
  }

  function markFailure(key, kind, detail) {
    key.inflight = Math.max(0, key.inflight - 1);
    key.lastError = { kind, detail: String(detail || '').slice(0, 200), at: new Date().toISOString() };
    record(key, false);
    if (kind === 'auth' || kind === 'forbidden') {
      key.state = 'dead';
      key.deadAt = Date.now();
    } else if (kind === 'quota') {
      key.state = 'exhausted';
    } else if (kind === 'rate_limit') {
      const strikes = (key.cooldownStrikes = (key.cooldownStrikes || 0) + 1);
      const backoff = Math.min(60_000 * 2 ** (strikes - 1), 30 * 60_000);
      key.state = 'cooling';
      key.coolingUntil = Date.now() + backoff;
    } else if (kind === 'tool_schema') {
      key.lastError.poolWide = true; // 见 docs/05 §4.7：换池而非换 key
    }
  }

  /** 到点自动恢复 cooling → active（dead 不自动恢复，需人工） */
  function housekeeping(now = Date.now()) {
    for (const p of providers) {
      for (const k of p.keys) {
        if (k.state === 'cooling' && k.coolingUntil <= now && k.inflight === 0) {
          k.state = 'active';
          k.coolingUntil = 0;
          k.cooldownStrikes = 0;
        }
        if (k.state === 'exhausted' && k.day !== today()) {
          rollDay(k);
          k.state = 'active';
        }
      }
    }
  }

  /**
   * 令牌桶限速：返回 0 表示可以立刻发；返回 >0 表示需要等待的毫秒数。
   * rpm 定义在池上（上游按 key 或按账号限速，先用池级近似）。
   */
  function takeRate(pool, key, now = Date.now()) {
    const rpm = pool.rpm || 0;
    if (rpm <= 0) return 0;
    if (!key.rpmBucket) key.rpmBucket = { tokens: rpm, last: now };
    const b = key.rpmBucket;
    const elapsedMin = (now - b.last) / 60000;
    b.tokens = Math.min(rpm, b.tokens + elapsedMin * rpm);
    b.last = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - b.tokens) * 60000) / rpm);
  }

  function snapshot() {
    return providers.map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      headersProfile: p.headersProfile,
      enabled: p.enabled,
      models: p.models,
      endpoints: p.endpoints,
      rpm: p.rpm,
      keys: p.keys.map((k) => ({
        id: k.id,
        label: k.label,
        state: k.state,
        health: Number(k.health.toFixed(3)),
        inflight: k.inflight,
        dayRequests: k.dayRequests,
        dayTokens: k.dayTokens,
        dailyQuota: k.dailyQuota,
        rpmTokens: k.rpmBucket ? Number(k.rpmBucket.tokens.toFixed(2)) : null,
        lastError: k.lastError,
      })),
    }));
  }

  function setKeyState(poolId, keyId, state) {
    const k = find(poolId, keyId);
    if (!k) return false;
    k.state = state;
    if (state === 'active') {
      k.coolingUntil = 0;
      k.cooldownStrikes = 0;
      k.health = 1;
      k.outcomes = [];
    }
    return true;
  }

  function toggleProvider(poolId, enabled) {
    const p = providers.find((x) => x.id === poolId);
    if (!p) return false;
    p.enabled = enabled;
    return true;
  }

  function provider(poolId) {
    return providers.find((p) => p.id === poolId) || null;
  }

  return {
    providers,
    find,
    candidates,
    takeRate,
    markSuccess,
    markFailure,
    housekeeping,
    snapshot,
    setKeyState,
    toggleProvider,
    provider,
  };
}
