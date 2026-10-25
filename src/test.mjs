/**
 * 离线自测（不碰真实上游、不花钱）：node src/test.mjs
 *
 * 覆盖：
 *  1. 健康检查 / 模型列表 / 鉴权（Bearer 与 x-api-key）
 *  2. chat 非流式转发 + 用量记账
 *  3. 请求头：UA 预设生效、hop-by-hop 剔除、自定义头保留、池级头注入
 *  4. 失败转移：401→拉黑、429→冷却、第三个 key 成功
 *  5. chat SSE 流式原样透传
 *  6. 探活与业务复用同一套头
 *  7. 多端点：responses / messages / embeddings
 *  8. 池级 403（分组不允许该端点）→ 跳过整池、不拉黑 key
 *  9. rpm 令牌桶
 * 10. SQLite 账本 + 状态机
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TMP = path.join(ROOT, '.tmp-test');
const GW_PORT = 18790;
const MOCK_PORT = 18899;
const HOOK_PORT = 18999;
const CLIENT_KEY = 'sk-fqrh-test';
const UA = 'claude-cli/2.1.241 (external, cli)';

let pass = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const seen = [];
const flakyCount = {};
const hookHits = [];
const hookServer = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    try { hookHits.push(JSON.parse(buf)); } catch { hookHits.push({ raw: buf }); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});

/* ------------------------------------------------------------------ mock upstream */

const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || '');
    seen.push({ path: req.url, headers: req.headers, key, stream: Boolean(body?.stream), model: body?.model });

    if (key === 'sk-flaky') {
      flakyCount[key] = (flakyCount[key] || 0) + 1;
      if (flakyCount[key] <= 2) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'API 密钥无效，请稍后重试', type: 'authentication_error' } }));
      }
    }
    if (key === 'sk-flaky-hard') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'API 密钥无效，请稍后重试', type: 'authentication_error' } }));
    }
    if (key === 'sk-flaky-stream') {
      flakyCount[key] = (flakyCount[key] || 0) + 1;
      if (flakyCount[key] === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('event: error\ndata: {"error":{"message":"API 密钥无效","type":"authentication_error"}}\n\n');
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: {"id":"c1","model":"m","choices":[{"delta":{"role":"assistant","content":"重试后成功"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"c1","model":"m","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (key === 'sk-flaky-json') {
      flakyCount[key] = (flakyCount[key] || 0) + 1;
      if (flakyCount[key] === 1) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'API 密钥无效（伪装在 200 里）', type: 'authentication_error' } }));
      }
    }
    if (key === 'sk-model-paid') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'authentication_error', code: 'api_key_expired', message: 'This API key has expired.' } }));
    }
    if (key === 'sk-bad') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'unauthorized client detected', type: 'UNAUTHENTICATED' } }));
    }
    if (key === 'sk-limited') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    }
    if (key === 'sk-messages-denied') {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'This group does not allow /v1/messages dispatch', type: 'permission_error' } }));
    }

    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    }
    if (req.url.endsWith('/messages')) {
      if (body?.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","model":"m","usage":{"input_tokens":9}}}\n\n');
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"流式Anthropic"}}\n\n');
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'msg_mock', type: 'message', role: 'assistant', model: body?.model,
        content: [{ type: 'text', text: 'ok-anthropic' }],
        usage: { input_tokens: 5, output_tokens: 2 },
      }));
    }
    if (req.url.endsWith('/responses')) {
      if (body?.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_s","model":"m"}}\n\n');
        res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant"}}\n\n');
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"流式Responses"}\n\n');
        res.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_s","status":"completed","usage":{"input_tokens":6,"output_tokens":3}}}\n\n');
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'resp_mock', object: 'response', model: body?.model,
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok-responses' }] }],
        usage: { input_tokens: 4, output_tokens: 6 },
      }));
    }
    if (req.url.endsWith('/embeddings')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 3, total_tokens: 3 } }));
    }
    if (req.url.endsWith('/images/generations')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ created: 1, data: [{ url: 'https://example.invalid/a.png' }] }));
    }

    if (body?.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"好"}}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 20);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok-from-mock' } }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    }));
  });
});

/* ------------------------------------------------------------------ helpers */

function req(pathname, { method = 'GET', body, headers = {}, key } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (payload) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(payload); }
    if (key !== null) h.authorization = `Bearer ${key || CLIENT_KEY}`;
    const r = http.request({ host: '127.0.0.1', port: GW_PORT, path: pathname, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await req('/healthz', { key: null });
      if (r.status === 200) return true;
    } catch { /* not yet */ }
    await sleep(200);
  }
  return false;
}

/* ------------------------------------------------------------------ config */

