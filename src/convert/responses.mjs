/**
 * OpenAI Responses API ⇄ 规范中间表示
 * 非流式：{object:'response', output:[...], usage:{input_tokens,output_tokens}}
 * 流式：response.created / response.output_text.delta / response.completed …
 */
import { sse } from './sse.mjs';

/* ------------------------------------------------------------ request in */

export function toCanonicalRequest(p) {
  const messages = [];
  if (p.instructions) messages.push({ role: 'system-note', text: p.instructions });

  const items = typeof p.input === 'string'
    ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: p.input }] }]
    : (p.input || []);

  for (const item of items) {
    const type = item.type || (item.role ? 'message' : null);
    if (type === 'message') {
      const texts = [];
      const parts = [];
      const content = typeof item.content === 'string'
        ? [{ type: 'input_text', text: item.content }]
        : item.content || [];
      for (const b of content) {
        if (b.type === 'input_text' || b.type === 'output_text' || b.type === 'text') {
          texts.push(b.text || '');
          parts.push({ type: 'text', text: b.text || '' });
        } else if (b.type === 'input_image' && b.image_url) {
          const m = /^data:([^;]+);base64,(.*)$/.exec(b.image_url);
          parts.push(m ? { type: 'image', mediaType: m[1], data: m[2] } : { type: 'image', url: b.image_url });
        }
      }
      messages.push({ role: item.role === 'assistant' ? 'assistant' : 'user', text: texts.join(''), parts });
      continue;
    }
    if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        text: '',
        toolCalls: [{ id: item.call_id || item.id, name: item.name, argsJson: item.arguments || '{}' }],
      });
      continue;
    }
    if (type === 'function_call_output') {
      messages.push({
        role: 'tool',
        toolResults: [{ toolCallId: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) }],
      });
    }
  }

  return {
    model: p.model,
    system: messages.filter((m) => m.role === 'system-note').map((m) => m.text).join('\n\n') || null,
    messages: messages.filter((m) => m.role !== 'system-note'),
    tools: (p.tools || []).filter((t) => t.type === 'function' || t.name).map((t) => ({
      name: t.name || t.function?.name,
      description: t.description || t.function?.description || '',
      parameters: t.parameters || t.function?.parameters || { type: 'object', properties: {} },
    })),
    toolChoice: mapToolChoice(p.tool_choice),
    maxTokens: p.max_output_tokens ?? null,
    temperature: p.temperature,
    topP: p.top_p,
    stop: null,
    stream: p.stream === true,
  };
}

function mapToolChoice(tc) {
  if (!tc) return null;
  if (tc === 'auto') return 'auto';
  if (tc === 'none') return 'none';
  if (tc === 'required') return 'required';
  if (tc.type === 'function') return { name: tc.name };
  return null;
}

/* ------------------------------------------------------------ request out */

export function fromCanonicalRequest(c) {
  const input = [];
  for (const m of c.messages) {
    if (m.role === 'tool' || (m.toolResults && m.toolResults.length)) {
      for (const tr of m.toolResults || []) {
        input.push({ type: 'function_call_output', call_id: tr.toolCallId, output: tr.content || '' });
      }
      continue;
    }
    const content = [];
    const parts = m.parts && m.parts.length ? m.parts : [{ type: 'text', text: m.text ?? '' }];
    for (const part of parts) {
      if (part.type === 'image') {
        content.push({ type: 'input_image', image_url: part.data ? `data:${part.mediaType};base64,${part.data}` : part.url });
      } else if (part.text) {
        content.push({ type: part.type === 'text' ? 'input_text' : 'input_text', text: part.text });
      }
    }
    if (content.length) input.push({ type: 'message', role: m.role, content });
    for (const tc of m.toolCalls || []) {
      input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.argsJson || '{}' });
    }
  }

  const body = { model: c.model, input };
  if (c.system) body.instructions = c.system;
  if (c.tools && c.tools.length) {
    body.tools = c.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
  }
  if (c.toolChoice) {
    if (typeof c.toolChoice === 'string') body.tool_choice = c.toolChoice;
    else body.tool_choice = { type: 'function', name: c.toolChoice.name };
  }
  if (c.maxTokens) body.max_output_tokens = c.maxTokens;
  if (c.temperature != null) body.temperature = c.temperature;
  if (c.topP != null) body.top_p = c.topP;
  if (c.stream) body.stream = true;
  return body;
}

/* ------------------------------------------------------------ response in */

export function toCanonicalResponse(json) {
  let text = '';
  const toolCalls = [];
  for (const item of json.output || []) {
    if (item.type === 'message') {
      for (const b of item.content || []) {
        if (b.type === 'output_text' || b.type === 'text') text += b.text || '';
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: item.call_id || item.id, name: item.name, argsJson: item.arguments || '{}' });
    }
  }
  const status = json.status;
  return {
    id: json.id,
    model: json.model,
    text,
    toolCalls,
    stopReason: status === 'incomplete' ? 'length' : status === 'failed' ? 'error' : (toolCalls.length ? 'tool_use' : 'stop'),
    usage: {
      input: json.usage?.input_tokens ?? null,
      output: json.usage?.output_tokens ?? null,
    },
  };
}

