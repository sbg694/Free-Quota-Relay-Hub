/**
 * FQRH v2 网关
 *
 * 相对 v1 的变化：
 *  - 协议转换：客户端说 chat / messages / responses，上游只支持其中一种时自动转换（含流式）
 *  - 端点规划：透传优先，转换其次；池级 403 不污染 key 状态
 *  - 限速：rpm（请求）+ tpm（token 预算）双桶
 *  - modelMap：按池配置「客户端模型 → 上游模型」
 *
 * 用法：node src/server.mjs --config config.json
 */
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { loadConfig, today, ENDPOINT_PATH } from './config.mjs';
import { openLedger } from './db.mjs';
import { createPool } from './pool.mjs';
import { createMonitor } from './monitor.mjs';
import {
  buildHeaders, requestUpstream, UsageTap, parseUsageJson, classifyStatus,
  jsonErrorBody, looksErrorEvent, looksContentEvent,
} from './upstream.mjs';
import { probePool } from './probe.mjs';
import { convertRequest, convertResponse, createStreamBridge, formatError, isConvertible } from './convert/index.mjs';
import { VERSION, CAPABILITIES, versionLine } from './version.mjs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const { config: initialConfig, warnings: initialWarnings } = loadConfig(argOf('--config', 'config.json'));
const configPath = argOf('--config', 'config.json');
let config = initialConfig;
let warnings = initialWarnings;
const port = Number(argOf('--port', config.listen.port));
const host = argOf('--host', config.listen.host);

const ledger = openLedger(argOf('--db', path.join('data', 'fqrh.db')));
let pool = createPool(config);
let monitor = createMonitor({ pool, config, ledger });

/* ---------------- 配置热更新（面板写操作走这里） ---------------- */

function reloadFromDisk() {
  const next = loadConfig(configPath);
  config = next.config;
  warnings = next.warnings;
  pool = createPool(config);
  try { monitor.stop(); } catch { /* ignore */ }
  monitor = createMonitor({ pool, config, ledger });
  monitor.start();
  return { ok: true, providers: config.providers.map((p) => p.id) };
}

function editableConfig() {
  return {
    configPath,
    resilience: config.resilience,
    routing: config.routing,
    aliases: config.aliases,
    clientKeys: config.clientKeys.map((k) => ({
      id: k.id,
      note: k.note || '',
      hasKey: Boolean(k.key),
      keyMasked: k.key ? `${String(k.key).slice(0, 6)}…${String(k.key).slice(-4)}` : '',
    })),
    providers: config.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      protocol: p.protocol,
      endpoints: p.endpoints,
      models: p.models,
      priority: p.priority,
      flakyAuth: p.flakyAuth,
      enabled: p.enabled,
      maxConcurrency: p.maxConcurrency,
      rpm: p.rpm,
      tpm: p.tpm,
      keys: p.keys.map((k) => ({
        id: k.id,
        label: k.label || '',
        weight: k.weight,
        env: k.env || '',
        file: k.file || '',
        hasValue: Boolean(k.value),
        state: k.state,
      })),
    })),
  };
}

