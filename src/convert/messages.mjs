/**
 * Anthropic Messages ⇄ 规范中间表示
 * 事件形状参考：/v1/messages（非流式）与 SSE（message_start → content_block_delta → message_stop）
 */
import { sse } from './sse.mjs';

const DEFAULT_MAX_TOKENS = 4096;

/* ------------------------------------------------------------ request in */

export function toCanonicalRequest(p) {
  const messages = [];
  if (p.system) messages.push({ role: 'system-note', text: blocksText(p.system) });

  for (const m of p.messages || []) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, text: m.content });
      continue;
    }
    const msg = { role: m.role, text: '', parts: [] };
    const toolCalls = [];
    const toolResults = [];
    for (const b of m.content || []) {
      if (b.type === 'text') { msg.text += b.text || ''; msg.parts.push({ type: 'text', text: b.text || '' }); }
      else if (b.type === 'image') {
        if (b.source?.type === 'base64') msg.parts.push({ type: 'image', mediaType: b.source.media_type, data: b.source.data });
        else if (b.source?.url) msg.parts.push({ type: 'image', url: b.source.url });
      } else if (b.type === 'tool_use') {
        toolCalls.push({ id: b.id, name: b.name, argsJson: JSON.stringify(b.input ?? {}) });
      } else if (b.type === 'tool_result') {
        toolResults.push({ toolCallId: b.tool_use_id, content: blocksText(b.content), isError: b.is_error === true });
      }
    }
    if (toolCalls.length) msg.toolCalls = toolCalls;
    if (toolResults.length) msg.toolResults = toolResults;
    messages.push(msg);
  }

  return {
    model: p.model,
    system: messages.filter((m) => m.role === 'system-note').map((m) => m.text).join('\n\n') || null,
    messages: messages.filter((m) => m.role !== 'system-note'),
    tools: (p.tools || []).map((t) => ({
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    })),
    toolChoice: mapToolChoice(p.tool_choice),
    maxTokens: p.max_tokens ?? null,
    temperature: p.temperature,
    topP: p.top_p,
    stop: p.stop_sequences || null,
    stream: p.stream === true,
  };
}

function blocksText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b.type === 'text' ? b.text : typeof b === 'string' ? b : '')).join('');
  }
  return '';
}

function mapToolChoice(tc) {
  if (!tc) return null;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool') return { name: tc.name };
  return null;
}

/* ------------------------------------------------------------ request out */

export function fromCanonicalRequest(c) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role && role === 'user') {
      last.content = [...(Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content || '') }]), ...blocks];
      return;
    }
    out.push({ role, content: blocks });
  };

  for (const m of c.messages) {
    if (m.role === 'tool' || (m.toolResults && m.toolResults.length)) {
      push('user', (m.toolResults || []).map((tr) => ({
        type: 'tool_result',
        tool_use_id: tr.toolCallId,
        content: tr.content || '',
        ...(tr.isError ? { is_error: true } : {}),
      })));
      continue;
    }
    const blocks = [];
    const parts = m.parts && m.parts.length ? m.parts : [{ type: 'text', text: m.text ?? '' }];
    for (const part of parts) {
      if (part.type === 'image') {
        blocks.push(part.data
          ? { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } }
          : { type: 'image', source: { type: 'url', url: part.url } });
      } else if (part.text) {
        blocks.push({ type: 'text', text: part.text });
      }
    }
    for (const tc of m.toolCalls || []) {
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: safeJson(tc.argsJson) });
    }
    if (!blocks.length) blocks.push({ type: 'text', text: '' });
    push(m.role, blocks);
  }

  const body = {
    model: c.model,
    max_tokens: c.maxTokens || DEFAULT_MAX_TOKENS,
    messages: out,
  };
  if (c.system) body.system = c.system;
  if (c.tools && c.tools.length) {
    body.tools = c.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  if (c.toolChoice) {
    if (c.toolChoice === 'auto') body.tool_choice = { type: 'auto' };
    else if (c.toolChoice === 'required') body.tool_choice = { type: 'any' };
    else if (c.toolChoice === 'none') body.tool_choice = { type: 'none' };
    else body.tool_choice = { type: 'tool', name: c.toolChoice.name };
  }
  if (c.temperature != null) body.temperature = c.temperature;
  if (c.topP != null) body.top_p = c.topP;
  if (c.stop && c.stop.length) body.stop_sequences = c.stop;
  if (c.stream) body.stream = true;
  return body;
}

