# v4 · Linux 部署

目标：把 v4 跑在 Linux 上，给局域网所有设备当统一 AI 出口。
三种方式任选：**systemd（推荐）**、前台手动、Docker。

> 前提：Node.js **24**（推荐）或 **22.5+**。Linux 上 `node:sqlite` 在 Node 22 需要 `--experimental-sqlite`，安装脚本会自动加；Node 24 不需要。

## 0. 前置检查

```bash
node -v                    # 需要 v22.5+ / v24
command -v systemctl       # systemd 系统
ip -4 addr show | grep inet   # 记下局域网 IP，例如 192.168.1.23
sudo ss -lntp | grep 8790  # 端口是否被占
```

把项目目录传到 Linux（任选）：

```bash
# 方式 A：从开源仓库
git clone <你的仓库> fqrh-v4 && cd fqrh-v4
# 方式 B：从 Windows 拷贝（scp/rsync）
scp -r fqrh-v4 user@linux:/opt/fqrh-src
```

## 1. 方式一：systemd 一键部署（推荐）

```bash
cd /path/to/fqrh-v4
sudo bash scripts/install-linux.sh
```

脚本做这些事（幂等，升级时重跑即可）：

| 位置 | 内容 | 权限 |
| --- | --- | --- |
| `/opt/fqrh` | 程序（src / scripts / deploy / 配置模板） | 服务用户可写（升级用） |
| `/var/lib/fqrh/config.json` | 主配置（**服务可写**，面板改配置写这里） | `640 fqrh:fqrh` |
| `/etc/fqrh/fqrh.env` | 上游 key 等环境变量（只读） | `640 root:fqrh` |
| `/etc/fqrh/keys/` | 可选：密钥文件 | `640 root:fqrh` |
| `/var/lib/fqrh/` | 运行数据（账本 `data/fqrh.db`、`data/keys/`） | 服务用户可写 |
| `/etc/systemd/system/fqrh.service` | 服务单元（含沙箱加固） | `644` |

然后**必须改配置**再重启：

```bash
sudo nano /var/lib/fqrh/config.json  # 填 providers / clientKeys（或用面板「中转站管理」添加）
sudo systemctl restart fqrh
sudo systemctl status fqrh
journalctl -u fqrh -n 30            # 看启动日志（会打印局域网入口）
```

## 2. 方式二：前台手动跑（先验证，不装服务）

```bash
cd /path/to/fqrh-v4
cp config.example.json config.json
nano config.json                     # 改 providers / clientKeys
bash scripts/start-gateway.sh
```

看到这些就说明监听成功：

```
FQRH v4.0.0 (conversion 6 pairs, LAN relay, transient-fault buffering)
[fqrh] listening on 0.0.0.0:8790（所有网卡，局域网可访问）
[fqrh]   局域网入口 http://192.168.1.23:8790/v1   （面板 http://192.168.1.23:8790/__admin/dashboard）
```

## 3. 方式三：Docker

```bash
cp config.example.json config.json        # 改 providers / clientKeys
cp deploy/systemd/fqrh.env.example fqrh.env
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f
```

容器内监听 `0.0.0.0:8790`，映射到宿主机 8790；数据在 `./data`，配置只读挂载 `/etc/fqrh/config.json`。

## 4. 配置与密钥（推荐用面板加）

打开面板 `http://<IP>:8790/__admin/dashboard?key=<客户端key>` → 「中转站管理」：填 id / Base URL / 模型 / API key → 保存即写入 `config.json` 并热重载，不用重启；每行有「测试 / 停用 / 删除」。也可以用 `curl` 调 `POST /__admin/config`（`addProviders` / `removeProviders`）。

**密钥三种放法**（按推荐排序）：

```jsonc
// 1) 环境变量（最推荐；写在 /etc/fqrh/fqrh.env，服务自动读取）
"keys": [{ "id": "k1", "env": "RELAY_API_KEY" }]

// 2) 密钥文件（绝对路径最稳，或用相对 cwd 的 data/keys/xxx.txt）
"keys": [{ "id": "k2", "file": "/etc/fqrh/keys/relay.txt" }]

// 3) 公共 key / 免注册中转站（不是秘密时才写 value）
"keys": [{ "id": "public", "value": "public" }]
```

- `/etc/fqrh/fqrh.env` 里写 `RELAY_API_KEY=sk-xxxx`，然后 `sudo systemctl restart fqrh`
- **客户端 key**（`clientKeys[]`）配在 `config.json`，不是 env 文件
- `config.json` 里**不要存上游密钥**；文件权限 `640 fqrh:fqrh`（服务要能写，面板改配置用）
- 改了 `config.json` 不必重启：面板「中转站管理 → 添加/删除」直接生效，或面板「从磁盘重载」/
  `curl -X POST http://127.0.0.1:8790/__admin/reload -H "authorization: Bearer <客户端key>"`

## 5. 局域网与防火墙

v4 的 `config.json` 里 `listen.host` 已是 `0.0.0.0`。放行端口：

```bash
# Ubuntu / Debian
sudo ufw allow 8790/tcp
# CentOS / Fedora / RHEL
sudo firewall-cmd --add-port=8790/tcp --permanent && sudo firewall-cmd --reload
# nftables 自己写了规则的话，放行 tcp dport 8790
```

