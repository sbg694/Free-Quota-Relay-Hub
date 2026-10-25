# 06 · v2 协议转换

> 目标：**客户端说哪种协议都行，池支持哪种协议就用哪种**。v1 只能同协议透传（客户端要 anthropic、池只有 openai → 503），v2 把这段接上。

## 1. 为什么不用两两转换

三种协议两两互转是 6 个方向（chat↔messages、chat↔responses、messages↔responses），每个方向都要写请求转换 + 响应转换 + 流式转换，共 18 份代码且容易不一致。

v2 用一个**规范中间表示（canonical）**：

```
        客户端协议                          上游协议
chat ─┐                                ┌─ chat
      ├─ toCanonical ─► canonical ─► fromCanonical ─┤
messages ─┘                                └─ messages
responses                                          responses
```

- 3 份「读入」：`toCanonicalRequest/Response`
- 3 份「写出」：`fromCanonicalRequest/Response`
- 任意两协议互转 = 两段组合，**6 份代码覆盖 6 个方向**

代码位置：`src/convert/{chat,messages,responses}.mjs`，调度在 `src/convert/index.mjs`。

## 2. 规范中间表示

```js
// 请求
{ model, system, messages: [{ role, text, parts?, toolCalls?, toolResults? }],
  tools: [{ name, description, parameters }], toolChoice,
  maxTokens, temperature, topP, stop, stream }

// 响应
{ id, model, text, toolCalls: [{ id, name, argsJson }], stopReason, usage: { input, output } }
```

工具参数统一存 `argsJson`（字符串），避免各协议反复 `JSON.parse` 把非法 JSON 变成异常。

## 3. 转换矩阵

| 客户端调用 | 池原生端点 | 行为 |
| --- | --- | --- |
| chat | chat | 透传 |
| chat | messages | chat → messages 转换 |
| chat | responses | chat → responses 转换 |
| messages | messages | 透传 |
| messages | chat | messages → chat 转换 |
| messages | responses | messages → responses 转换 |
| responses | responses | 透传 |
| responses | chat | responses → chat 转换 |
| responses | messages | responses → messages 转换 |
| embeddings / images | 同端点 | 透传（无转换） |

**端点规划**：`pool.mjs:planEndpoint` 先找原生支持，再按 `chat → messages → responses` 顺序找可转换目标。候选排序里**透传优先于转换**（少一次转换 = 少一类故障）。

响应会带 `x-fqrh-convert: chat:messages` 头，方便排查「这次到底转没转」。

## 4. 字段映射要点

| 概念 | chat | messages | responses |
| --- | --- | --- | --- |
| 系统提示 | `role:system` 消息 | 顶层 `system` | `instructions` |
| 工具定义 | `tools[].function` | `tools[].input_schema` | `tools[]`（type=function） |
| 工具选择 | `tool_choice: auto/none/required/{function}` | `{type:auto/any/tool/none}` | `auto/none/required/{type:function}` |
| 模型调用 | `message.tool_calls[]` | `content[]` 里的 `tool_use` 块 | `output[]` 里的 `function_call` 项 |
| 工具结果 | `role:tool` + `tool_call_id` | `tool_result` 块 | `function_call_output` 项 |
| 结束原因 | `finish_reason`（stop/length/tool_calls） | `stop_reason`（end_turn/max_tokens/tool_use） | `status`（completed/incomplete/failed） |
| 用量 | `prompt/completion_tokens` | `input/output_tokens` | `input/output_tokens` |
| 停止序列 | `stop[]` | `stop_sequences[]` | 不支持（丢弃） |

## 5. 流式转换

流式不是"整包转换"，而是 **SSE 事件重编码**：

```
上游 SSE ─► SseParser ─► parseStream(上游协议) ─► 规范事件 ─► createStreamWriter(客户端协议) ─► 客户端 SSE
规范事件：start / text / toolStart / toolArgs / toolEnd / usage / stop / end
```

- chat：`data: {"choices":[{"delta":…}]}` + `data: [DONE]`
- messages：`message_start` → `content_block_start/delta` → `message_delta` → `message_stop`
- responses：`response.created` → `response.output_text.delta` → `response.completed`

已实现全部 6 个方向的流式转换，实测「客户端 chat 流 ← 上游 anthropic 流」「客户端 messages 流 ← 上游 chat 流」「客户端 responses 流 ← 上游 chat 流」均通过。

## 6. 调试

```powershell
# 只预览请求会变成什么样，不发上游
curl.exe -X POST http://127.0.0.1:8790/__admin/convert-preview ^
  -H "authorization: Bearer <client key>" -H "content-type: application/json" ^
  -d '{"from":"chat","to":"messages","payload":{"model":"m","messages":[{"role":"user","content":"hi"}],"max_tokens":64}}'

# 看这次请求转没转
#   GET /__admin/state  → metrics.byConversion
#   GET /healthz        → capabilities.conversions
```

## 7. 验证

| 层 | 命令 | 结果 |
| --- | --- | --- |
| 转换单元 | `node src/test-convert.mjs` | **47 项通过**（含 4 组流式桥） |
| 网关集成 | `node src/test.mjs` | **54 项通过**（含跨协议非流式/流式 7 项） |
| 真实上游 | `node scripts/live-smoke.mjs` | **8/8**：`/v1/messages` 走 relay-backup chat 上游，转换后 200（`stop_reason=end_turn`） |

## 8. 已知限制

1. **图片**：chat 的 `image_url` 与 messages 的 base64 图片互转已支持；responses 的 `input_image` 支持 base64 data URL。URL 形式的图片依赖上游自己抓取。
2. **thinking / reasoning 块**：anthropic 的 `thinking` 与 responses 的 `reasoning` 块目前**丢弃**（不转发给客户端），避免客户端不认识；token 记账仍以 usage 为准。
3. **`stop_sequences`**：responses 协议没有对应字段，转 responses 时丢弃（会在 `x-fqrh-convert` 场景下丢失该约束）。
4. **工具结果的大对象**：非字符串 `output` 会 `JSON.stringify` 后传输，部分上游可能不接受。
5. **协议转换不保证语义等价**：字段丢失（如 `seed`、`response_format`）属于预期；需要严格一致时请让池使用原生协议。
