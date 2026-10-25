/**
 * OpenAI Chat Completions ⇄ 规范中间表示
 *
 * 规范请求（CanonicalRequest）：
 *   { model, system, messages:[{role, text, parts?, toolCalls?, toolResults?}],
 *     tools:[{name,description,parameters}], toolChoice, maxTokens, temperature, topP, stop, stream }
 * 规范响应（CanonicalResponse）：
 *   { id, model, text, toolCalls:[{id,name,argsJson}], stopReason, usage:{input,output} }
 *
 * 工具调用统一用 `argsJson`（字符串）保存，避免各协议反复 JSON.parse 出错。
 */
import { sse, done } from './sse.mjs';

/* ------------------------------------------------------------ request in */

export function toCanonicalRequest(p) {
  const system = [];
  const messages = [];
  for (const m of p.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      system.push(textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      messages.push({
        role: 'tool',
        toolResults: [{ toolCallId: m.tool_call_id, content: textOf(m.content) }],
      });
      continue;
    }
    const msg = { role: m.role === 'assistant' ? 'assistant' : 'user' };
    if (Array.isArray(m.content)) {
      msg.parts = m.content.map((part) => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        if (part.type === 'image_url') return imageFromUrl(part.image_url?.url);
        return { type: 'text', text: '' };
      });
      msg.text = msg.parts.filter((x) => x.type === 'text').map((x) => x.text).join('');
    } else {
      msg.text = typeof m.content === 'string' ? m.content : '';
    }
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      msg.toolCalls = m.tool_calls.map((tc, i) => ({
        id: tc.id || `call_${i}`,
        name: tc.function?.name || '',
        argsJson: tc.function?.arguments || '{}',
      }));
    }
    messages.push(msg);
  }
  return {
    model: p.model,
    system: system.filter(Boolean).join('\n\n') || null,
    messages,
    tools: (p.tools || []).filter((t) => t.type === 'function').map((t) => ({
      name: t.function?.name,
      description: t.function?.description || '',
      parameters: t.function?.parameters || { type: 'object', properties: {} },
    })),
    toolChoice: mapToolChoice(p.tool_choice),
    maxTokens: p.max_tokens ?? p.max_completion_tokens ?? null,
    temperature: p.temperature,
    topP: p.top_p,
    stop: p.stop ? (Array.isArray(p.stop) ? p.stop : [p.stop]) : null,
    stream: p.stream === true,
  };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text || '').join('');
  return '';
}

function imageFromUrl(url) {
  if (!url) return { type: 'text', text: '' };
  const m = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (m) return { type: 'image', mediaType: m[1], data: m[2] };
  return { type: 'image', url };
}

function mapToolChoice(tc) {
  if (!tc) return null;
  if (tc === 'auto') return 'auto';
  if (tc === 'none') return 'none';
  if (tc === 'required') return 'required';
  if (tc.type === 'function') return { name: tc.function?.name };
  return null;
}

/* ------------------------------------------------------------ request out */

export function fromCanonicalRequest(c) {
  const messages = [];
  if (c.system) messages.push({ role: 'system', content: c.system });

  for (const m of c.messages) {
    if (m.role === 'tool' || (m.toolResults && m.toolResults.length)) {
      for (const tr of m.toolResults || []) {
        messages.push({ role: 'tool', tool_call_id: tr.toolCallId, content: tr.content });
      }
      if (m.text || (m.parts && m.parts.length)) {
        messages.push({ role: 'user', content: m.text || '' });
      }
      continue;
    }
    const out = { role: m.role };
    if (m.parts && m.parts.some((x) => x.type === 'image')) {
      out.content = m.parts.map((part) => (part.type === 'image'
        ? (part.data
          ? { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } }
          : { type: 'image_url', image_url: { url: part.url } })
        : { type: 'text', text: part.text }));
    } else {
      out.content = m.text ?? '';
    }
    if (m.toolCalls && m.toolCalls.length) {
      out.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.argsJson || '{}' },
      }));
      if (!out.content) out.content = null;
    }
    messages.push(out);
  }

  const body = { model: c.model, messages };
  if (c.tools && c.tools.length) {
    body.tools = c.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  const choice = toolChoiceOut(c.toolChoice);
  if (choice !== undefined) body.tool_choice = choice;
  if (c.maxTokens) body.max_tokens = c.maxTokens;
  if (c.temperature != null) body.temperature = c.temperature;
  if (c.topP != null) body.top_p = c.topP;
  if (c.stop && c.stop.length) body.stop = c.stop;
  if (c.stream) body.stream = true;
  return body;
}