function applyConfigPatch(patch) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const aliasesRemoved = [];
  if (patch.clientKeys) raw.clientKeys = patch.clientKeys;
  if (patch.clientKey && patch.clientKey.id) {
    // 面板只改单个客户端 key：按 id 合并，避免把其它 key 冲掉
    raw.clientKeys = raw.clientKeys || [];
    const i = raw.clientKeys.findIndex((k) => k.id === patch.clientKey.id);
    if (i < 0) raw.clientKeys.push({ ...patch.clientKey });
    else raw.clientKeys[i] = { ...raw.clientKeys[i], key: patch.clientKey.key };
  }
  if (patch.resilience) raw.resilience = { ...(raw.resilience || {}), ...patch.resilience };
  if (patch.routing) raw.routing = { ...(raw.routing || {}), ...patch.routing };
  if (patch.aliases) raw.aliases = patch.aliases;
  if (Array.isArray(patch.addProviders)) {
    raw.providers = raw.providers || [];
    for (const p of patch.addProviders) {
      if (!p || typeof p !== 'object') throw new Error('addProviders 里的项必须是对象');
      const id = String(p.id || '').trim();
      if (!id) throw new Error('提供商需要 id');
      if (raw.providers.some((x) => x.id === id)) throw new Error(`提供商 id 已存在：${id}`);
      if (!p.baseUrl) throw new Error(`提供商 ${id} 缺少 baseUrl`);
      const models = (Array.isArray(p.models) ? p.models : [p.models]).map(String).map((s) => s.trim()).filter(Boolean);
      if (!models.length) throw new Error(`提供商 ${id} 至少声明一个模型`);
      const keys = Array.isArray(p.keys) ? p.keys : [];
      if (!keys.length) throw new Error(`提供商 ${id} 至少需要一个 key`);
      raw.providers.push({
        ...p,
        id,
        name: p.name || id,
        models,
        keys,
        endpoints: Array.isArray(p.endpoints) && p.endpoints.length ? p.endpoints : ['chat'],
        protocol: p.protocol || 'chat',
        priority: Number(p.priority) || 0,
        enabled: p.enabled !== false,
      });
    }
  }
  if (Array.isArray(patch.removeProviders)) {
    raw.providers = (raw.providers || []).filter((p) => !patch.removeProviders.includes(p.id));
  }
  if (patch.providers) {
    raw.providers = raw.providers || [];
    for (const [id, p] of Object.entries(patch.providers)) {
      const i = raw.providers.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(`provider 不存在：${id}`);
      const merged = { ...raw.providers[i], ...p };
      if (p.keys) {
        merged.keys = p.keys.map((k) => {
          if (k && k.value === '') { const copy = { ...k }; delete copy.value; return copy; }
          return k;
        });
      }
      raw.providers[i] = merged;
    }
  }
  // 池增删/改动后，清理指向已不存在模型的别名（否则 /v1/models 会一直挂着一个死名字）
  if (patch.addProviders || patch.removeProviders || patch.providers) {
    raw.aliases = raw.aliases || {};
    const knownModels = new Set();
    for (const p of raw.providers || []) {
      for (const m of p.models || []) knownModels.add(m);
      for (const m of Object.keys(p.modelMap || {})) knownModels.add(m);
    }
    const poolIds = new Set((raw.providers || []).map((p) => p.id));
    for (const [name, a] of Object.entries(raw.aliases)) {
      const modelOk = !a || !a.model || knownModels.has(a.model);
      const prio = a && Array.isArray(a.priority) ? a.priority : [];
      const prioOk = !prio.length || prio.some((id) => poolIds.has(id));
      if (!modelOk || !prioOk) {
        delete raw.aliases[name];
        aliasesRemoved.push(name);
      }
    }
    if (aliasesRemoved.length) console.log('[fqrh] 已自动清理悬空别名:', aliasesRemoved.join(', '));
  }

  fs.copyFileSync(configPath, `${configPath}.bak`);
  fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return { ...reloadFromDisk(), aliasesRemoved };
}
const DASHBOARD_HTML = (() => {
  try {
    return fs.readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
  } catch {
    return '<h1>dashboard.html 缺失</h1>';
  }
})();

const metrics = {
  total: 0, success: 0, failed: 0, converted: 0,
  byKind: {}, byEndpoint: {}, byConversion: {}, bytesOut: 0,
};
const startedAt = new Date().toISOString();

