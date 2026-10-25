# v4 · 局域网中转（LAN Relay）

v4 是 v3.1 的**独立克隆**，唯一目标：让这台机器变成**局域网内所有设备的统一 AI 出口**。
手机、平板、另一台电脑、电视盒子、家里其他服务，都只填一个地址 + 一个 key，不用各自配中转站。

## 与 v3.1 的差异

| 项 | v3.1 | v4 |
| --- | --- | --- |
| 默认监听 | `127.0.0.1`（仅本机） | `0.0.0.0`（所有网卡） |
| 启动日志 | 本机地址 | 每个网卡的局域网入口（含面板地址） |
| 跨域（浏览器客户端） | 无 | `cors` 配置：`enabled` + `allowOrigins` |
| 优雅关停 | Ctrl+C / 杀进程 | 额外 `POST /__admin/shutdown` |
| 版本号 | 3.1.0 | 4.0.0 |
| 代码 | `src/`（主项目） | `src/`（本仓库） |

> v4 自带 `src/`、`scripts/`、`config*.json`、`data/`，不依赖主项目，可以整个目录拷到别的机器跑。

## 1. 配置

```jsonc
{
  "listen": { "host": "0.0.0.0", "port": 8790 },
  "cors": { "enabled": false, "allowOrigins": [] },   // 见 §4
  "clientKeys": [
    { "id": "pc",     "key": "sk-fqrh-<自己编>", "note": "台式机" },
    { "id": "phone",  "key": "sk-fqrh-<另一串>", "note": "手机" },
    { "id": "tablet", "key": "sk-fqrh-<第三串>", "note": "平板" }
  ]
}
```

- **一台设备一个 key**：便于单独吊销、看日志时知道是谁在用；`__admin/state` 里 `clientKeys` 只存本机，不会转发给上游
- 上游 key 仍按原方式：`env` 或 `data/keys/*.txt`，**不要写进被 git 跟踪的文件**
- 监听 `0.0.0.0` 后，`/__admin/*`（面板、写配置、关停）也从局域网可达，靠 `clientKeys` 拦；不要把 `clientKeys` 设成空

## 2. 启动

```bash
cd fqrh-v4
node src/server.mjs --config config.json
```

启动日志会列出所有可用入口，例如：

```
FQRH v4.0.0 (conversion 6 pairs, LAN relay, transient-fault buffering)
[fqrh] listening on 0.0.0.0:8790（所有网卡，局域网可访问）
[fqrh]   局域网入口 http://192.168.1.23:8790/v1   （面板 http://192.168.1.23:8790/__admin/dashboard）
[fqrh]   本机入口   http://127.0.0.1:8790/v1
```

Windows 也可双击 `scripts/start-gateway.cmd`（用 v4 目录里的这份）。

## 3. 设备侧接入

统一三要素：**Base URL** = `http://<笔记本局域网IP>:8790/v1`，**API Key** = 该设备对应的 `clientKeys[].key`，**模型** = `dsv4.1`（= `deepseek-v4.1-flash`，上游自动映射到 `-free`）或 `gpt-4o-mini`。

| 设备/工具 | 填法 |
| --- | --- |
| Cherry Studio / ChatBox / NextChat | 自定义 OpenAI：Base URL 上面那个，Key 填自己的，模型选 `dsv4.1` |
| Cline / Continue / Roo | OpenAI Compatible，同上 |
| Python `openai` SDK | `OpenAI(base_url="http://192.168.1.23:8790/v1", api_key="sk-...")` |
| curl（手机 Termux） | `curl http://192.168.1.23:8790/v1/chat/completions -H 'authorization: Bearer sk-...' -H 'content-type: application/json' -d '{"model":"dsv4.1","messages":[{"role":"user","content":"hi"}]}'` |
| 浏览器里的 Web UI（LibreChat 等） | 需要开 CORS，见 §4 |

