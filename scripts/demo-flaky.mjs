/**
 * v3 故障注入演示：node scripts/demo-flaky.mjs
 *
 * 起一个"像 relay-free 一样"的假上游（30% 概率返回假 401「API 密钥无效」，
 * 流式则是 200 + SSE error 事件），然后：
 *   1) 直连假上游 40 次 → 看原始失败率
 *   2) 经 FQRH 网关 40 次（非流式）+ 20 次（流式）→ 看客户端看到多少失败
 *
 * 输出对比表。全部本地，不消耗任何真实额度。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCK = 18901;
const GW = 18791;
const KEY = 'sk-fqrh-demo';
const FAIL_RATE = 0.3;

/* ---------------- 假上游：relay-free 的错误形态 ---------------- */
const stats = { hit: 0, failed: 0 };
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }
    stats.hit += 1;
    const fail = Math.random() < FAIL_RATE;

    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'demo-model', object: 'model' }] }));
    }

    if (fail) {
      stats.failed += 1;
      if (body.stream) {
        // 真实中转站常见形态：已经 200，然后 SSE 里报错
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('event: error\ndata: {"error":{"type":"authentication_error","message":"API 密钥无效，请稍后重试"}}\n\n');
        return res.end();
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'API 密钥无效，请稍后重试' } }));
    }

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: {"id":"demo","model":"${body.model}","choices":[{"delta":{"role":"assistant","content":"正常回复"},"finish_reason":null}]}\n\n`);
      res.write('data: {"id":"demo","model":"demo","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4}}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'demo', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: '正常回复' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    }));
  });
});

/* ---------------- 临时配置 + 网关 ---------------- */
const TMP = path.join(ROOT, '.tmp-flaky');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const cfg = {
  listen: { host: '127.0.0.1', port: GW },
  clientKeys: [{ id: 'demo', key: KEY }],
  routing: { maxCandidates: 2, maxAttempts: 2, totalBudgetMs: 30000, maxRateWaitMs: 500 },
  resilience: { retries: 3, backoffMs: 40, backoffMaxMs: 120, jitterMs: 20, flakyCooldownMs: 200, preludeMs: 400, retryAfterSec: 1 },
  monitor: { enabled: false },
  aliases: {},
  providers: [{
    id: 'flaky-mock', name: '假中转（30% 假 401）', baseUrl: `http://127.0.0.1:${MOCK}/v1`,
    protocol: 'chat', endpoints: ['chat'], headersProfile: 'none', headers: {}, upstreamProxy: '',
    models: ['demo-model'], rpm: 0, tpm: 0, maxConcurrency: 4,
    flakyAuth: true, enabled: true,
    keys: [{ id: 'k1', value: 'public', weight: 1 }],
  }],
};
const cfgPath = path.join(TMP, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${GW}/healthz`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await sleep(200);
  }
  return false;
}

async function directOnce(stream) {
  try {
    const r = await fetch(`http://127.0.0.1:${MOCK}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer public', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'demo-model', stream, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const txt = await r.text();
    const bad = r.status !== 200 || (stream && txt.includes('"error"'));
    return bad ? 'fail' : 'ok';
  } catch { return 'fail'; }
}

async function viaGateway(stream) {
  try {
    const r = await fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'demo-model', stream, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const txt = await r.text();
    const hasError = txt.includes('"error"');
    const hasDone = txt.includes('[DONE]');
    const bad = r.status !== 200 || (hasError && !hasDone);
    return { state: bad ? 'fail' : 'ok', status: r.status, ct: r.headers.get('content-type'), head: txt.slice(0, 120), hasError, hasDone };
  } catch (e) { return { state: 'fail', err: e.message }; }
}

async function run(n, fn) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(await fn(i));
  return out;
}

const gw = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--config', cfgPath, '--db', path.join(TMP, 'db.sqlite')], {
  cwd: ROOT, stdio: 'ignore',
});

try {
  await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));
  if (!(await waitReady())) throw new Error('网关没起来');
  await sleep(200);

  const N = 40;
  const direct = (await run(N, () => directOnce(false)));
  const gwNonStreamRaw = await run(N, () => viaGateway(false));
  const gwStreamRaw = await run(20, () => viaGateway(true));
  const gwNonStream = gwNonStreamRaw.map((x) => x.state);
  const gwStream = gwStreamRaw.map((x) => x.state);
  const st = await (await fetch(`http://127.0.0.1:${GW}/__admin/state`, { headers: { authorization: `Bearer ${KEY}` } })).json();

  const pct = (arr) => `${((arr.filter((x) => x === 'fail').length / arr.length) * 100).toFixed(0)}%`;
  console.log('\n===== v3 瞬时故障吸收演示 =====');
  console.log(`假上游故障率        : ${(FAIL_RATE * 100).toFixed(0)}%`);
  console.log(`上游实际返回失败    : ${stats.failed}/${stats.hit}`);
  console.log(`直连失败率          : ${pct(direct)}   (${N} 次)`);
  console.log(`经网关 非流式失败率 : ${pct(gwNonStream)}   (${N} 次)`);
  console.log(`经网关 流式失败率   : ${pct(gwStream)}   (${gwStream.length} 次)`);
  console.log(`网关内部重试吸收    : ${st.metrics.transient || 0} 次`);
  console.log(`客户端可见失败      : ${st.metrics.failed} 次 / ${st.metrics.total} 请求`);
  console.log(`key 状态            : ${st.providers[0].keys.map((k) => `${k.id}:${k.state}(transient=${k.transientCount || 0})`).join(',')}`);

  const streamFails = gwStreamRaw.filter((x) => x.state === 'fail').slice(0, 3);
  if (streamFails.length) {
    console.log('\n流式失败样本（前 3 条）：');
    for (const f of streamFails) console.log(JSON.stringify(f));
  }
  const nonStreamFails = gwNonStreamRaw.filter((x) => x.state === 'fail').slice(0, 2);
  if (nonStreamFails.length) {
    console.log('\n非流式失败样本（前 2 条）：');
    for (const f of nonStreamFails) console.log(JSON.stringify(f));
  }
} finally {
  try { gw.kill(); } catch { /* ignore */ }
  mock.close();
  await sleep(500);
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 文件占用，忽略 */ }
}