const ROUTES = {
  '/v1/chat/completions': 'chat',
  '/v1/messages': 'messages',
  '/v1/responses': 'responses',
  '/v1/embeddings': 'embeddings',
  '/v1/images/generations': 'images',
};
const STREAMABLE = new Set(['chat', 'messages', 'responses']);
const RETRYABLE = new Set([
  'auth', 'quota', 'rate_limit', 'upstream_error', 'model_not_found', 'tool_schema', 'rate_limit_local', 'token_rate_local',
]);
const POOL_LEVEL = new Set(['endpoint_denied', 'unsupported_protocol']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendJson(res, status, obj) {
  if (res.headersSent) { res.end(); return; }
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function authorized(req) {
  const keys = config.clientKeys.map((k) => k.key).filter(Boolean);
  if (!keys.length) return false;
  const h = req.headers.authorization || '';
  const bearer = String(h).toLowerCase().startsWith('bearer ') ? String(h).slice(7).trim() : '';
  const xkey = String(req.headers['x-api-key'] || '');
  const gkey = String(req.headers['x-goog-api-key'] || '');
  return keys.includes(bearer) || keys.includes(xkey) || keys.includes(gkey);
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function filterResponseHeaders(upstreamHeaders) {
  const out = { ...upstreamHeaders };
  for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'host']) {
    delete out[name];
  }
  return out;
}

function drain(stream, limit = 8192) {
  return new Promise((resolve) => {
    let text = '';
    stream.on('data', (c) => { if (text.length < limit) text += c.toString('utf8'); });
    stream.on('end', () => resolve(text));
    stream.on('error', () => resolve(text));
  });
}

function promptChars(payload) {
  try { return JSON.stringify(payload.messages || payload.input || '').length; } catch { return 0; }
}

/** 估算本次请求的 token 预算（用于 tpm 预扣） */
function estimateTokens(payload) {
  const chars = promptChars(payload);
  const maxOut = payload.max_tokens ?? payload.max_output_tokens ?? 1024;
  return Math.ceil(chars / 4) + Math.min(Math.max(maxOut, 16), 4096);
}

/** 客户端协议的响应里取 usage */
function usageOf(endpoint, out) {
  const u = out?.usage || {};
  if (endpoint === 'chat') {
    return { promptTokens: u.prompt_tokens ?? null, completionTokens: u.completion_tokens ?? null, estimated: u.prompt_tokens == null && u.completion_tokens == null };
  }
  return { promptTokens: u.input_tokens ?? null, completionTokens: u.output_tokens ?? null, estimated: u.input_tokens == null && u.output_tokens == null };
}

/* ------------------------------------------------------------------ 主代理 */

async function handleProxy(clientEndpoint, req, res) {
  const bodyBuf = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    return sendJson(res, 400, formatError(clientEndpoint, 400, 'invalid_request', '请求体不是合法 JSON'));
  }
  if (!payload.model) {
    return sendJson(res, 400, formatError(clientEndpoint, 400, 'invalid_request', '缺少 model 字段'));
  }

  const clientModel = payload.model;
  const alias = config.aliases[clientModel] || {};
  const baseUpstreamModel = alias.model || clientModel;
  const wantsStream = payload.stream === true && STREAMABLE.has(clientEndpoint);

  const requestId = crypto.randomUUID();
  const t0 = Date.now();
  const rz = config.resilience;

  const buildPlan = () => pool.candidates(
    clientModel, baseUpstreamModel, alias.priority || [], clientEndpoint,
    (from) => isConvertible(from),
  );
  let plan = buildPlan();

  const blockedModelInfo = [clientModel, baseUpstreamModel].map((m) => ({ model: m, hit: pool.blockedModelFor(m) })).find((x) => x.hit) || null;

  const availableModels = () => {
    const set = new Set(Object.keys(config.aliases || {}));
    for (const p of config.providers) {
      if (p.enabled === false) continue;
      for (const m of p.models || []) if (m && m !== '*') set.add(m);
      for (const m of Object.keys(p.modelMap || {})) set.add(m);
    }
    return [...set].sort();
  };

  const planEmptyResponse = () => {
    let kind = 'no_candidate';
    let status = 503;
    let message;
    let retryable = false;
    const extra = {};

    if (blockedModelInfo) {
      kind = 'model_unauthorized';
      status = 404;
      message = `模型 ${blockedModelInfo.model} 在该池不可用（需要付费 key）。免费用请改用 -free 模型，例如 deepseek-v4.1-flash-free`;
    } else if (!pool.knowsModel(clientModel) && !pool.knowsModel(baseUpstreamModel)) {
      kind = 'model_not_found';
      status = 404;
      const avail = availableModels();
      message = `网关没有配置模型 ${clientModel}。可用模型：${avail.slice(0, 8).join(', ')}${avail.length > 8 ? ' …' : ''}`;
      extra.available_models = avail;
    } else if (pool.nextFlakyWakeMs(60000) !== null) {
      kind = 'transient_auth';
      retryable = true;
      message = '上游正在瞬时故障冷却中，请稍后重试（你的网关 key 没有问题）';
      extra.retry_after = rz.retryAfterSec ?? 2;
    } else {
      message = `没有可用上游能服务 ${clientEndpoint}（模型 ${clientModel}）：检查 providers[].models / endpoints / key 状态`;
    }

    metrics.byKind[kind] = (metrics.byKind[kind] || 0) + 1;
    // 只有「上游侧」失败进 failed 计数；模型名不对属于客户端用法问题
    if (kind === 'no_candidate' || kind === 'transient_auth') metrics.failed += 1;

    const body = formatError(clientEndpoint, status, kind, message, { request_id: requestId, retryable, ...extra });
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      ...(extra.retry_after ? { 'retry-after': String(extra.retry_after) } : {}),
    });
    return res.end(text);
  };

  // 模型已被判定为「要付费 key」：直接给明确错误，不等冷却、不重试
  if (!plan.length && blockedModelInfo) return planEmptyResponse();

  // v3：单 key 池刚被瞬时故障打冷时，等它几百毫秒再试，而不是直接给客户端 503
  for (let round = 0; round < 5 && plan.length === 0; round += 1) {
    const wake = pool.nextFlakyWakeMs(Math.max(1000, rz.flakyCooldownMs + 500));
    if (process.env.FQRH_DEBUG_PLAN) console.log('[plan] round', round, 'empty, wake=', wake);
    if (wake === null) break;
    await sleep(Math.min(wake + 30, 600));
    plan = buildPlan();
  }
  if (process.env.FQRH_DEBUG_PLAN) console.log('[plan] final len=', plan.length);

  if (!plan.length) return planEmptyResponse();

  const maxAttempts = Math.min(config.routing.maxAttempts, plan.length);
  const skippedPools = new Set();
  let lastError = null;

  for (let i = 0; i < maxAttempts; i += 1) {
    if (Date.now() - t0 > config.routing.totalBudgetMs) { lastError = { kind: 'budget_exceeded' }; break; }
    const item = plan[i];
    const { pool: provider, key } = item;
    if (!provider.enabled || skippedPools.has(provider.id)) continue;

    const target = item.target || clientEndpoint;
    // modelMap 的 key 是「规范模型名」：别名先解析成 baseUpstreamModel，再查映射
  const upstreamModel = provider.modelMap?.[baseUpstreamModel] || provider.modelMap?.[clientModel] || baseUpstreamModel;
    // 只有标记 flakyAuth 的池（免费中转站）才做"瞬时故障内重试"
    const tries = provider.flakyAuth ? Math.max(0, rz.retries) : 0;

    for (let t = 0; t <= tries; t += 1) {
      if (t > 0) {
        const wait = Math.min(rz.backoffMs * 2 ** (t - 1), rz.backoffMaxMs)
          + (rz.jitterMs ? Math.random() * rz.jitterMs : 0);
        await sleep(wait);
        if (Date.now() - t0 > config.routing.totalBudgetMs) { lastError = { kind: 'budget_exceeded' }; break; }
      }

      let upstreamBody;
      try {
        const withModel = { ...payload, model: upstreamModel };
        upstreamBody = item.converted
          ? JSON.stringify(convertRequest(clientEndpoint, target, withModel))
          : JSON.stringify(withModel);
      } catch (err) {
        lastError = { kind: 'conversion_error', provider: provider.id, detail: err.message };
        break;
      }

      // 限速只在候选的第一次尝试扣，重试不再消耗桶
      if (t === 0) {
        const waitMs = pool.takeRate(provider, key);
        if (waitMs > 0) {
          await sleep(Math.min(waitMs, config.routing.maxRateWaitMs ?? 1500));
          if (pool.takeRate(provider, key) > 0) {
            lastError = { kind: 'rate_limit_local', provider: provider.id, detail: `rpm ${provider.rpm} 已打满` };
            break;
          }
        }
        const tokenWait = pool.takeTokens(provider, key, estimateTokens(payload));
        if (tokenWait > 0) {
          await sleep(Math.min(tokenWait, config.routing.maxRateWaitMs ?? 1500));
          if (pool.takeTokens(provider, key, estimateTokens(payload)) > 0) {
            lastError = { kind: 'token_rate_local', provider: provider.id, detail: `tpm ${provider.tpm} 已打满` };
            break;
          }
        }
      }

      key.inflight += 1;
      const { headers } = buildHeaders({ provider, keyValue: key.value, inbound: req.headers, endpoint: target });
      headers['content-type'] = 'application/json';
      headers['accept-encoding'] = 'identity';
      headers['content-length'] = Buffer.byteLength(upstreamBody);

      let upstream;
      try {
        upstream = await requestUpstream({
          provider,
          path: ENDPOINT_PATH[target],
          method: 'POST',
          headers,
          body: upstreamBody,
          timeoutMs: config.routing.totalBudgetMs,
        });
      } catch (err) {
        key.inflight = Math.max(0, key.inflight - 1);
        pool.markFailure(key, 'upstream_error', err.message);
        lastError = { kind: 'upstream_error', provider: provider.id, detail: err.message };
        if (t < tries) continue;
        break;
      }

      if (upstream.status >= 200 && upstream.status < 300) {
        if (item.converted) {
          metrics.converted += 1;
          const label = `${clientEndpoint}→${target}`;
          metrics.byConversion[label] = (metrics.byConversion[label] || 0) + 1;
        }
        try {
          return await finishOk({
            res, upstream, key, provider, requestId, t0,
            wantsStream, payload, clientEndpoint, target,
            upstreamModel, clientModel, converted: item.converted, rz,
          });
        } catch (err) {
          if (err && err.transient) {
            metrics.transient = (metrics.transient || 0) + 1;
            pool.markTransient(key, rz.flakyCooldownMs, err.detail || '');
            lastError = { kind: 'transient_auth', provider: provider.id, detail: err.detail || '' };
            if (t < tries) continue;
            break;
          }
          throw err;
        }
      }

      const errText = await drain(upstream.res);
      const kind = classifyStatus(upstream.status, errText, { flakyAuth: provider.flakyAuth });

      if (kind === 'transient_auth') {
        metrics.transient = (metrics.transient || 0) + 1;
        pool.markTransient(key, rz.flakyCooldownMs, errText);
        lastError = { kind, provider: provider.id, status: upstream.status, detail: errText.slice(0, 300), upstreamModel };
        if (t < tries) continue;
        break;
      }

      if (POOL_LEVEL.has(kind)) {
        key.inflight = Math.max(0, key.inflight - 1);
        skippedPools.add(provider.id);
        lastError = { kind, provider: provider.id, status: upstream.status, detail: errText.slice(0, 300) };
        break;
      }

      pool.markFailure(key, kind, errText);
      lastError = { kind, provider: provider.id, status: upstream.status, detail: errText.slice(0, 300) };

      if (!RETRYABLE.has(kind)) { t = tries + 1; break; }
      break;
    }
  }

  // 同一个池 + 同一个模型反复鉴权失败 → 判定为该模型不可用（免费站的非 free 模型要付费 key），
  // 短期屏蔽它，避免每个请求都重试一轮再失败
  let kind = lastError?.kind || 'no_candidate';
  if (kind === 'transient_auth' && lastError?.upstreamModel) {
    const justBlocked = pool.markModelAuthFailure(lastError.provider, lastError.upstreamModel);
    if (justBlocked || pool.isModelBlocked(lastError.provider, lastError.upstreamModel)) {
      kind = 'model_unauthorized';
      lastError = { ...lastError, kind, detail: `模型 ${lastError.upstreamModel} 在该池需要付费 key（免费池不提供）` };
    }
  }

  metrics.failed += 1;
  metrics.byKind[kind] = (metrics.byKind[kind] || 0) + 1;
  ledger.logRequest({
    requestId, ts: new Date().toISOString(), endpoint: clientEndpoint, clientModel,
    upstreamModel: baseUpstreamModel, status: lastError?.status || 502,
    errorKind: kind, totalMs: Date.now() - t0,
  });

  const status = kind === 'model_unauthorized' ? 404
    : kind === 'transient_auth' ? 503
      : kind === 'rate_limit_local' || kind === 'token_rate_local' ? 429
        : lastError?.status === 404 ? 404
          : 502;

  const body = formatError(
    clientEndpoint, status, kind,
    kind === 'model_unauthorized'
      ? `模型 ${lastError?.upstreamModel || clientModel} 在该池不可用（需要付费 key）。免费用请改用 -free 模型，例如 deepseek-v4.1-flash-free`
      : kind === 'transient_auth'
        ? `上游瞬时故障（共享 key 池空转/假鉴权失败），已自动重试仍失败，请几秒后重试；你的网关 key 没有问题`
        : `所有候选上游都失败了（最后：${lastError?.provider || '-'} ${lastError?.kind || ''} ${String(lastError?.detail || '').slice(0, 200)}）`,
    { last: lastError, attempts: maxAttempts, request_id: requestId, retryable: kind === 'transient_auth' },
  );

  if (kind === 'transient_auth') {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(503, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'retry-after': String(config.resilience.retryAfterSec ?? 2),
    });
    return res.end(text);
  }
  return sendJson(res, status, body);
}

