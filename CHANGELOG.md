# Changelog

## 3.1.4（2026-10-25）

- 面板新增「别名」管理（添加/更新/删除）
- 删提供商时自动清理悬空别名（返回 `aliasesRemoved`）；`/v1/models` 只列有效别名
- 新增 3 条测试

## 3.1.3（2026-10-23）

- 面板「中转站管理」新增**扫描模型**：按 Base URL + key 或按池拉取上游 `/models`，一键填入模型列表（`POST /__admin/scan-models`）
- 扫描按 key 健康度挑候选并重试（最多 3 key、网络错误再试 1 次），错误信息可读
- 新增 3 条测试（按池扫描 / 临时扫描 / 无 key 400）

## 3.1.2（2026-10-23）

- 面板新增「中转站管理」：添加 / 更新 / 删除提供商（id、Base URL、协议、模型、API key 或 `env:`/`file:`），保存即备份 + 热重载
- 服务端校验 `addProviders`（重复 id / 缺 baseUrl / 缺 models / 缺 key → 400）
- 新增 7 条测试（提供商增删与校验）

## 3.1.1（2026-10-23）

- 修复 `modelMap` 与 `aliases` 的组合：别名先解析成规范名，再按规范名查 `modelMap`（之前别名请求会把规范名原样发给上游）
- `pool.supports()` 同时用别名和规范名匹配 `modelMap`
- 新增 2 条测试：modelMap 直接映射、别名 → 规范名 → modelMap

## 3.1.0（2026-10-22）

- 管理面板可写：切主用池（`priority`）、启停池、改上游 key、改客户端 key、调缓冲参数
- 配置热重载：`POST /__admin/config`（写前备份 `config.json.bak`）与 `POST /__admin/reload`，改配置不用重启
- `GET /__admin/config` 脱敏视图（客户端 key 只给掩码，上游 key 只给 `hasValue/env/file/state`）
- 无依赖一键启动器 `FQRH-hub.exe`（源码 `tools/FQRH-hub.cs`，用 `tools/build-exe.cmd` 现场编译）
- 时间口径统一：库里存 UTC，面板/日报按本机时区显示；日报改用 `date(ts,'localtime')` 切天
- 修复 Windows `.cmd` 启动脚本的行尾/编码问题（CRLF + ASCII + `chcp 65001`）

## 3.0.0（2026-10-22）

- 上游**假鉴权失败缓冲**：`flakyAuth` 池的假 401 / 假"密钥无效"自动重试，客户端无感
- 流式首包缓冲（`preludeMs`）：200 + SSE error 事件也能重试
- 重试耗尽返回 `503 + Retry-After`，绝不把假 401 透传成"客户端密钥无效"
- 模型级错误学习：反复鉴权失败的模型短期屏蔽，返回 `404 model_unauthorized`
- 池级 `priority`：主用中转站权重高于备用

## 2.0.0（2026-10-22）

- 跨协议转换：chat ⇄ messages ⇄ responses（含流式），透传优先、转换其次
- `tpm` Token 预算、`modelMap` 模型映射、管理面板 + 定时探活 + Webhook 告警

## 1.0.0（2026-10-22）

- 首版：同协议透传、密钥池、额度账本、探活、失败转移
