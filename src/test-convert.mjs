/**
 * 协议转换单元测试（不起服务、不联网）：node src/test-convert.mjs
 */
import { convertRequest, convertResponse, createStreamBridge } from './convert/index.mjs';

let pass = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const j = (o) => JSON.stringify(o);

console.log('[1] chat 请求 → anthropic messages 请求');
{
  const chatReq = {
    model: 'grok-4.5',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '北京天气？' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴，25°C' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
    tool_choice: 'auto',
    max_tokens: 256,
    temperature: 0.3,
    stop: ['END'],
    stream: true,
  };
  const out = convertRequest('chat', 'messages', chatReq);
  check('system 提升为顶层 system 字段', out.system === '你是助手', j(out.system));
  check('max_tokens 保留', out.max_tokens === 256);
  check('stop → stop_sequences', j(out.stop_sequences) === '["END"]');
  check('tools → input_schema', out.tools?.[0]?.input_schema?.properties?.city?.type === 'string');
  check('tool_choice auto → {type:auto}', out.tool_choice?.type === 'auto');
  check('assistant tool_calls → tool_use 块', j(out.messages?.[1]?.content || []).includes('tool_use'));
  check('tool 结果 → tool_result 块', j(out.messages?.[2]?.content || []).includes('tool_result'));
  check('stream 透传', out.stream === true);
}

console.log('\n[2] anthropic messages 请求 → chat 请求');
{
  const msgReq = {
    model: 'claude-x',
    system: '你是助手',
    max_tokens: 512,
    messages: [
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: '上海' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '阴，20°C' }] },
    ],
    tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    tool_choice: { type: 'any' },
    stop_sequences: ['STOP'],
  };
  const out = convertRequest('messages', 'chat', msgReq);
  check('system 变成 system message', out.messages?.[0]?.role === 'system');
  check('tools → function 格式', out.tools?.[0]?.function?.name === 'get_weather');
  check('tool_choice any → required', out.tool_choice === 'required', j(out.tool_choice));
  check('tool_use → assistant tool_calls', Boolean(out.messages?.find((m) => m.tool_calls)));
  check('tool_result → role:tool', Boolean(out.messages?.find((m) => m.role === 'tool' && m.tool_call_id === 'tu_1')));
  check('stop_sequences → stop', j(out.stop) === '["STOP"]');
}

console.log('\n[3] chat 请求 → responses 请求');
{
  const out = convertRequest('chat', 'responses', {
    model: 'grok-4.5',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    max_tokens: 64,
    stream: true,
  });
  check('system → instructions', out.instructions === 'sys');
  check('input 是数组且含 message 项', Array.isArray(out.input) && out.input[0]?.type === 'message');
  check('max_tokens → max_output_tokens', out.max_output_tokens === 64);
  check('stream 透传', out.stream === true);
}

console.log('\n[4] responses 请求 → chat 请求（含工具调用历史）');
{
  const out = convertRequest('responses', 'chat', {
    model: 'gpt-x',
    instructions: 'sys',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'function_call', call_id: 'fc_1', name: 'get_weather', arguments: '{"city":"广州"}' },
      { type: 'function_call_output', call_id: 'fc_1', output: '晴' },
    ],
    max_output_tokens: 32,
  });
  check('instructions → system', out.messages?.[0]?.role === 'system');
  check('function_call → tool_calls', Boolean(out.messages?.find((m) => m.tool_calls)));
  check('function_call_output → role:tool', Boolean(out.messages?.find((m) => m.role === 'tool' && m.tool_call_id === 'fc_1')));
  check('max_output_tokens → max_tokens', out.max_tokens === 32);
}

console.log('\n[5] 响应转换');
{
  const anth = {
    id: 'msg_1', model: 'claude', role: 'assistant',
    content: [{ type: 'text', text: '好的' }, { type: 'tool_use', id: 'tu_1', name: 'f', input: { a: 1 } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 7 },
  };
  const chat = convertResponse('messages', 'chat', anth);
  check('text 合并到 content', chat.choices?.[0]?.message?.content === '好的');
  check('tool_use → tool_calls', chat.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === 'f');
  check('finish_reason tool_use → tool_calls', chat.choices?.[0]?.finish_reason === 'tool_calls');
  check('usage 映射', chat.usage?.prompt_tokens === 10 && chat.usage?.completion_tokens === 7);

  const chatResp = {
    id: 'c1', model: 'm',
    choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 5, completion_tokens: 6 },
  };
  const msg = convertResponse('chat', 'messages', chatResp);
  check('content 变成 text 块数组', Array.isArray(msg.content) && msg.content[0]?.type === 'text');
  check('finish_reason length → max_tokens', msg.stop_reason === 'max_tokens');
  check('usage → input/output_tokens', msg.usage?.input_tokens === 5 && msg.usage?.output_tokens === 6);

  const resp = convertResponse('chat', 'responses', chatResp);
  check('chat → responses 结构', resp.object === 'response' && Array.isArray(resp.output));
  check('responses usage 字段', resp.usage?.input_tokens === 5 && resp.usage?.output_tokens === 6);
}

console.log('\n[6] 流式桥：anthropic SSE → chat SSE');
{
  const out = [];
  const bridge = createStreamBridge({ fromEndpoint: 'messages', toEndpoint: 'chat', write: (c) => out.push(c) });
  const chunks = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_9","model":"claude-x","usage":{"input_tokens":11}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  for (const c of chunks) bridge.feed(c);
  bridge.end();
  const text = out.join('');
  check('chat 流以 data: 开头', text.trimStart().startsWith('data: {'));
  check('含角色首块', text.includes('"role":"assistant"'));
  check('含正文 delta', text.includes('你好'));
  check('含 finish_reason', text.includes('"finish_reason":"stop"'));
  check('以 [DONE] 结束', text.trimEnd().endsWith('data: [DONE]'));
  const u = bridge.usage();
  check('usage 被捕获', u.promptTokens === 11 && u.completionTokens === 3, j(u));
}