从别的设备验证（手机浏览器打开也行）：

```bash
curl http://192.168.1.23:8790/healthz
```

设备填法：Base URL `http://192.168.1.23:8790/v1`，API Key = 该设备的 `clientKeys[]`，模型 `dsv4.1`。
浏览器里的 Web UI 需要开 CORS：`"cors": { "enabled": true, "allowOrigins": ["http://192.168.1.23:3000"] }`。

> **只给内网用**：不要把 8790 映射到公网。要远程访问就用 WireGuard/Tailscale 或下面的 HTTPS 反代 + 认证。

## 6. HTTPS 反向代理（可选，给公网/域名用）

Caddy（自动证书）：

```
fqrh.example.com {
    reverse_proxy 127.0.0.1:8790 {
        flush_interval -1      # 关键：SSE 流式不能被缓冲
    }
}
```

nginx：

```nginx
location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;                  # 关键：流式
    proxy_read_timeout 300s;
}
```

注意：反代后 `listen.host` 可以改回 `127.0.0.1`（只让反代访问），并在 Caddy/nginx 层做 IP 白名单/基础认证。

## 7. 运维

```bash
sudo systemctl restart fqrh            # 改代码/配置后重启
sudo systemctl stop fqrh               # 停止
journalctl -u fqrh -f                  # 跟日志
curl http://127.0.0.1:8790/healthz     # 健康检查
curl http://127.0.0.1:8790/metrics     # Prometheus 指标
curl -X POST http://127.0.0.1:8790/__admin/shutdown \
     -H "authorization: Bearer <客户端key>"          # 优雅关停（v4 新增）

# 备份（账本 + 配置）
sudo tar czf fqrh-backup-$(date +%F).tgz /var/lib/fqrh /etc/fqrh

# 升级：覆盖 /opt/fqrh 后重启（install-linux.sh 可重跑）
sudo systemctl restart fqrh
```

面板：`http://<IP>:8790/__admin/dashboard?key=<客户端key>`。
日报：`node /opt/fqrh/scripts/report.mjs --db /var/lib/fqrh/data/fqrh.db`。

## 8. 安全清单

- [ ] 专用系统用户 `fqrh`（安装脚本已建），不用 root 跑
- [ ] `/etc/fqrh/*` 权限 `640 root:fqrh`，不要 `644`
- [ ] 不在 config.json 里写上游密钥（用 env / 专用文件）
- [ ] 每台设备一个 `clientKeys[]`，设备丢了就删掉那一条
- [ ] 只监听内网；公网必须走 HTTPS 反代 + 额外认证
- [ ] 不用 root 执行 node；开 service 的 `ProtectSystem=strict` 等加固（单元已带）
- [ ] 定期备份 `/var/lib/fqrh`（账本）与 `/etc/fqrh`（配置）

## 9. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` | Node < 22.5；或 Node 22 没开 `NODE_OPTIONS=--experimental-sqlite`（安装脚本会自动加） |
| `EACCES: permission denied, open .../data/fqrh.db` | 数据目录权限：`chown -R fqrh:fqrh /var/lib/fqrh` |
| `EADDRINUSE 8790` | 端口被占：`ss -lntp \| grep 8790`，或改 `listen.port` |
| 服务起来就退出 | `journalctl -u fqrh -n 50`：多半是 config.json 不是合法 JSON / providers 为空 |
| 局域网连不上 | `listen.host=0.0.0.0`？防火墙放行？手机和服务器同网段？`curl` 从另一台机器测 |
| 面板 401 | URL 带 `?key=`，或先在本机打开面板填客户端 key |
| 流式回答被"憋住"、一次性出来 | 反代没关缓冲：Caddy `flush_interval -1` / nginx `proxy_buffering off` |
| 时间显示是 UTC | 面板按浏览器时区渲染；服务端时区不影响；报表按本地日切天，容器里记得 `TZ=Asia/Shanghai` |
| Node 22 内存告警 | `node:sqlite` 实验特性会警告，属正常；升级到 24 消失 |
| 启动即退出，日志有 `uv_interface_addresses` / `EAFNOSUPPORT` / `errno 97` | v4.0.0 的网卡枚举没有兜底；v4.0.1 已 try/catch（拉新版或手动加 try/catch）。带 monitor 模式网卡的 Kali 常见 |

## 10. 验证清单（Linux 上逐条跑）

```bash
node -v                                              # v24.x / v22.5+
node src/test-convert.mjs                            # 57 通过
node src/test.mjs                                    # 99 通过（离线，自带 mock 上游）
node src/server.mjs --config config.demo.json &      # 演示启动
curl -s http://127.0.0.1:8790/healthz                # {"ok":true,"version":"4.0.0",...}
curl -s -H "authorization: Bearer sk-fqrh-demo" \
     http://127.0.0.1:8790/v1/models                 # 模型列表
sudo systemctl status fqrh                           # 仅 systemd 方式
```

> 部署资产的验证方式：测试套件是跨平台的（不依赖 Windows API），导出仓库的 `.github/workflows/ci.yml` 会在 **ubuntu-latest** 上跑 `test-convert` 与 `test`，推送后看 Actions 即可确认真实 Linux 环境通过。