async function finishOk(ctx) {
  const {
    res, upstream, key, provider, requestId, t0, wantsStream, payload,
    clientEndpoint, target, upstreamModel, clientModel, converted, rz,
  } = ctx;

  let settled = false;

  const complete = (usage, status) => {
    if (settled) return;
    settled = true;
    const totalMs = Date.now() - t0;
    const tokens = (usage?.promptTokens || 0) + (usage?.completionTokens || 0);
    pool.markSuccess(key, tokens);
    if (provider.tpm) pool.settleTokens(provider, key, tokens);
    metrics.total += 1;
    metrics.success += 1;
    metrics.byEndpoint[clientEndpoint] = (metrics.byEndpoint[clientEndpoint] || 0) + 1;
    ledger.logRequest({
      requestId, ts: new Date().toISOString(), endpoint: clientEndpoint,
      poolId: provider.id, keyId: key.id, clientModel, upstreamModel, status,
      firstTokenMs: firstTokenMs || null, totalMs,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      estimated: usage?.estimated ? 1 : 0,
    });
    ledger.bumpDaily(today(), key.id, 1, tokens);
  };

  let firstTokenMs = null;

  res.on('close', () => {
    if (!settled && !res.writableEnded) {
      upstream.res.destroy();
      settled = true;
      pool.markFailure(key, 'client_abort', '客户端提前断开');
      metrics.byKind.client_abort = (metrics.byKind.client_abort || 0) + 1;
    }
  });

  // v3：只有 flaky 池才做首包缓冲（普通上游零延迟直通）
  const preludeMs = provider.flakyAuth ? (rz?.preludeMs ?? 2500) : 0;

  /* ---------- 流式（透传或转换），带首包缓冲 ---------- */
  if (wantsStream) {
    const tap = new UsageTap();
    const headers = filterResponseHeaders(upstream.headers);
    const bridge = converted
      ? createStreamBridge({
        fromEndpoint: target,
        toEndpoint: clientEndpoint,
        write: (chunk) => res.write(chunk),
        meta: { id: `${requestId}`, model: upstreamModel },
      })
      : null;

    return await new Promise((resolve, reject) => {
      let started = false;
      let aborted = false;
      let buf = Buffer.alloc(0);
      let timer = null;

      const failTransient = (detail) => {
        if (aborted) return;
        aborted = true;
        if (timer) { clearTimeout(timer); timer = null; }
        try { upstream.res.destroy(); } catch { /* ignore */ }
        reject({ transient: true, detail });
      };

      const forward = (chunk) => {
        if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
        metrics.bytesOut += chunk.length;
        if (converted) {
          try { bridge.feed(chunk); } catch (err) {
            metrics.byKind.conversion_error = (metrics.byKind.conversion_error || 0) + 1;
            console.error('[fqrh] stream convert error', err.message);
          }
        } else {
          tap.feed(chunk);
          res.write(chunk);
        }
      };

      const start = () => {
        if (started) return;
        started = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (res.headersSent) return;
        if (converted) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
            'x-fqrh-convert': `${clientEndpoint}:${target}`,
          });
        } else {
          res.writeHead(upstream.status, {
            ...headers,
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
        }
        if (buf.length) { const b = buf; buf = null; forward(b); }
      };

      if (preludeMs > 0) timer = setTimeout(start, preludeMs);
      else start();

      upstream.res.on('data', (chunk) => {
        if (aborted) return;
        if (started) { forward(chunk); return; }
        buf = Buffer.concat([buf, chunk]);
        const text = buf.toString('utf8');
        if (looksErrorEvent(text)) {
          failTransient(text.slice(0, 200));
          return;
        }
        if (looksContentEvent(text) || buf.length > 64 * 1024) start();
      });

      upstream.res.on('end', () => {
        if (aborted) return;
        if (!started) start();
        if (converted) { try { bridge.end(); } catch { /* ignore */ } }
        res.end();
        complete(converted ? bridge.usage() : tap.result(promptChars(payload)), upstream.status);
        resolve({ ok: true });
      });

      upstream.res.on('error', () => {
        if (aborted) return;
        if (!started) {
          failTransient('stream error before first byte');
          return;
        }
        if (!settled) {
          settled = true;
          pool.markFailure(key, 'upstream_error', 'stream error');
          metrics.byKind.upstream_stream_error = (metrics.byKind.upstream_stream_error || 0) + 1;
        }
        if (converted) { try { bridge.end(); } catch { /* ignore */ } }
        res.end();
        resolve({ ok: true });
      });
    });
  }

  /* ---------- 非流式 ---------- */
  const headers = filterResponseHeaders(upstream.headers);
  return await new Promise((resolve, reject) => {
    const buf = [];
    upstream.res.on('data', (chunk) => { metrics.bytesOut += chunk.length; buf.push(chunk); });

    upstream.res.on('end', () => {
      const text = Buffer.concat(buf).toString('utf8');

      // v3：200 里藏 error（免费站伪装）→ 当作瞬时故障，交给上层静默重试
      if (provider.flakyAuth) {
        const err = jsonErrorBody(text);
        if (err) {
          reject({ transient: true, detail: JSON.stringify(err).slice(0, 200) });
          return;
        }
      }

      if (converted) {
        let out;
        try {
          const upstreamJson = JSON.parse(text);
          out = convertResponse(target, clientEndpoint, upstreamJson, { id: requestId, model: upstreamModel });
        } catch (err) {
          metrics.byKind.conversion_error = (metrics.byKind.conversion_error || 0) + 1;
          if (!res.headersSent) sendJson(res, 502, formatError(clientEndpoint, 502, 'conversion_error', `上游响应转换失败：${err.message}`));
          else res.end();
          complete({ promptTokens: null, completionTokens: null, estimated: true }, 502);
          resolve({ ok: true });
          return;
        }
        const bodyText = JSON.stringify(out);
        if (!res.headersSent) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(bodyText), 'x-fqrh-convert': `${clientEndpoint}:${target}` });
        }
        res.end(bodyText);
        complete(usageOf(clientEndpoint, out), 200);
        resolve({ ok: true });
        return;
      }

      const usage = parseUsageJson(text);
      if (!res.headersSent) {
        res.writeHead(upstream.status, {
          ...headers,
          'content-type': headers['content-type'] || 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(text),
        });
      }
      res.end(text);
      complete(usage, upstream.status);
      resolve({ ok: true });
    });

    upstream.res.on('error', () => {
      if (!settled) {
        settled = true;
        pool.markFailure(key, 'upstream_error', 'stream error');
        metrics.byKind.upstream_stream_error = (metrics.byKind.upstream_stream_error || 0) + 1;
      }
      if (!res.headersSent) sendJson(res, 502, formatError(clientEndpoint, 502, 'upstream_stream_error', '上游流中断'));
      else res.end();
      resolve({ ok: true });
    });
  });
}

