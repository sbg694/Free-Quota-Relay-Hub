# FQRH · 免费额度中转枢纽

> **FQRH** = **F**ree-**Q**uota **R**elay **H**ub
> 把散落在各家 API 中转站 / 官方免费层里的 key 与额度收拢成一个**统一的 OpenAI 兼容出口**：密钥池、额度账本、健康探活、失败转移、跨协议转换、可写面板。

零依赖：只用 Node 内置模块（`fetch`、`node:sqlite`、`node:http`），`git clone` 完直接 `node src/server.mjs`，**不需要 npm install**。

## 为什么需要它

免费中转站/免费层常见两个坑：

1. **多个站、多个 key 分散**，额度各自过期，客户端要手工换 base_url 和 key
2. **上游抽风**：明明 key 没问题，却间歇性返回 `401 API 密钥无效`（共享 key 池空转的伪装），客户端直接报错

FQRH 把 1 收拢成一个出口，把 2 用「假鉴权错误缓冲」吃掉：对声明了 `flakyAuth` 的池，假 401 会被分类成 `transient_auth`，换候选/退避重试，重试耗尽也只回 `503 + Retry-After`（让客户端自然重试），**绝不把「上游抽风」透传成「你的密钥无效」**。

## 特性

| 特性 | 说明 |
| --- | --- |
| 统一出口 | 客户端只认 `http://127.0.0.1:8790/v1` + 一个本地 key |
| 密钥池 | 每池多 key，按 `weight × 健康 × 额度 × 负载` 打分选路；`active/cooling/dead/exhausted/missing/flaky` 状态机 |
| 跨协议转换 | 按池声明能力（不需要手工配置），endpoint 级选路 / 模型级选路两种粒度 |
| 假 401 缓冲 | 同候选重试 + 退避抖动 + 流式首包缓冲 + 200 内嵌 error 识别 + 模型级错误学习 |
| 额度账本 | SQLite 记每日请求/Token/失败分类；`GET /metrics` Prometheus 指标 |
| 探活 + 告警 | 定时探上游、连续失败落库、Webhook 推送（飞书/钉钉/Slack/generic） |
| 可写面板 | 浏览器里换主用池、启停池、改 key、调参数，**保存即热重载，不用重启** |
| 一键 exe | `FQRH-hub.exe` 控制台菜单：起网关 / 开面板 / 跑自测 / 探活 / 日报 |

## 快速开始

```bash
# Node.js >= 22.5（推荐 24）
cp config.example.json config.json
# 编辑 config.json：填 providers[].baseUrl / models / keys，以及 clientKeys[].key
node src/server.mjs --config config.json
```

然后用任意 OpenAI 兼容客户端：

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H 'authorization: Bearer <你的 clientKeys[].key>' \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

演示（自带假上游，不需要真实 key）：

```bash
node src/mock-upstream.mjs --port 8899 &
node src/server.mjs --config config.demo.json &
# 面板：http://127.0.0.1:8790/__admin/dashboard
```

Windows：双击 `scripts/start-gateway.cmd`；或先 `tools/build-exe.cmd` 编出 `FQRH-hub.exe` 再双击。

## 配置

```jsonc
{
  "listen": { "host": "127.0.0.1", "port": 8790 },
  "clientKeys": [{ "id": "local", "key": "<客户端访问网关用的 key>" }],
  "resilience": { "retries": 4, "backoffMs": 300, "preludeMs": 2500, "retryAfterSec": 2 },
  "providers": [{
    "id": "relay-free",
    "baseUrl": "https://relay-free.example.com/v1",
    "protocol": "chat",                 // chat | messages | responses
    "endpoints": ["chat", "messages", "responses"],
    "models": ["deepseek-v4.1-flash-free"],
    "priority": 100,                     // 主用 > 备用 > 默认 0
    "flakyAuth": true,                   // 该上游鉴权错误不可信 → 启用缓冲
    "keys": [
      { "id": "public", "value": "public" },          // 公共 key（若上游不校验）
      { "id": "k2", "env": "RELAY_API_KEY" },          // 推荐：环境变量
      { "id": "k3", "file": "data/keys/relay.txt" }    // 或密钥文件（已 gitignore）
    ]
  }]
}
```

**别把密钥写进被跟踪的文件**：用 `env` / `file`；`config.json`、`config.json.bak`、`data/` 都在 `.gitignore` 里。

## 管理面板

`http://127.0.0.1:8790/__admin/dashboard`（带 `?key=<客户端key>` 自动登录）。

- 只读：池/key 状态、今日账本、失败分类、告警、最近请求（5s 自动刷新，时间按本机时区）
- 可写：主用池优先级、池启停、上游 key、客户端 key、缓冲参数、从磁盘重载
- 中转站管理：增删官方提供商、扫描上游模型；别名管理：增删别名，删提供商时自动清理悬空别名
- 写操作会先备份 `config.json.bak` 再热重载；配置视图对 key 脱敏

## 接口

| 接口 | 说明 |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI chat（支持流式） |
| `POST /v1/messages` | Anthropic messages（原生或自动转换） |
| `POST /v1/responses` | OpenAI responses（原生或自动转换） |
| `GET /v1/models` | 只列已声明模型 |
| `GET /healthz` / `GET /metrics` | 健康检查 / Prometheus |
| `GET /__admin/state` `/alerts` `/config` | 运维与配置视图 |
| `POST /__admin/probe-all` `/config` `/reload` | 探活 / 写配置 / 热重载 |

## 目录

```
src/            网关（server / pool / upstream / config / db / monitor / probe / mock）
src/convert/    协议转换（chat / messages / responses / sse）
src/dashboard.html  单文件面板
scripts/        启动、真实冒烟、故障注入演示、日报
tools/          FQRH-hub.exe 源码与编译脚本
docs/           设计、协议转换、运维、假 401 缓冲、GUI
```

## 测试

```bash
node src/test-convert.mjs   # 57 项转换单元测试
node src/test.mjs           # 109 项网关集成测试（自带 mock 上游，离线）
node scripts/demo-flaky.mjs # 故障注入演示：30% 假 401 的上游，直连会失败，经网关 0 失败
```

## 版本

| 版本 | 内容 |
| --- | --- |
| v1 | 同协议透传、密钥池、账本、探活 |
| v2 | 跨协议转换（chat ⇄ messages ⇄ responses）、tpm、modelMap、面板/探活/告警 |
| v3 | 假鉴权错误缓冲、流式首包缓冲、503 兜底、模型级错误学习、池级 priority |
| v3.1 | 面板可写 + 配置热重载 + 一键 exe + 本地时区口径 + 中转站管理/扫描模型 |
| v3.1.4 | 别名管理 + 悬空别名自动清理（删提供商时同步清理） |

详见 [CHANGELOG.md](CHANGELOG.md)。

## 合规声明

本项目只做**自己 key 的额度聚合与故障转移**，不包含批量注册、多账号轮换、转售等用途的代码或教程；不修改系统 hosts、不转发他人凭据。使用第三方中转站请遵守其服务条款。详见 [docs/04-risks-and-compliance.md](docs/04-risks-and-compliance.md)。

## License

MIT
