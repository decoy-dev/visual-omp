import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { initializeFixture } from "./environment.mjs";
import { isolationHtml } from "./isolation-page.mjs";
import { proofCalls } from "./proof.mjs";
import { officeCommand } from "./office.mjs";

export function posterSvg() {
  const lines = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960" viewBox="0 0 720 960">',
    '<rect width="720" height="960" fill="#f5f4ee"/>',
    '<text x="42" y="80" font-family="sans-serif" font-size="38" fill="#183a40">Streaming poster</text>',
    '<text x="42" y="116" font-family="sans-serif" font-size="18" fill="#183a40">Shapes arrive before this file is saved.</text>',
  ];
  for (let i = 0; i < 295; i++) {
    const x = 45 + (i % 15) * 44;
    const y = 165 + Math.floor(i / 15) * 36;
    lines.push(`<circle cx="${x}" cy="${y}" r="${6 + i % 10}" fill="${["#197f86", "#db783e", "#183a40"][i % 3]}"/>`);
  }
  lines.push("</svg>");
  return lines.join("\n") + "\n";
}

const image = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#197f86"/><circle cx="80" cy="50" r="30" fill="#f5f4ee"/></svg>\n';
const css = 'body { margin: 32px; font: 20px sans-serif; background: #f5f4ee; color: #183a40; } h1 { color: #197f86; } img { max-width: 320px; }\n';
function pageHtml() {
  return [
    '<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">',
    '<title>Static preview fixture</title>', '<link rel="stylesheet" href="style.css">',
    '<link rel="stylesheet" href="https://example.invalid/remote.css">',
    '<style>@font-face { font-family: remote; src: url(https://example.invalid/remote.woff2); } .remote-font { font-family: remote; }</style>',
    '<meta http-equiv="refresh" content="3;url=https://example.invalid/refresh">', '</head>', '<body>',
    '<h1>Static preview fixture</h1>', '<p>The local stylesheet and image should load.</p>',
    '<img src="image.svg" alt="Local fixture image">',
    '<img src="https://example.invalid/remote.png" alt="Remote image must stay blocked">',
    '<p class="remote-font">The remote font must stay blocked.</p>',
    '<p><a href="https://example.invalid/link">Try navigation</a></p>',
    '<form action="https://example.invalid/form"><button type="submit">Try form submission</button></form>',
    '<p id="scripts">Scripts have not run.</p>',
    '<script>document.querySelector("#scripts").textContent = "Script ran"; fetch("https://example.invalid/fetch");</script>',
    ...Array.from({ length: 80 }, (_, i) => `<p>Streaming paragraph ${i + 1}.</p>`),
    '</body>', '</html>',
  ].join("\n") + "\n";
}

function pngCommand() {
  return `python3 - <<'PY'\nimport pathlib, struct, time, zlib\np = pathlib.Path('frames.png')\ndef chunk(kind, data):\n    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)\nfor i, rgb in enumerate([(25,127,134), (219,120,62), (24,58,64)]):\n    raw = (b'\\x00' + bytes(rgb) * 240) * 160\n    png = b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB',240,160,8,2,0,0,0)) + chunk(b'IDAT',zlib.compress(raw)) + chunk(b'IEND',b'')\n    p.write_bytes(png)\n    print(str(p.resolve()) + ' save ' + str(i + 1), flush=True)\n    time.sleep(1)\nPY`;
}

export function videoCommand(prores = false) {
  const codec = prores ? "-c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le" : "-c:v libx264 -pix_fmt yuv420p";
  return `ffmpeg -hide_banner -y -re -f lavfi -i testsrc=duration=6:size=320x240:rate=30 -frames:v 180 ${codec} -stats_period 0.25 -progress pipe:1 ${prores ? "unsupported.mov" : "out.mp4"}`;
}

export function sequenceCommand() {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
  const unrelated = `import base64,pathlib; folder=pathlib.Path('frames'); folder.mkdir(exist_ok=True); [(folder/f'photo{i}.png').write_bytes(base64.b64decode('${png}')) for i in range(1,4)]`;
  return `python3 -c "${unrelated}" && ffmpeg -hide_banner -y -re -f lavfi -i testsrc=duration=6:size=320x240:rate=1 -frames:v 6 -stats_period 0.25 -progress pipe:1 frames/frame%04d.png`;
}

