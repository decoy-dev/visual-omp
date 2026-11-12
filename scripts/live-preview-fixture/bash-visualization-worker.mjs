// Evidence-only extension. The presentation role never creates or executes a shell.
export default function visualizationEvidence(pi) {
  pi.on('session_start', async () => {
    const bridge = process.env.VOMP_SHELL_EVIDENCE_BRIDGE;
    if (!bridge) return;
    const role = process.env.VOMP_SHELL_EVIDENCE_ROLE;
    const post = (path, value) => fetch(bridge + path, { method: 'POST', body: JSON.stringify(value) });
    let natives;
    try { natives = await import('@oh-my-pi/pi-natives'); }
    catch (error) { await post('/ready', { pid: process.pid, unavailable: String(error) }); return; }
    const restoreAvailable = process.env.VOMP_SHELL_EVIDENCE_HIDE_RESTORE !== '1' && typeof natives.ShellVisualization === 'function';
    await post('/ready', { pid: process.pid, role, restore: restoreAvailable, live: typeof natives.RunTrace === 'function', rss: process.memoryUsage().rss });
    const preferences = { view: 'pseudo', layers: { color: true, inline: true, idioms: true, effects: true, unwrap: true }, split: false, playing: false, speed: 1, expandedNodes: [] };
    const sizes = new Map();
    const handles = new Map();
    void (async () => {
      for (;;) {
        const response = await fetch(bridge + '/next');
        if (!response.ok) return;
        const request = await response.json();
        await post('/started', { id: request.id });
        const start = performance.now();
        try {
          let data;
          if (request.op === 'restore') {
            if (!restoreAvailable) throw new Error('Native restoration capability unavailable');
            const json = JSON.stringify(request.trace);
            const bytes = Buffer.byteLength(json);
            if (!handles.has(request.handle) && handles.size >= 4) throw new Error('Presentation handle limit');
            if (bytes > 16 * 1024 ** 2 || [...sizes.values()].reduce((a, b) => a + b, 0) - (sizes.get(request.handle) ?? 0) + bytes > 32 * 1024 ** 2) throw new Error('Presentation source byte limit');
            const restored = new natives.ShellVisualization(json);
            sizes.set(request.handle, bytes);
            handles.set(request.handle, restored);
            data = { handles: handles.size };
          } else if (request.op === 'present') {
            const source = handles.get(request.handle);
            if (!source) throw new Error('Unknown fixture presentation handle');
            const json = source.present({ ...preferences, ...request.options });
            if (Buffer.byteLength(json) > 2 * 1024 ** 2) throw new Error('Presentation response byte limit');
            data = JSON.parse(json);
          } else if (request.op === 'capture' && role === 'capture') {
            const trace = new natives.RunTrace(request.script);
            const shell = new natives.Shell();
            const timeoutMs = request.timeoutMs ?? 30000;
            const outputBytes = request.outputBytes ?? 2 * 1024 ** 2;
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new Error('Capture timeout limit');
            if (!Number.isSafeInteger(outputBytes) || outputBytes <= 0 || outputBytes > 2 * 1024 ** 2) throw new Error('Capture output limit');
            const chunks = [];
            let retainedBytes = 0;
            let outputTruncated = false;
            const result = await shell.run({ command: request.script, trace, cwd: request.cwd, timeoutMs }, (_error, chunk) => {
              const bytes = Buffer.from(chunk ?? '');
              const remaining = outputBytes - retainedBytes;
              if (bytes.length > remaining) outputTruncated = true;
              if (remaining > 0) {
                const retained = Buffer.from(bytes.subarray(0, remaining));
                chunks.push(retained);
                retainedBytes += retained.length;
              }
            });
            const output = Buffer.concat(chunks).toString('utf8');
            if (Buffer.byteLength(output, 'utf8') > outputBytes) throw new Error('Decoded capture output byte limit');
            const snapshotJson = trace.snapshot();
            if (Buffer.byteLength(snapshotJson) > 16 * 1024 ** 2) throw new Error('Capture trace byte limit');
            const snapshot = JSON.parse(snapshotJson);
            const checkpoints = [0, Math.floor((snapshot.history?.length ?? 0) / 2), snapshot.history?.length ?? 0];
            const presentations = ['raw', 'pseudo'].flatMap(view => checkpoints.map(cursor => {
              const json = trace.present({ ...preferences, view, cursor });
              if (Buffer.byteLength(json) > 2 * 1024 ** 2) throw new Error('Capture presentation byte limit');
              return { view, cursor, presentation: JSON.parse(json) };
            }));
            data = { result, output, outputTruncated, failures: outputTruncated ? ['Capture output byte limit; retained prefix only'] : [], trace: snapshot, presentations };
          } else if (request.op === 'release') {
            handles.delete(request.handle);
            data = { handles: handles.size };
            sizes.delete(request.handle);
          } else throw new Error('Operation unavailable for this evidence process role');
          await post('/result', { id: request.id, data, nativeMs: performance.now() - start, rss: process.memoryUsage().rss });
        } catch (error) {
          await post('/result', { id: request.id, error: String(error), nativeMs: performance.now() - start, rss: process.memoryUsage().rss });
        }
      }
    })().catch(error => post('/failure', { error: String(error) }).catch(() => {}));
  });
}
