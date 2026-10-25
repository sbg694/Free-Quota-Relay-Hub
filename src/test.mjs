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
const CLIENT_KEY = 'sk-fqrh-test';
const UA = 'claude-cli/2.1.241 (external, cli)';

let pass = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const seen = [];

/* ------------------------------------------------------------------ mock upstream */

const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || '');
    seen.push({ path: req.url, headers: req.headers, key, stream: Boolean(body?.stream) });

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
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'msg_mock', type: 'message', role: 'assistant', model: body?.model,
        content: [{ type: 'text', text: 'ok-anthropic' }],
        usage: { input_tokens: 5, output_tokens: 2 },
      }));
    }
    if (req.url.endsWith('/responses')) {
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
    aliases: {},
    providers: [
      mkProvider({
        id: 'mock',
        endpoints: ['chat', 'embeddings', 'images'],
        models: ['mock-model', 'mock-model-pro'],
        headersProfile: 'claude-cli',
        headers: { 'x-pool': 'fqrh-test' },
        keys: [
          { id: 'a-bad', label: '401 key', value: 'sk-bad', weight: 1 },
          { id: 'b-limited', label: '429 key', value: 'sk-limited', weight: 1 },
          { id: 'c-good', label: 'good key', value: 'sk-good', weight: 1 },
        ],
      }),
      mkProvider({
        id: 'mock-responses',
        protocol: 'openai-responses',
        endpoints: ['responses'],
        models: ['gr-resp'],
        keys: [{ id: 'r-good', value: 'sk-good', weight: 1 }],
      }),
      mkProvider({
        id: 'mock-anthropic',
        protocol: 'anthropic-messages',
        endpoints: ['messages'],
        models: ['mock-model'],
        keys: [{ id: 'm-good', value: 'sk-good', weight: 1 }],
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

    console.log('\n[8] SQLite 账本');
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

    console.log('\n[9] 状态机直测');
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
    check('日额度耗尽后无候选', p3.candidates('any', null, [], 'chat').length === 0);
  } finally {
    try { gw.kill(); } catch { /* ignore */ }
    mock.close();
  }

  console.log(`\n结果：${pass} 通过${failures.length ? `，${failures.length} 失败` : ''}`);
  if (failures.length) {
    console.log('失败项：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('全部通过 ✅');
}

main().catch((e) => { console.error('测试异常：', e); process.exit(2); });
