/**
 * 上游适配：请求头构造 + 传输（直连 / HTTP CONNECT 隧道）+ 用量解析
 *
 * 设计依据：docs/03 §10、docs/05 §1。
 * 关键约束：
 * - 头合并顺序固定：入站(去 hop-by-hop) → 协议头 → profile → 池级 headers
 * - 池级 headers 不允许覆盖 authorization / x-api-key（密钥只能来自密钥池）
 * - 探活必须走同一个 buildHeaders + request（client-relay 的 probe 就是因为没复用而误判）
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

/**
 * 客户端带来的凭据头必须丢弃：网关的 key 不能漏给上游（反之密钥只能来自密钥池）。
 * 这是安全红线，不是可选优化。
 */
const CLIENT_CREDENTIAL = new Set([
  'authorization', 'x-api-key', 'x-goog-api-key', 'api-key', 'x-api-token', 'cookie',
]);

/** 客户端身份预设（与 data/header-presets.csv 对应） */
export const PROFILES = {
  none: {},
  'claude-cli': { 'user-agent': 'claude-cli/2.1.241 (external, cli)' },
  codex: {
    'user-agent': 'codex_cli_rs/0.156.0 (Windows 10.0.26200; x86_64) codex_cli_rs',
    originator: 'codex_cli_rs',
  },
  custom: {},
};

export function protocolHeaders(protocol, keyValue) {
  switch (protocol) {
    case 'anthropic-messages':
      return { 'x-api-key': keyValue, 'anthropic-version': '2023-06-01' };
    case 'openai-responses':
    case 'openai-completions':
    default:
      return { authorization: `Bearer ${keyValue}` };
  }
}

const lower = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));

/**
 * @param {{provider:object, keyValue:string, inbound?:object, endpoint?:string}} args
 * @returns {{headers:object, stripped:string[]}}
 *
 * 鉴权头按**端点**决定（同一 base_url 上 /v1/messages 要 x-api-key，其余要 Bearer），
 * provider.protocol 只决定默认端点集合与探活路径（见 docs/03 §10）。
 */
export function buildHeaders({ provider, keyValue, inbound = {}, endpoint = null }) {
  const headers = {};
  const stripped = [];

  for (const [k, v] of Object.entries(inbound)) {
    const name = k.toLowerCase();
    if (HOP_BY_HOP.has(name)) {
      stripped.push(name);
      continue;
    }
    if (CLIENT_CREDENTIAL.has(name)) {
      stripped.push(`${name}(client-credential)`);
      continue;
    }
    headers[name] = v;
  }

  const style = endpoint === 'messages' ? 'anthropic-messages' : 'openai-completions';
  Object.assign(headers, protocolHeaders(style, keyValue));
  Object.assign(headers, PROFILES[provider.headersProfile] || {});

  const poolHeaders = lower(provider.headers);
  for (const name of Object.keys(poolHeaders)) {
    if (name === 'authorization' || name === 'x-api-key') continue; // 密钥只能来自池
    headers[name] = poolHeaders[name];
  }

  delete headers.host; // 由传输层按目标地址重建
  return { headers, stripped };
}

/* ------------------------------------------------------------------ transport */

function connectViaProxy(proxyUrl, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const port = Number(p.port) || (p.protocol === 'https:' ? 443 : 80);
    const socket = net.connect({ host: p.hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`proxy connect timeout: ${proxyUrl}`));
    }, Math.min(timeoutMs, 15000));

    socket.once('error', (e) => { clearTimeout(timer); reject(e); });
    socket.once('connect', () => {
      const auth = p.username
        ? 'Proxy-Authorization: Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64') + '\r\n'
        : '';
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}Connection: keep-alive\r\n\r\n`,
      );
    });

    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (buf.length > 8192) { clearTimeout(timer); socket.destroy(); reject(new Error('proxy response too large')); }
        return;
      }
      socket.removeListener('data', onData);
      clearTimeout(timer);
      const statusLine = buf.split('\r\n')[0] || '';
      const code = Number(statusLine.split(' ')[1]);
      if (code !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: ${statusLine}`));
        return;
      }
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

/**
 * 向上游发请求，返回 { status, headers, res(可读流), errorKind }
 * 注意：不消费 body —— 由调用方决定是透传还是读完。
 */
export async function requestUpstream({ provider, path, method = 'POST', headers, body, timeoutMs = 90_000 }) {
  const url = new URL(provider.baseUrl + path);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;
  const host = url.hostname;
  const port = Number(url.port) || (isHttps ? 443 : 80);

  let socket = null;
  if (provider.upstreamProxy) {
    socket = await connectViaProxy(provider.upstreamProxy, host, port, timeoutMs);
  }

  return await new Promise((resolve, reject) => {
    const options = {
      method,
      host,
      port,
      path: url.pathname + url.search,
      headers: { ...headers, host: url.host },
      agent: false,
      timeout: timeoutMs,
    };
    if (socket) {
      options.createConnection = () => (isHttps ? tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] }) : socket);
    }
    const req = mod.request(options, (res) => resolve({ status: res.statusCode, headers: res.headers, res }));
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ usage */

export class UsageTap {
  constructor() {
    this.tail = '';
    this.bytes = 0;
  }

  feed(chunk) {
    this.bytes += chunk.length;
    if (this.tail.length < 65536) this.tail += chunk.toString('utf8');
  }

  /** 从 SSE 尾巴里找 usage；找不到则按字符数粗估 */
  result(fallbackPromptChars = 0) {
    const m = this.tail.match(/"usage"\s*:\s*\{[^}]*\}/g);
    if (m && m.length) {
      const last = m[m.length - 1];
      try {
        const u = JSON.parse(last.replace(/^"usage"\s*:\s*/, ''));
        if (u && (u.prompt_tokens != null || u.completion_tokens != null)) {
          return {
            promptTokens: u.prompt_tokens ?? u.input_tokens ?? null,
            completionTokens: u.completion_tokens ?? u.output_tokens ?? null,
            estimated: false,
          };
        }
      } catch { /* 部分流式实现不会输出完整 JSON */ }
    }
    return {
      promptTokens: Math.ceil(fallbackPromptChars / 4),
      completionTokens: Math.ceil(this.bytes / 4),
      estimated: true,
    };
  }
}

export function parseUsageJson(text) {
  try {
    const j = JSON.parse(text);
    const u = j.usage || {};
    if (u.prompt_tokens != null || u.completion_tokens != null) {
      return {
        promptTokens: u.prompt_tokens ?? u.input_tokens ?? null,
        completionTokens: u.completion_tokens ?? u.output_tokens ?? null,
        estimated: false,
      };
    }
  } catch { /* ignore */ }
  return { promptTokens: null, completionTokens: null, estimated: true };
}

/* ------------------------------------------------------------------ errors */

export function classifyStatus(status, bodyText = '') {
  if (status === 401) return 'auth';
  if (status === 403) {
    // 403 有两种：key 失效（拉黑）与「该分组不允许此端点」（池级策略，不能拉黑 key）
    if (/does not allow|permission_error|not allowed|dispatch/i.test(bodyText)) return 'endpoint_denied';
    return 'auth';
  }
  if (status === 402) return 'quota';
  if (status === 429) return 'rate_limit';
  if (status === 404 && /model/i.test(bodyText)) return 'model_not_found';
  if (status === 400 && /invalid schema for function|tool.*schema/i.test(bodyText)) return 'tool_schema';
  if (status >= 500) return 'upstream_error';
  return 'bad_request';
}
