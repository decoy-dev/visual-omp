// Local-only stress provider. All omp files are written under the explicit fixture root.
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { initializeFixture } from "../live-preview-fixture/environment.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const root = value("--root");
const port = Number(value("--port", 47832));
const seconds = Number(value("--seconds", 180));
const rounds = Number(value("--rounds", 1000));
if (!root || !Number.isInteger(port) || port < 0 || port > 65535 || !Number.isFinite(seconds) || seconds <= 0 || !Number.isInteger(rounds) || rounds <= 0) {
  throw new Error("Usage: node scripts/dev/stream-provider.mjs --root <scratch> [--port 47832] [--seconds 180] [--rounds 1000]");
}
let sequence = 0;
const words = "the quick brown fox jumps over the lazy dog while omp keeps streaming a long answer with code and prose".split(" ");
const textOf = message => typeof message?.content === "string" ? message.content : (message?.content ?? []).map(part => part.text ?? "").join("\n");
const server = createServer(async (request, response) => {
  if (request.url !== "/v1/chat/completions" || request.method !== "POST") { response.writeHead(404).end(); return; }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const id = ++sequence;
    const messages = body.messages ?? [];
    const lastUser = textOf(messages.findLast(message => message.role === "user"));
    const userIndex = messages.findLastIndex(message => message.role === "user");
    const toolResults = messages.slice(userIndex + 1).filter(message => message.role === "tool").length;
    console.log(`request ${id}: mode=${/stress tools/i.test(lastUser) ? "tools" : "text"} tools=${toolResults}`);
    const send = (delta, finish_reason = null) => {
      if (!response.destroyed) response.write(`data: ${JSON.stringify({ id: `stress-${id}`, object: "chat.completion.chunk", created: 1, model: "preview", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    };
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    send({ role: "assistant", content: "" });
    if (/stress tools/i.test(lastUser) && toolResults < rounds) {
      send({ content: `Round ${toolResults + 1}: listing numbers.\n` });
      send({ tool_calls: [{ index: 0, id: `stress-${id}-0`, type: "function", function: { name: "bash", arguments: "" } }] });
      // bash is available through omp on every supported platform, including Windows.
      const command = `for ((i=1;i<=400;i++)); do echo "line $i of round ${toolResults + 1} with some padding text to widen it"; done`;
      send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command, timeout: 30 }) } }] });
      send({}, "tool_calls");
    } else {
      if (/stress text/i.test(lastUser)) {
        const until = Date.now() + seconds * 1000;
        let n = 0;
        while (Date.now() < until && !response.destroyed) {
          // Varied words and a counter avoid omp's repeated-cycle loop detector.
          send({ content: Array.from({ length: 6 }, () => words[Math.floor(Math.random() * words.length)]).join(" ") + ` ${n}` + (n % 240 === 0 ? "\n\n" : " ") });
          n += 6;
          await sleep(20);
        }
      } else send({ content: "Done." });
      send({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.writeHead(400);
    response.end();
  }
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
const address = server.address();
await initializeFixture(root, `http://127.0.0.1:${address.port}/v1`);
console.log(`Stress provider listening at http://127.0.0.1:${address.port}/v1; fixture root: ${root}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.closeAllConnections(); server.close(); });
