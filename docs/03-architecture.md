# 03 · 架构设计（M1 草案）

> 目标形态：**轻量自研薄壳**（约 3–5k 行），复用成熟组件而不是从零造网关。选型依据见 同类开源项目调研（未随仓库发布）；本文只描述「如果自研，长什么样」。

## 1. 分层视图

```
                          ┌──────────────────────────────────────────────┐
  客户端                  │                 接入层 (Edge)                 │
  - Cherry Studio         │  /v1/chat/completions  /v1/embeddings        │
  - LobeChat              │  /v1/models            /healthz  /metrics    │
  - Cline / 自写脚本      │  鉴权: 本地 sk-fqrh-xxx（只认自己的 key）      │
  └───────────┬───────────└──────────────────────┬───────────────────────┘
              │                                  │
              ▼                                  ▼
   ┌──────────────────┐                  ┌──────────────────────────────┐
   │  模型别名层       │  gpt-4o ──▶      │  路由层 (Router)              │
   │  alias registry  │  gpt-4o@tier-a   │  1. 过滤: 支持该模型 + 池启用  │
   └──────────────────┘                  │  2. 打分: 健康×权重×额度×并发  │
                                         │  3. 候选队列 (failover 顺序)   │
                                         └──────────────┬───────────────┘
                                                        │
                     ┌──────────────────────────────────▼───────────────────┐
                     │              密钥池层 (Key Pool)                      │
                     │  pool = (vendor, base_url, 协议适配器, 限流策略)       │
                     │  key  = (pool, secret, weight, daily_quota, state)   │
                     │  state: active / cooling(until) / disabled / dead    │
                     └──────────────────────────────────┬───────────────────┘
                                                        │
      ┌─────────────────────────────────────────────────▼───────────────────────┐
      │                          上游适配器 (Adapters)                           │
      │  openai-compatible ▌ anthropic原生 ▌ gemini原生 ▌ cloudflare ▌ 自定义     │
      └─────────────────────────────────────────────────┬───────────────────────┘
                                                        │
      ┌─────────────────────────────────────────────────▼───────────────────────┐
      │ 观测与账本 (Telemetry & Ledger)                                          │
      │  request_logs ─▶ 聚合视图(按天/池/模型) ─▶ Prometheus /metrics ─▶ 告警    │
      └─────────────────────────────────────────────────────────────────────────┘
```

## 2. 组件职责

| 组件 | 职责 | 关键实现要点 |
| --- | --- | --- |
| **Edge** | 鉴权、请求校验、超时预算、SSE 透传 | 只接受本地签发的 key；`X-Request-Id` 全链路贯穿；开启 `--workers` 多进程时账本需用 DB 而非内存 |
| **Alias Registry** | 客户端模型名 → 上游模型名 + 池优先级 | 支持通配（`claude-*` → `claude-sonnet-4-5`）；未知模型返回 404 而不是猜 |
| **Router** | 候选排序、并发控制、失败转移 | 打分函数必须**纯函数 + 可解释**，便于排障 |
| **Key Pool** | key 生命周期、状态机、冷却/恢复 | 状态迁移必须写审计日志（谁、何时、为什么被拉黑） |
| **Adapters** | 协议转换、错误码归一 | 统一内部错误枚举，见 §5 |
| **Ledger** | 用量记账、额度估算、到期提醒 | 幂等写入：`(request_id)` 唯一索引 |
| **Admin UI** | 导入 key、批量探活、看板 | 首版可用静态页面 + REST，不必上 React |

## 3. 选路算法

### 3.1 打分

```
score(key) = w_weight          // 人工权重，0.1 ~ 10
           × health(key)       // 滑动窗口成功率，0.05 ~ 1.0
           × quota_factor(key)// min(1, remaining/quota_headroom)
           × load_factor(key)  // 1 - inflight/max_concurrency
```

- 候选按 `score` 降序，取前 N（默认 3）作为 failover 链；
- 同分时用 **平滑加权轮询（SWRR）** 打散，避免永远打到同一个 key；
- 明确排除：`state != active`、`today_used >= daily_quota`、`inflight >= max_concurrency`、`模型不在 pool.models`。

### 3.2 伪代码

```python
def pick(model: str, req) -> list[Candidate]:
    alias = aliases.resolve(model)
    pools = [p for p in pools.of(alias) if p.enabled and p.supports(alias)]
    cands = []
    for p in pools:
        for k in p.keys:
            if not k.eligible(alias, req):     # 状态/额度/并发/冷却
                continue
            cands.append(Candidate(p, k, score(k)))
    cands.sort(key=lambda c: (-c.score, hash(c.key.id)))
    return swrr_order(cands)[:cfg.max_candidates]   # 默认 3
```