async function progressCalls() {
  return Promise.all(["remotion-4.0.391-video.json", "manim-0.19.0-video.json"].map(async name => {
    const sample = JSON.parse(await readFile(new URL(`./samples/${name}`, import.meta.url), "utf8"));
    const replay = `import sys,time; lines=${JSON.stringify(sample.output)}.splitlines(); delay=6/max(1,len(lines)); [(print(line,flush=True),time.sleep(delay)) for line in lines]`;
    // The function replays the captured tool log; this scenario does not run either renderer.
    const quoted = `'${replay.replaceAll("'", "'\\''")}'`;
    const invocation = sample.tool === "remotion" ? "remotion render index.jsx Sample progress.mp4" : "manim render -ql scene.py Sample";
    return { name: "bash", args: { command: `${sample.tool}() { python3 -c ${quoted}; }\n${invocation}`, timeout: 30 }, slow: false };
  }));
}

function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  return (message?.content ?? []).map(part => part.text ?? "").join("\n");
}

export async function startFixture({ root, port = 47831, durationMs = 15000, onRequest = () => {} }) {
  let sequence = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/health" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" }).end('{"fixture":"live-preview"}');
        return;
      }
      if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const id = ++sequence;
      const messages = body.messages ?? [];
      const lastUser = messages.findLast(message => message.role === "user");
      const afterTool = messages.at(-1)?.role === "tool";
      const fixture = /fixture\s+(svg|html|png|image|isolation|video|sequence|progress|prores|proof|docx|xlsx|pptx)/i.exec(textOf(lastUser))?.[1]?.toLowerCase();
      const htmlNeedsPage = afterTool && fixture === "html" && !messages.some(message =>
        (message.tool_calls ?? []).some(call => {
          try { return call.function?.name === "write" && JSON.parse(call.function.arguments).path === "page.html"; }
          catch { return false; }
        }));
      onRequest({ id, fixture, afterTool, tools: (body.tools ?? []).map(tool => tool.function?.name) });
      const send = (delta, finish_reason = null) => {
        if (response.destroyed) return;
        response.write(`data: ${JSON.stringify({ id: `fixture-${id}`, object: "chat.completion.chunk", created: 1, model: "preview", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      send({ role: "assistant", content: afterTool ? "The fixture tool result was received." : fixture ? `I will prepare the ${fixture} fixture.` : "The correction was received." });
      if ((afterTool && !htmlNeedsPage && fixture !== "proof") || !fixture) {
        send({}, "stop");
        response.end("data: [DONE]\n\n");
        return;
      }
      const calls = fixture === "proof" ? proofCalls(messages, videoCommand()) : htmlNeedsPage ? [
        { name: "write", args: { path: "page.html", content: pageHtml() }, slow: true },
      ] : fixture === "html" ? [
        { name: "write", args: { path: "style.css", content: css }, slow: false },
        { name: "write", args: { path: "image.svg", content: image }, slow: false },
      ] : fixture === "isolation" ? [
        { name: "write", args: { path: "isolation.html", content: isolationHtml() }, slow: false },
      ] : fixture === "png" ? [
        { name: "bash", args: { command: pngCommand(), timeout: 30 }, slow: false },
      ] : fixture === "video" || fixture === "prores" ? [
        { name: "bash", args: { command: videoCommand(fixture === "prores"), timeout: 30 }, slow: false },
      ] : fixture === "sequence" ? [
        { name: "bash", args: { command: sequenceCommand(), timeout: 30 }, slow: false },
      ] : ["docx", "xlsx", "pptx"].includes(fixture) ? [
        { name: "bash", args: { command: officeCommand(fixture), timeout: 60 }, slow: false },
      ] : fixture === "progress" ? await progressCalls() : fixture === "image" ? [
        { name: "generate_image", args: { subject: "A measured architectural poster. " + "Use a teal circle on a cream background. ".repeat(200), image_size: "1024x1024", aspect_ratio: "1:1" }, slow: true },
      ] : [{ name: "write", args: { path: "poster.svg", content: posterSvg() }, slow: true }];
      for (const [index, call] of calls.entries()) {
        send({ tool_calls: [{ index, id: `fixture-${id}-${index}`, type: "function", function: { name: call.name, arguments: "" } }] });
        const args = JSON.stringify(call.args);
        const count = call.slow ? 150 : 1;
        const width = Math.ceil(args.length / count);
        for (let offset = 0; offset < args.length; offset += width) {
          if (response.destroyed) return;
          send({ tool_calls: [{ index, function: { arguments: args.slice(offset, offset + width) } }] });
          if (call.slow) await sleep(durationMs / count);
        }
      }
      send({}, calls.length ? "tool_calls" : "stop");
      response.end("data: [DONE]\n\n");
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try { await initializeFixture(root, baseUrl); }
  catch (error) { server.close(); throw error; }
  return { baseUrl, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes("--root")) throw new Error("Usage: node server.mjs --root <scratch-directory> [--port <port>]");
  const fixture = await startFixture({ root: value("--root"), port: args.includes("--port") ? Number(value("--port")) : 47831 });
  console.log(`Live preview fixture listening at ${fixture.baseUrl}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await fixture.close(); });
}