/* ------------------------------------------------------------ response out */

export function fromCanonicalResponse(c, meta = {}) {
  const output = [];
  const msgId = `msg_${c.id || Date.now()}`;
  if (c.text) {
    output.push({
      id: msgId, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: c.text, annotations: [] }],
    });
  }
  for (const tc of c.toolCalls || []) {
    output.push({
      id: `fc_${tc.id}`, type: 'function_call', status: 'completed',
      call_id: tc.id, name: tc.name, arguments: tc.argsJson || '{}',
    });
  }
  return {
    id: c.id || meta.id || `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: c.stopReason === 'error' ? 'failed' : (c.stopReason === 'length' ? 'incomplete' : 'completed'),
    model: c.model || meta.model,
    output,
    usage: {
      input_tokens: c.usage?.input ?? 0,
      output_tokens: c.usage?.output ?? 0,
      total_tokens: (c.usage?.input ?? 0) + (c.usage?.output ?? 0),
    },
  };
}

/* ------------------------------------------------------------ stream */

export function parseStream(emit) {
  let usage = { input: null, output: null };

  return {
    handle(ev) {
      const j = ev.json;
      const type = (ev.event !== 'message' ? ev.event : j?.type) || '';
      if (!j) { if (ev.event === 'done') emit.end(); return; }

      if (type === 'response.created' || type === 'response.in_progress') {
        emit.start({ id: j.response?.id, model: j.response?.model });
        return;
      }
      if (type === 'response.output_item.added' && j.item?.type === 'function_call') {
        emit.toolStart({ index: j.output_index ?? 0, id: j.item.call_id || j.item.id, name: j.item.name });
        return;
      }
      if (type === 'response.output_text.delta' && j.delta) { emit.text(j.delta); return; }
      if (type === 'response.function_call_arguments.delta' && j.delta) {
        emit.toolArgs({ index: j.output_index ?? 0, delta: j.delta });
        return;
      }
      if (type === 'response.output_item.done') { emit.toolEnd({ index: j.output_index ?? 0 }); return; }
      if (type === 'response.completed' || type === 'response.incomplete') {
        const r = j.response || {};
        usage = { input: r.usage?.input_tokens ?? null, output: r.usage?.output_tokens ?? null };
        emit.usage(usage);
        const reason = r.status === 'incomplete' ? 'length' : (r.output || []).some((o) => o.type === 'function_call') ? 'tool_use' : 'stop';
        emit.stop({ reason });
        emit.end();
      }
    },
  };
}

export function createStreamWriter(write, meta = {}) {
  let id = meta.id || `resp_${Date.now()}`;
  let model = meta.model;
  let index = 0;
  let usage = { input: 0, output: 0 };
  let textItem = null;
  const toolItems = new Map();

  return {
    start(info) {
      id = info?.id || id;
      model = info?.model || model;
      write(sse('response.created', {
        type: 'response.created',
        response: { id, object: 'response', status: 'in_progress', model, output: [] },
      }));
    },
    text(t) {
      if (!t) return;
      if (!textItem) {
        textItem = { id: `msg_${id}`, index: index++ };
        write(sse('response.output_item.added', {
          type: 'response.output_item.added', output_index: textItem.index,
          item: { id: textItem.id, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        }));
      }
      write(sse('response.output_text.delta', {
        type: 'response.output_text.delta', item_id: textItem.id,
        output_index: textItem.index, content_index: 0, delta: t,
      }));
    },
    toolStart({ id: toolId, name }) {
      const item = { id: `fc_${toolId}`, index: index++, callId: toolId, name, args: '' };
      toolItems.set(toolId, item);
      write(sse('response.output_item.added', {
        type: 'response.output_item.added', output_index: item.index,
        item: { id: item.id, type: 'function_call', status: 'in_progress', call_id: toolId, name, arguments: '' },
      }));
    },
    toolArgs({ delta }) {
      const item = [...toolItems.values()].pop();
      if (!item) return;
      item.args += delta;
      write(sse('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta', item_id: item.id,
        output_index: item.index, delta,
      }));
    },
    toolEnd() {
      const item = [...toolItems.values()].pop();
      if (!item) return;
      write(sse('response.output_item.done', {
        type: 'response.output_item.done', output_index: item.index,
        item: { id: item.id, type: 'function_call', status: 'completed', call_id: item.callId, name: item.name, arguments: item.args },
      }));
    },
    usage(u) {
      if (!u) return;
      if (u.input != null) usage.input = u.input;
      if (u.output != null) usage.output = u.output;
    },
    stop() { /* completed 事件里带 status */ },
    end() {
      write(sse('response.completed', {
        type: 'response.completed',
        response: {
          id, object: 'response', status: 'completed', model,
          output: [], usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output },
        },
      }));
    },
  };
}
