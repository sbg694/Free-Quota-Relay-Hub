/**
 * 本地假上游（演示 / 冒烟用，不产生任何费用）：node src/mock-upstream.mjs [--port 8899]
 *
 * 行为：
 *  - /v1/models            返回两个模型
 *  - /v1/chat/completions  支持 stream=true/false
 *  - 会在控制台打印收到的 user-agent 与关键头，用来肉眼确认改头是否生效
 *
 * 与 config.example.json 里的 mock-openai provider 对应（默认 8899）。
 */
import http from 'node:http';

const args = process.argv.slice(2);
const i = args.indexOf('--port');
const port = Number(i >= 0 ? args[i + 1] : 8899);

const MODELS = ['mock-model', 'mock-model-pro'];

function sse(res, text, usage) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const pieces = text.match(/[\s\S]{1,4}/g) || [text];
  let n = 0;
  const timer = setInterval(() => {
    if (n < pieces.length) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[n] } }] })}\n\n`);
      n += 1;
      return;
    }
    res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage })}\n\n`);
    res.write('data: [DONE]\n\n');
    clearInterval(timer);
    res.end();
  }, 20);
}

const server = http.createServer((req, res) => {
  const ua = req.headers['user-agent'] || '(none)';
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

    console.log(`[mock] ${req.method} ${req.url} ua="${ua}" auth=${String(req.headers.authorization || '').slice(0, 12)}… x-api-key=${req.headers['x-api-key'] ? 'yes' : 'no'}`);

    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'mock' })),
      }));
    }

    if (req.url.endsWith('/chat/completions')) {
      const question = (body.messages || []).map((m) => m.content).join(' ').slice(0, 40);
      const text = `[mock] 收到模型 ${body.model}，你说的是「${question}」。`;
      const usage = { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 };
      if (body.stream) return sse(res, text, usage);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage,
      }));
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found', path: req.url } }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock] 假上游已启动 http://127.0.0.1:${port}/v1  （模型：${MODELS.join(', ')}）`);
});