### 3.3 并发与配额保护

- 每个 key 有 `max_concurrency`（默认 2–4，按上游 RPM 折算）；
- 每个池有令牌桶：`rpm`、`tpm` 双维度，满了直接**排队**（短队列，≤2s）而不是报错；
  - 已实现：`rpm` 令牌桶（`pool.mjs:takeRate`），排队上限 `routing.maxRateWaitMs`（默认 1500ms），超时换候选并最终对客户端回 429；
  - 未实现：`tpm`（按 token 限速）。
- 每日本地额度 `daily_quota` 是「软上限」，宁可少用也不要把某个免费额度打爆触发风控。

## 4. 失败转移与错误矩阵

| 上游返回 | 归类 | 动作 | 是否换候选 |
| --- | --- | --- | --- |
| 401 | 凭证失效/封禁 | key → `dead`，写审计 | ✅（若还没吐字） |
| 403「分组不允许该端点」 | 池级策略（如 relay-backup 禁 `/v1/messages`） | **不拉黑 key**，整池跳过 | ✅ 换其他池 |
| 403 其他 | 凭证失效/封禁 | key → `dead` | ✅ |
| 402 / 余额不足 | 额度耗尽 | key → `disabled`，标记 `exhausted_at` | ✅ |
| 429 | 限流 | key → `cooling(backoff)`，`backoff = min(60s × 2^n, 30min)` | ✅ |
| 400 / 422 | 请求本身有问题 | 原样返回客户端 | ❌（换谁都没用） |
| 400 `Invalid schema for function` | 上游工具 schema 不兼容（某类中转站） | 给该池打 `tool_schema_incompatible`，**换池**（不是换 key） | ⚠️ 换池，不重试同池 |
| 404 model | 模型不存在/下架 | 该池对模型置灰，换池 | ✅ |
| 5xx | 上游故障 | 退避 1 次后换候选 | ✅ |
| 超时（未吐字） | 网络/上游挂起 | 换候选（总预算内） | ✅ |
| 超时（已吐字） | 流中断 | **不重试**，向客户端补 `[DONE]` 并记 `partial` | ❌ |

**重试预算**：`max_attempts=3`、`total_budget=90s`（可配），非幂等的 `/v1/chat/completions` 在**已产生输出后绝不重放**，避免重复计费。

## 5. 数据模型（SQLite 起步，Postgres 可平移）

```sql
-- 池：一个上游供应商/中转站
CREATE TABLE pools (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  adapter       TEXT NOT NULL,              -- openai|anthropic|gemini|cloudflare|...
  protocol      TEXT DEFAULT 'openai-completions',  -- 上游真正认的协议
  headers_profile TEXT DEFAULT 'none',      -- none|claude-cli|codex|custom（见 §10）
  headers_json  TEXT,                       -- JSON：额外静态头，覆盖 profile 同名项
  upstream_proxy TEXT,                      -- 可选：http://127.0.0.1:7890
  models        TEXT NOT NULL,              -- JSON 数组或 '*'
  endpoints     TEXT DEFAULT '["chat"]',    -- JSON 数组：chat|messages|responses|embeddings|images
  rpm           INTEGER DEFAULT 0,          -- 0 = 不限
  max_concurrency INTEGER DEFAULT 4,
  enabled       INTEGER DEFAULT 1,
  created_at    TEXT NOT NULL
);

-- key
CREATE TABLE keys (
  id            TEXT PRIMARY KEY,
  pool_id       TEXT NOT NULL REFERENCES pools(id),
  label         TEXT,                       -- 人看的备注：来源/领取日期
  secret_enc    BLOB NOT NULL,              -- AES-GCM(主密码派生)
  weight        REAL DEFAULT 1.0,
  daily_quota   INTEGER DEFAULT 0,          -- 0 = 不限
  max_concurrency INTEGER DEFAULT 2,
  state         TEXT DEFAULT 'active',      -- active|cooling|disabled|dead
  cooling_until TEXT,
  created_at    TEXT, last_used_at TEXT, last_error TEXT
);

-- 模型别名
CREATE TABLE aliases (
  client_model  TEXT PRIMARY KEY,
  upstream_model TEXT NOT NULL,
  pool_priority TEXT,                       -- JSON: 池 id 顺序
  notes         TEXT
);

-- 请求流水（幂等写入）
CREATE TABLE request_logs (
  request_id    TEXT PRIMARY KEY,
  ts            TEXT NOT NULL,
  endpoint      TEXT,                       -- chat|messages|responses|embeddings|images
  pool_id       TEXT, key_id TEXT,
  client_model  TEXT, upstream_model TEXT,
  status        INTEGER, error_kind TEXT,
  first_token_ms INTEGER, total_ms INTEGER,
  prompt_tokens INTEGER, completion_tokens INTEGER,
  estimated     INTEGER DEFAULT 0
);
CREATE INDEX idx_logs_ts ON request_logs(ts);

-- 额度账本（按天滚动）
CREATE TABLE quota_daily (
  day       TEXT, key_id TEXT,
  requests  INTEGER, tokens  INTEGER,
  cost_usd  REAL,
  PRIMARY KEY (day, key_id)
);
```

