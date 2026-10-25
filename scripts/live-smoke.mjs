/**
 * 真实链路冒烟：node scripts/live-smoke.mjs
 *
 * 先起网关（node src/server.mjs --config config.json），再跑这个。
 * 会真实调用上游、消耗额度（本项目的 relay-free 公开池与 relay-backup 免费额度）。
 *
 * 环境变量：FQRH_URL 默认 http://127.0.0.1:8790，FQRH_KEY 默认取 config.json 的第一个 clientKey
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfgPath = path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const BASE = new URL(process.env.FQRH_URL || `http://${cfg.listen.host}:${cfg.listen.port}`);
const KEY = process.env.FQRH_KEY || cfg.clientKeys?.[0]?.key;

function call(pathname, { method = 'GET', body, accept } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const mod = BASE.protocol === 'https:' ? https : http;
    const h = { authorization: `Bearer ${KEY}` };
    if (payload) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(payload); }
    if (accept) h.accept = accept;
    const t0 = Date.now();
    const req = mod.request({
      host: BASE.hostname, port: BASE.port, path: pathname, method, headers: h,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        ms: Date.now() - t0,
        type: res.headers['content-type'] || '',
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const results = [];
async function step(name, fn) {
  process.stdout.write(`- ${name} … `);
  try {
    const r = await fn();
    results.push({ name, ok: true });
    console.log(`OK (${r.ms ?? '-'}ms) ${r.hint ?? ''}`);
    return r;
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`FAIL — ${e.message}`);
    return null;
  }
}

function expect(cond, msg) { if (!cond) throw new Error(msg); }

const health = await step('/healthz', async () => {
  const r = await call('/healthz');
  expect(r.status === 200, `status=${r.status}`);
  return { ms: r.ms };
});

const models = await step('/v1/models', async () => {
  const r = await call('/v1/models');
  expect(r.status === 200, `status=${r.status}`);
  const j = JSON.parse(r.text);
  expect(j.data.length > 0, '模型列表为空');
  return { ms: r.ms, hint: `models=${j.data.map((m) => m.id).join(',')}`, ids: j.data.map((m) => m.id) };
});

const model = (models?.ids || [])[0] || 'grok-4.5';

const chat = await step(`/v1/chat/completions 非流式 (${model})`, async () => {
  const r = await call('/v1/chat/completions', {
    method: 'POST',
    body: { model, messages: [{ role: 'user', content: '用一句话回答：1+1=?' }], max_tokens: 64 },
  });
  expect(r.status === 200, `status=${r.status} ${r.text.slice(0, 160)}`);
  const j = JSON.parse(r.text);
  expect(j.choices?.[0]?.message?.content, '没有 content');
  return { ms: r.ms, hint: `usage=${JSON.stringify(j.usage || {})}` };
});

await step(`/v1/chat/completions 流式 (${model})`, async () => {
  const r = await call('/v1/chat/completions', {
    method: 'POST',
    body: { model, stream: true, messages: [{ role: 'user', content: '数到三' }], max_tokens: 64 },
    accept: 'text/event-stream',
  });
  expect(r.status === 200, `status=${r.status}`);
  expect(r.type.includes('event-stream'), `content-type=${r.type}`);
  expect(r.text.includes('data: [DONE]'), '没有收到 [DONE]');
  const chunks = (r.text.match(/^data: \{/gm) || []).length;
  return { ms: r.ms, hint: `sse_chunks≈${chunks}` };
});

await step('/v1/responses (若池不支持则应为 503)', async () => {
  const r = await call('/v1/responses', { method: 'POST', body: { model, input: 'hi', max_output_tokens: 32 } });
  expect(r.status === 200 || r.status === 503, `status=${r.status}`);
  return { ms: r.ms, hint: r.status === 503 ? '池未开放 responses 端点（正常）' : 'ok' };
});

await step(`/v1/messages 协议转换 (${model})`, async () => {
  const r = await call('/v1/messages', {
    method: 'POST',
    body: { model, max_tokens: 64, messages: [{ role: 'user', content: '用一句话回答：2+2=?' }] },
  });
  expect(r.status === 200 || r.status === 503, `status=${r.status} ${r.text.slice(0, 200)}`);
  if (r.status === 503) return { ms: r.ms, hint: '无可用池（正常）' };
  const j = JSON.parse(r.text);
  expect(j.type === 'message', `返回结构不是 anthropic message: ${r.text.slice(0, 120)}`);
  const converted = (r.text || '').length > 0;
  return { ms: r.ms, hint: `converted=${converted} stop_reason=${j.stop_reason}` };
});

await step('/__admin/state', async () => {
  const r = await call('/__admin/state');
  expect(r.status === 200, `status=${r.status}`);
  const j = JSON.parse(r.text);
  return { ms: r.ms, hint: `keys=${j.providers.flatMap((p) => p.keys).map((k) => `${k.id}:${k.state}`).join(',')}` };
});

await step('/__admin/probe-all', async () => {
  const r = await call('/__admin/probe-all', { method: 'POST', body: {} });
  expect(r.status === 200, `status=${r.status}`);
  const j = JSON.parse(r.text);
  return { ms: r.ms, hint: j.results.map((x) => `${x.poolId}:${x.ok ? 'ok' : 'FAIL'}`).join(',') };
});

await step('/__admin/dashboard 面板', async () => {
  const r = await call('/__admin/dashboard');
  expect(r.status === 200, `status=${r.status}`);
  expect(r.text.includes('FQRH 中转池面板'), '面板 HTML 不含标题');
  return { ms: r.ms, hint: `html=${Math.round(r.text.length / 1024)}KB` };
});

await step('/__admin/alerts 告警通道', async () => {
  const t = await call('/__admin/alert-test', { method: 'POST', body: {} });
  expect(t.status === 200, `alert-test status=${t.status}`);
  await new Promise((res) => setTimeout(res, 400));
  const r = await call('/__admin/alerts');
  expect(r.status === 200, `status=${r.status}`);
  const j = JSON.parse(r.text);
  const hit = (j.alerts || []).find((a) => a.kind === 'manual_test');
  expect(Boolean(hit), '告警没有落库');
  return { ms: r.ms, hint: `alerts=${j.alerts.length} webhook=${Boolean(j.monitor?.webhook)} delivered=${hit.delivered}` };
});

const failed = results.filter((r) => !r.ok);
console.log(`\n冒烟结果：${results.length - failed.length}/${results.length} 通过${failed.length ? `，失败：${failed.map((f) => f.name).join(' | ')}` : ''}`);
if (failed.length) process.exit(1);
