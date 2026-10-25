# Free-Quota Relay Hub

[![ci](https://github.com/sbg694/Free-Quota-Relay-Hub/actions/workflows/ci.yml/badge.svg)](https://github.com/sbg694/Free-Quota-Relay-Hub/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022.5-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![deps](https://img.shields.io/badge/dependencies-0-brightgreen)](#零依赖)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> **FQRH** = **F**ree-**Q**uota **R**elay **H**ub

把散落在各家 API 中转站、官方免费层里的 key 与额度，收拢成**一个统一的 OpenAI 兼容出口**。你只需要改一行 `base_url`，剩下的选路、切换、转换、监控全部交给它。

零依赖，`git clone` 下来直接跑 —— **不需要 `npm install`**。

---

## 它解决什么问题

| 你现在的状态 | 用它之后 |
| --- | --- |
| 几十个 key 散在各家控制台，手动挑哪个能用 | 一个 `base_url`，池子自己按健康度和额度选 |
| 用完了 / 被限流了，得手动换 endpoint | 401 自动拉黑、429 冷却、额度见底自动避让，无感转移 |
| 上游接口格式不统一（chat / messages / responses 三种方言） | 三种协议互转，客户端用 OpenAI 格式，上游随便是什么 |
| 上游时不时返回一个假 401，一换 key 又好了 | `flakyAuth` 缓冲：同一 key 短期内失败几次才拉黑 |
| 炸了没人知道，等你发现已经断了半天 | 周期探活 + Webhook 告警，面板上一眼看清每个 key 的状态 |

---

## 特性

- **统一 OpenAI 兼容出口** — `/v1/chat/completions`、`/v1/models`，SSE 全流式，工具调用透传
- **跨协议转换** — `chat ⇄ messages ⇄ responses` 三种协议以统一中间表示互转，57 项单元测试覆盖
- **密钥池** — 打分选路、并发上限、权重、日额度、401 拉黑、429 冷却、探活失败转移
- **额度账本** — `node:sqlite` 单文件落库，按天统计用量，可出日报
- **健康探活** — 定时探测 + 失败阈值 + Webhook 告警（冷却时间防刷屏）
- **可写面板** — 内置单页面板，增删中转站、扫描模型、管理别名，改动即写回配置并热重载
- **局域网出口**（v4）— `0.0.0.0` 监听、多设备各自的 client key、可选 CORS，手机/平板/另一台电脑直接用
- **Linux 部署资产**（v4）— systemd 单元 + 一键安装脚本 + Dockerfile / compose

---

## 快速开始

### 1. 30 秒跑起来（自带假上游，不用真 key）

```bash
git clone https://github.com/sbg694/Free-Quota-Relay-Hub.git
cd Free-Quota-Relay-Hub
bash scripts/demo-mock.sh          # Windows: scripts\demo-mock.cmd
```

它会起两个进程：本地假上游（`127.0.0.1:8899`）和网关（`127.0.0.1:8790`），配置用的是 [`config.demo.json`](config.demo.json) —— 里面没有任何真实密钥。

### 2. 像调 OpenAI 一样调它

```bash
curl -s http://127.0.0.1:8790/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-fqrh-demo' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}],"stream":true}'
```

`gpt-4o-mini` 是 `config.demo.json` 里的一个**别名**，它会落到 `mock-model` 并指定走 `mock-openai` 这个上游。响应是标准的 OpenAI SSE 流，接你现有的 SDK 不用改代码。

### 3. 换成你自己的 key

```bash
cp config.example.json config.json
# 填 providers[].baseUrl / models / keys，和 clientKeys[].key
node src/server.mjs --config config.json
```

| | |
| --- | --- |
| 网关 | `http://127.0.0.1:8790/v1` |
| 面板 | `http://127.0.0.1:8790/__admin/dashboard` |
| 健康 | `http://127.0.0.1:8790/healthz` |

`config.json` 被 `.gitignore` 挡着，不会被提交。

---

## 接口

**对客户端（OpenAI 兼容）**

| 路径 | 说明 |
| --- | --- |
| `GET /v1/models` | 列出所有可用模型与别名 |
| `POST /v1/chat/completions` | 主入口，支持 `stream` |
| `GET /healthz`、`GET /metrics` | 健康检查 / 指标 |

**管理面板用的**

| 路径 | 说明 |
| --- | --- |
| `GET /__admin/dashboard` | 内置单页面板 |
| `GET /__admin/state` | 池子全量状态（key 健康度、额度、冷却） |
| `GET`/`POST /__admin/config`、`POST /__admin/reload` | 读配置 / 写配置 / 热重载 |
| `POST /__admin/probe`、`/__admin/probe-all` | 单个 / 全量探活 |
| `GET /__admin/alerts`、`POST /__admin/alert-test` | 告警历史 / 测试告警 |
| `POST /__admin/scan-models` | 扫上游支持哪些模型 |
| `POST /__admin/shutdown` | 优雅停机 |

---

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

> v2 没有独立快照 —— 当时是在同一份 `src/` 上增量改的，没留副本。它的能力在 `v3.1.4` 里有完整代码与文档（`CHANGELOG.md` 的 v2.0.0 一节）。

---

## 项目结构

```
src/
  server.mjs          网关主体：路由、鉴权、流式转发
  upstream.mjs        上游请求与失败重试
  pool.mjs            密钥池：打分、选路、冷却、拉黑
  monitor.mjs         周期探活与 Webhook 告警
  probe.mjs           单次探活实现
  db.mjs              node:sqlite 账本（用量、日报）
  config.mjs          配置加载 / 校验 / 热重载
  dashboard.html      内置单页面板
  convert/            chat ⇄ messages ⇄ responses 协议转换
  mock-upstream.mjs   假上游，测试与演示用
  test.mjs            网关集成自测（自带 mock 上游，离线）
  test-convert.mjs    协议转换单元自测
deploy/
  systemd/            fqrh.service + fqrh.env.example
  Dockerfile          多阶段构建
  docker-compose.yml  一键起容器
scripts/
  install-linux.sh    一键安装（systemd / 手动 / Docker 三选一）
  demo-mock.sh        假上游演示
docs/
  10-lan-access.md    局域网多设备接入
  11-linux-deploy.md  Linux 部署（systemd / Docker / 手动）
```

---

## 局域网与 Linux 部署

**局域网多设备**：`listen.host` 改成 `0.0.0.0`，给每台设备发一个 `clientKeys[].key`，手机 / 平板 / 另一台电脑的 `base_url` 填你这台机器的 IP。可选 CORS 用于网页端直连。详见 [docs/10-lan-access.md](docs/10-lan-access.md)。

**Linux 部署**：

```bash
sudo bash scripts/install-linux.sh        # systemd / 手动 / Docker 三选一
```

手动或 Docker 的细节见 [docs/11-linux-deploy.md](docs/11-linux-deploy.md)，也可直接看 [`deploy/`](deploy/systemd/fqrh.service) 下的单元文件与 Dockerfile。

---

## 测试

```bash
git checkout v4.0.4
node src/test-convert.mjs    # 57 项转换单元
node src/test.mjs            # 112 项网关集成（自带 mock 上游，离线可跑）
```

`v3.1.4` 是 57 + 109，`v1.0.0` 是 42。换 tag 后路径不变，`node src/test.mjs` 一直都在。

CI 在 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：跑单元 + 集成自测 + `bash -n` 校验 shell 脚本，最后起 mock 上游做一次 `/healthz` 冒烟。

---

## 合规

只做**自己 key 的额度聚合与故障转移**：不含批量注册、多账号轮换、转售等用途的代码或教程；不修改系统 hosts、不转发他人凭据。使用第三方中转站请遵守其服务条款。

---

## License

[MIT](LICENSE)