面板：`http://<IP>:8790/__admin/dashboard?key=<你的key>`，手机上也能打开。

## 4. 浏览器客户端要开 CORS

浏览器里的网页版聊天工具受同源策略限制，直连本机会被浏览器拦。开法：

```jsonc
"cors": { "enabled": true, "allowOrigins": ["http://192.168.1.23:3000"] }
```

- `allowOrigins` 写**具体源**（协议+host+端口），不要图省事写 `["*"]`——那等于允许局域网里任何网页拿你的 key 打网关
- 改完不用重启：面板「从磁盘重载」或 `POST /__admin/reload`
- 预检（OPTIONS）返回 204，并回显允许的 `Access-Control-Allow-Origin`

## 5. Windows 防火墙

默认可能挡住其他设备的入站连接。放行方式（管理员 PowerShell，二选一）：

```powershell
# A. 只放行端口
New-NetFirewallRule -DisplayName "FQRH gateway 8790" -Direction Inbound -Protocol TCP -LocalPort 8790 -Action Allow -Profile Private

# B. 只放行 node.exe（更窄）
New-NetFirewallRule -DisplayName "FQRH node" -Direction Inbound -Program "C:\Program Files\nodejs\node.exe" -Action Allow -Profile Private
```

建议 `-Profile Private`（家里/公司内网），不要对 `Public` 开。用的是 Radmin/ZeroTier 之类的虚拟网卡时，确认对应的网络配置是 Private。

## 6. 安全边界（重要）

- **只给局域网用**：不要把 8790 端口映射到公网、不要放到 DMZ；需要远程用就上 VPN（WireGuard/Tailscale）而不是直接暴露
- **每设备独立 key**：设备丢了/卖了就删掉那一条，其它设备不受影响
- **面板等于管理员权限**：面板能改 key、切主用池、关停进程。手机浏览器别长期存 key
- **HTTP 明文**：局域网内可以接受；跨不可信网络请走 VPN 或前置 HTTPS 反代
- **代理池合规**：v4 只转发你自己的 key / 免注册公共 key，不做批量注册、多账号轮换、转售

## 7. 故障排查

| 现象 | 排查 |
| --- | --- |
| 手机连不上 | 手机和电脑在同一网段？`listen.host` 是否 `0.0.0.0`？Windows 防火墙放行了吗（§5）？用另一台电脑 `curl http://<IP>:8790/healthz` 测 |
| 面板 401 | 地址要带 `?key=`，或先在本机打开面板填 key（存 localStorage） |
| 浏览器客户端报 CORS | 按 §4 开 `cors`，`allowOrigins` 写它页面实际的源 |
| 网页能打开但请求超时 | 电脑休眠/睡眠会导致网关挂起；插电并关闭睡眠，或用计划任务开机自启 |
| 只有 127.0.0.1 能通 | 多半是防火墙，或 `listen.host` 还是 `127.0.0.1`（v4 的示例配置已改为 `0.0.0.0`） |
| 关不掉进程 | v4 新增 `POST /__admin/shutdown`（带 key）：`curl -X POST http://127.0.0.1:8790/__admin/shutdown -H 'authorization: Bearer sk-...'` |

## 8. 验证记录（2026-10-23）

| 检查 | 结果 |
| --- | --- |
| v4 转换单测 | 57 通过 |
| v4 网关集成 | **98 通过**（v3.1 的 95 + CORS 3） |
| 监听 | `0.0.0.0:8791`，日志打印 4 个网卡的局域网入口 |
| 局域网访问 | `http://192.168.1.23:8790/healthz` → v4.0.0 OK；`/v1/models` 正常 |
| 局域网中转 | 经局域网 IP 请求演示上游 → 200；面板 200（17KB） |
| CORS | 允许源预检 204 + 回显 ACAO；未允许源不回显 |
| 真实上游 | `deepseek-v4.1-flash` → 上游 `deepseek-v4.1-flash-free`（modelMap 生效） |
