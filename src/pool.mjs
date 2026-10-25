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
    if (key.state === 'flaky') {
      if (key.coolingUntil > now) return false;
      key.state = 'active';
      key.coolingUntil = 0;
    }
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
    if (pool.models.includes('*')) return true;
    const names = [model, upstreamModel].filter(Boolean);
    // v4：池可以只声明上游模型名，用 modelMap 把客户端模型名映射过去
    // 别名场景：supports 收到的是 (别名, 规范名)，两个都要试
    const mapKey = [model, upstreamModel].find((n) => n && pool.modelMap && Object.prototype.hasOwnProperty.call(pool.modelMap, n));
    const mapped = mapKey ? pool.modelMap[mapKey] : null;
    const declared = names.some((n) => pool.models.includes(n)) || (mapped && pool.models.includes(mapped));
    if (!declared) return false;
    const blocked = pool.modelBlocked || {};
    const now = Date.now();
    return !names.some((n) => blocked[n] && blocked[n] > now);
  }

  /**
   * v3：同一个「池 + 模型」反复返回鉴权类错误（例如免费站的非 free 模型要付费 key），
   * 记下来短期屏蔽该模型，避免每次都重试一轮再失败。
   */
  function markModelAuthFailure(poolId, model, { threshold = 2, blockMs = 10 * 60_000 } = {}) {
    const p = providers.find((x) => x.id === poolId);
    if (!p || !model) return false;
    p.modelAuthFails = p.modelAuthFails || {};
    const rec = p.modelAuthFails[model] || { count: 0, at: 0 };
    const now = Date.now();
    if (now - rec.at > 5 * 60_000) rec.count = 0;
    rec.count += 1;
    rec.at = now;
    p.modelAuthFails[model] = rec;
    if (rec.count >= threshold) {
      p.modelBlocked = p.modelBlocked || {};
      p.modelBlocked[model] = now + blockMs;
      return true;
    }
    return false;
  }

  function isModelBlocked(poolId, model) {
    const p = providers.find((x) => x.id === poolId);
    const until = p?.modelBlocked?.[model];
    return Boolean(until && until > Date.now());
  }

  /** v3：是否有任何启用中的池声明过这个模型（含 modelMap 别名） */
  function knowsModel(model) {
    if (!model) return false;
    for (const p of providers) {
      if (!p.enabled) continue;
      if (p.models.includes('*') || p.models.includes(model)) return true;
      if (p.modelMap && Object.prototype.hasOwnProperty.call(p.modelMap, model)) return true;
    }
    return false;
  }

  /** v3：该模型是否正在某个池里被短期屏蔽（判定为「要付费 key」） */
  function blockedModelFor(model) {
    const now = Date.now();
    for (const p of providers) {
      if (!p.enabled) continue;
      const until = p.modelBlocked?.[model];
      if (until && until > now) return { provider: p.id, until };
    }
    return null;
  }

  /**
   * 池能为该客户端端点提供哪种上游端点：
   * 1) 原生支持 → 直接透传
   * 2) 支持其他可转换端点 → 转换（优先 chat，其次 messages，最后 responses）
   */
  function planEndpoint(pool, clientEndpoint, canConvert) {
    const eps = pool.endpoints || [];
    if (eps.includes(clientEndpoint)) return { target: clientEndpoint, converted: false };
    if (!canConvert || !canConvert(clientEndpoint)) return null;
    for (const target of ['chat', 'messages', 'responses']) {
      if (target === clientEndpoint) continue;
      if (eps.includes(target) && canConvert(clientEndpoint, target)) return { target, converted: true };
    }
    return null;
  }

  /**
   * 返回排好序的候选列表（provider + key + 目标端点），供 failover 依次尝试。
   * 透传候选优先于需转换的候选（少一次转换 = 少一类故障）。
   */
  function candidates(model, upstreamModel, aliasPriority = [], clientEndpoint = null, canConvert = null) {
    const now = Date.now();
    const out = [];
    for (const pool of providers) {
      const plan = clientEndpoint ? planEndpoint(pool, clientEndpoint, canConvert) : { target: null, converted: false };
      if (clientEndpoint && !plan) continue;
      if (!supports(pool, model, upstreamModel)) continue;
      for (const key of pool.keys) {
        if (!eligible(pool, key, now)) continue;
        out.push({
          pool, key, score: score(key),
          priorityRank: aliasPriority.indexOf(pool.id),
          target: plan.target, converted: plan.converted,
        });
      }
    }
    out.sort((a, b) => {
      if (a.converted !== b.converted) return a.converted ? 1 : -1;
      const pa = a.priorityRank < 0 ? 999 : a.priorityRank;
      const pb = b.priorityRank < 0 ? 999 : b.priorityRank;
      if (pa !== pb) return pa - pb;
      // 池级优先级（主用中转站压过备用池），再比 key 打分
      const ppa = a.pool.priority || 0;
      const ppb = b.pool.priority || 0;
      if (ppa !== ppb) return ppb - ppa;
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

  /**
   * v3：最近的 flaky key 还要多久恢复。单 key 池冷却期间不该直接 503，
   * 上层可以用这个值等一小会儿再重试。
   */
  function nextFlakyWakeMs(maxMs = 6000, now = Date.now()) {
    let best = null;
    for (const p of providers) {
      if (!p.enabled) continue;
      for (const k of p.keys) {
        if (k.state !== 'flaky') continue;
        const ms = Math.max(0, k.coolingUntil - now);
        if (ms <= maxMs && (best === null || ms < best)) best = ms;
      }
    }
    return best;
  }

  function markSuccess(key, tokens) {
    key.inflight = Math.max(0, key.inflight - 1);
    key.state = 'active';
    key.coolingUntil = 0;
    key.consecutiveTransient = 0;
    rollDay(key);
    key.dayRequests += 1;
    key.dayTokens += tokens || 0;
    record(key, true);
  }

  /**
   * v3：瞬时故障（假 401 / 假密钥无效 / 200 里藏 error）——不拉黑 key，
   * 只让它短暂冷却，随后可继续用；同时计入健康度，让调度偏向更稳的 key。
   */
  function markTransient(key, cooldownMs = 2500, detail = '') {
    key.inflight = Math.max(0, key.inflight - 1);
    key.state = 'flaky';
    key.coolingUntil = Date.now() + Math.max(200, cooldownMs);
    key.transientCount = (key.transientCount || 0) + 1;
    key.consecutiveTransient = (key.consecutiveTransient || 0) + 1;
    key.lastError = { kind: 'transient_auth', detail: String(detail || '').slice(0, 200), at: new Date().toISOString() };
    record(key, false);
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
        if (k.state === 'flaky' && k.coolingUntil <= now && k.inflight === 0) {
          k.state = 'active';
          k.coolingUntil = 0;
        }
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
   * rpm 按请求数计，tpm 按 token 预算计（请求前用估算值预扣，请求后按实际值修正）。
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

  /** 按 token 预算预扣（tpm<=0 时直接放行） */
  function takeTokens(pool, key, estimate, now = Date.now()) {
    const tpm = pool.tpm || 0;
    if (tpm <= 0) return 0;
    if (!key.tpmBucket) key.tpmBucket = { tokens: tpm, last: now };
    const b = key.tpmBucket;
    const elapsedMin = (now - b.last) / 60000;
    b.tokens = Math.min(tpm, b.tokens + elapsedMin * tpm);
    b.last = now;
    const need = Math.max(1, Math.min(estimate || 1, tpm));
    if (b.tokens >= need) {
      b.tokens -= need;
      key.tpmReserved = (key.tpmReserved || 0) + need;
      return 0;
    }
    return Math.ceil(((need - b.tokens) * 60000) / tpm);
  }

  /** 请求结束后按实际用量修正 tpm 桶（多退少补） */
  function settleTokens(pool, key, actualTokens) {
    if (!pool.tpm || !key.tpmBucket) return;
    const reserved = key.tpmReserved || 0;
    const diff = actualTokens - reserved;
    key.tpmBucket.tokens = Math.max(-pool.tpm, Math.min(pool.tpm, key.tpmBucket.tokens - diff));
    key.tpmReserved = 0;
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
      protocol: p.protocol,
      priority: p.priority || 0,
      models: p.models,
      modelBlocked: Object.fromEntries(Object.entries(p.modelBlocked || {}).filter(([, until]) => until > Date.now())),
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
        tpmTokens: k.tpmBucket ? Number(k.tpmBucket.tokens.toFixed(0)) : null,
        transientCount: k.transientCount || 0,
        consecutiveTransient: k.consecutiveTransient || 0,
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
    takeTokens,
    settleTokens,
    nextFlakyWakeMs,
    markSuccess,
    markFailure,
    markTransient,
    markModelAuthFailure,
    isModelBlocked,
    blockedModelFor,
    knowsModel,
    housekeeping,
    snapshot,
    setKeyState,
    toggleProvider,
    provider,
  };
}
