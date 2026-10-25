/**
 * FQRH 网关（M2/M3）
 *
 * 对外（OpenAI / Anthropic 兼容）：
 *   POST /v1/chat/completions     chat
 *   POST /v1/messages             messages（anthropic 头）
 *   POST /v1/responses            responses
 *   POST /v1/embeddings           embeddings
 *   POST /v1/images/generations   images
 *   GET  /v1/models
 *   GET  /healthz   /metrics
 * 管理（需客户端 key）：
 *   GET  /__admin/state           池/密钥/日用量/最近日志
 *   POST /__admin/probe           { poolId, keyId? }       单池探活
 *   POST /__admin/probe-all       全部探活
 *   POST /__admin/key-state       { poolId, keyId, state }
 *   POST /__admin/provider-toggle { poolId, enabled }
 *
 * 用法：node src/server.mjs --config config.json
 */
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { loadConfig, today, ENDPOINT_PATH } from './config.mjs';
import { openLedger } from './db.mjs';
import { createPool } from './pool.mjs';
import {
  buildHeaders, requestUpstream, UsageTap, parseUsageJson, classifyStatus,
} from './upstream.mjs';
import { probePool } from './probe.mjs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const { config, warnings } = loadConfig(argOf('--config', 'config.json'));
const port = Number(argOf('--port', config.listen.port));
const host = argOf('--host', config.listen.host);

const ledger = openLedger(argOf('--db', path.join('data', 'fqrh.db')));
const pool = createPool(config);

const metrics = { total: 0, success: 0, failed: 0, byKind: {}, byEndpoint: {}, bytesOut: 0 };
const startedAt = new Date().toISOString();

const ROUTES = {
  '/v1/chat/completions': 'chat',
  '/v1/messages': 'messages',
  '/v1/responses': 'responses',
  '/v1/embeddings': 'embeddings',
  '/v1/images/generations': 'images',
};
/** 能流式返回的端点 */
const STREAMABLE = new Set(['chat', 'messages', 'responses']);
const RETRYABLE = new Set([
  'auth', 'quota', 'rate_limit', 'upstream_error', 'model_not_found', 'tool_schema', 'rate_limit_local',
]);
/** 池级策略错误：不拉黑 key、不重试同一池 */
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

/** 估算 prompt 字符数（流式且上游不给 usage 时用来粗略记账） */
function promptChars(payload) {
  try {
    const m = payload.messages || payload.input || '';
    return JSON.stringify(m).length;
  } catch { return 0; }
}

/* ------------------------------------------------------------------ 主代理 */