## 6. 配置示例（`config.yaml`）

```yaml
server:
  listen: "127.0.0.1:8787"
  api_keys: ["sk-fqrh-local-replace-me"]     # 客户端带这个
routing:
  max_candidates: 3
  max_attempts: 3
  total_budget_s: 90
  sticky_by: session                         # 同一会话尽量同上游，便于缓存命中
pools:
  - name: "gemini-free"
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai"
    adapter: openai
    models: ["gemini-2.5-flash", "gemini-2.5-pro"]
    rpm: 15
    max_concurrency: 2
  - name: "relay-a"
    base_url: "https://api.relay-a.example/v1"
    adapter: openai
    protocol: openai-completions
    headers_profile: none            # 默认不改头；需要时显式设 claude-cli/codex/custom
    models: ["*"]
    rpm: 60
  - name: "relay-b-anthropic"
    base_url: "https://api.relay-b.example"
    adapter: anthropic
    protocol: anthropic-messages     # 走 /v1/messages + x-api-key + anthropic-version
    headers_profile: custom
    headers:
      anthropic-version: "2023-06-01"
    upstream_proxy: "http://127.0.0.1:7890"
    models: ["claude-opus-4-6"]
  - name: "siliconflow"
    base_url: "https://api.siliconflow.cn/v1"
    adapter: openai
    models: ["Qwen/Qwen3-8B", "THUDM/GLM-4-9B-0414"]
aliases:
  gpt-4o-mini: { upstream: "gpt-4o-mini", priority: ["relay-a"] }
  "claude-*":  { upstream: "claude-sonnet-4-5", priority: ["relay-a"] }
```

## 7. 部署形态

```yaml
# docker-compose.yml 骨架
services:
  fqrh:
    build: .
    ports: ["127.0.0.1:8787:8787"]      # 只监听本地，不裸奔公网
    volumes: ["./data:/app/data"]        # SQLite + 加密 key 库
    restart: unless-stopped
  # 可选：prometheus + grafana（M4）
```

**安全底线**：默认只监听 `127.0.0.1`；若要远程访问，必须走 Tailscale/WireGuard 或反代 + mTLS，**不要**把管理端直接暴露公网。

## 8. 里程碑拆解

| 里程碑 | 交付 | 验收标准 |
| --- | --- | --- |
| ~~M2 骨架~~ | Edge + 单池单 key 透传（含 SSE） | ✅ curl 能用，Cherry Studio 能连 |
| ~~M2.5 池化~~ | key 轮询 + 冷却 + 拉黑 | ✅ 手工把某 key 设成死 key，请求仍成功 |
| M3 账本 | request_logs + quota_daily + 每日汇总 | 🟡 表已落、写入已通；汇总视图/日报未做 |
| M3.5 探活 | 定时最小请求 + 批量导入校验 | 🟡 同源探活已通（`/__admin/probe`）；批量与定时未做 |
| M3.7 协议扩展 | anthropic-messages / openai-responses 的请求转换 | ⬜ v1 只路由 openai-completions |
| M4 面板 | 看板 + 告警（Webhook/邮件） | ⬜ |

> 实现状态（2026-10-22，v3）：`src/` 下已落地零依赖网关（Node 24 内置 `node:sqlite` + `fetch`），`node src/test.mjs` **84 项**、`node src/test-convert.mjs` **57 项**自测全通过，并用 `src/mock-upstream.mjs` + `scripts/demo-flaky.mjs` 做过端到端冒烟（UA 改写、SSE、失败转移、假 401 缓冲均在真实 HTTP 链路上验证）。

