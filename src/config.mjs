/**
 * 配置加载：JSON → 运行时配置（含密钥解析）
 *
 * v2 变化：
 * - `protocol` 归一化为 chat | messages | responses（兼容 v1 的 openai-completions 等写法）
 * - `endpoints` = 该池**上游原生支持**的端点；不在其中的端点会尝试协议转换
 * - 新增 `tpm`（每分钟 token 桶）与 `modelMap`（客户端模型 → 上游模型）
 */
import fs from 'node:fs';
import path from 'node:path';

export const ENDPOINT_PATH = {
  chat: '/chat/completions',
  messages: '/messages',
  responses: '/responses',
  embeddings: '/embeddings',
  images: '/images/generations',
};

/** 端点 → 上游协议名（embeddings/images 不做转换） */
export const ENDPOINT_PROTOCOL = {
  chat: 'chat',
  messages: 'messages',
  responses: 'responses',
  embeddings: 'embeddings',
  images: 'images',
};

const PROTOCOL_ALIASES = {
  'openai-completions': 'chat',
  'openai-chat': 'chat',
  chat: 'chat',
  'anthropic-messages': 'messages',
  messages: 'messages',
  anthropic: 'messages',
  'openai-responses': 'responses',
  responses: 'responses',
};

export function normalizeProtocol(value) {
  return PROTOCOL_ALIASES[String(value || 'chat')] || 'chat';
}

export function loadConfig(file) {
  const abs = path.resolve(file);
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const warnings = [];

  const config = {
    listen: { host: '127.0.0.1', port: 8790, ...(raw.listen || {}) },
    // v4：局域网/浏览器跨域（默认关闭；allowOrigins 里写具体源，或 ["*"]）
    cors: {
      enabled: raw.cors?.enabled === true,
      allowOrigins: Array.isArray(raw.cors?.allowOrigins) ? raw.cors.allowOrigins.map(String) : [],
    },
    clientKeys: raw.clientKeys || [],
    routing: { maxCandidates: 3, maxAttempts: 3, totalBudgetMs: 90000, maxRateWaitMs: 1500, ...(raw.routing || {}) },
    monitor: {
      enabled: true,
      probeIntervalSec: 300,
      probeOnStartup: true,
      probeTimeoutMs: 15000,
      failThreshold: 2,
      alertCooldownSec: 1800,
      webhookUrl: '',
      webhookFormat: 'generic',
      ...(raw.monitor || {}),
    },
    // v3：瞬时故障吸收（免费中转站常见的"假 401 / 假密钥无效"）
    resilience: {
      retries: 2,              // 同一候选内的重试次数
      backoffMs: 400,          // 首次重试等待
      backoffMaxMs: 2500,      // 单次等待上限
      jitterMs: 250,           // 随机抖动，避免多请求同时打
      flakyCooldownMs: 2500,   // 瞬时失败后该 key 短暂冷却
      preludeMs: 2500,         // 流式首包缓冲窗口：窗口内出错可静默重试
      retryAfterSec: 2,        // 彻底失败时给客户端的 Retry-After
      ...(raw.resilience || {}),
    },
    aliases: raw.aliases || {},
    providers: (raw.providers || []).map((p, pi) => normalizeProvider(p, pi, warnings)),
    configPath: abs,
  };

  if (!config.clientKeys.length) warnings.push('clientKeys 为空：任何请求都会被 401（至少配置一个客户端 key）');
  return { config, warnings };
}

function normalizeProvider(p, pi, warnings) {
  const id = p.id || `provider-${pi + 1}`;
  if (!p.baseUrl) warnings.push(`provider ${id} 缺少 baseUrl`);

  const protocol = normalizeProtocol(p.protocol);
  let endpoints = Array.isArray(p.endpoints) && p.endpoints.length
    ? p.endpoints.filter((e) => e in ENDPOINT_PATH)
    : (protocol === 'chat' ? ['chat', 'embeddings', 'images'] : [protocol]);

  if (!endpoints.includes(protocol)) endpoints = [protocol, ...endpoints];

  const provider = {
    id,
    name: p.name || id,
    baseUrl: String(p.baseUrl || '').replace(/\/+$/, ''),
    protocol,
    endpoints,
    headersProfile: p.headersProfile || 'none',
    headers: p.headers || {},
    upstreamProxy: p.upstreamProxy || '',
    models: p.models && p.models.length ? p.models : ['*'],
    modelMap: p.modelMap || {},
    rpm: Number(p.rpm) || 0,
    tpm: Number(p.tpm) || 0,
    maxConcurrency: Number(p.maxConcurrency) || 4,
    // 池级优先级：数值越大越优先被选中（主用中转站给 100，备用给 10 或留空）
    priority: Number(p.priority) || 0,
    // 免费中转站专用：把"假 401 / 密钥无效"当瞬时故障重试，而不是拉黑 key
    flakyAuth: p.flakyAuth === true,
    enabled: p.enabled !== false,
    keys: [],
  };

  const keys = p.keys && p.keys.length ? p.keys : [{ id: 'default' }];
  provider.keys = keys.map((k, ki) => {
    const keyId = k.id || `${id}-k${ki + 1}`;
    let value = k.value || '';
    if (!value && k.file) {
      try {
        value = fs.readFileSync(path.resolve(k.file), 'utf8').trim();
      } catch (e) {
        warnings.push(`provider ${id} / key ${keyId} 读取 key 文件失败：${k.file}（${e.message}）`);
      }
    }
    if (!value && k.env) value = process.env[k.env] || '';
    if (!value) warnings.push(`provider ${id} / key ${keyId} 未找到密钥（env ${k.env || '未指定'} / file ${k.file || '未指定'}），已跳过`);
    return {
      id: keyId,
      label: k.label || keyId,
      env: k.env || '',
      file: k.file || '',
      value,
      weight: Number(k.weight) > 0 ? Number(k.weight) : 1,
      dailyQuota: Number(k.dailyQuota) || 0,
      maxConcurrency: Number(k.maxConcurrency) || provider.maxConcurrency,
      missing: !value,
    };
  });

  if (!['none', 'claude-cli', 'codex', 'custom'].includes(provider.headersProfile)) {
    warnings.push(`provider ${id} headersProfile=${provider.headersProfile} 不在白名单，回退 none`);
    provider.headersProfile = 'none';
  }
  return provider;
}

/** 本地日期 YYYY-MM-DD（账本按自然日滚动） */
export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
