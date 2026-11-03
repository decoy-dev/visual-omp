import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type ScriptedReply = { text?: string; prefix?: string; tool?: { name: string; arguments: object }; delayMs?: number; gate?: string; error?: string };

export interface ScriptedProvider {
  requests: object[];
  release: (gate: string) => void;
  stop: () => void;
}

/** Shared loopback provider; optional models support session-switch compaction probes. */
export async function scriptedProvider(script: ScriptedReply[], agent: string, models?: object[]): Promise<ScriptedProvider> {
  const requests: object[] = [];
  const gates = new Map<string, PromiseWithResolvers<void>>();
  const released = new Set<string>();
  const release = (name: string) => { released.add(name); gates.get(name)?.resolve(); };
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== "/v1/chat/completions" || request.method !== "POST") { response.writeHead(404).end(); return; }
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
      const index = requests.length;
      requests.push(body);
      const reply = script[index];
      if (!reply) { response.writeHead(500).end(`No scripted response for request ${index + 1}`); return; }
      const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: `fixture-${index}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      if (reply.prefix) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(chunk({ role: "assistant", content: reply.prefix }, null));
      }
      if (reply.gate && !released.has(reply.gate)) {
        const gate = gates.get(reply.gate) ?? Promise.withResolvers<void>();
        gates.set(reply.gate, gate);
        await gate.promise;
      }
      if (reply.delayMs) await sleep(reply.delayMs);
      if (reply.error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: reply.error, type: "invalid_request_error", code: "invalid_request_error" } }));
        return;
      }
      const delta = reply.tool
        ? { role: "assistant", tool_calls: [{ index: 0, id: `fixture-tool-${index}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.arguments) } }] }
        : { role: "assistant", content: reply.text ?? "Fixture response." };
      if (!reply.prefix) response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(chunk(delta, null) + chunk({}, reply.tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback provider port");
  await writeFile(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-fixture-only", api: "openai-completions",
    models: models ?? [{ id: "fixture-model", name: "Local scripted fixture", reasoning: true, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  } } }));
  return { requests, release, stop: () => { for (const gate of gates.values()) gate.resolve(); server.closeAllConnections(); server.close(); } };
}
