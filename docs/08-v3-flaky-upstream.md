# v3 · 上游「假鉴权失败」缓冲（锦上添花层）

> 一句话：免费中转站时不时返回 `401 API 密钥无效`，但那**不是你的 key 有问题**，而是它自己的共享池在空转。
> v3 把这种「瞬时故障」在网关内部消化掉，让客户端**无感**——不报错、不中断对话、不换 key。

## 1. 现象

用 `https://relay-free.example.com/v1`（key 填 `public`）接 DSH 跑 `deepseek-v4.1-flash-free` 时，会间歇性冒出：

```
本轮运行失败 API 密钥无效
```

特点：

- **过几秒重发同样的话就又能继续**（客户端层面重试就好了）；
- 换了 key 也一样（因为该站根本不校验 key）；
- 直连（不经过网关）时也能复现，说明问题在上游，不在网关。

## 2. 实测定位（2026-10-22）

| 探测项 | 结果 | 结论 |
| --- | --- | --- |
| `GET /v1/models` | 86 个模型，含 `deepseek-v4.1-flash-free` | 站点可用 |
| 用空 key / `sk-definitely-wrong` | 仍然 200 | **它不校验客户端 key** |
| `deepseek-v4.1-flash-free` × 3 | 3/3 200 | 免费模型可用 |
| `deepseek-v4.1-flash`、`deepseek-v4-flash` × 3 | 6/6 `401 api_key_expired` | **非 `-free` 模型要它自己的付费 key，稳定失败** |
| 168 次并发压测（concurrency 8，55s） | 168/168 成功，0 个 >8s | 偶发故障无法按需复现 |
| `/v1/messages`、`/v1/responses` | 原生可用 | 不需要协议转换 |

**两个关键结论**：

1. `401 API 密钥无效` ≠ 你的 key 失效。该站不校验 key，这个错误只可能是它**共享池里上游 key 过期/池空转**时的伪装。
   → 所以**绝不能**把它当 401 透传给客户端，更不能把本地 key 判定为死。
2. 同一个错误文案有两种含义，必须分开处理：
   - `-free` 模型上偶发出现 → **瞬时故障**（等几百毫秒重试就好）；
   - 非 `-free` 模型上稳定出现 → **该模型要付费 key**（重试多少次都没用，要换模型）。

## 3. 机制（六层）

### 3.1 池级标记 `flakyAuth`

```json
{ "id": "relay-free", "flakyAuth": true, ... }
```

声明「这个上游的鉴权错误不可信」。只有标了 `flakyAuth` 的池才启用下面所有缓冲逻辑，普通池（relay-backup 等）行为完全不变：

- 401/403 仍然 → `auth` → 拉黑 key（真·密钥错误就该拉黑）。

### 3.2 状态分流：`transient_auth` 而不是 `auth`

`src/upstream.mjs` 的 `classifyStatus(status, body, { flakyAuth })`：

| 情况 | 分类 | 处理 |
| --- | --- | --- |
| `flakyAuth` 池 + 401/403（非「该分组不允许此端点」） | `transient_auth` | 重试同一个候选，**key 进 `flaky` 短冷却，不拉黑** |
| 403 + `does not allow / dispatch` | `endpoint_denied` | 跳过该池（原有逻辑） |
| 普通池 401 | `auth` | 拉黑 key（原有逻辑） |
| 429 / 402 | `rate_limit` / `quota` | 冷却/额度（原有逻辑） |

key 状态机新增 `flaky`：

```
active ──假401──> flaky（冷却 ~2.5s）──到期──> active
                  └─ 不计入 dead、不影响权重排序
```

### 3.3 同候选内重试（指数退避 + 抖动）

`src/server.mjs` 的候选循环内，对 `flakyAuth` 池额外做 `resilience.retries` 次同候选重试：

```
第 1 次失败 → 等 400ms + rand(0..250ms)
第 2 次失败 → 等 800ms + rand(0..250ms)   （上限 backoffMaxMs）
仍失败 → 换下一个候选（多池时天然失败转移）
```

重试**不消耗** `routing.maxAttempts` 的候选名额（那是换池的次数）。

### 3.4 流式首包缓冲（prelude）

免费站更阴的形态：**已经回了 200，然后 SSE 里发一个 error 事件**。这时客户端已经收到响应头，普通网关只能把错误原样转出去。