function safeJson(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

/* ------------------------------------------------------------ response in */

export function toCanonicalResponse(json) {
  let text = '';
  const toolCalls = [];
  for (const b of json.content || []) {
    if (b.type === 'text') text += b.text || '';
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, argsJson: JSON.stringify(b.input ?? {}) });
  }
  return {
    id: json.id,
    model: json.model,
    text,
    toolCalls,
    stopReason: mapStop(json.stop_reason),
    usage: { input: json.usage?.input_tokens ?? null, output: json.usage?.output_tokens ?? null },
  };
}

function mapStop(reason) {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'refusal') return 'content_filter';
  return 'stop';
}

/* ------------------------------------------------------------ response out */

export function fromCanonicalResponse(c, meta = {}) {
  const content = [];
  if (c.text) content.push({ type: 'text', text: c.text });
  for (const tc of c.toolCalls || []) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: safeJson(tc.argsJson) });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: c.id || meta.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: c.model || meta.model,
    content,
    stop_reason: stopOut(c.stopReason),
    stop_sequence: null,
    usage: {
      input_tokens: c.usage?.input ?? 0,
      output_tokens: c.usage?.output ?? 0,
    },
  };
}

function stopOut(reason) {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'content_filter') return 'refusal';
  return 'end_turn';
}

/* ------------------------------------------------------------ stream */

export function parseStream(emit) {
  let inputTokens = 0;
  let started = false;

  return {
    handle(ev) {
      const j = ev.json;
      const type = ev.event !== 'message' ? ev.event : j?.type;
      if (!j && ev.event !== 'done') return;

      if (type === 'message_start') {
        started = true;
        inputTokens = j.message?.usage?.input_tokens ?? 0;
        emit.start({ id: j.message?.id, model: j.message?.model });
        return;
      }
      if (type === 'content_block_start') {
        const b = j.content_block || {};
        if (b.type === 'tool_use') emit.toolStart({ index: j.index, id: b.id, name: b.name });
        return;
      }
      if (type === 'content_block_delta') {
        const d = j.delta || {};
        if (d.type === 'text_delta' && d.text) emit.text(d.text);
        else if (d.type === 'input_json_delta' && d.partial_json) emit.toolArgs({ index: j.index, delta: d.partial_json });
        return;
      }
      if (type === 'content_block_stop') { emit.toolEnd({ index: j.index }); return; }
      if (type === 'message_delta') {
        emit.usage({ input: inputTokens, output: j.usage?.output_tokens ?? null });
        if (j.delta?.stop_reason) emit.stop({ reason: mapStop(j.delta.stop_reason) });
        return;
      }
      if (type === 'message_stop' || ev.event === 'done') { emit.end(); }
    },
  };
}

export function createStreamWriter(write, meta = {}) {
  let index = 0;
  let textOpen = false;
  let id = meta.id || `msg_${Date.now()}`;
  let model = meta.model;
  let inputTokens = 0;
  let outputTokens = 0;
  const openTools = new Set();

  return {
    start(info) {
      id = info?.id || id;
      model = info?.model || model;
      write(sse('message_start', {
        type: 'message_start',
        message: {
          id, type: 'message', role: 'assistant', model, content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
    },
    text(t) {
      if (!t) return;
      if (!textOpen) {
        write(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
        textOpen = true;
      }
      write(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } }));
    },
    toolStart({ id: toolId, name }) {
      if (textOpen) {
        write(sse('content_block_stop', { type: 'content_block_stop', index }));
        index += 1;
        textOpen = false;
      }
      openTools.add(index);
      write(sse('content_block_start', {
        type: 'content_block_start', index,
        content_block: { type: 'tool_use', id: toolId, name, input: {} },
      }));
    },
    toolArgs({ delta }) {
      const idx = [...openTools].pop() ?? index;
      write(sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: delta } }));
    },
    toolEnd() {
      if (openTools.size) {
        const idx = [...openTools].pop();
        write(sse('content_block_stop', { type: 'content_block_stop', index: idx }));
        index = Math.max(index, idx) + 1;
      }
    },
    usage(u) {
      if (u?.input != null) inputTokens = u.input;
      if (u?.output != null) outputTokens = u.output;
    },
    stop({ reason }) {
      if (textOpen) {
        write(sse('content_block_stop', { type: 'content_block_stop', index }));
        textOpen = false;
        index += 1;
      }
      write(sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopOut(reason), stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }));
    },
    end() {
      write(sse('message_stop', { type: 'message_stop' }));
    },
  };
}