console.log('\n[7] 流式桥：chat SSE → anthropic SSE');
{
  const out = [];
  const bridge = createStreamBridge({ fromEndpoint: 'chat', toEndpoint: 'messages', write: (c) => out.push(c) });
  bridge.feed('data: {"id":"c1","model":"m","choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n');
  bridge.feed('data: {"id":"c1","model":"m","choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n');
  bridge.feed('data: {"id":"c1","model":"m","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n');
  bridge.feed('data: [DONE]\n\n');
  bridge.end();
  const text = out.join('');
  check('message_start 事件', text.includes('event: message_start'));
  check('text_delta 事件', text.includes('text_delta'));
  check('message_delta + message_stop', text.includes('event: message_delta') && text.includes('event: message_stop'));
  const u = bridge.usage();
  check('chat usage 被捕获', u.promptTokens === 4 && u.completionTokens === 2, j(u));
}

console.log('\n[8] 流式桥：chat SSE → responses SSE');
{
  const out = [];
  const bridge = createStreamBridge({ fromEndpoint: 'chat', toEndpoint: 'responses', write: (c) => out.push(c) });
  bridge.feed('data: {"id":"c1","model":"m","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
  bridge.feed('data: {"id":"c1","model":"m","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
  bridge.feed('data: [DONE]\n\n');
  bridge.end();
  const text = out.join('');
  check('response.created 事件', text.includes('response.created'));
  check('output_text.delta 事件', text.includes('response.output_text.delta'));
  check('response.completed 事件', text.includes('response.completed'));
}

console.log('\n[9] 流式桥：responses SSE → messages SSE');
{
  const out = [];
  const bridge = createStreamBridge({ fromEndpoint: 'responses', toEndpoint: 'messages', write: (c) => out.push(c) });
  bridge.feed('event: response.created\ndata: {"type":"response.created","response":{"id":"r1","model":"m"}}\n\n');
  bridge.feed('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant"}}\n\n');
  bridge.feed('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"嘿"}\n\n');
  bridge.feed('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":6,"output_tokens":2}}}\n\n');
  bridge.end();
  const text = out.join('');
  check('转出 message_start', text.includes('event: message_start'));
  check('转出 text_delta', text.includes('text_delta'));
  check('转出 message_stop', text.includes('event: message_stop'));
}

console.log('\n[10] 流式工具调用：chat → messages');
{
  const out = [];
  const bridge = createStreamBridge({ fromEndpoint: 'chat', toEndpoint: 'messages', write: (c) => out.push(c) });
  bridge.feed('data: {"id":"c1","model":"m","choices":[{"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n');
  bridge.feed('data: {"id":"c1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"北京\\"}"}}]},"finish_reason":null}]}\n\n');
  bridge.feed('data: {"id":"c1","model":"m","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  bridge.feed('data: [DONE]\n\n');
  bridge.end();
  const text = out.join('');
  check('转出 tool_use 块', text.includes('"type":"tool_use"') && text.includes('get_weather'), text.slice(0, 300));
  check('转出 input_json_delta', text.includes('input_json_delta'));
  check('转出 stop_reason=tool_use', text.includes('"stop_reason":"tool_use"'));
}

console.log('\n[11] 流式工具调用：messages → chat');
{
  const out = [];
  const bridge = createStreamBridge({ fromEndpoint: 'messages', toEndpoint: 'chat', write: (c) => out.push(c) });
  bridge.feed('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude","usage":{"input_tokens":8}}}\n\n');
  bridge.feed('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather","input":{}}}\n\n');
  bridge.feed('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"上海\\"}"}}\n\n');
  bridge.feed('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
  bridge.feed('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n');
  bridge.feed('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  bridge.end();
  const text = out.join('');
  check('转出 tool_calls delta', text.includes('"tool_calls"') && text.includes('get_weather'), text.slice(0, 300));
  check('转出 arguments 片段', text.includes('city'));
  check('转出 finish_reason=tool_calls', text.includes('"finish_reason":"tool_calls"'));
}

console.log('\n[12] 非流式工具往返：chat → messages → chat 保真');
{
  const chatReq = {
    model: 'm',
    messages: [
      { role: 'user', content: '天气' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_9', content: '晴' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
  };
  const msgReq = convertRequest('chat', 'messages', chatReq);
  const back = convertRequest('messages', 'chat', msgReq);
  const assistant = back.messages.find((m) => m.tool_calls);
  const toolMsg = back.messages.find((m) => m.role === 'tool');
  check('工具名往返保留', assistant?.tool_calls?.[0]?.function?.name === 'get_weather');
  check('工具参数往返保留', assistant?.tool_calls?.[0]?.function?.arguments === '{"city":"北京"}', assistant?.tool_calls?.[0]?.function?.arguments);
  check('tool_call_id 往返保留', toolMsg?.tool_call_id === 'call_9', toolMsg?.tool_call_id);
  check('工具结果内容往返保留', toolMsg?.content === '晴');
}

console.log(`\n结果：${pass} 通过${fails.length ? `，${fails.length} 失败` : ''}`);
if (fails.length) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('全部通过 ✅');