/* ------------------------------------------------------------------ 元信息 */

function handleModels(req, res) {
  const ids = new Set();
  // 只列「目标模型仍然存在」的别名，避免删池后残留死名字
  for (const [name, a] of Object.entries(config.aliases || {})) {
    if (!a || !a.model || pool.knowsModel(a.model)) ids.add(name);
  }
  for (const p of config.providers) {
    if (!p.enabled) continue;
    for (const m of p.models) if (m !== '*') ids.add(m);
    // modelMap 的 key 是客户端可用的规范模型名（上游可能叫别的）
    for (const m of Object.keys(p.modelMap || {})) ids.add(m);
  }
  sendJson(res, 200, {
    object: 'list',
    data: [...ids].sort().map((id) => ({ id, object: 'model', owned_by: 'fqrh' })),
  });
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    version: VERSION,
    capabilities: CAPABILITIES,
    startedAt,
    uptimeSec: Math.round(process.uptime()),
    providers: pool.snapshot().map((p) => ({
      id: p.id, enabled: p.enabled, protocol: p.protocol, endpoints: p.endpoints,
      keys: p.keys.map((k) => ({ id: k.id, state: k.state, health: k.health })),
    })),
    metrics,
    monitor: (() => {
      const s = monitor.status();
      return { enabled: s.enabled, intervalSec: s.intervalSec, lastRunAt: s.lastRunAt, counters: s.counters, webhook: Boolean(s.webhook) };
    })(),
  });
}

