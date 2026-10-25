# 07 · 运维面：面板 / 定时探活 / 告警

> M4 的目标不是"多几个页面"，而是**能长期无人值守**：出问题能自己发现、留下记录、推给人。

## 1. 三件套

| 组件 | 位置 | 做什么 |
| --- | --- | --- |
| 管理面板 | `GET /__admin/dashboard` | 一页看全：池/key 状态、今日用量、失败分类、转换统计、告警、最近请求，5s 自动刷新 |
| 定时探活 | `src/monitor.mjs` | 按 `monitor.probeIntervalSec` 周期跑探活，连续失败计数 |
| 告警 | 同上 + `alerts` 表 | 失败/恢复/key 失效 → 落库 + Webhook 推送（飞书/钉钉/Slack/通用） |

三者共用一个 `createMonitor()`，面板和 REST 读的是同一份状态，不会出现"页面显示 OK、告警说挂了"。

## 2. 面板

打开 `http://127.0.0.1:8790/__admin/dashboard`，填客户端 key（存 `localStorage`），之后自动刷新。

- 顶部：版本、运行时长、总/成功/失败/转换数、端点分布
- 池与密钥：协议、端点、模型、rpm/tpm、每个 key 的状态（active/cooling/dead/missing）+ health + 今日 tokens
- 今日账本：请求数、tokens、失败分类、转换方向
- 告警：时间/级别/池/类型/内容/是否推送成功
- 最近请求：端点、池/key、模型、状态码+错误类型、耗时（含首包）、tokens
- 两个动作按钮：**立即探活**、**测试告警**（验证 Webhook 通不通）

便捷入口：`?key=<客户端key>` 会自动写入并立刻从地址栏抹掉，方便收藏/截图；代价是 key 会短暂出现在 URL 里，**别在共享机器上用**。

面板本身不需要鉴权（HTML 里没有数据），但所有数据接口都要 key——所以别人打开页面也看不到你的 key 和用量。

## 3. 定时探活

```json
"monitor": {
  "enabled": true,
  "probeIntervalSec": 300,
  "probeOnStartup": true,
  "failThreshold": 2,
  "alertCooldownSec": 1800,
  "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx",
  "webhookFormat": "feishu"
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉则完全不探活、不告警 |
| `probeIntervalSec` | `300` | 探活周期；`0` = 只允许手动 `POST /__admin/probe-all` |
| `probeOnStartup` | `true` | 启动 2s 后先探一次，避免"起来就是坏的" |
| `failThreshold` | `2` | 连续失败多少次才告警（防止单次抖动刷屏） |
| `alertCooldownSec` | `1800` | 同一问题 30 分钟内不重复推 |
| `webhookUrl` / `webhookFormat` | 空 / `generic` | 告警推送目标与格式 |

**探活与业务同源**：用的是同一套 `buildHeaders` + `requestUpstream`（`src/probe.mjs`），不是单独写的 healthcheck，所以"探活过 ≠ 业务过"这种误判不会发生。探活默认请求 `/v1/models`（不消耗 token），失败时才退到模型列表里的第一个模型发一条最小请求。

## 4. 告警

### 触发条件

| kind | 级别 | 含义 |
| --- | --- | --- |
| `probe_failed` | critical | 池探活连续失败 ≥ `failThreshold` |
| `probe_recovered` | info | 恢复（附带此前失败次数与本次延迟） |
| `key_dead` | critical | 某个 key 被 401/403 拉黑，需要换 key |
| `key_missing` | critical | key 的 file/env 没读到密钥 |
| `manual_test` | info | 面板/接口手动触发，验证通道 |

### 推送格式

`generic`（默认，适合自建机器人）：

```json
{
  "text": "[FQRH][critical] relay-backup probe_failed：探活连续 2 次失败：HTTP 502",
  "level": "critical", "poolId": "relay-backup", "kind": "probe_failed",
  "message": "探活连续 2 次失败：HTTP 502", "ts": "2026-10-22T12:38:36.171Z"
}
```

`feishu` → `{msg_type:"text",content:{text}}`；`dingtalk` → `{msgtype:"text",text:{content}}`；`slack` → `{text}`。

### 落库

`alerts` 表（SQLite）：`id / ts / level / pool_id / kind / message / delivered`。
`delivered`：`1` 已推送成功，`0` 推送失败，面板按"未配置/已推送/推送失败"三态展示。

## 5. 接口

```powershell
$H = @{ authorization = "Bearer <客户端key>" }
# 面板
Invoke-WebRequest http://127.0.0.1:8790/__admin/dashboard -OutFile panel.html
# 告警列表 + 监控状态
#   GET  /__admin/alerts
# 手动探活（结果写进监控状态，也会触发告警判定）
#   POST /__admin/probe-all
# 测试告警通道
#   POST /__admin/alert-test
# Prometheus
#   GET /metrics → fqrh_monitor_probes / fqrh_monitor_alerts / fqrh_monitor_alerts_delivered / fqrh_monitor_alert_failures
```

## 6. 验证

| 项 | 证据 |
| --- | --- |
| 面板可访问、含数据 | 集成测试 `[8]`：200 + 标题 + `/__admin/state` 引用 |
| 手动探活 | `POST /__admin/probe-all` → `runAt` + 全部池结果（真实链路：relay-backup ✓ mock ✓） |
| 告警落库 | `alert-test` → `GET /__admin/alerts` 出现 `manual_test` 且 `delivered=true` |
| Webhook 真实推送 | 测试里起本地 HTTP 接收端，收到 generic JSON（`text/level/kind` 齐全） |
| key 失效也告警 | 集成测试先制造 401 拉黑 → 收到 `key_dead` 推送 |
| 阈值/恢复逻辑 | 单元测试：1 次失败不告警 → 2 次告警 → 恢复发 info |

## 7. 边界

- **告警不自动改池状态**：自动禁用/恢复会影响正在跑的流量且难以解释，只通知、由人决定。
- **计数在进程内**：`/metrics` 与面板的"本次运行"计数重启归零；告警历史在 SQLite 里不丢。
- 探活是**串行**的：池多时一轮耗时 ≈ 池数 × 单池延迟；`probeIntervalSec` 要大于一轮耗时（默认 300s 足够）。
- 面板是单文件、无前端构建、无 WebSocket；数据靠 5s 轮询，够小团队用。