async function handleProxy(endpoint, req, res) {
  const bodyBuf = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: { type: 'invalid_request', message: '请求体不是合法 JSON' } });
  }
  if (!payload.model) {
    return sendJson(res, 400, { error: { type: 'invalid_request', message: '缺少 model 字段' } });
  }

  const clientModel = payload.model;
  const alias = config.aliases[clientModel] || {};
  const upstreamModel = alias.model || clientModel;

  if (!ENDPOINT_PATH[endpoint]) {
    return sendJson(res, 404, { error: { type: 'not_found', endpoint } });
  }

  const plan = pool.candidates(clientModel, upstreamModel, alias.priority || [], endpoint);
  if (!plan.length) {
    return sendJson(res, 503, {
      error: {
        type: 'no_candidate',
        message: `没有可用上游能服务 ${endpoint}（模型 ${clientModel}）`,
        hint: '检查 providers[].models / providers[].endpoints / key 状态；GET /__admin/state',
      },
    });
  }

  const requestId = crypto.randomUUID();
  const t0 = Date.now();
  const wantsStream = payload.stream === true && STREAMABLE.has(endpoint);
  const upstreamBody = JSON.stringify({ ...payload, model: upstreamModel });
  const maxAttempts = Math.min(config.routing.maxAttempts, plan.length);
  const skippedPools = new Set();
  let lastError = null;

  for (let i = 0; i < maxAttempts; i += 1) {
    if (Date.now() - t0 > config.routing.totalBudgetMs) { lastError = { kind: 'budget_exceeded' }; break; }
    const { pool: provider, key } = plan[i];
    if (!provider.enabled || skippedPools.has(provider.id)) continue;

    // rpm 令牌桶：先等一下，还拿不到就换下一个候选
    const waitMs = pool.takeRate(provider, key);
    if (waitMs > 0) {
      await sleep(Math.min(waitMs, config.routing.maxRateWaitMs ?? 1500));
      if (pool.takeRate(provider, key) > 0) {
        lastError = { kind: 'rate_limit_local', provider: provider.id, detail: `rpm ${provider.rpm} 已打满` };
        continue;
      }
    }

    key.inflight += 1;
    const { headers } = buildHeaders({ provider, keyValue: key.value, inbound: req.headers, endpoint });
    headers['content-type'] = 'application/json';
    headers['accept-encoding'] = 'identity';
    headers['content-length'] = Buffer.byteLength(upstreamBody);

    let upstream;
    try {
      upstream = await requestUpstream({
        provider,
        path: ENDPOINT_PATH[endpoint],
        method: 'POST',
        headers,
        body: upstreamBody,
        timeoutMs: config.routing.totalBudgetMs,
      });
    } catch (err) {
      key.inflight = Math.max(0, key.inflight - 1);
      pool.markFailure(key, 'upstream_error', err.message);
      lastError = { kind: 'upstream_error', provider: provider.id, detail: err.message };
      continue;
    }

    if (upstream.status >= 200 && upstream.status < 300) {
      return finishOk({ res, upstream, key, provider, requestId, t0, wantsStream, upstreamModel, clientModel, payload, endpoint });
    }

    const errText = await drain(upstream.res);
    const kind = classifyStatus(upstream.status, errText);

    if (POOL_LEVEL.has(kind)) {
      // 分组不允许该端点：整池跳过，不污染 key 状态
      key.inflight = Math.max(0, key.inflight - 1);
      skippedPools.add(provider.id);
      lastError = { kind, provider: provider.id, status: upstream.status, detail: errText.slice(0, 300) };
      continue;
    }

    pool.markFailure(key, kind, errText);
    lastError = { kind, provider: provider.id, status: upstream.status, detail: errText.slice(0, 300) };

    if (!RETRYABLE.has(kind)) {
      return sendJson(res, upstream.status, {
        error: {
          type: kind,
          message: `上游 ${provider.id} 返回 ${upstream.status}`,
          upstream: errText.slice(0, 500),
          request_id: requestId,
        },
      });
    }
  }

  const kind = lastError?.kind || 'no_candidate';
  metrics.failed += 1;
  metrics.byKind[kind] = (metrics.byKind[kind] || 0) + 1;
  ledger.logRequest({
    requestId, ts: new Date().toISOString(), endpoint, clientModel, upstreamModel,
    status: lastError?.status || 502, errorKind: kind, totalMs: Date.now() - t0,
  });

  const status = kind === 'rate_limit_local' ? 429 : 502;
  return sendJson(res, status, {
    error: {
      type: 'upstream_failed',
      message: '所有候选上游都失败了',
      attempts: maxAttempts,
      last: lastError,
      request_id: requestId,
    },
  });
}

function finishOk(ctx) {
  const { res, upstream, key, provider, requestId, t0, wantsStream, upstreamModel, clientModel, payload, endpoint } = ctx;
  const tap = new UsageTap();
  let firstTokenMs = null;
  let settled = false;

  const headers = filterResponseHeaders(upstream.headers);
  if (wantsStream) {
    res.writeHead(upstream.status, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
  }

  // 客户端断开：立刻断开上游，别把 token 白烧完
  res.on('close', () => {
    if (!settled && !res.writableEnded) {
      upstream.res.destroy();
      settled = true;
      pool.markFailure(key, 'client_abort', '客户端提前断开');
      metrics.byKind.client_abort = (metrics.byKind.client_abort || 0) + 1;
    }
  });

  const complete = (usage, status) => {
    if (settled) return;
    settled = true;
    const totalMs = Date.now() - t0;
    const tokens = (usage?.promptTokens || 0) + (usage?.completionTokens || 0);
    pool.markSuccess(key, tokens);
    metrics.total += 1;
    metrics.success += 1;
    metrics.byEndpoint[endpoint] = (metrics.byEndpoint[endpoint] || 0) + 1;
    ledger.logRequest({
      requestId, ts: new Date().toISOString(), endpoint, poolId: provider.id, keyId: key.id,
      clientModel, upstreamModel, status,
      firstTokenMs, totalMs,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      estimated: usage?.estimated ? 1 : 0,
    });
    ledger.bumpDaily(today(), key.id, 1, tokens);
  };

  const buf = wantsStream ? null : [];
  upstream.res.on('data', (chunk) => {
    if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
    tap.feed(chunk);
    metrics.bytesOut += chunk.length;
    if (wantsStream) res.write(chunk);
    else buf.push(chunk);
  });

  upstream.res.on('end', () => {
    if (wantsStream) {
      res.end();
      complete(tap.result(promptChars(payload)), upstream.status);
    } else {
      const text = Buffer.concat(buf).toString('utf8');
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
    }
  });

  upstream.res.on('error', () => {
    if (!settled) {
      settled = true;
      pool.markFailure(key, 'upstream_error', 'stream error');
      metrics.byKind.upstream_stream_error = (metrics.byKind.upstream_stream_error || 0) + 1;
    }
    if (!res.headersSent) sendJson(res, 502, { error: { type: 'upstream_stream_error', request_id: requestId } });
    else res.end();
  });
}

/* ------------------------------------------------------------------ 元信息 */

function handleModels(req, res) {
  const ids = new Set();
  for (const p of config.providers) {
    if (!p.enabled) continue;
    for (const m of p.models) if (m !== '*') ids.add(m);
  }
  sendJson(res, 200, {
    object: 'list',
    data: [...ids].sort().map((id) => ({ id, object: 'model', owned_by: 'fqrh' })),
  });
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    startedAt,
    uptimeSec: Math.round(process.uptime()),
    declaredModels: [...new Set(config.providers.flatMap((p) => p.models))].filter((m) => m !== '*'),
    providers: pool.snapshot().map((p) => ({
      id: p.id, enabled: p.enabled, endpoints: p.endpoints,
      keys: p.keys.map((k) => ({ id: k.id, state: k.state, health: k.health })),
    })),
    metrics,
  });
}