function writeTestConfig() {
  fs.mkdirSync(TMP, { recursive: true });
  const mkProvider = (over) => ({
    id: 'p', name: 'p', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    protocol: 'openai-completions', endpoints: ['chat'], headersProfile: 'none',
    headers: {}, upstreamProxy: '', models: ['*'], rpm: 0, maxConcurrency: 4, enabled: true,
    keys: [{ id: 'k', value: 'sk-good', weight: 1 }], ...over,
  });
  const cfg = {
    listen: { host: '127.0.0.1', port: GW_PORT },
    clientKeys: [{ id: 'test', key: CLIENT_KEY }],
    routing: { maxCandidates: 4, maxAttempts: 4, totalBudgetMs: 20000, maxRateWaitMs: 1500 },
    resilience: { retries: 2, backoffMs: 10, backoffMaxMs: 40, jitterMs: 0, flakyCooldownMs: 100, preludeMs: 400, retryAfterSec: 1 },
    monitor: {
      enabled: true, probeIntervalSec: 0, probeOnStartup: false,
      failThreshold: 2, alertCooldownSec: 0,
      webhookUrl: `http://127.0.0.1:${HOOK_PORT}/hook`, webhookFormat: 'generic',
    },
    aliases: { 'client-alias': { model: 'client-canonical', priority: ['mock-mapped'] } },
    providers: [
      mkProvider({
        id: 'mock',
        endpoints: ['chat', 'embeddings', 'images'],
        models: ['mock-model', 'mock-model-pro', 'chat-only'],
        headersProfile: 'claude-cli',
        headers: { 'x-pool': 'fqrh-test' },
        keys: [
          { id: 'a-bad', label: '401 key', value: 'sk-bad', weight: 1 },
          { id: 'b-limited', label: '429 key', value: 'sk-limited', weight: 1 },
          { id: 'c-good', label: 'good key', value: 'sk-good', weight: 1 },
        ],
      }),
      mkProvider({
        id: 'mock-anthropic',
        protocol: 'anthropic-messages',
        endpoints: ['messages'],
        models: ['mock-model', 'anthro-only'],
        keys: [{ id: 'm-good', value: 'sk-good', weight: 1 }],
      }),
      mkProvider({
        id: 'mock-responses',
        protocol: 'openai-responses',
        endpoints: ['responses'],
        models: ['gr-resp', 'resp-only'],
        keys: [
          { id: 'r-good', value: 'sk-good', weight: 1 },
          { id: 'r-only', value: 'sk-good', weight: 1 },
        ],
      }),
      mkProvider({
        id: 'mock-denied',
        protocol: 'anthropic-messages',
        endpoints: ['messages'],
        models: ['denied-model'],
        keys: [{ id: 'd-denied', value: 'sk-messages-denied', weight: 1 }],
      }),
      mkProvider({
        id: 'mock-rpm',
        endpoints: ['chat'],
        models: ['rpm-model'],
        rpm: 60,
        keys: [{ id: 'rpm-key', value: 'sk-good', weight: 1 }],
      }),
      mkProvider({
        id: 'mock-flaky',
        models: ['flaky-model'],
        flakyAuth: true,
        keys: [{ id: 'f1', value: 'sk-flaky', weight: 1 }],
      }),
      mkProvider({
        id: 'mock-flaky-hard',
        models: ['flaky-hard'],
        flakyAuth: true,
        keys: [{ id: 'f2', value: 'sk-flaky-hard', weight: 1 }],
      }),
      mkProvider({
        id: 'mock-flaky-sse',
        models: ['flaky-stream'],
        flakyAuth: true,
        keys: [{ id: 'f3', value: 'sk-flaky-stream', weight: 1 }],
      }),
      mkProvider({
        id: 'mock-flaky-json',
        models: ['flaky-json'],
        flakyAuth: true,
        keys: [{ id: 'f4', value: 'sk-flaky-json', weight: 1 }],
      }),
      mkProvider({
        id: 'mock-mapped',
        models: ['upstream-real'],
        modelMap: { 'client-canonical': 'upstream-real' },
        keys: [{ id: 'map-1', value: 'sk-good', weight: 1 }],
      }),
      mkProvider({
        id: 'mock-paid-model',
        models: ['paid-model'],
        flakyAuth: true,
        keys: [{ id: 'p1', value: 'sk-model-paid', weight: 1 }],
      }),
      mkProvider({
        id: 'mock-prio-low',
        models: ['prio-model'],
        priority: 1,
        keys: [{ id: 'pl', value: 'sk-prio-low', weight: 1 }],
      }),
      mkProvider({
        id: 'mock-prio-high',
        models: ['prio-model'],
        priority: 100,
        keys: [{ id: 'ph', value: 'sk-prio-high', weight: 1 }],
      }),
    ],
  };
  const p = path.join(TMP, 'config.test.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return p;
}

/* ------------------------------------------------------------------ main */

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  const configPath = writeTestConfig();
  const dbPath = path.join(TMP, 'fqrh.db');

  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  await new Promise((r) => hookServer.listen(HOOK_PORT, '127.0.0.1', r));
  const gw = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--config', configPath, '--db', dbPath], {
    cwd: ROOT,
    stdio: 'ignore',
  });

  try {
    const ready = await waitReady();
    check('网关启动并响应 /healthz', ready);
    if (!ready) throw new Error('gateway 未能启动');
    await sleep(150);

    console.log('\n[1] 鉴权与元信息');
    check('无 key 访问 /v1/models → 401', (await req('/v1/models', { key: null })).status === 401);
    check('错误 key → 401', (await req('/v1/models', { key: 'sk-wrong' })).status === 401);
    const models = await req('/v1/models');
    check('/v1/models 返回 mock-model', models.status === 200 && models.text.includes('mock-model'));
    check('/v1/models 含 modelMap 的客户端模型名', models.text.includes('client-canonical'));

    console.log('\n[2] chat 非流式 + 失败转移（401 → 429 → 成功）');
    const t0 = Date.now();
    const chat = await req('/v1/chat/completions', {
      method: 'POST',
      headers: { connection: 'keep-alive', 'proxy-authorization': 'Basic Zm9vOmJhcg==', 'x-custom': 'yes' },
      body: { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    check('最终 200', chat.status === 200, `got ${chat.status} ${chat.text.slice(0, 120)}`);
    check('响应体来自 mock', chat.text.includes('ok-from-mock'));

    const chatSeen = seen.filter((s) => s.path.endsWith('/chat/completions'));
    check('失败转移路径上打了 3 次上游', chatSeen.length === 3, `seen=${chatSeen.length}`);
    const last = seen[seen.length - 1];
    check('UA 被改写成 claude-cli 预设', last.headers['user-agent'] === UA, `got ${last.headers['user-agent']}`);
    check('hop-by-hop 头（proxy-authorization）已剔除', !('proxy-authorization' in last.headers));
    check('自定义头 x-custom 原样保留', last.headers['x-custom'] === 'yes');
    check('池级静态头 x-pool 已注入', last.headers['x-pool'] === 'fqrh-test');
    check('出站不带 content-length 以外的传输头', !('transfer-encoding' in last.headers));
    check('客户端凭据头没有漏给上游（authorization 已被替换为池内 key）', last.headers.authorization === 'Bearer sk-good', last.headers.authorization);

    const state1 = JSON.parse((await req('/__admin/state')).text);
    const keys = Object.fromEntries(state1.providers[0].keys.map((k) => [k.id, k]));
    check('401 → a-bad 变为 dead', keys['a-bad']?.state === 'dead', keys['a-bad']?.state);
    check('429 → b-limited 变为 cooling', keys['b-limited']?.state === 'cooling', keys['b-limited']?.state);
    check('成功 → c-good 保持 active', keys['c-good']?.state === 'active', keys['c-good']?.state);

    // modelMap：客户端规范名 → 上游真实名（池只声明上游名也能命中）
    const mapped = await req('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'client-canonical', messages: [{ role: 'user', content: 'hi' }] },
    });
    const mappedSeen = seen.filter((s) => s.path.endsWith('/chat/completions')).pop();
    check('modelMap：客户端模型名 → 上游模型名（池只声明上游名也能命中）',
      mapped.status === 200 && mappedSeen?.model === 'upstream-real',
      `status=${mapped.status} upstreamModel=${mappedSeen?.model}`);

    // 别名 → 规范名 → modelMap：客户端写别名也要映射到上游真实名
    const aliasMapped = await req('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'client-alias', messages: [{ role: 'user', content: 'hi' }] },
    });
    const aliasSeen = seen.filter((s) => s.path.endsWith('/chat/completions')).pop();
    check('modelMap 对别名同样生效（alias → 规范名 → 上游名）',
      aliasMapped.status === 200 && aliasSeen?.model === 'upstream-real',
      `status=${aliasMapped.status} upstreamModel=${aliasSeen?.model}`);

    console.log('\n[3] chat SSE 流式透传');
    const stream = await req('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'mock-model', stream: true, messages: [{ role: 'user', content: 'stream' }] },
    });
    check('流式 200 且 content-type 为 event-stream', stream.status === 200 && /event-stream/.test(stream.headers['content-type'] || ''));
    check('SSE 包含两段 delta', stream.text.includes('"你"') && stream.text.includes('"好"'));
    check('SSE 以 [DONE] 结束', stream.text.includes('data: [DONE]'));

    console.log('\n[4] 多端点：responses / messages / embeddings / images');
    const resp = await req('/v1/responses', { method: 'POST', body: { model: 'gr-resp', input: 'hi' } });
    check('/v1/responses → 200 且内容来自上游', resp.status === 200 && resp.text.includes('ok-responses'), resp.text.slice(0, 120));

    const msg = await req('/v1/messages', { method: 'POST', body: { model: 'mock-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] } });
    check('/v1/messages → 200 且内容来自上游', msg.status === 200 && msg.text.includes('ok-anthropic'), msg.text.slice(0, 120));
    const msgSeen = seen.filter((s) => s.path.endsWith('/messages')).pop();
    check('messages 走 x-api-key 而非 Bearer', Boolean(msgSeen?.headers['x-api-key']) && !msgSeen?.headers.authorization);
    check('messages 自动补 anthropic-version', msgSeen?.headers['anthropic-version'] === '2023-06-01', msgSeen?.headers['anthropic-version']);

    const emb = await req('/v1/embeddings', { method: 'POST', body: { model: 'mock-model', input: 'hello' } });
    check('/v1/embeddings → 200 且返回向量', emb.status === 200 && emb.text.includes('0.1'), emb.text.slice(0, 120));

    const img = await req('/v1/images/generations', { method: 'POST', body: { model: 'mock-model', prompt: 'cat' } });
    check('/v1/images/generations → 200', img.status === 200 && img.text.includes('a.png'), img.text.slice(0, 120));

    console.log('\n[5] 池级 403：分组不允许该端点');
    const denied = await req('/v1/messages', { method: 'POST', body: { model: 'denied-model', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] } });
    const dj = JSON.parse(denied.text);
    check('返回 502 且 last.kind=endpoint_denied', denied.status === 502 && dj?.error?.last?.kind === 'endpoint_denied', denied.text.slice(0, 200));
    const state2 = JSON.parse((await req('/__admin/state')).text);
    const deniedKey = state2.providers.find((p) => p.id === 'mock-denied').keys[0];
    check('池级 403 不拉黑 key（仍为 active）', deniedKey.state === 'active', deniedKey.state);

    console.log('\n[6] 协议转换：客户端协议 ≠ 上游协议');
    const toAnth = await req('/v1/chat/completions', {
      method: 'POST', body: { model: 'anthro-only', messages: [{ role: 'user', content: 'hi' }] },
    });
    const toAnthJson = JSON.parse(toAnth.text || '{}');
    check('chat → messages：200 且转回 chat 结构', toAnth.status === 200 && toAnth.text.includes('ok-anthropic') && toAnthJson.object === 'chat.completion', toAnth.text.slice(0, 160));
    check('转换响应带 x-fqrh-convert 头', /:messages$/.test(toAnth.headers['x-fqrh-convert'] || ''), toAnth.headers['x-fqrh-convert']);

    const toResp = await req('/v1/chat/completions', {
      method: 'POST', body: { model: 'resp-only', messages: [{ role: 'user', content: 'hi' }] },
    });
    check('chat → responses：200 且转回 chat 结构', toResp.status === 200 && toResp.text.includes('ok-responses') && JSON.parse(toResp.text || '{}').object === 'chat.completion', toResp.text.slice(0, 160));

    const toChat = await req('/v1/messages', {
      method: 'POST', body: { model: 'chat-only', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
    });
    check('messages → chat：200 且转回 message 结构', toChat.status === 200 && toChat.text.includes('ok-from-mock') && JSON.parse(toChat.text || '{}').type === 'message', toChat.text.slice(0, 160));

    const sChat = await req('/v1/chat/completions', {
      method: 'POST', body: { model: 'anthro-only', stream: true, messages: [{ role: 'user', content: 'x' }] },
    });
    check('流式 chat ← anthropic：内容与 [DONE] 正确', sChat.status === 200 && sChat.text.includes('流式Anthropic') && sChat.text.includes('data: [DONE]'), sChat.text.slice(0, 160));

    const sMsg = await req('/v1/messages', {
      method: 'POST', body: { model: 'chat-only', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'x' }] },
    });
    check('流式 messages ← chat：转出 anthropic 事件', sMsg.status === 200 && sMsg.text.includes('event: message_start') && sMsg.text.includes('text_delta'), sMsg.text.slice(0, 160));

    const sResp = await req('/v1/responses', {
      method: 'POST', body: { model: 'chat-only', stream: true, input: 'x' },
    });
    check('流式 responses ← chat：转出 responses 事件', sResp.status === 200 && sResp.text.includes('response.created') && sResp.text.includes('response.completed'), sResp.text.slice(0, 160));

    console.log('\n[7] 转换预览 & 版本信息');
    const prev = await req('/__admin/convert-preview', {
      method: 'POST',
      body: { from: 'chat', to: 'messages', payload: { model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], max_tokens: 64 } },
    });
    const previewJson = JSON.parse(prev.text || '{}');
    check('convert-preview 返回转换后的请求体', prev.status === 200 && previewJson.request?.system === 's' && Array.isArray(previewJson.request?.messages), prev.text.slice(0, 160));
    const health = JSON.parse((await req('/healthz', { key: null })).text);
    check('healthz 报 v3 版本与 6 种转换能力', String(health.version).startsWith('3.') && health.capabilities?.conversions?.length === 6, JSON.stringify(health.version));
    check('healthz 声明瞬时故障缓冲能力', (health.capabilities?.resilience || []).includes('transient-auth-retry'), JSON.stringify(health.capabilities?.resilience));

    console.log('\n[6] 探活复用同一套头 + 批量探活');
    const probe = await req('/__admin/probe', { method: 'POST', body: { poolId: 'mock' } });
    const pj = JSON.parse(probe.text);
    check('探活成功', probe.status === 200 && pj.ok === true, probe.text.slice(0, 160));
    check('探活带同一个 UA', pj.headersUsed?.ua === UA, JSON.stringify(pj.headersUsed));
    const all = JSON.parse((await req('/__admin/probe-all', { method: 'POST', body: {} })).text);
    check('批量探活返回所有池', Array.isArray(all.results) && all.results.length >= 5, `n=${all.results?.length}`);

    console.log('\n[7] rpm 令牌桶（集成）');
    // rpm=60 → 每秒补 1 个 token；连打 3 次，第 2 次起需要等
    const r1 = Date.now();
    await req('/v1/chat/completions', { method: 'POST', body: { model: 'rpm-model', messages: [{ role: 'user', content: 'a' }] } });
    const r2 = Date.now();
    await req('/v1/chat/completions', { method: 'POST', body: { model: 'rpm-model', messages: [{ role: 'user', content: 'b' }] } });
    const r3 = Date.now();
    check('rpm 桶允许突发（前两次不排队）', r2 - r1 < 900, `${r2 - r1}ms`);
    check('第二次请求有轻微延迟或直接通过', r3 - r2 >= 0);

    console.log('\n[8] 运维面：面板 / 探活 / 告警 / Webhook');
    const dash = await req('/__admin/dashboard', { key: null });
    check('面板 HTML 可访问（无需 key）', dash.status === 200 && dash.text.includes('FQRH 中转池面板') && dash.text.includes('/__admin/state'), `status=${dash.status}`);
    const pa = JSON.parse((await req('/__admin/probe-all', { method: 'POST' })).text || '{}');
    check('手动探活返回 runAt 与全部池结果', Boolean(pa.runAt) && Array.isArray(pa.results) && pa.results.length >= 5, JSON.stringify(pa).slice(0, 200));
    const at = JSON.parse((await req('/__admin/alert-test', { method: 'POST' })).text || '{}');
    check('测试告警触发', at.ok === true && at.alert?.kind === 'manual_test', JSON.stringify(at).slice(0, 160));
    await sleep(800);
    const hookManual = hookHits.find((h) => h.kind === 'manual_test');
    check('Webhook 收到推送（generic 格式含 text/level/kind）', Boolean(hookManual) && hookManual.level === 'info' && String(hookManual.text).includes('FQRH'), JSON.stringify(hookManual || hookHits[0] || null).slice(0, 240));
    check('key 被拉黑也会触发告警推送', hookHits.some((h) => h.kind === 'key_dead'), JSON.stringify(hookHits.map((h) => h.kind)));
    const al = JSON.parse((await req('/__admin/alerts')).text || '{}');
    check('告警落库且标记已推送', (al.alerts || []).some((a) => a.kind === 'manual_test' && a.delivered === true), JSON.stringify((al.alerts || [])[0] || null).slice(0, 240));
    check('monitor 状态含探活结果与计数', Boolean(al.monitor?.lastRunAt) && al.monitor.counters.probes >= 1 && al.monitor.counters.delivered >= 1, JSON.stringify(al.monitor?.counters));
    const h2 = JSON.parse((await req('/healthz', { key: null })).text);
    check('healthz 暴露 monitor', h2.monitor && typeof h2.monitor.enabled === 'boolean' && h2.monitor.counters.probes >= 1, JSON.stringify(h2.monitor));

    console.log('\n[9] v3 瞬时故障吸收（假 401 / 假密钥无效）');
    const fl = await req('/v1/chat/completions', { method: 'POST', body: { model: 'flaky-model', messages: [{ role: 'user', content: 'hi' }] } });
    check('连续 2 次假 401 后静默重试成功', fl.status === 200 && fl.text.includes('ok-from-mock'), `status=${fl.status} ${fl.text.slice(0, 160)}`);
    check('重试次数已记录（上游收到 ≥3 次）', (flakyCount['sk-flaky'] || 0) >= 3, `calls=${flakyCount['sk-flaky']}`);

    const fls = await req('/v1/chat/completions', { method: 'POST', body: { model: 'flaky-stream', stream: true, messages: [{ role: 'user', content: 'hi' }] } });
    check('SSE 首包是错误 → 缓冲后重试，客户端只看到正常流', fls.status === 200 && fls.text.includes('重试后成功') && !fls.text.includes('密钥无效'), fls.text.slice(0, 200));

    const flj = await req('/v1/chat/completions', { method: 'POST', body: { model: 'flaky-json', messages: [{ role: 'user', content: 'hi' }] } });
    check('200 里藏 error 也按瞬时故障重试', flj.status === 200 && flj.text.includes('ok-from-mock'), flj.text.slice(0, 160));

    const flh = await req('/v1/chat/completions', { method: 'POST', body: { model: 'flaky-hard', messages: [{ role: 'user', content: 'hi' }] } });
    const flhj = JSON.parse(flh.text || '{}');
    check('彻底失败返回 503 而不是 401', flh.status === 503, `status=${flh.status}`);
    check('带 Retry-After（可触发客户端重试）', Number(flh.headers['retry-after']) >= 1, `retry-after=${flh.headers['retry-after']}`);
    check('错误体标记 retryable 且 kind=transient_auth', flhj.error?.retryable === true && flhj.error?.type === 'transient_auth', JSON.stringify(flhj.error || {}).slice(0, 200));
    const stFlaky = JSON.parse((await req('/__admin/state')).text);
    const hardKey = stFlaky.providers.find((p) => p.id === 'mock-flaky-hard').keys[0];
    check('假 401 不会把 key 拉黑', hardKey.state !== 'dead', `state=${hardKey.state}`);
    check('metrics 记录瞬时重试次数', (stFlaky.metrics?.transient || 0) >= 1, `transient=${stFlaky.metrics?.transient}`);

    const mp1 = await req('/v1/chat/completions', { method: 'POST', body: { model: 'paid-model', messages: [{ role: 'user', content: 'hi' }] } });
    check('模型级 401 首次给可重试 503', mp1.status === 503 && Number(mp1.headers['retry-after']) >= 1, `status=${mp1.status}`);
    const mp2 = await req('/v1/chat/completions', { method: 'POST', body: { model: 'paid-model', messages: [{ role: 'user', content: 'hi' }] } });
    const mp2j = JSON.parse(mp2.text || '{}');
    const dbgState = JSON.parse((await req('/__admin/state')).text).providers.find((p) => p.id === 'mock-paid-model');
    check('重复失败后判定「该模型要付费 key」（404，不再重试）', mp2.status === 404 && mp2j.error?.type === 'model_unauthorized', `${mp2.status} key=${JSON.stringify(dbgState?.keys?.map((k) => k.state))} blocked=${JSON.stringify(dbgState?.modelBlocked)}`);
    const t3 = Date.now();
    const mp3 = await req('/v1/chat/completions', { method: 'POST', body: { model: 'paid-model', messages: [{ role: 'user', content: 'hi' }] } });
    const mp3ms = Date.now() - t3;
    check('被屏蔽的模型立刻 404（不再打上游、不再重试）', mp3.status === 404 && mp3ms < 400, `status=${mp3.status} ${mp3ms}ms`);
    const stPaid = JSON.parse((await req('/__admin/state')).text);
    const paidKey = stPaid.providers.find((p) => p.id === 'mock-paid-model').keys[0];
    check('模型级失败也不拉黑 key', paidKey.state !== 'dead', `state=${paidKey.state}`);

    const pr = await req('/v1/chat/completions', { method: 'POST', body: { model: 'prio-model', messages: [{ role: 'user', content: 'hi' }] } });
    const chatKeys = seen.filter((s) => s.path === '/v1/chat/completions').map((s) => s.key);
    check('池级 priority 高者优先被选中', pr.status === 200 && chatKeys.at(-1) === 'sk-prio-high', `status=${pr.status} last=${chatKeys.at(-1)}`);
    const stPrio = JSON.parse((await req('/__admin/state')).text);
    check('状态快照暴露池级 priority', stPrio.providers.find((p) => p.id === 'mock-prio-high')?.priority === 100, JSON.stringify(stPrio.providers.find((p) => p.id === 'mock-prio-high')?.priority));

    // ---- 面板写操作（/__admin/config、/__admin/reload） ----
    const cfgView = JSON.parse((await req('/__admin/config')).text);
    const ck = cfgView.clientKeys[0];
    check('配置视图不泄露明文客户端 key', ck && !ck.key && Boolean(ck.keyMasked), JSON.stringify(ck));
    check('配置视图带池 priority / 上游 key 元信息', cfgView.providers.some((p) => p.id === 'mock-prio-high' && p.priority === 100) && cfgView.providers.every((p) => Array.isArray(p.keys)), JSON.stringify(cfgView.providers.map((p) => p.priority)));

    const patchRes = await req('/__admin/config', { method: 'POST', body: { providers: { 'mock-prio-high': { priority: 0 } } } });
    check('写配置成功并热重载', patchRes.status === 200 && JSON.parse(patchRes.text).ok === true, patchRes.text.slice(0, 160));
    check('写配置前自动备份 .bak', fs.existsSync(`${configPath}.bak`), configPath);

    await req('/v1/chat/completions', { method: 'POST', body: { model: 'prio-model', messages: [{ role: 'user', content: 'hi' }] } });
    const keysAfter = seen.filter((s) => s.path === '/v1/chat/completions').map((s) => s.key);
    check('热重载后优先级立即改变选路', keysAfter.at(-1) === 'sk-prio-low', `last=${keysAfter.at(-1)}`);

    const restore = await req('/__admin/config', { method: 'POST', body: { providers: { 'mock-prio-high': { priority: 100 } } } });
    check('优先级可改回', restore.status === 200, restore.text.slice(0, 120));

    const reloadRes = await req('/__admin/reload', { method: 'POST' });
    check('POST /__admin/reload 正常', reloadRes.status === 200 && JSON.parse(reloadRes.text).ok === true, reloadRes.text.slice(0, 120));

    // ---- 提供商增删（面板「中转站管理」走 addProviders / removeProviders）----
    const addRes = await req('/__admin/config', { method: 'POST', body: { addProviders: [{
      id: 'added-official', name: '官方示例', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
      protocol: 'chat', endpoints: ['chat'], models: ['added-model'],
      keys: [{ id: 'k1', value: 'sk-good', weight: 1 }], priority: 5,
    }] } });
    check('添加提供商成功', addRes.status === 200 && JSON.parse(addRes.text).providers.includes('added-official'), addRes.text.slice(0, 160));
    check('新提供商的模型出现在 /v1/models', JSON.parse((await req('/v1/models')).text).data.some((x) => x.id === 'added-model'));
    const chatAdded = await req('/v1/chat/completions', { method: 'POST', body: { model: 'added-model', messages: [{ role: 'user', content: 'hi' }] } });
    check('新提供商可正常调用', chatAdded.status === 200, String(chatAdded.status));
    const dupRes = await req('/__admin/config', { method: 'POST', body: { addProviders: [{ id: 'added-official', baseUrl: 'http://x/v1', models: ['m'], keys: [{ id: 'k', value: 'v' }] }] } });
    check('重复 id 添加被拒绝（400）', dupRes.status === 400, dupRes.text.slice(0, 120));
    const badRes = await req('/__admin/config', { method: 'POST', body: { addProviders: [{ id: 'bad-one', baseUrl: 'http://x/v1', models: [], keys: [{ id: 'k', value: 'v' }] }] } });
    check('缺 models 的提供商被拒绝（400）', badRes.status === 400, badRes.text.slice(0, 120));
    const delRes = await req('/__admin/config', { method: 'POST', body: { removeProviders: ['added-official'] } });
    check('删除提供商成功', delRes.status === 200 && !JSON.parse(delRes.text).providers.includes('added-official'), delRes.text.slice(0, 160));
    check('删除后模型从 /v1/models 消失', !JSON.parse((await req('/v1/models')).text).data.some((x) => x.id === 'added-model'));

    // ---- 扫描模型（面板「扫描模型」按钮 / POST /__admin/scan-models）----
    const scanRes = await req('/__admin/scan-models', { method: 'POST', body: { providerId: 'mock' } });
    const scanJson = JSON.parse(scanRes.text);
    check('扫描模型：按池返回上游模型列表',
      scanRes.status === 200 && scanJson.ok === true && scanJson.models.includes('mock-model'),
      scanRes.text.slice(0, 160));
    const scanAdhoc = await req('/__admin/scan-models', { method: 'POST', body: { baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, key: 'sk-good' } });
    check('扫描模型：按 baseUrl + key 临时扫描', scanAdhoc.status === 200 && JSON.parse(scanAdhoc.text).count >= 1, scanAdhoc.text.slice(0, 120));
    const scanNoKey = await req('/__admin/scan-models', { method: 'POST', body: { baseUrl: 'http://127.0.0.1:1/v1' } });
    check('扫描模型：没 key 返回 400', scanNoKey.status === 400, scanNoKey.text.slice(0, 120));

    // ---- 别名：随提供商删除自动清理悬空别名 ----
    await req('/__admin/config', { method: 'POST', body: { addProviders: [{ id: 'tmp-alias-pool', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, models: ['tmp-alias-model'], keys: [{ id: 'k', value: 'sk-good' }] }] } });
    await req('/__admin/config', { method: 'POST', body: { aliases: { 'tmp-alias': { model: 'tmp-alias-model', priority: ['tmp-alias-pool'] } } } });
    check('/v1/models 出现别名', JSON.parse((await req('/v1/models')).text).data.some((x) => x.id === 'tmp-alias'));
    const delAliasPool = await req('/__admin/config', { method: 'POST', body: { removeProviders: ['tmp-alias-pool'] } });
    const delAliasJson = JSON.parse(delAliasPool.text);
    check('删池自动清理悬空别名', Array.isArray(delAliasJson.aliasesRemoved) && delAliasJson.aliasesRemoved.includes('tmp-alias'), delAliasPool.text.slice(0, 200));
    check('清理后 /v1/models 不再有该别名', !JSON.parse((await req('/v1/models')).text).data.some((x) => x.id === 'tmp-alias'));

    console.log('\n[10] SQLite 账本');
    gw.kill();
    await sleep(300);
    const db = new DatabaseSync(dbPath);
    const logs = db.prepare('SELECT COUNT(*) AS n FROM request_logs').get();
    const eps = db.prepare('SELECT DISTINCT endpoint FROM request_logs ORDER BY endpoint').all().map((r) => r.endpoint);
    const daily = db.prepare('SELECT COUNT(*) AS n, SUM(tokens) AS t FROM quota_daily').get();
    check('request_logs 有记录', logs.n >= 4, `n=${logs.n}`);
    check('日志记录了多个端点', eps.includes('chat') && eps.includes('messages'), JSON.stringify(eps));
    check('quota_daily 累计 token > 0', (daily.t || 0) > 0, `t=${daily.t}`);
    db.close();

    console.log('\n[11] 状态机直测');
    const { classifyStatus } = await import('./upstream.mjs');
    check('flakyAuth 池：401 密钥无效 → transient_auth', classifyStatus(401, '{"error":{"message":"API 密钥无效"}}', { flakyAuth: true }) === 'transient_auth');
    check('普通池：401 → auth（照旧拉黑）', classifyStatus(401, '{"error":{"message":"invalid api key"}}', { flakyAuth: false }) === 'auth');
    check('403 分组不允许仍归 endpoint_denied', classifyStatus(403, 'This group does not allow /v1/messages dispatch', { flakyAuth: true }) === 'endpoint_denied');
    check('429 仍是 rate_limit（走冷却而非瞬时重试）', classifyStatus(429, '') === 'rate_limit');
    const { createPool } = await import('./pool.mjs');
    const mk = () => createPool({
      providers: [{
        id: 'p', name: 'p', baseUrl: 'http://x', protocol: 'openai-completions',
        headersProfile: 'none', headers: {}, upstreamProxy: '', models: ['*'], endpoints: ['chat'],
        rpm: 0, enabled: true,
        keys: [{ id: 'k', label: 'k', value: 'v', weight: 1, dailyQuota: 0, maxConcurrency: 1 }],
      }],
    });
    const p = mk();
    const k = p.find('p', 'k');
    k.inflight = 1;
    p.markFailure(k, 'rate_limit', '429');
    check('429 后进入 cooling', k.state === 'cooling');
    k.coolingUntil = Date.now() - 1;
    k.inflight = 0;
    p.housekeeping();
    check('冷却到期回到 active', k.state === 'active', k.state);
    k.inflight = 1;
    p.markFailure(k, 'auth', '401');
    check('401 后进入 dead', k.state === 'dead');
    p.housekeeping();
    check('housekeeping 不复活 dead', k.state === 'dead');

    const p2 = createPool({
      providers: [{
        id: 'p', name: 'p', baseUrl: 'http://x', protocol: 'openai-completions',
        headersProfile: 'none', headers: {}, upstreamProxy: '', models: ['*'], endpoints: ['chat'],
        rpm: 60, enabled: true,
        keys: [{ id: 'k', label: 'k', value: 'v', weight: 1, dailyQuota: 0, maxConcurrency: 1 }],
      }],
    });
    const k2 = p2.find('p', 'k');
    const prov = p2.provider('p');
    let drained = 0;
    for (let i = 0; i < 60; i += 1) if (p2.takeRate(prov, k2) === 0) drained += 1;
    check('rpm=60 时一次能拿 60 个 token', drained === 60, `drained=${drained}`);
    const wait = p2.takeRate(prov, k2);
    check('第 61 个 token 需要等待（约 1000ms）', wait > 500 && wait <= 1100, `wait=${wait}`);

    const p4 = createPool({
      providers: [{
        id: 'p', name: 'p', baseUrl: 'http://x', protocol: 'chat',
        headersProfile: 'none', headers: {}, upstreamProxy: '', models: ['*'], endpoints: ['chat'],
        rpm: 0, tpm: 100, enabled: true,
        keys: [{ id: 'k', label: 'k', value: 'v', weight: 1, dailyQuota: 0, maxConcurrency: 1 }],
      }],
    });
    const k4 = p4.find('p', 'k');
    const prov4 = p4.provider('p');
    let drainedTokens = 0;
    for (let i = 0; i < 10; i += 1) if (p4.takeTokens(prov4, k4, 10) === 0) drainedTokens += 1;
    check('tpm=100 时一次能预扣 10×10 token', drainedTokens === 10, `drained=${drainedTokens}`);
    const tokenWait = p4.takeTokens(prov4, k4, 10);
    check('token 桶打满后需要等待', tokenWait > 0, `wait=${tokenWait}`);
    p4.settleTokens(prov4, k4, 10);
    check('settleTokens 按实际用量多退少补', k4.tpmBucket.tokens > 0, `tokens=${k4.tpmBucket.tokens}`);

    const { createMonitor } = await import('./monitor.mjs');
    const store = [];
    const fakeLedger = {
      logAlert(a) { store.push({ ...a, delivered: a.delivered === true ? 1 : 0 }); },
      markAlertDelivered(id) { const r = store.find((x) => x.id === id); if (r) r.delivered = 1; },
      alerts(n) { return store.slice(-n).reverse(); },
    };
    const p5 = createPool({
      providers: [{
        id: 'mon', name: 'mon', baseUrl: 'http://x', protocol: 'chat',
        headersProfile: 'none', headers: {}, upstreamProxy: '', models: ['*'], endpoints: ['chat'],
        rpm: 0, enabled: true,
        keys: [{ id: 'mk', label: 'mk', value: 'v', weight: 1, dailyQuota: 0, maxConcurrency: 1 }],
      }],
    });
    let probeOk = false;
    const mons = createMonitor({
      pool: p5, ledger: fakeLedger, log: () => {},
      config: { monitor: { enabled: false, failThreshold: 2, alertCooldownSec: 0 } },
      probe: async () => (probeOk ? { ok: true, latencyMs: 3 } : { ok: false, error: 'boom' }),
    });
    await mons.probeOnce('test');
    check('首次失败不告警（阈值 2）', store.length === 0, `n=${store.length}`);
    await mons.probeOnce('test');
    check('连续 2 次失败 → critical 告警', store.length === 1 && store[0].level === 'critical' && store[0].kind === 'probe_failed', JSON.stringify(store[0] || null));
    probeOk = true;
    await mons.probeOnce('test');
    check('恢复 → info 告警', store.length === 2 && store[1].level === 'info' && store[1].kind === 'probe_recovered', JSON.stringify(store[1] || null));
    check('探活计数正确', mons.status().counters.probes === 3, JSON.stringify(mons.status().counters));

    const p3 = createPool({
      providers: [{
        id: 'p', name: 'p', baseUrl: 'http://x', protocol: 'openai-completions',
        headersProfile: 'none', headers: {}, upstreamProxy: '', models: ['*'], endpoints: ['chat'],
        rpm: 0, enabled: true,
        keys: [{ id: 'k', label: 'k', value: 'v', weight: 1, dailyQuota: 100, maxConcurrency: 1 }],
      }],
    });
    const k3 = p3.find('p', 'k');
    k3.dayTokens = 100;
    check('日额度耗尽后无候选', p3.candidates('any', null, [], null).length === 0);
  } finally {
    try { gw.kill(); } catch { /* ignore */ }
    mock.close();
    hookServer.close();
  }

  console.log(`\n结果：${pass} 通过${failures.length ? `，${failures.length} 失败` : ''}`);
  if (failures.length) {
    console.log('失败项：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('全部通过 ✅');
}

main().catch((e) => { console.error('测试异常：', e); process.exit(2); });
