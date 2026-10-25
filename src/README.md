# src/ · FQRH 网关（零依赖）

Node 24 自带 `fetch` / `node:sqlite` / `node:http`，因此**不需要 npm install**。

| 文件 | 职责 |
| --- | --- |
| `server.mjs` | HTTP 入口：5 个推理端点 + `/v1/models` + `/healthz` + `/metrics` + `/__admin/*` |
| `pool.mjs` | 池 / key 状态机（active/cooling/dead/exhausted）、打分、候选排序、rpm 令牌桶、日额度滚动 |
| `upstream.mjs` | 头构造（协议头 → profile → 池级头）、hop-by-hop 与**客户端凭据头**过滤、直连/CONNECT、SSE 用量解析 |
| `probe.mjs` | 探活——**刻意复用** `buildHeaders` + `requestUpstream`，避免「探活通、业务不通」 |
| `config.mjs` | 读 `config.json`、解析 `file`/`env` 密钥、端点/协议映射、告警 |
| `db.mjs` | SQLite 账本：`request_logs` + `quota_daily`（WAL，含轻量迁移） |
| `test.mjs` | 42 项离线自测（mock 上游，不花钱） |
| `mock-upstream.mjs` | 演示用假上游，会打印收到的 UA，肉眼确认改头是否生效 |

## 端点

| 客户端调用 | 上游路径 | 鉴权 |
| --- | --- | --- |
| `POST /v1/chat/completions` | `/chat/completions` | Bearer |
| `POST /v1/messages` | `/messages` | `x-api-key` + `anthropic-version` |
| `POST /v1/responses` | `/responses` | Bearer |
| `POST /v1/embeddings` | `/embeddings` | Bearer |
| `POST /v1/images/generations` | `/images/generations` | Bearer |
| `GET /v1/models` | 本地汇总 | — |

池是否接受某端点由 `providers[].endpoints` 决定；不接受时回 **503 no_candidate**，不打上游。

## 跑起来

```powershell
cd .
node src\server.mjs --config config.json       # → http://127.0.0.1:8790
node src\test.mjs                              # 离线自测 42 项
node scripts\live-smoke.mjs                    # 真实链路冒烟 8 项
node scripts\report.mjs                        # 今日账本
```

也可以用 `scripts\demo-mock.cmd` 起假上游演示（不花钱、不碰外网）。

## 配置要点

- 密钥**不要**写进 `config.json`：用 `{"file":"data/keys/xxx.txt"}`（gitignored）或 `{"env":"VAR"}`。
- `providers[].endpoints`：`chat` / `messages` / `responses` / `embeddings` / `images`，默认按 protocol 推导。
- `providers[].rpm`：0 = 不限；限速超时会短暂排队（`routing.maxRateWaitMs`）后换候选。
- `providers[].headersProfile`：`none` / `claude-cli` / `codex` / `custom`（伪装身份默认关闭，开启风险自负）。
- 客户端带来的 `authorization` / `x-api-key` / `x-goog-api-key` / `cookie` **一律丢弃**，密钥只从池里取。

## 已知边界

- 同协议透传，**不做协议转换**（客户端 anthropic 而池只有 openai → 请等 M3.5）。
- `tpm` 限速未做；单进程；管理端只有 REST，无面板。
