const MAX_BODY_BYTES = 1024;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\s\S])/;
const PLATFORMS: Record<string, true> = { darwin: true, win32: true, linux: true };
const ARCHITECTURES: Record<string, true> = { arm64: true, x64: true, ia32: true };

interface Check {
  version: string;
  platform: string;
  arch: string;
  channel?: string;
}

function isCheck(value: unknown): value is Check {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return Object.keys(data).every(key => ["version", "platform", "arch", "channel"].includes(key))
    && typeof data.version === "string" && data.version.length <= 32 && VERSION.test(data.version)
    && typeof data.platform === "string" && Object.hasOwn(PLATFORMS, data.platform)
    && typeof data.arch === "string" && Object.hasOwn(ARCHITECTURES, data.arch)
    && (data.channel === undefined || (typeof data.channel === "string" && /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,31}(?![\s\S])/.test(data.channel)));
}

/** Enforce the byte limit while reading, including requests without Content-Length. */
async function readCheck(request: Request): Promise<Check | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) return null;
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !request.body) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size)));
    return isCheck(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (new URL(request.url).pathname !== "/v1/check") return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const check = await readCheck(request);
    if (!check) return new Response(null, { status: 400 });
    const day = new Date().toISOString().slice(0, 10);
    ctx.waitUntil(env.DB.prepare(
      "INSERT INTO daily_counts (day, version, platform, arch, count) VALUES (?, ?, ?, ?, 1) ON CONFLICT (day, version, platform, arch) DO UPDATE SET count = count + 1",
    ).bind(day, check.version, check.platform, check.arch).run().then(() => {}, () => {}));
    return new Response(null, { status: 204 });
  },
} satisfies ExportedHandler<Env>;