function handleMetrics(req, res) {
  const lines = [
    '# TYPE fqrh_requests_total counter',
    `fqrh_requests_total ${metrics.total}`,
    `fqrh_requests_success ${metrics.success}`,
    `fqrh_requests_failed ${metrics.failed}`,
  ];
  for (const [kind, n] of Object.entries(metrics.byKind)) lines.push(`fqrh_failures{kind="${kind}"} ${n}`);
  for (const [ep, n] of Object.entries(metrics.byEndpoint)) lines.push(`fqrh_endpoint_requests{endpoint="${ep}"} ${n}`);
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
      configPath: config.configPath,
      warnings,
      routing: config.routing,
      providers: pool.snapshot(),
      daily: ledger.daily(today()),
      recent: ledger.recent(20),
    });
  }

  if (req.method === 'POST' && url.pathname === '/__admin/probe') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const provider = pool.provider(body.poolId);
    if (!provider) return sendJson(res, 404, { error: { type: 'provider_not_found' } });
    const key = (body.keyId && provider.keys.find((k) => k.id === body.keyId))
      || provider.keys.find((k) => k.state === 'active')
      || provider.keys.find((k) => k.state !== 'missing');
    if (!key) return sendJson(res, 400, { error: { type: 'no_key' } });
    const result = await probePool({ provider, key });
    return sendJson(res, 200, { poolId: provider.id, keyId: key.id, ...result });
  }

  if (req.method === 'POST' && url.pathname === '/__admin/probe-all') {
    const results = [];
    for (const provider of pool.providers) {
      if (!provider.enabled) {
        results.push({ poolId: provider.id, ok: true, skipped: 'disabled' });
        continue;
      }
      const key = provider.keys.find((k) => k.state === 'active') || provider.keys.find((k) => k.state !== 'missing');
      if (!key) {
        results.push({ poolId: provider.id, ok: false, error: 'no key' });
        continue;
      }
      results.push({ poolId: provider.id, keyId: key.id, ...(await probePool({ provider, key })) });
    }
    const active = results.filter((r) => !r.skipped);
    return sendJson(res, 200, { ok: active.every((r) => r.ok), results });
  }

  if (req.method === 'POST' && url.pathname === '/__admin/key-state') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const ok = pool.setKeyState(body.poolId, body.keyId, body.state);
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  if (req.method === 'POST' && url.pathname === '/__admin/provider-toggle') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const ok = pool.toggleProvider(body.poolId, body.enabled !== false);
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  return sendJson(res, 404, { error: { type: 'not_found' } });
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/healthz') return handleHealth(req, res);
    if (url.pathname === '/metrics') return handleMetrics(req, res);
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
  console.log(`[fqrh] listening http://${host}:${port}`);
  console.log(`[fqrh] config ${config.configPath}`);
  for (const p of config.providers) {
    console.log(`[fqrh]   ${p.id.padEnd(16)} ${p.enabled ? 'on ' : 'off'} protocol=${p.protocol} endpoints=${p.endpoints.join(',')} models=${p.models.join(',')}`);
  }
  for (const w of warnings) console.warn(`[fqrh] warn: ${w}`);
});

function shutdown(sig) {
  console.log(`[fqrh] ${sig} → closing`);
  server.close(() => { ledger.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