v3 的做法：流式响应**先不写响应头**，把前若干字节缓在内存里看：

- 看到 `event: error` / `data: {"error":...}` → 丢弃这次响应、**静默重试**（客户端什么都没收到）；
- 看到第一个正文事件（`choices[].delta`、`content_block_delta`、`response.output_text.delta` 等）→ 立刻把缓冲刷出去，之后字节流式透传；
- 等满 `resilience.preludeMs`（默认 2500ms）仍无正文也无错误 → 按正常流开始转发（保证慢上游不被卡）。

代价：只有 `flakyAuth` 池的流式请求，首字延迟最多多 `preludeMs`（实测首个正文事件通常 <300ms 就到达，所以基本不增加延迟）；普通池 `preludeMs = 0`，零成本。

> 实现要点：一旦 prelude 判定失败，必须给上游连接和事件回调打 `aborted` 标记，否则 `res.end()` 会把缓冲里的错误事件二次写进已经重试成功的响应里（这个坑是故障注入演示抓出来的，见 §5）。

### 3.5 200 里藏 error（非流式）

非流式响应体是 `{"error":{...}}` 但 HTTP 状态是 200 时，按 `transient_auth` 处理（重试），而不是把错误 JSON 当正常回复透传给客户端。

### 3.6 兜底：503 + `Retry-After`，永远不 401

