/**
 * 探活：必须与业务请求走**同一套** buildHeaders + requestUpstream。
 *
 * 为什么单独强调：client-relay 的 probe/test 忽略了 upstreamProxy、fetchModels 也没并入伪装头，
 * 导致「探活说通、业务不通」的误判（docs/05 §1.9）。这里刻意复用同一条路径。
 */
import { buildHeaders, requestUpstream } from './upstream.mjs';

export async function probePool({ provider, key, timeoutMs = 15000, endpoint = null }) {
  const started = Date.now();
  if (!key.value) {
    return { ok: false, status: 0, latency: 0, error: '密钥缺失（env 未设置）' };
  }

  const { headers } = buildHeaders({ provider, keyValue: key.value, inbound: { accept: 'application/json' }, endpoint });
  headers['accept-encoding'] = 'identity';

  try {
    const upstream = await requestUpstream({
      provider,
      path: '/models',
      method: 'GET',
      headers,
      timeoutMs,
    });
    let text = '';
    await new Promise((resolve) => {
      upstream.res.on('data', (c) => { if (text.length < 65536) text += c.toString('utf8'); });
      upstream.res.on('end', resolve);
      upstream.res.on('error', resolve);
    });
    let modelCount = null;
    let models = [];
    try {
      const j = JSON.parse(text);
      const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : null;
      modelCount = list ? list.length : null;
      models = list
        ? list.map((m) => m && (m.id || m.name || m.model)).filter(Boolean).slice(0, 500)
        : [];
    } catch { /* 不是 JSON 就不统计 */ }

    return {
      ok: upstream.status >= 200 && upstream.status < 300,
      status: upstream.status,
      latency: Date.now() - started,
      modelCount,
      models,
      headersUsed: {
        profile: provider.headersProfile,
        protocol: provider.protocol,
        hasUA: Boolean(headers['user-agent']),
        ua: headers['user-agent'] || null,
        viaProxy: Boolean(provider.upstreamProxy),
      },
      sample: text.slice(0, 200),
    };
  } catch (err) {
    return { ok: false, status: 0, latency: Date.now() - started, error: (err && (err.message || err.code || err.name)) || 'network error' };
  }
}
