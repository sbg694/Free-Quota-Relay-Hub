# 图形界面与一键启动（v3.1）

v3.1 把「改 key、换中转站、调优先级」这些常见操作搬进了面板，并给 Windows 加了一个双击即用的 `FQRH-hub.exe`。

## 1. 管理面板（浏览器里的 GUI）

打开：`http://127.0.0.1:8790/__admin/dashboard`（可带 `?key=你的客户端key` 自动登录一次）。

### 1.1 只读部分（v2 已有）

总请求/成功/失败/转换、池与密钥状态、今日账本、失败分类、告警表、最近请求。每 5 秒自动刷新。

### 1.2 「常用操作」写入区（v3.1 新增）

| 操作 | 做什么 | 背后接口 |
| --- | --- | --- |
| 保存优先级 | 改某池 `priority`（主用 100 / 备用 10） | `POST /__admin/config` |
| 启用 / 停用 | 改 `providers[].enabled` | 同上 |
| 保存上游 key | 改某池某个 key 的 `value`（按 key id 覆盖或新增） | 同上 |
| 保存客户端 key | 改 `clientKeys[]` 里某个 id 的 key（只改这一个，不会冲掉其它） | 同上 |
| 保存缓冲参数 | 改 `resilience.retries` / `preludeMs` | 同上 |
| 从磁盘重载 | 手工改过 config.json 后强制重读 | `POST /__admin/reload` |

写入流程（**不需要重启网关**）：

```
面板改值 → POST /__admin/config
        → 备份 config.json → config.json.bak（.gitignore 已排除，含密钥）
        → 合并写入 config.json
        → 热重载：重建池 + 重建定时探活（monitor）
        → 面板自动刷新，5s 内看到新状态
```

### 1.3 配置视图（脱敏）

`GET /__admin/config` 只返回可编辑字段，客户端 key 只给 `sk-fqr…E-ME` 这样的掩码 + `hasKey`；上游 key 只给 `hasValue/env/file/state`，**不返回明文**。写操作要带客户端 key（`Authorization: Bearer …`）。

### 1.4 中转站管理（添加 / 删除官方提供商）

面板新增「中转站管理」区，v3.1.2 / v4.0.2 起可用：

| 操作 | 界面 | 背后 |
| --- | --- | --- |
| 添加提供商 | 填 id / 显示名 / Base URL / 协议 / 模型（逗号分隔）/ API key（或 `env:变量`、`file:路径`）/ priority / flakyAuth → 保存 | `POST /__admin/config` → `addProviders` |
| 更新提供商 | 用同一个 id 再保存（不填 key 则保留原 key） | `providers[id]` 合并 |
| 删除提供商 | 表格行「删除」（带确认） | `removeProviders` |
| 启停 | 行「启用/停用」 | `providers[id].enabled` |
| 测试连通性 | 行「测试」→ 打该池 `/models` | `POST /__admin/probe` |
| **扫描模型** | 表单「扫描模型」（填 Base URL + key）或行内「扫描模型」→ 自动拉 `/models` 填进模型框 | `POST /__admin/scan-models` |

- **扫描模型**：自动请求上游 `<baseUrl>/models`，把返回的模型列表填进「模型」框（可删减后保存）；接口支持 `providerId`（用该池已有 key，会按健康度挑 key 并重试）或 `{baseUrl,key}` 临时扫描；网络抖动会自动重试一次
- 保存后**自动备份 `config.json.bak` + 热重载**，不用重启；新模型立刻出现在 `/v1/models`
- 服务端有校验：id 重复、缺 baseUrl、缺 models、缺 key 都返回 400 并在面板提示
- 配置写在 `config.json`（Linux 上是 `/var/lib/fqrh/config.json`，权限 640，**不在 /etc 下**，因为服务要能写）

### 1.5 别名（aliases）

面板新增「别名」区（v3.1.4 / v4.0.4）：

| 操作 | 说明 |
| --- | --- |
| 添加 / 更新别名 | 填「别名」+「真实模型名」（可选「优先池」逗号分隔）→ 保存 |
| 删除别名 | 行内「删除」 |

要点：