## 9. 待定问题

- 是否直接基于 **new-api / one-api** 二次开发，还是自研薄壳？（等 调研文档 调研结论）
- 账本用 SQLite 单文件够不够（预期 QPS < 5，够；但多进程写要 WAL + 单写者）。
- 免费额度「过期提醒」数据从哪来：多数中转站不提供 API 查余额，只能靠本地累计估算 + 人工核对。

## 10. 上游请求头与协议适配（衔接 client-relay / 同类项目）

> 详细代码级分析见 上游请求头适配分析（未随仓库发布）；本节只放**架构决策**。

### 10.1 为什么网关必须能改头

上游要的「协议正确」不止是 URL 和 body，还有头。三类需求，性质完全不同：

| 类型 | 例子 | 性质 | 本项目的态度 |
| --- | --- | --- | --- |
| **协议必需头** | Anthropic 的 `x-api-key` + `anthropic-version: 2023-06-01`；Gemini 的 `x-goog-api-key` | 不发送就 400，**这是正确性** | ✅ 默认实现 |
| **客户端身份校验** | 某中转站只让 `claude-cli/...` 或 `codex_cli_rs/...` 的 UA 通过，DSH 自己的 `某 CLI/...` 会被判 `unauthorized client detected` | 这是**上游的准入策略**，伪装 = 绕过访问控制 | ⚠️ 默认关闭，需显式开启，风险自负 |
| **企业网关标识** | 内部网关要求 `x-team-id`、`x-biz-line` 之类的路由/计费头 | 路由需求 | ✅ 配置项 |

前两类在工程上是同一段代码，**风险却完全不同**——所以配置必须显式区分「协议头」与「身份头」，不能一个开关全开。

### 10.2 从 client-relay 拿到的六个可复用事实

`client-relay` 是一个已经在用的单上游改头中转（127.0.0.1:8788），其实现给了我们现成答案（细节与行号见 上游请求头适配分析）：

1. **头合并顺序**：`入站头 → 预设头（preset.headers）→ customHeaders → extraHeaders`，后者覆盖前者（`relay.mjs:124`、`relay.mjs:419`）。FQRH 沿用这个顺序：`入站 → 协议头 → profile 头 → 池级 headers → 密钥级 headers`。
2. **hop-by-hop 过滤**：逐跳头（`connection`、`keep-alive`、`transfer-encoding` 等）必须在转发前剔除，否则上游会 400（`relay.mjs:561-564`）。
3. **两种协议的两套头**：`openai-completions` 用 `authorization: Bearer <key>`；`anthropic-messages` 用 `x-api-key` + `anthropic-version`（`relay.mjs:315-320`、`338-351`）。**同一个 base_url 可能两种协议都支持**，所以 `protocol` 必须是池级配置。⚠️ 但 `protocol` 只是「探测请求形状」，**不是协议转换器**——转发是原样透传（`relay.mjs:332-354` 只管探测），FQRH 要做真转换得自己写。
4. **两条上游通道**：直连 `fetch`（undici）、配代理走 `CONNECT` 隧道（`relay.mjs:218-260`）。⚠️ 隧道路径**没有重建 `Host` 头**，复刻时必须显式处理。
5. **探活路径不可直接继承**：`probe`/`test` 忽略 `upstreamProxy`（`relay.mjs:434-439`），`fetchModels` 不并入伪装头（`relay.mjs:316-320`）→ 探活会误判「能通」或「不能通」。FQRH 的探活**必须复用业务同一套头构造与传输路径**。
6. **工具 schema 不兼容要按池降级**：部分中转站对客户端工具 schema 返回 `400 Invalid schema ...`，这不是 key 的问题——所以路由层要能「换池」而不是「换 key」，见 §4 错误矩阵。

### 10.3 三种集成形态

| 形态 | 拓扑 | 延迟 | 故障面 | 结论 |
| --- | --- | --- | --- | --- |
| **(a) 内置 header profile** | FQRH 适配器直接改头转发 | 最低（一次转发） | 只有一个进程 | ✅ **推荐，M2 就做** |
| **(b) FQRH → client-relay → 上游** | 网关再套一层现成 relay | +1~3ms/跳 | 两个进程、两套配置、双份日志 | 🟡 仅作**过渡**：M1 验证期先用它跑通，别长期保留 |
| **(c) client-relay 只当探活/面板** | 旁路，不承载流量 | 0 | 无 | 🟡 面板可用，**探活不可直接信**（它忽略代理与伪装头，见 10.2-⑤） |

