# FQRH v1 · 免费额度中转枢纽

> **FQRH** = **F**ree-**Q**uota **R**elay **H**ub
> 把散落在各家 API 中转站 / 官方免费层里的 key 收拢起来，做成**一个 OpenAI 兼容出口**：密钥池、额度账本、健康探活、失败转移、管理面板。

这是 **v1（冻结版，2026-10-22）**：同协议透传、5 个端点、42 项离线自测 + 8 项真实冒烟。

- 协议：只做**同协议透传**（OpenAI chat / embeddings / images / models 等），不做跨协议转换
- 零依赖：只用 Node 内置模块（`fetch`、`node:sqlite`、`node:http`），`git clone` 完直接跑，**不需要 npm install**
- 后续版本：v2 加跨协议转换（chat ⇄ messages ⇄ responses）、v3 加"上游假鉴权失败缓冲"、v3.1 加面板可写 + 中转站管理/别名 + 一键 exe

## 快速开始

```bash
# 需要 Node.js >= 22.5（推荐 24，node:sqlite 在 22 上要加 --experimental-sqlite）
node --version

cp config.example.json config.json     # 然后按需改 providers / clientKeys
node src/server.mjs --config config.json
# 网关: http://127.0.0.1:8790/v1   客户端 key: 自己填的 clientKeys[].key
```

不想接真实上游时，用自带的假上游跑演示：

```bash
node src/mock-upstream.mjs --port 8899 &
node src/server.mjs --config config.demo.json &
curl http://127.0.0.1:8790/v1/chat/completions -H 'authorization: Bearer sk-fqrh-demo' \
  -H 'content-type: application/json' \
  -d '{"model":"mock-model","messages":[{"role":"user","content":"hi"}]}'
```

Windows 双击：`scripts/start-gateway.cmd`（网关）、`scripts/demo-mock.cmd`（假上游 + 网关）。

## 配置要点

```jsonc
{
  "clientKeys": [{ "id": "local", "key": "<客户端访问网关的 key>" }],
  "providers": [{
    "id": "relay-free",
    "baseUrl": "https://relay-free.example.com/v1",
    "protocol": "openai-completions",
    "endpoints": ["chat", "embeddings", "images"],
    "models": ["gpt-4o-mini"],
    "keys": [
      { "id": "k1", "env": "RELAY_KEY" },              // 推荐：环境变量
      { "id": "k2", "file": "data/keys/relay.txt" }    // 或密钥文件（已 gitignore）
    ]
  }]
}
```

**密钥永远别写进被跟踪的文件**：用 `env` 或 `file`，`config.json` / `data/` 已被 `.gitignore` 排除。客户端 key 只是本机门禁，不是上游密钥。

## 能力

| 能力 | 说明 |
| --- | --- |
| 密钥池 | 每个上游多 key，按 `weight × 健康 × 额度 × 负载` 打分选路 |
| 状态机 | `active / cooling / dead / exhausted / missing`，401 拉黑、429 冷却、额度耗尽停用 |
| 额度账本 | SQLite 记每日请求 / Token / 失败分类，`scripts/report.mjs` 出日报 |
| 探活 + 告警 | 定时打上游 `/models`，连续失败落库并推 Webhook（飞书/钉钉/Slack/generic） |
| 管理面板 | `/__admin/dashboard` 看池、key、账本、告警、最近请求 |
| 失败转移 | 候选内换 key / 换池，池级 403 不污染 key 状态 |

管理接口（都要带客户端 key）：`GET /__admin/state`、`GET /__admin/alerts`、`POST /__admin/probe-all`。

## 目录

```
src/       网关源码（server / pool / upstream / config / db / monitor / probe / mock）
scripts/   启动脚本、真实链路冒烟、日报
config.example.json   配置模板（无密钥）
```

## 测试

```bash
node src/test.mjs        # 42 项离线集成自测（自带 mock 上游，不联网）
node scripts/live-smoke.mjs   # 可选：打真实上游（需要先配好 config.json）
```

## 合规声明

本项目只做**自己 key 的额度聚合与故障转移**，不含批量注册、多账号轮换、转售等用途的代码或教程。使用第三方中转站请遵守其服务条款；请勿用它绕过任何服务商的限制。详见仓库内安全与合规说明。

## License

MIT
