/**
 * 配置加载：JSON → 运行时配置（含密钥解析）
 *
 * v1 的约定（与 docs/03 §5 的差异在此注明）：
 * - providers / keys 以 config.json 为唯一事实源（M2）；M3 再迁进 SQLite。
 * - 密钥优先取 key.value（仅本地测试），否则取 key.env 指向的环境变量；
 *   两者都没有 → 该 key 标记为 missing（跳过，不报错退出）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 各端点所属协议（路由时用来筛池） */
export const ENDPOINT_PROTOCOL = {
  chat: 'openai-completions',
  embeddings: 'openai-completions',
  images: 'openai-completions',
  responses: 'openai-responses',
  messages: 'anthropic-messages',
};

export const ENDPOINT_PATH = {
  chat: '/chat/completions',
  embeddings: '/embeddings',
  images: '/images/generations',
  responses: '/responses',
  messages: '/messages',
};

/** 协议默认允许的端点（config 里可显式覆盖） */
const DEFAULT_ENDPOINTS = {
  'openai-completions': ['chat', 'embeddings', 'images'],
  'openai-responses': ['responses'],
  'anthropic-messages': ['messages'],
};

export function loadConfig(file) {
  const abs = path.resolve(file);
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const warnings = [];

  const config = {
    listen: { host: '127.0.0.1', port: 8790, ...(raw.listen || {}) },
    clientKeys: raw.clientKeys || [],
    routing: { maxCandidates: 3, maxAttempts: 3, totalBudgetMs: 90000, ...(raw.routing || {}) },
    aliases: raw.aliases || {},
    providers: (raw.providers || []).map((p, pi) => normalizeProvider(p, pi, warnings)),
    configPath: abs,
  };

  if (!config.clientKeys.length) {
    warnings.push('clientKeys 为空：任何请求都会被 401（至少配置一个客户端 key）');
  }
  return { config, warnings };
}

function normalizeProvider(p, pi, warnings) {
  const id = p.id || `provider-${pi + 1}`;
  if (!p.baseUrl) warnings.push(`provider ${id} 缺少 baseUrl`);
  const provider = {
    id,
    name: p.name || id,
    baseUrl: String(p.baseUrl || '').replace(/\/+$/, ''),
    protocol: p.protocol || 'openai-completions',
    headersProfile: p.headersProfile || 'none',
    headers: p.headers || {},
    upstreamProxy: p.upstreamProxy || '',
    models: p.models && p.models.length ? p.models : ['*'],
    endpoints: p.endpoints && p.endpoints.length
      ? p.endpoints.filter((e) => e in ENDPOINT_PATH)
      : DEFAULT_ENDPOINTS[p.protocol || 'openai-completions'] || ['chat'],
    rpm: Number(p.rpm) || 0,
    maxConcurrency: Number(p.maxConcurrency) || 4,
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