> 结论：**能力搬进 FQRH（a），工具留着用（c），链路不要叠（b 只做临时）。** 把 client-relay 当上游会带来「改两次头、记两份账、错两次」的问题。

### 10.4 落到配置与表结构

- 池级新增五个字段：`protocol`、`endpoints`、`headers_profile`、`headers_json`、`upstream_proxy`（DDL 见 §5，YAML 见 §6）。
- **鉴权头由端点决定，不由 protocol 决定**（2026-10-22 实测 relay-backup）：`/v1/messages` 用 `x-api-key` + `anthropic-version`，`/v1/chat|responses|embeddings|images` 用 `authorization: Bearer`。`protocol` 只决定默认端点集合与探活路径。
- **客户端带来的凭据头必须丢弃**（`authorization` / `x-api-key` / `x-goog-api-key` / `cookie`）：网关 key 不能漏给上游，密钥只能来自密钥池。已实现于 `upstream.mjs` 的 `CLIENT_CREDENTIAL`。
- `headers_profile` 只暴露白名单值：`none` / `claude-cli` / `codex` / `custom`；`custom` 才允许任意头。
- 池级 `headers` 优先级高于 profile，**但禁止覆盖 `authorization` / `x-api-key`**（防止把密钥写进静态配置）。
- 日志只记录 `headers_profile` 名字与最终 UA 的哈希，不记录任何认证头（沿用 client-relay 的脱敏做法）。

### 10.5 边界（写进代码注释与 UI）

- 伪装客户端身份是**绕过上游访问控制**的行为，只在你持有该 key 且上游条款允许时使用；上游封号风险由使用者承担。
- 本项目**默认不开启**任何身份伪装；开启时 UI 必须弹一次显式确认，并在池详情里常驻黄色警告。
- 不实现：批量身份轮换、随机 UA 生成、请求体指纹伪造（`同类项目` 的实测也表明请求体指纹是另一层校验，见 调研文档）。

## 11. 实现状态与真实上游实测（2026-10-22）

### 11.1 已实现的端点

| 客户端调用 | 上游路径 | 鉴权头 | 可流式 |
| --- | --- | --- | --- |
| `POST /v1/chat/completions` | `/chat/completions` | Bearer | ✅ |
| `POST /v1/messages` | `/messages` | `x-api-key` + `anthropic-version` | ✅ |
| `POST /v1/responses` | `/responses` | Bearer | ✅ |
| `POST /v1/embeddings` | `/embeddings` | Bearer | ❌ |
| `POST /v1/images/generations` | `/images/generations` | Bearer | ❌ |
| `GET /v1/models` | （本地汇总） | — | ❌ |

> 池是否接受某端点由 `providers[].endpoints` 决定；不接受时网关直接回 **503 no_candidate**，不会把请求打到上游换一个 403。

### 11.2 已验证的真实上游（relay-backup）

一手实测见 （原调研笔记未随仓库发布）。摘要：

- `/v1/chat/completions` ✅（含流式）、`/v1/responses` ✅、`/v1/models` ✅
- `/v1/messages` ❌ 403 `permission_error`（分组策略，**不是 key 失效**）
- `/v1/embeddings` ❌ 404、`/v1/images/generations` ❌ 400（该池没有对应模型）
- completion token 大头是 reasoning（1830 token 只为「数到三」），流式 19–68s 属上游特性

### 11.3 代码与验证

- 代码：`src/`（零依赖，Node 24 内置 `node:sqlite`）
- 离线自测：`node src/test.mjs` → **84 项全通过**（含 UA 改写、凭据不外漏、多端点、池级 403、rpm/tpm 桶、账本、状态机、v3 假 401 缓冲）
- 协议转换：`node src/test-convert.mjs` → **57 项全通过**
- 真实链路：`node scripts/live-smoke.mjs` → **10 项全通过**
- 日报：`node scripts/report.mjs`

### 11.4 仍然缺的（按优先级）

1. `tpm` 令牌桶与「按池 QPS」保护；
2. 协议**转换**（客户端说 anthropic、上游只支持 openai，或反之）；当前只做同协议透传；
3. 定时探活 + 告警（Webhook/邮件）、管理面板；
4. `pools/keys/aliases` 从 config.json 迁进 SQLite（多实例共享时需要）。
