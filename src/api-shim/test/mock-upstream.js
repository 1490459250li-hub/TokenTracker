"use strict";
// Mock OpenAI-compatible upstream for shim verification (test only).
const http = require("node:http");
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let stream = false;
    try { stream = JSON.parse(body).stream === true; } catch {}
    // Echo the auth header so we can assert key replacement happened.
    const auth = req.headers.authorization || "";
    const model = (() => { try { return JSON.parse(body).model; } catch { return "mock-model"; } })();
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"1","model":"' + model + '","choices":[{"delta":{"content":"Hi"}}]}\n\n');
      res.write('data: {"id":"2","model":"' + model + '","choices":[{"delta":{"content":"!"}}]}\n\n');
      res.write('data: {"id":"3","model":"' + model + '","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"total_tokens":1050,"prompt_tokens_details":{"cached_tokens":200},"completion_tokens_details":{"reasoning_tokens":10}}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "1", model,
        choices: [{ message: { role: "assistant", content: "Hello" } }],
        usage: { prompt_tokens: 500, completion_tokens: 30, total_tokens: 530, prompt_tokens_details: { cached_tokens: 100 } },
        _auth_seen: auth,
      }));
    }
  });
});
server.listen(17999, "127.0.0.1", () => console.log("mock upstream on 17999"));