- 客户端可以一直用别名（如 `chat`），网关在请求时映射到真实模型；响应里的 `model` 字段仍是上游真实名
- **删提供商会自动清理悬空别名**：如果别名的目标模型或优先池已经不存在，保存时自动删除，返回 `aliasesRemoved` 列表
- `/v1/models` 只列「目标模型仍存在」的别名，不会再挂死名字

### 1.6 时间对齐（本机时区）

统一规则：

| 位置 | 存什么 | 显示/切天 |
| --- | --- | --- |
| SQLite `request_logs.ts` / `alerts.ts` | **UTC ISO**（`2026-10-22T14:25:26.000Z`，跨时区不歧义） | — |
| 面板「告警」「最近请求」 | — | 浏览器本地时区，表头显示 `本地时间 Asia/Shanghai` |
| `quota_daily.day` | **本地日**（`2026-10-22`） | 与「今日账本」一致 |
| `scripts/report.mjs` | — | 用 SQLite `date(ts,'localtime')` 切天；最近失败按本地时间打印；标题带时区 |

> 之前日报用 `substr(ts,1,10)` 按 UTC 切天，会出现「本地 0–8 点的请求被算到前一天」；v3.1 已改为 `date(ts,'localtime')`，与面板/账本口径统一。

## 2. FQRH-hub.exe（双击即用）

项目根目录的 `FQRH-hub.exe`（10KB，.NET Framework 编译，不打包 node）是一个控制台菜单：

> 仓库不提交二进制（`.gitignore` 已排除 `FQRH-hub.exe`），克隆后双击 `tools/build-exe.cmd` 现场编译（需要 .NET Framework 自带的 `csc.exe`，Windows 10/11 默认就有）。

```
=== FQRH 免费额度中转枢纽 v3 ===
  1. 启动网关（前台运行，Ctrl+C 停止）
  2. 打开管理面板（浏览器）
  3. 查看接入信息（地址 / 客户端 key / 模型）
  4. 运行离线自测（协议转换 + 网关集成）
  5. 真实链路冒烟（会消耗上游免费额度）
  6. 立即探活所有池
  7. 今日账本日报
  8. 打开项目 README / 文档目录
  0. 退出
```

- **它只是启动器**，真正干活还是 `node src\server.mjs`，所以逻辑只有一份，改代码不用重新编译 exe
- 需要本机已装 Node 22+（已在 PATH 或常见安装目录，exe 会自动找）
- 支持参数：`FQRH-hub.exe serve` 直接起网关（可做快捷方式）、`FQRH-hub.exe panel` 直接开面板
- 源码：[`tools/FQRH-hub.cs`](../tools/FQRH-hub.cs)；改完重新编译：双击 [`tools/build-exe.cmd`](../tools/build-exe.cmd)

### 为什么不做「单文件自带 Node」

真正打成不依赖 Node 的独立 exe，需要 Node SEA（node.exe 内嵌 blob，还得 postject 注入）或 pkg/bun 之类打包器，产物 80~120MB，且本项目大量用 `node:sqlite` 动态加载，打包风险高。10KB 启动器 + 系统 Node 是性价比最高的方案。

## 3. .cmd 启动脚本（已修）

之前 `scripts\start-gateway.cmd` 是 **LF 行尾 + UTF-8 中文**，cmd.exe 在 GBK 代码页下会把中文注释和 `cd /d` 行解析乱码，导致：
- `'級銆傜瓑浠蜂簬锛歯ode' 不是内部或外部命令`
- 目录没切换 → `Cannot find module …\scripts\src\server.mjs`

现在所有启动脚本统一为 **CRLF + 纯 ASCII + `chcp 65001`**，双击即可用（本仓库 `scripts\`；v1 冻结快照仓库里同样各一份）。

## 4. 快速对照：三种启动方式

| 方式 | 适合 | 命令/操作 |
| --- | --- | --- |
| `FQRH-hub.exe` | 日常双击、给不熟命令的人 | 双击 → 选 1 |
| `scripts\start-gateway.cmd` | 只要网关 | 双击 |
| `node src\server.mjs --config config.json` | 开发调试 | 终端 |

改配置**不用重启**：面板「常用操作」保存即热重载；直接改文件也行，然后在面板点「从磁盘重载」或 `POST /__admin/reload`。
