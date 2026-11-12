/** Executed only by installed omp's public extension loader. No native module enters Electron. */
export const SHELL_VISUALIZATION_EXTENSION = String.raw`
export default async function presentationOnly() {
  const park = () => new Promise(() => {});
  try {
    const bridge = process.env.VOMP_SHELL_PRESENTATION_BRIDGE;
    if (!bridge) await park();
    const post = async (path, value) => {
      const response = await fetch(bridge + path, { method: 'POST', body: JSON.stringify(value), timeout: false });
      if (!response.ok) await park();
    };
    let Native;
    // Optional installed-runtime module: a static import would bypass the startup gate on failure.
    try { Native = (await import('@oh-my-pi/pi-natives')).ShellVisualization; } catch {}
    const capable = typeof Native === 'function' && typeof Native.prototype?.present === 'function';
    await post('/ready', { capable });
    if (!capable) await park();
    const handles = new Map();
    const sizes = new Map();
    // Keeping this async factory pending prevents agent/session/model startup entirely.
    // There is deliberately no session_start handler, capture operation or shell API.
    for (;;) {
      const response = await fetch(bridge + '/next', { timeout: false });
      if (!response.ok) await park();
      const request = await response.json();
      let data;
      let failure;
      try {
        if (request.op === 'restore') {
          if (typeof request.json !== 'string') throw new Error();
          const bytes = Buffer.byteLength(request.json);
          const source = JSON.parse(request.json);
          if (source?.v !== 1 || bytes > 16 * 1024 ** 2 || handles.has(request.handle) || handles.size >= 4 ||
              [...sizes.values()].reduce((a, b) => a + b, 0) + bytes > 32 * 1024 ** 2) throw new Error();
          const native = new Native(request.json);
          if (typeof native.present !== 'function') throw new Error();
          handles.set(request.handle, native);
          sizes.set(request.handle, bytes);
          data = null;
        } else if (request.op === 'present') {
          const source = handles.get(request.handle);
          if (!source) throw new Error();
          const json = source.present(request.options);
          if (typeof json !== 'string' || Buffer.byteLength(json) > 2 * 1024 ** 2) {
            failure = 'too-large';
          } else data = JSON.parse(json);
        } else if (request.op === 'release') {
          handles.delete(request.handle);
          sizes.delete(request.handle);
          data = null;
        } else throw new Error();
      } catch { failure = 'unavailable'; }
      await post('/result', { id: request.id, data, failure });
    }
  } catch {
    // A bridge failure must never release omp's pending-factory startup gate.
    await park();
  }
}
`;