重试用尽仍失败时，网关返回：

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 2
{ "error": { "type": "transient_auth", "retryable": true, ... } }
```

- **不是 401**：避免客户端（DSH/ Cherry Studio）把 key 判死、弹「密钥无效」；
- **503 + Retry-After**：告诉客户端「过几秒再来」，DSH 的模型重试会自然接住；
- 单 key 池冷却期间（没有别的候选）也不立刻 503：先等最多 ~600ms × 5 轮，能等到就正常服务。

## 4. 模型级错误的区分（顺手解决的真问题）

持续性的「假 401」其实是「这个模型要付费 key」。v3 会学习：

- 同一 `池 + 模型` 在 5 分钟内累计 2 次鉴权失败 → 记入 `providers[].modelBlocked`（默认屏蔽 10 分钟）；
- 之后该模型直接返回 **404 `model_unauthorized`**（非可重试），提示换 `-free` 模型；
- **key 不受影响**（不进 dead，也不会被反复重试）；
- 客户端请求**网关没配置过的模型** → 404 `model_not_found`，并附 `available_models` 列表（比原来的 503「没有可用上游」清楚得多）。

## 5. 验证

### 5.1 故障注入演示（`node scripts/demo-flaky.mjs`）

本地起一个「像 relay-free 一样 30% 概率假 401」的假上游，对比直连与走网关：

```
假上游故障率        : 30%
上游实际返回失败    : 43/130
直连失败率          : 33%   (40 次)
经网关 非流式失败率 : 0%    (40 次)
经网关 流式失败率   : 0%    (20 次)
网关内部重试吸收    : 30 次
客户端可见失败      : 0 次 / 60 请求
key 状态            : k1:active(transient=30)
```

> 这个演示在开发中真的抓出两个 bug：流式错误事件被 `end` 回调二次写出、单 key 冷却期直接 503。都已修。

### 5.2 自动化测试

| 测试 | 数量 | 覆盖 |
| --- | --- | --- |
| `node src/test.mjs` | **84 项** | 含 3 类假 401 吸收、SSE 首包错误、200 藏 error、耗尽后 503+Retry-After、模型级 404、key 不拉黑、`classifyStatus` 单元 |
| `node src/test-convert.mjs` | 57 项 | 协议转换（v2 能力，未受影响） |
| `node scripts/live-smoke.mjs` | 10 项 | 真实上游链路 |

### 5.3 真实链路（relay-free + relay-backup）

```
① 免费模型 dsv4.1:            200 "free-ok" 2.6s
② 未配置的付费模型:           404 model_not_found（附可用列表）
③ 完全未知模型:               404 model_not_found
④ relay-free key 状态:           active | 模型屏蔽: {}
```

## 6. 配置项

### 6.1 池级：让主用中转站排在前面

```json
{ "id": "relay-free", "priority": 100, "flakyAuth": true, ... },
{ "id": "relay-backup",  "priority": 10,  ... }
```

`providers[].priority`：数值越大越优先（默认 0）。选路完整顺序是：

```
① 透传优先于协议转换
② alias 的 priority 数组（模型级指定，精确控制）
③ 池级 priority（主用 100 > 备用 10 > 未配置 0）
④ key 打分（weight × health × 额度余量 × 负载）
```

只要 relay-free 有可用 key 且没在冷却，声明了该模型的请求就**必然**先给它；它整池不可用（disabled / key 全 dead / 模型被屏蔽）时才落到备用池。`/__admin/state` 里能看到每个池的 `priority` 和各 key 的 `dayRequests`，可据此确认流量确实落在主用池。

### 6.2 缓冲参数

`config.json` 顶层（`config.mjs` 有同样的默认值，不写也生效）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `resilience.retries` | `2` | 同一候选上额外重试次数（共 3 次机会）；**主用池建议 3~4**，本机 `config.json` 用 4 |
| `resilience.backoffMs` | `400` | 首次退避（本机配置 300） |
| `resilience.backoffMaxMs` | `2500` | 退避上限 |
| `resilience.jitterMs` | `250` | 随机抖动，避免多客户端同拍重试 |
| `resilience.flakyCooldownMs` | `2500` | key 进 `flaky` 态后冷却多久（服务端实际下限 200ms；本机 2000） |
| `resilience.preludeMs` | `2500` | 流式首包缓冲最长等多久 |
| `resilience.retryAfterSec` | `2` | 最终失败时回给客户端的 `Retry-After` |

> 重试只在 `flakyAuth` 池上生效（普通池 `retries` 视为 0），所以把 `retries` 调大不会让 relay-backup 这类正规池重复打上游。

池级：`"flakyAuth": true`（只对「不校验 key 的免费中转站」开；普通池别开，否则真密钥错误会被当瞬时故障反复重试）。

## 7. 客户端侧建议（DSH 等）

网关只能救「第一次请求就失败」的情况。**流式已经输出一半才断**的，只能靠客户端重试：

- 超时别设太短（免费站首 token 2~3s 很常见，给 60~120s）；
- 尊重 `Retry-After`（DSH 一般会自动重试 503/5xx）；
- 模型名用 `dsv4.1` / `deepseek-v4.1-flash-free`，别用非 `-free` 的（那要付费 key）；
- 若仍频繁「本轮运行失败」，先看 `/__admin/state` 的 `metrics.transient` 和 `byKind`，再判断是不是网关没救到（例如上游整体 5xx）。

## 8. 边界（救不了的情况）

| 情况 | 结果 | 说明 |
| --- | --- | --- |
| 模型要付费 key | 404 `model_unauthorized` | 换 `-free` 模型；重试无意义 |
| 上游长时间空转（>3 次重试仍 401） | 503 + Retry-After | 客户端几秒后重试通常就好 |
| 流式已输出部分内容后断开 | 客户端侧看到截断 | 网关无法「倒带」，只能靠客户端重试整轮 |
| 上游整体 5xx / 超时 | 照旧换候选，最后 502 | v3 不改变这部分语义 |
| 客户端把 503 当致命错误 | 仍报错 | 需要客户端支持重试；DSH 支持 |

## 9. 变更文件

| 文件 | 改动 |
| --- | --- |
| `src/upstream.mjs` | `TRANSIENT_AUTH_PATTERNS`、`looksTransientAuth`、`classifyStatus(...,{flakyAuth})`、`jsonErrorBody`、`looksErrorEvent`、`looksContentEvent` |
| `src/pool.mjs` | `flaky` 状态、`markTransient`、`nextFlakyWakeMs`、`markModelAuthFailure`/`isModelBlocked`/`blockedModelFor`/`knowsModel`、快照新增字段 |
| `src/server.mjs` | 同候选重试循环、流式 prelude 缓冲、200 藏 error、503+Retry-After、冷却等待、模型级 404、`metrics.transient` |
| `src/config.mjs` | `resilience` 默认值、`provider.flakyAuth` |
| `src/version.mjs` | `3.0.0` + 能力声明 |
| `src/test.mjs` | +18 项（假 401 / SSE 首包 / 200 藏 error / 503 / 模型 404 / 单元） |
| `scripts/demo-flaky.mjs` | 新增：故障注入对比演示 |
| `docs/08-v3-flaky-upstream.md` | 本文件 |