function handleMetrics(req, res) {
  const lines = [
    '# TYPE fqrh_requests_total counter',
    `fqrh_requests_total ${metrics.total}`,
    `fqrh_requests_success ${metrics.success}`,
    `fqrh_requests_failed ${metrics.failed}`,
    `fqrh_requests_converted ${metrics.converted}`,
    `fqrh_transient_retries ${metrics.transient || 0}`,
  ];
  for (const [kind, n] of Object.entries(metrics.byKind)) lines.push(`fqrh_failures{kind="${kind}"} ${n}`);
  const ms = monitor.status();
  lines.push(`fqrh_monitor_probes ${ms.counters.probes || 0}`);
  lines.push(`fqrh_monitor_alerts ${ms.counters.alerts || 0}`);
  lines.push(`fqrh_monitor_alerts_delivered ${ms.counters.delivered || 0}`);
  lines.push(`fqrh_monitor_alert_failures ${ms.counters.failed || 0}`);
  for (const [ep, n] of Object.entries(metrics.byEndpoint)) lines.push(`fqrh_endpoint_requests{endpoint="${ep}"} ${n}`);
  for (const [pair, n] of Object.entries(metrics.byConversion)) lines.push(`fqrh_conversions{pair="${pair}"} ${n}`);
  for (const p of pool.snapshot()) {
    for (const k of p.keys) {
      lines.push(`fqrh_key_health{pool="${p.id}",key="${k.id}"} ${k.health}`);
      lines.push(`fqrh_key_day_tokens{pool="${p.id}",key="${k.id}"} ${k.dayTokens}`);
    }
  }
  const body = lines.join('\n') + '\n';
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/* ------------------------------------------------------------------ 管理 */

async function handleAdmin(req, res, url) {
  if (!authorized(req)) return sendJson(res, 401, { error: { type: 'unauthorized' } });

  if (req.method === 'GET' && url.pathname === '/__admin/state') {
    return sendJson(res, 200, {
      version: VERSION,
      capabilities: CAPABILITIES,
      configPath: config.configPath,
      warnings,
      routing: config.routing,
      resilience: config.resilience,
      metrics,
      providers: pool.snapshot(),
      daily: ledger.daily(today()),
      recent: ledger.recent(20),
    });
  }

  if (req.method === 'POST' && url.pathname === '/__admin/convert-preview') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const { from, to, payload } = body;
    if (!isConvertible(from) || !isConvertible(to) || !payload) {
      return sendJson(res, 400, { error: { type: 'bad_request', message: '需要 from/to ∈ chat|messages|responses 且提供 payload' } });
    }
    try {
      return sendJson(res, 200, { from, to, request: convertRequest(from, to, payload) });
    } catch (err) {
      return sendJson(res, 400, { error: { type: 'conversion_error', message: err.message } });
    }
  }

  if (req.method === 'POST' && url.pathname === '/__admin/probe') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const provider = pool.provider(body.poolId);
    if (!provider) return sendJson(res, 404, { error: { type: 'provider_not_found' } });
    const key = (body.keyId && provider.keys.find((k) => k.id === body.keyId))
      || provider.keys.find((k) => k.state === 'active')
      || provider.keys.find((k) => k.state !== 'missing');
    if (!key) return sendJson(res, 400, { error: { type: 'no_key' } });
    return sendJson(res, 200, { poolId: provider.id, keyId: key.id, ...(await probePool({ provider, key })) });
  }

  if (req.method === 'POST' && url.pathname === '/__admin/probe-all') {
    const run = await monitor.probeOnce('manual');
    const active = run.results.filter((r) => !r.skipped);
    return sendJson(res, 200, { ok: active.every((r) => r.ok), runAt: run.runAt, results: run.results });
  }

  if (req.method === 'GET' && url.pathname === '/__admin/alerts') {
    return sendJson(res, 200, {
      alerts: monitor.alertsView(50),
      monitor: monitor.status(),
    });
  }

  if (req.method === 'POST' && url.pathname === '/__admin/alert-test') {
    const alert = monitor.testAlert();
    return sendJson(res, 200, { ok: Boolean(alert), alert });
  }

  if (req.method === 'POST' && url.pathname === '/__admin/key-state') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    return sendJson(res, 200, { ok: pool.setKeyState(body.poolId, body.keyId, body.state) });
  }

  if (req.method === 'POST' && url.pathname === '/__admin/provider-toggle') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    return sendJson(res, 200, { ok: pool.toggleProvider(body.poolId, body.enabled !== false) });
  }

  if (req.method === 'GET' && url.pathname === '/__admin/config') {
    return sendJson(res, 200, editableConfig());
  }

  if (req.method === 'POST' && url.pathname === '/__admin/config') {
    let patch;
    try { patch = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {
      return sendJson(res, 400, { error: { type: 'bad_request', message: 'body 必须是 JSON' } });
    }
    try {
      const r = applyConfigPatch(patch);
      return sendJson(res, 200, { ...r, config: editableConfig() });
    } catch (err) {
      return sendJson(res, 400, { error: { type: 'config_write_failed', message: err.message } });
    }
  }

  if (req.method === 'POST' && url.pathname === '/__admin/reload') {
    try {
      return sendJson(res, 200, reloadFromDisk());
    } catch (err) {
      return sendJson(res, 400, { error: { type: 'reload_failed', message: err.message } });
    }
  }

  if (req.method === 'POST' && url.pathname === '/__admin/scan-models') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    let provider;
    let key;
    let endpoint = null;
    if (body.providerId) {
      provider = pool.provider(body.providerId);
      if (!provider) return sendJson(res, 404, { error: { type: 'provider_not_found' } });
      key = provider.keys.find((k) => k.state === 'active')
        || provider.keys.find((k) => k.state !== 'missing' && k.state !== 'dead' && k.state !== 'exhausted')
        || provider.keys.find((k) => k.value)
        || { id: 'none', value: '' };
      endpoint = provider.protocol === 'messages' ? 'messages' : null;
    } else {
      if (!body.baseUrl) return sendJson(res, 400, { error: { type: 'bad_request', message: '需要 baseUrl 或 providerId' } });
      provider = {
        id: body.id || 'scan-temp',
        baseUrl: String(body.baseUrl),
        protocol: body.protocol || 'chat',
        endpoints: ['chat'],
        headersProfile: body.headersProfile || 'none',
        headers: body.headers || {},
        upstreamProxy: body.upstreamProxy || '',
        keys: [],
      };
      key = {
        id: 'scan',
        value: body.key ? String(body.key) : (body.env ? String(process.env[body.env] || '') : ''),
      };
      endpoint = provider.protocol === 'messages' ? 'messages' : null;
    }
    const candidates = body.providerId
      ? provider.keys.filter((k) => k.value && k.state !== 'missing')
        .sort((a, b) => (b.health == null ? 1 : b.health) - (a.health == null ? 1 : a.health))
      : (key.value ? [key] : []);
    if (!candidates.length) return sendJson(res, 400, { error: { type: 'no_key', message: '扫描需要 API key（或该池已有可用 key）' } });
    let r = null;
    for (const k of candidates.slice(0, 3)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        r = await probePool({ provider, key: k, endpoint });
        if (r.ok) break;
        if (r.status !== 0) break; // 明确的 HTTP 错误不重试
        await new Promise((res) => setTimeout(res, 300));
      }
      if (r.ok) break;
    }
    return sendJson(res, 200, {
      ok: Boolean(r.ok),
      status: r.status,
      latency: r.latency,
      count: (r.models || []).length,
      models: r.models || [],
      error: r.error || null,
    });
  }

  return sendJson(res, 404, { error: { type: 'not_found' } });
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/healthz') return handleHealth(req, res);
    if (url.pathname === '/metrics') return handleMetrics(req, res);
    if (url.pathname === '/__admin/dashboard') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(DASHBOARD_HTML) });
      return res.end(DASHBOARD_HTML);
    }
    if (url.pathname.startsWith('/__admin')) return await handleAdmin(req, res, url);

    if (!authorized(req)) {
      return sendJson(res, 401, { error: { type: 'unauthorized', message: '缺少或错误的网关 key（authorization: Bearer … / x-api-key）' } });
    }

    if (url.pathname === '/v1/models' && req.method === 'GET') return handleModels(req, res);

    const endpoint = ROUTES[url.pathname];
    if (endpoint && req.method === 'POST') return await handleProxy(endpoint, req, res);

    return sendJson(res, 404, { error: { type: 'not_found', path: url.pathname } });
  } catch (err) {
    console.error('[fqrh] unhandled', err);
    if (!res.headersSent) sendJson(res, 500, { error: { type: 'internal', message: err.message } });
    else res.end();
  }
});

setInterval(() => pool.housekeeping(), 5000).unref();

server.listen(port, host, () => {
  console.log(versionLine());
  console.log(`[fqrh] listening http://${host}:${port}`);
  console.log(`[fqrh] 面板 http://${host}:${port}/__admin/dashboard`);
  console.log(`[fqrh] config ${config.configPath}`);
  for (const p of config.providers) {
    console.log(`[fqrh]   ${p.id.padEnd(16)} ${p.enabled ? 'on ' : 'off'} endpoints=${p.endpoints.join(',')} models=${p.models.join(',')} rpm=${p.rpm} tpm=${p.tpm}`);
  }
  for (const w of warnings) console.warn(`[fqrh] warn: ${w}`);
  monitor.start();
});

function shutdown(sig) {
  console.log(`[fqrh] ${sig} → closing`);
  monitor.stop();
  server.close(() => { ledger.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
