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

export function videoCommand(prores = false, regular = false) {
  const codec = prores ? "-c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le" : "-c:v libx264 -pix_fmt yuv420p";
  const live = prores || regular ? "" : " -g 30 -bf 0 -movflags frag_keyframe+empty_moov+default_base_moof -flush_packets 1";
  return `ffmpeg -hide_banner -y -re -f lavfi -i testsrc=duration=6:size=320x240:rate=30 -frames:v 180 ${codec}${live} -stats_period 0.25 -progress pipe:1 ${prores ? "unsupported.mov" : regular ? "regular.mp4" : "out.mp4"}`;
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

export function bashTraceCalls() {
  return [
    { name: "bash", args: { i: "Exercising many shell trace producers", command: "for ((i=0; i<3500; i++)); do value=\"producer-$i\"; printf '%s:%080d\\n' \"$value\" \"$i\"; done", timeout: 120 }, slow: false },
    { name: "bash", args: { i: "Exercising large shell trace values", command: "printf -v payload '%032768d' 0; for ((i=0; i<350; i++)); do value=\"$payload:$i\"; printf '%s\\n' \"$value\"; done", timeout: 120 }, slow: false },
    { name: "bash", args: { i: "Exercising dense shell trace output", command: "python3 -c \"import sys; sys.stdout.write(''.join(f'{i:04d}' + 'x'*4091 + '\\n' for i in range(2048)))\"", timeout: 120 }, slow: false },
  ];
}

function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  return (message?.content ?? []).map(part => part.text ?? "").join("\n");
}

export async function startFixture({ root, port = 47831, durationMs = 15000, onRequest = () => {}, initializeProfile = true }) {
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
      const turnMessages = messages.slice(messages.findLastIndex(message => message.role === "user"));
      const afterTool = messages.at(-1)?.role === "tool";
      const fixture = /fixture\s+(bash-trace|helper-reply|colors|helper|notes|process|svg|html|png|image|isolation|video|sequence|progress|prores|proof|docx|xlsx|pptx|regular-video)/i.exec(textOf(lastUser))?.[1]?.toLowerCase();
      const htmlNeedsPage = afterTool && fixture === "html" && !turnMessages.some(message =>
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
      if (fixture === "colors") {
        send({ role: "assistant", content: "Check prose swatches: #2B72E5 and #197f8680. Check inline swatches: `#fff`, `#1234`, `#2B72E5`, `#197f8680`. Issue #123, https://example.invalid/#2B72E5 and /tmp/#2B72E5 stay plain.\n\n```css\n/* Code blocks stay unchanged. */\ncolor: #2B72E5;\n```\n" });
      } else if (fixture === "helper-reply") {
        send({ role: "assistant", content: "The helper checked the sample. Open this conversation from Tasks in the live chat, then send a message while the helper is idle to check delivery. The fixture provider answers locally." });
        send({}, "stop");
        response.end("data: [DONE]\n\n");
        return;
      } else if (fixture === "notes") {
        send({ role: "assistant", content: "The release checks are in the first message. This chat uses the local fixture model. Settings and commands still need your interaction, and platform-specific checks require the target platform." });
        send({}, "stop");
        response.end("data: [DONE]\n\n");
        return;
      }
      send({ role: "assistant", content: afterTool ? "The fixture tool result was received." : fixture ? `I will prepare the ${fixture} fixture.` : "The correction was received." });
      if ((afterTool && !htmlNeedsPage && !["proof", "helper", "process"].includes(fixture)) || !fixture) {
        send({}, "stop");
        response.end("data: [DONE]\n\n");
        return;
      }
      const helperCalls = turnMessages.flatMap(message => message.tool_calls ?? []);
      const calls = fixture === "bash-trace" ? bashTraceCalls() : fixture === "colors" ? [
        { name: "ask", args: { questions: [{ id: "color", question: "Which color should the fixture use: #2B72E5 or #197f8680?", options: [{ label: "#2B72E5", description: "Opaque blue #2B72E5" }, { label: "#197f8680", description: "Transparent teal #197f8680" }] }] }, slow: false },
      ] : fixture === "helper" ? !afterTool ? [
        { name: "task", args: { i: "Checking release helper conversation", context: "Use the local fixture provider. Do not run tools, checks or edit files.", tasks: [{ name: "TourHelper", task: "fixture helper-reply. Reply with the short release-tour helper check.", solutionSpace: "One fixed reply, no investigation." }] }, slow: false },
      ] : helperCalls.some(call => call.function?.name === "wait") ? [] : [
        { name: "wait", args: { i: "Waiting for tour helper" }, slow: false },
      ] : fixture === "process" ? !afterTool ? [
        { name: "bash", args: { i: "Starting process exit example", command: "python3 -u -c \"import time; print('tour process ready', flush=True); time.sleep(1); raise SystemExit(1)\"", name: "tour-process", pty: false, timeout: 0, ready: { log: "tour process ready" } }, slow: false },
      ] : helperCalls.filter(call => call.function?.name === "bash").length === 1 ? [
        { name: "bash", args: { i: "Recording supervised process exit", command: "python3 -c \"import time; time.sleep(2)\"", timeout: 10 }, slow: false },
      ] : [] : fixture === "proof" ? proofCalls(turnMessages, videoCommand()) : htmlNeedsPage ? [
        { name: "write", args: { path: "page.html", content: pageHtml() }, slow: true },
      ] : fixture === "html" ? [
        { name: "write", args: { path: "style.css", content: css }, slow: false },
        { name: "write", args: { path: "image.svg", content: image }, slow: false },
      ] : fixture === "isolation" ? [
        { name: "write", args: { path: "isolation.html", content: isolationHtml() }, slow: false },
      ] : fixture === "png" ? [
        { name: "bash", args: { command: pngCommand(), timeout: 30 }, slow: false },
      ] : fixture === "video" || fixture === "prores" || fixture === "regular-video" ? [
        { name: "bash", args: { command: videoCommand(fixture === "prores", fixture === "regular-video"), timeout: 30 }, slow: false },
      ] : fixture === "sequence" ? [
        { name: "bash", args: { command: sequenceCommand(), timeout: 30 }, slow: false },
      ] : ["docx", "xlsx", "pptx"].includes(fixture) ? [
        { name: "bash", args: { command: officeCommand(fixture, 1, !/fixture\s+(docx|xlsx|pptx)\s+complete/i.test(textOf(lastUser))), timeout: 60 }, slow: false },
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
  try { if (initializeProfile) await initializeFixture(root, baseUrl); }
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