function toolChoiceOut(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  return { type: 'function', function: { name: tc.name } };
}

/* ------------------------------------------------------------ response in */

export function toCanonicalResponse(json) {
  const choice = json.choices?.[0] || {};
  const msg = choice.message || {};
  const text = textOf(msg.content);
  const toolCalls = (msg.tool_calls || []).map((tc, i) => ({
    id: tc.id || `call_${i}`,
    name: tc.function?.name || '',
    argsJson: tc.function?.arguments || '{}',
  }));
  return {
    id: json.id,
    model: json.model,
    text,
    toolCalls,
    stopReason: mapFinish(choice.finish_reason),
    usage: {
      input: json.usage?.prompt_tokens ?? null,
      output: json.usage?.completion_tokens ?? null,
    },
  };
}

function mapFinish(fr) {
  if (fr === 'length') return 'length';
  if (fr === 'tool_calls' || fr === 'function_call') return 'tool_use';
  if (fr === 'content_filter') return 'content_filter';
  return 'stop';
}

/* ------------------------------------------------------------ response out */

export function fromCanonicalResponse(c, meta = {}) {
  const message = { role: 'assistant', content: c.text || null };
  if (c.toolCalls && c.toolCalls.length) {
    message.tool_calls = c.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.argsJson || '{}' },
    }));
  }
  return {
    id: c.id || meta.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: c.model || meta.model,
    choices: [{ index: 0, message, finish_reason: finishOut(c.stopReason) }],
    usage: usageOut(c.usage),
  };
}

function finishOut(reason) {
  if (reason === 'length') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'content_filter') return 'content_filter';
  return 'stop';
}

function usageOut(u = {}) {
  const input = u.input ?? 0;
  const output = u.output ?? 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

/* ------------------------------------------------------------ stream */

export function parseStream(emit) {
  let usage = null;
  let started = false;
  const tools = new Map();

  return {
    feed(chunk) {
      return chunk;
    },
    handle(ev) {
      if (ev.event === 'done') {
        emit.usage(usage);
        emit.stop({ reason: 'stop' });
        emit.end();
        return;
      }
      const j = ev.json;
      if (!j) return;
      if (j.usage) usage = { input: j.usage.prompt_tokens, output: j.usage.completion_tokens };
      const choice = j.choices?.[0];
      if (!choice) return;
      if (!started) {
        started = true;
        emit.start({ id: j.id, model: j.model });
      }
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) emit.text(delta.content);
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index ?? 0;
        if (!tools.has(idx)) {
          tools.set(idx, { id: tc.id || `call_${idx}`, name: tc.function?.name || '' });
          if (tc.function?.name) emit.toolStart({ index: idx, id: tc.id || `call_${idx}`, name: tc.function.name });
        }
        if (tc.function?.arguments) emit.toolArgs({ index: idx, delta: tc.function.arguments });
      }
      if (choice.finish_reason) emit.stop({ reason: mapFinish(choice.finish_reason) });
    },
  };
}

export function createStreamWriter(write, meta = {}) {
  let started = false;
  let id = meta.id || `chatcmpl-${Date.now()}`;
  let model = meta.model;

  const chunk = (delta, finish = null, extra = {}) => write(sse(null, {
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
  }));

  return {
    start(info) {
      if (started) return;
      started = true;
      id = info?.id || id;
      model = info?.model || model;
      chunk({ role: 'assistant', content: '' });
    },
    text(t) { if (t) chunk({ content: t }); },
    toolStart({ index, id: tcId, name }) {
      chunk({ tool_calls: [{ index, id: tcId, type: 'function', function: { name, arguments: '' } }] });
    },
    toolArgs({ index, delta }) {
      chunk({ tool_calls: [{ index, function: { arguments: delta } }] });
    },
    toolEnd() { /* chat 协议没有显式 tool end */ },
    usage(u) {
      if (!u) return;
      write(sse(null, {
        id, object: 'chat.completion.chunk', model,
        choices: [],
        usage: { prompt_tokens: u.input ?? 0, completion_tokens: u.output ?? 0, total_tokens: (u.input ?? 0) + (u.output ?? 0) },
      }));
    },
    stop({ reason }) { chunk({}, finishOut(reason)); },
    end() { write(done()); },
  };
}
