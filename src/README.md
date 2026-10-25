# src/ · FQRH v3 网关（零依赖）

Node 24 自带 `fetch` / `node:sqlite` / `node:http`，**不需要 npm install**。
v1 快照在 v1 冻结快照（独立仓库 fqrh-v1），本目录是 **v3** 主线（v2 协议转换 + v3 假鉴权缓冲）。

## 文件

| 文件 | 职责 |
| --- | --- |
| `server.mjs` | HTTP 入口：5 端点 + `/v1/models` + `/healthz` + `/metrics` + `/__admin/*`；v3 的重试循环 / 流式 prelude / 503 兜底也在这里 |
| `convert/index.mjs` | 协议转换调度：规范中间表示、流式桥、错误体格式化 |
| `convert/chat.mjs` `messages.mjs` `responses.mjs` | 三种协议 ⇄ 规范中间表示（请求/响应/流式各一份） |
| `convert/sse.mjs` | SSE 解析与序列化 |
| `pool.mjs` | 池/key 状态机（含 v3 `flaky` 态）、打分、端点规划（透传优先）、rpm+tpm 令牌桶、模型级屏蔽 |
| `upstream.mjs` | 头构造、hop-by-hop 与客户端凭据过滤、直连/CONNECT、用量解析、v3 错误分类（`transient_auth` 等） |
| `probe.mjs` | 探活——复用业务同一套头与传输 |
| `monitor.mjs` | M4 运维面：定时探活、连续失败判定、告警落库 + Webhook 推送 |
| `dashboard.html` | 管理面板（单文件，无构建，5s 轮询；v3.1 起可写配置） |
| `config.mjs` | 配置加载、protocol 归一化、密钥 file/env 解析、`resilience` 默认值 |
| `db.mjs` | SQLite 账本（WAL + 轻量迁移，含 alerts 表） |
| `version.mjs` | 版本与能力矩阵（v3.0.0） |
| `test.mjs` | **93 项**网关集成自测（含跨协议、运维面、v3 假 401 缓冲、面板写操作/热重载） |
| `test-convert.mjs` | 57 项转换单元自测（含 4 组流式桥、2 组流式工具调用） |
| `mock-upstream.mjs` | 演示假上游 |

## 跑起来

```powershell
node src\server.mjs --config config.json        # → http://127.0.0.1:8790
# 面板：http://127.0.0.1:8790/__admin/dashboard
node src\test-convert.mjs                       # 57 项
node src\test.mjs                               # 84 项
node ..\scripts\demo-flaky.mjs                  # v3 故障注入演示（30% 假 401）
node ..\scripts\live-smoke.mjs                  # 10 项真实链路
```

## 协议转换怎么用

不用额外配置：只要池里写了 `endpoints`，网关自动判断能不能转。

```json
{ "id": "some-pool", "baseUrl": "https://…/v1", "protocol": "chat",
  "endpoints": ["chat"], "models": ["grok-4.5"],
  "modelMap": { "gpt-4o-mini": "grok-chat-fast" } }
```

- 客户端发 `/v1/messages` → 网关自动按 chat 协议发上游，再把响应转回 anthropic 结构（`x-fqrh-convert: messages:chat`）
- 客户端发 `/v1/chat/completions` → 池只有 anthropic 时反过来转
- 流式同样适用（SSE 事件重编码）
- 想先看转换结果：`POST /__admin/convert-preview {"from":"chat","to":"messages","payload":{…}}`

## v3 抗抖动怎么用

给「不校验 key 的免费中转站」加 `"flakyAuth": true`，并保留 `resilience` 默认配置即可：

```json
{ "id": "relay-free", "baseUrl": "https://relay-free.example.com/v1", "protocol": "chat",
  "endpoints": ["chat","messages","responses"], "flakyAuth": true, "priority": 100,
  "models": ["deepseek-v4.1-flash-free"], "keys": [{ "id": "public", "value": "public" }] }
```

- `priority` 越大越优先（备用池给 `10` 或不写）；重试次数 `resilience.retries` 只作用于 `flakyAuth` 池

- 上游 401/403（假密钥无效）→ `transient_auth` → 同候选重试 + key 进 `flaky` 短冷却（**不拉黑**）
- 流式「200 + SSE error」→ 首包缓冲到确认正文才发，错误在客户端无感的情况下重试
- 重试耗尽 → **503 + `Retry-After`**（不是 401）；`/metrics` 的 `fqrh_transient_retries` 计数
- 同一模型反复鉴权失败 → 学习成 404 `model_unauthorized`（提示换 `-free` 模型），key 不受影响

## 面板写操作 / 配置热重载（v3.1）

| 接口 | 作用 |
| --- | --- |
| `GET /__admin/config` | 脱敏配置视图（客户端 key 掩码、上游 key 只给 hasValue/env/file） |
| `POST /__admin/config` | 按池 patch 配置 → 备份 `config.json.bak` → 写盘 → 热重载（重建池 + monitor） |
| `POST /__admin/reload` | 手工改过 config.json 后强制重读 |

面板「常用操作」区即调用这几个接口：切主用池（priority）、启停池、改上游 key、改客户端 key、调 `resilience`。改完不需要重启进程。

## 已知边界

- 图片：base64/data-url 互转 OK；远程 URL 依赖上游自己抓
- `thinking` / `reasoning` 块丢弃（不转发，避免客户端不识别）
- responses 没有 `stop_sequences` 概念，转过去会丢
- 转换不保证字段级等价（`seed`、`response_format` 等可能丢）
- 单进程；面板是只读轮询页，无前端构建、无 WebSocket
- 告警只通知、不自动改池状态（自动禁用会影响在跑的流量）
- v3 只能救「首字节前」的失败；流式已输出一半再断只能靠客户端重试整轮
