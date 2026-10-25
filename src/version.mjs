/** 版本与能力矩阵（/healthz、日志里都用这里） */
export const VERSION = '4.0.4';

export const CAPABILITIES = {
  endpoints: ['chat', 'messages', 'responses', 'embeddings', 'images'],
  conversions: [
    'chat→messages', 'messages→chat',
    'chat→responses', 'responses→chat',
    'messages→responses', 'responses→messages',
  ],
  streaming: ['chat', 'messages', 'responses'],
  limits: ['rpm', 'tpm', 'maxConcurrency', 'dailyQuota'],
  resilience: [
    'transient-auth-retry',   // 假 401 / 假密钥无效 静默重试
    'sse-prelude-buffer',     // 流式首包缓冲，出错时客户端无感切换
    'json-error-detection',   // 200 里藏 error 也算瞬时故障
    'retry-after',            // 彻底失败时返回 503 + Retry-After，触发客户端重试
  ],
  ops: ['dashboard', 'panel-config-write', 'config-hot-reload', 'local-time-display', 'scheduled-probe', 'webhook-alerts', 'admin-shutdown'],
  lan: [
    'bind-all-interfaces',    // listen.host = 0.0.0.0
    'lan-url-hints',          // 启动时打印局域网入口
    'cors',                   // 可配置跨域（浏览器客户端）
    'per-device-keys',        // clientKeys 多条目，一台设备一个 key
  ],
};

export function versionLine() {
  return `FQRH v${VERSION} (conversion ${CAPABILITIES.conversions.length} pairs, LAN relay, transient-fault buffering)`;
}
