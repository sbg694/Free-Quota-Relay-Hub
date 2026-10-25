/** SSE 解析与序列化（v2 协议转换的底座） */

export class SseParser {
  constructor(onEvent) {
    this.buf = '';
    this.onEvent = onEvent;
  }

  feed(chunk) {
    this.buf += chunk.toString('utf8').replace(/\r\n/g, '\n');
    let idx;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.handle(raw);
    }
  }

  end() {
    if (this.buf.trim()) {
      const raw = this.buf;
      this.buf = '';
      this.handle(raw);
    }
  }

  handle(raw) {
    let event = 'message';
    const data = [];
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) return;
    const payload = data.join('\n');
    if (payload === '[DONE]') { this.onEvent({ event: 'done', json: null, raw: payload }); return; }
    let json = null;
    try { json = JSON.parse(payload); } catch { /* 非 JSON 的 data 原样传 */ }
    this.onEvent({ event, json, raw: payload });
  }
}

export function sse(event, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return event && event !== 'message' ? `event: ${event}\ndata: ${body}\n\n` : `data: ${body}\n\n`;
}

export const done = () => 'data: [DONE]\n\n';
