/**
 * 协议转换总调度。
 *
 * 设计：三个协议各自实现「⇄ 规范中间表示」，任意两协议互转 = 两段映射组合，
 * 因此 3 个协议只需 6 份代码（3 进 + 3 出），而不是 6 组两两转换。
 *
 *   chat ⇄ canonical ⇄ messages ⇄ canonical ⇄ responses
 */
import * as chat from './chat.mjs';
import * as messages from './messages.mjs';
import * as responses from './responses.mjs';
import { SseParser } from './sse.mjs';

export const CONVERTIBLE = { chat, messages, responses };

export const isConvertible = (endpoint) => Object.hasOwn(CONVERTIBLE, endpoint);

export function convertRequest(fromEndpoint, toEndpoint, payload) {
  const from = CONVERTIBLE[fromEndpoint];
  const to = CONVERTIBLE[toEndpoint];
  if (!from || !to) throw new Error(`不支持从 ${fromEndpoint} 转换到 ${toEndpoint}`);
  if (from === to) return payload;
  return to.fromCanonicalRequest(from.toCanonicalRequest(payload));
}

export function convertResponse(fromEndpoint, toEndpoint, json, meta = {}) {
  const from = CONVERTIBLE[fromEndpoint];
  const to = CONVERTIBLE[toEndpoint];
  if (!from || !to) return json;
  if (from === to) return json;
  return to.fromCanonicalResponse(from.toCanonicalResponse(json), meta);
}

/**
 * 流式桥：把上游协议的 SSE 解析成规范事件，再用客户端协议序列化。
 * 返回 { feed(chunk), end(), usage() }
 */
export function createStreamBridge({ fromEndpoint, toEndpoint, write, meta = {} }) {
  const writer = CONVERTIBLE[toEndpoint].createStreamWriter(write, meta);
  const parser = CONVERTIBLE[fromEndpoint].parseStream(writer);
  const sse = new SseParser((ev) => parser.handle(ev));

  const captured = { input: null, output: null };
  const origUsage = writer.usage;
  writer.usage = (u) => {
    if (u) {
      if (u.input != null) captured.input = u.input;
      if (u.output != null) captured.output = u.output;
    }
    return origUsage.call(writer, u);
  };

  return {
    feed(chunk) { sse.feed(chunk); },
    end() {
      try { sse.end(); } catch { /* 上游流不完整时忽略解析错误 */ }
      writer.end();
    },
    usage() {
      if (captured.input == null && captured.output == null) return { promptTokens: null, completionTokens: null, estimated: true };
      return { promptTokens: captured.input, completionTokens: captured.output, estimated: false };
    },
  };
}

/** 错误体按客户端协议输出，避免客户端解析不到；extra 用于带上排查信息（last/attempts） */
export function formatError(endpoint, status, type, message, extra = {}) {
  if (endpoint === 'messages') {
    return { type: 'error', error: { type, message, ...extra } };
  }
  if (endpoint === 'responses') {
    return { error: { message, type, code: status, ...extra } };
  }
  return { error: { message, type, ...extra } };
}
