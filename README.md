# Free-Quota Relay Hub

> **FQRH** = **F**ree-**Q**uota **R**elay **H**ub
> 把散落在各家 API 中转站 / 官方免费层里的 key 与额度收拢成**一个统一的 OpenAI 兼容出口**：密钥池、额度账本、健康探活、失败转移、跨协议转换、可写面板。

零依赖：只用 Node 内置模块（`fetch`、`node:sqlite`、`node:http`），`git clone` 完直接 `node src/server.mjs`，**不需要 npm install**。

## 一个仓库，三个版本

本仓库用「**每个版本一个完整快照提交 + tag**」存放三个版本。`main` 上是最新的 v4，往前翻一个提交就能取到 v3 和 v1：

| 版本 | tag | 定位 | 自测 |
| --- | --- | --- | --- |
| v1.0.0 | [`v1.0.0`](https://github.com/sbg694/Free-Quota-Relay-Hub/tree/v1.0.0) | 最小可用：同协议透传、密钥池、额度账本、探活告警 | 42 项 |
| v3.1.4 | [`v3.1.4`](https://github.com/sbg694/Free-Quota-Relay-Hub/tree/v3.1.4) | 主线：跨协议转换 + 假 401 缓冲 + 可写面板 + 一键 exe | 57 + 109 项 |
| **v4.0.4** | [`v4.0.4`](https://github.com/sbg694/Free-Quota-Relay-Hub/tree/v4.0.4) | **当前版（main）**：局域网统一出口 + Linux 部署 | 57 + 112 项 |

取某个版本：

```bash
git clone https://github.com/sbg694/Free-Quota-Relay-Hub.git
cd Free-Quota-Relay-Hub

git checkout v1.0.0     # v1 快照
git checkout v3.1.4     # v3.1 快照
git checkout v4.0.4     # v4 快照（= main，只少一个根 README）

# 或者只要一版、不带历史：
git clone --depth 1 --branch v1.0.0 https://github.com/sbg694/Free-Quota-Relay-Hub.git fqrh-v1
```

三个 tag 各自带一份 CI 配置，推送 tag 时会按**那一版**的测试跑，互不影响。

## 快速开始（当前版 v4）

```bash
# 需要 Node.js >= 22.5（推荐 24；node:sqlite 在 22 上要加 --experimental-sqlite）
cp config.example.json config.json      # 填 providers[].baseUrl / models / keys 与 clientKeys[].key
node src/server.mjs --config config.json

# 网关    http://127.0.0.1:8790/v1
# 面板    http://127.0.0.1:8790/__admin/dashboard
```

Linux 部署（systemd / Docker / 手动）：`sudo bash scripts/install-linux.sh`，详见 [docs/11-linux-deploy.md](docs/11-linux-deploy.md)；局域网多设备接入见 [docs/10-lan-access.md](docs/10-lan-access.md)。

## 三版的差异

| 能力 | v1 | v3.1 | v4 |
| --- | :---: | :---: | :---: |
| 统一 OpenAI 兼容出口 + SSE 流式 | ✅ | ✅ | ✅ |
| 密钥池打分选路、401 拉黑 / 429 冷却 | ✅ | ✅ | ✅ |
| 额度账本 + 日报 | ✅ | ✅ | ✅ |
| 探活 + Webhook 告警 | ✅ | ✅ | ✅ |
| 跨协议转换 chat ⇄ messages ⇄ responses | — | ✅ | ✅ |
| 上游假 401 缓冲（`flakyAuth`） | — | ✅ | ✅ |
| 可写面板 + 配置热重载 | — | ✅ | ✅ |
| 中转站增删 / 扫描模型 / 别名管理 | — | ✅ | ✅ |
| 局域网出口（`0.0.0.0` + 多设备 key + CORS） | — | — | ✅ |
| Linux 部署资产（systemd / Docker） | — | — | ✅ |

## 测试

```bash
git checkout v4.0.4
node src/test-convert.mjs    # 57 项转换单元
node src/test.mjs            # 112 项网关集成（自带 mock 上游，离线）
```

`v3.1.4` 是 57 + 109，`v1.0.0` 是 42。换 tag 后 `node src/test.mjs` 的路径不变。

## 合规

只做**自己 key 的额度聚合与故障转移**，不含批量注册、多账号轮换、转售等用途的代码或教程；不修改系统 hosts、不转发他人凭据。使用第三方中转站请遵守其服务条款。

## License

MIT