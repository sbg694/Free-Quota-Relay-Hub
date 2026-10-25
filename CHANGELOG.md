# Changelog

## 4.0.4（2026-10-25）

- **别名管理**：面板新增「别名」区，可添加/更新/删除别名（客户端用别名，网关映射到真实模型）
- **悬空别名自动清理**：删提供商或改模型后，指向已不存在模型/池的别名会被自动删除，响应里返回 `aliasesRemoved`；`/v1/models` 也只列有效别名（修掉「删了池但旧别名一直挂在模型列表里」的问题）
- 测试：网关集成 112（新增 3 条别名/清理测试）

## 4.0.3（2026-10-23）

- **自动扫描模型**：面板「中转站管理」新增「扫描模型」按钮（表单里按 Base URL + key 扫描，或每行按池扫描），自动请求上游 `/models` 并把模型列表填进模型框，确认后保存；后端新增 `POST /__admin/scan-models`
- 扫描会按 key 健康度挑候选 key 并逐个尝试（最多 3 个），网络类失败自动重试一次；错误信息更可读（不再出现空错误）
- 适配 Anthropic messages 池的扫描鉴权头（`x-api-key` + `anthropic-version`）
- 测试：网关集成 109（新增 3 条扫描测试）

## 4.0.2（2026-10-23）

- **面板「中转站管理」**：浏览器里添加 / 更新 / 删除提供商，填 id、Base URL、协议、模型、API key（或 `env:` / `file:`）即可；保存自动备份 + 热重载，新模型立刻出现在 `/v1/models`；每行可「测试 / 停用 / 删除」
- 服务端校验 `addProviders`：id 重复、缺 baseUrl、缺 models、缺 key 返回 400
- **配置路径修正**：配置移到服务可写的 `/var/lib/fqrh/config.json`（systemd `ProtectSystem=strict` 下 `/etc` 只读，原先面板改配置会 `EROFS`）；`/etc/fqrh` 只保留 `fqrh.env` 与 `keys/`（只读）
- 测试：网关集成 106（新增 7 条提供商增删/校验）

## 4.0.1（2026-10-23）

部署到真实 Kali 主机时发现并修复两个问题：

- **`modelMap` 别名链路**：`aliases` 里写的客户端模型名（如 `dsv4.1`）经别名解析成规范名后，`modelMap` 没有按规范名查表，导致别名请求把规范名（`deepseek-v4.1-flash`）原样发给上游 → 免费站返回 401。现在按「别名 → 规范名 → modelMap」顺序映射；`pool.supports()` 也同时用别名和规范名查 `modelMap`。新增两条测试。
- **`os.networkInterfaces()` 在部分 Linux 上崩溃**：带 monitor 模式/虚拟网卡的 Kali 上 libuv `uv_interface_addresses` 返回 `EAFNOSUPPORT(errno 97)`，未捕获会让网关启动即退出。现在用 try/catch 包住，失败只跳过局域网入口提示，服务照常运行。

验证：转换 57 + 网关集成 99（新增 2 条）；真实 Kali 主机上 `dsv4.1` 与 `deepseek-v4.1-flash` 均 200，上游收到 `deepseek-v4.1-flash-free`。

## 4.0.0（2026-10-23）

- 从 v3.1 克隆的独立局域网版本：默认 `listen.host=0.0.0.0`，启动打印各网卡局域网入口
- 多设备接入：`clientKeys` 一设备一条；可选 CORS（浏览器 Web UI 用）
- 新增 `POST /__admin/shutdown` 优雅关停
- Linux 部署资产：systemd 单元（专用用户 + `ProtectSystem=strict` 等加固）、`scripts/install-linux.sh` 一键安装、`Dockerfile` + `docker-compose.yml`
- `docs/10-lan-access.md`（局域网接入）与 `docs/11-linux-deploy.md`（Linux 部署）
