# FQRH v4 · 局域网中转

**FQRH v4** 是从 v3.1 克隆出来的**独立版本**，目标只有一个：把这台机器变成**局域网内所有设备的统一 AI 出口**。

- 手机 / 平板 / 另一台电脑 / 家里的服务，都只填 `http://<本机局域网IP>:8790/v1` + 一个 key
- 一台设备一个 key，单独吊销互不影响
- 保留了 v3.1 的全部能力：协议转换、假 401 缓冲、密钥池、账本、探活告警、可写面板、别名管理
- 相比 v3.1：默认监听 `0.0.0.0`、启动打印局域网入口、可选 CORS、`POST /__admin/shutdown`

> 独立仓库：`git clone` 后 `cp config.example.json config.json` 即可运行；零依赖，只需要 Node 22.5+（推荐 24）。

## 快速开始

```bash
cp config.example.json config.json     # 首次；之后按需改 providers / clientKeys
node src/server.mjs --config config.json
```

**Linux 部署**（systemd / Docker / 手动三种方式，含防火墙与 HTTPS 反代）：

```bash
sudo bash scripts/install-linux.sh     # 一键装成 systemd 服务（推荐）
# 或手动：bash scripts/start-gateway.sh
# 或容器：docker compose -f deploy/docker-compose.yml up -d --build
```

详见 [docs/11-linux-deploy.md](docs/11-linux-deploy.md)。Windows 直接双击 `scripts/start-gateway.cmd`。

启动日志会直接列出局域网入口：

```
FQRH v4.0.4 (conversion 6 pairs, LAN relay, transient-fault buffering)
[fqrh] listening on 0.0.0.0:8790（所有网卡，局域网可访问）
[fqrh]   局域网入口 http://192.168.1.23:8790/v1   （面板 http://192.168.1.23:8790/__admin/dashboard）
[fqrh]   本机入口   http://127.0.0.1:8790/v1
```

任何设备（OpenAI 兼容客户端）填：

| 字段 | 值 |
| --- | --- |
| Base URL | `http://192.168.1.23:8790/v1` |
| API Key | `clientKeys[]` 里给这台设备的那一条 |
| 模型 | `dsv4.1`（= `deepseek-v4.1-flash`，上游自动映射到 `-free`）或 `gpt-4o-mini` |

## 配置要点

```jsonc
{
  "listen": { "host": "0.0.0.0", "port": 8790 },     // 0.0.0.0 = 局域网可访问
  "cors": { "enabled": false, "allowOrigins": [] },  // 浏览器 Web UI 才需要开
  "clientKeys": [
    { "id": "pc",    "key": "sk-fqrh-<自己编>", "note": "台式机" },
    { "id": "phone", "key": "sk-fqrh-<另一串>", "note": "手机" }
  ],
  "aliases": {
    "dsv4.1": { "model": "deepseek-v4.1-flash", "priority": ["relay-free"] }
  },
  "providers": [{
    "id": "relay-free",
    "baseUrl": "https://relay-free.example.com/v1",
    "models": ["deepseek-v4.1-flash-free", "deepseek-v4.1-flash"],
    "modelMap": { "deepseek-v4.1-flash": "deepseek-v4.1-flash-free" },  // 规范名 → 上游真实名
    "priority": 100,
    "flakyAuth": true,
    "keys": [{ "id": "k1", "env": "RELAY_API_KEY" }]                     // 或 data/keys/*.txt
  }]
}
```

**密钥永远别写进被跟踪的文件**：用 `env` 或 `file`；`config.json`、`config.json.bak`、`data/` 都在 `.gitignore` 里。

## 局域网注意事项

1. **防火墙**：Windows 默认挡入站，放行 8790 端口（详见 [docs/10-lan-access.md](docs/10-lan-access.md) §5）
2. **只给内网**：不要把端口映射到公网；远程用 VPN
3. **浏览器客户端**：需要开 `cors`，`allowOrigins` 写具体源，别写 `*`
4. **面板 = 管理员权限**：能改 key、切主用池、关停进程，手机别长期存
5. **关停**：`POST /__admin/shutdown`（带客户端 key），或 Ctrl+C

## 测试

```bash
node src/test-convert.mjs   # 57 项协议转换单测
node src/test.mjs           # 112 项网关集成（含 CORS 3 项、别名管理 3 项；自带 mock 上游，离线）
node scripts/demo-flaky.mjs # 故障注入演示：30% 假 401 的上游
```

## 目录

```
src/            网关（server / pool / upstream / config / db / monitor / probe / mock）
src/convert/    协议转换（chat / messages / responses / sse）
src/dashboard.html  单文件面板（可写：切池、改 key、调参数，保存即热重载）
scripts/        启动脚本（Windows .cmd + Linux .sh）、安装脚本、真实冒烟、日报
deploy/         systemd 单元 + env 模板 + Dockerfile + docker-compose
docs/10-lan-access.md   局域网接入指南（设备填法、防火墙、CORS、安全边界）
docs/11-linux-deploy.md Linux 部署指南（systemd/Docker/HTTPS/运维/排错）
config.example.json     配置模板（0.0.0.0 + 无密钥）
config.demo.json        纯演示（本地假上游，无需真实 key）
```

## 与其他版本

| 版本 | 定位 |
| --- | --- |
| v1 | 最小可用：同协议透传、密钥池、账本、探活 |
| v3.1 | 主线：跨协议转换 + 假 401 缓冲 + 可写面板 + 一键 exe |
| **v4** | **v3.1 的局域网克隆**：0.0.0.0、局域网入口、CORS、多设备 key |

## 合规

只做自己 key 的额度聚合与故障转移；不含批量注册、多账号轮换、转售等用途。使用第三方中转站请遵守其服务条款。
