import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview, transformWithEsbuild } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Dedicated measurement graph: never used by electron.vite.config.ts or shipped output. */
export async function productionRenderer({ sourceRoot, checkout, workspace }) {
  sourceRoot = await realpath(sourceRoot);
  const root = join(sourceRoot, 'src/renderer');
  const entry = '\0vomp-speed-production-entry.tsx';
  const main = join(root, 'src/main.tsx');
  const replay = join(root, 'src/dev/speedReplay.ts');
  const evidence = { sourceRoot, outputDir: join(workspace, 'renderer-build'), cacheDir: join(workspace, 'vite-cache'), nodeEnv: 'production', strictModeRemoved: false, subscriberTransform: false, profilerTransform: false, modules: [] };
  // Both app and worker builds resolve packages from the existing checkout.
  // Frozen source trees deliberately contain no copied or linked node_modules.
  const dependencies = () => ({
    name: 'vomp:speed-checkout-dependencies',
    async resolveId(id, importer) {
      if (importer && !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0') && !id.startsWith('@shared/') && !id.startsWith('@/')) {
        return this.resolve(id, join(checkout, 'src/renderer/src/main.tsx'), { skipSelf: true });
      }
    },
  });
  const plugin = {
    name: 'vomp:speed-production-only',
    apply: 'build',
    enforce: 'pre',
    transformIndexHtml: { order: 'pre', handler(html) { return html.replace('src="/src/main.tsx"', 'src="/vomp-speed-production-entry"'); } },
    resolveId(id) { if (id === '/vomp-speed-production-entry') return entry; },
    async load(id) {
      if (id !== entry) return;
      let code = await readFile(main, 'utf8');
      const strictImport = /import\s*\{\s*StrictMode\s*\}\s*from\s*["']react["'];?\s*/;
      if (!strictImport.test(code) || !code.includes('<StrictMode>') || !code.includes('</StrictMode>')) this.error('Renderer bootstrap changed; update production speed entry.');
      code = code.replace(strictImport, '').replace('<StrictMode>', '<>').replace('</StrictMode>', '</>');
      code = code.replace(/from\s*(["'])\.\//g, `from $1${root}/src/`).replace(/import\s*(["'])\.\//g, `import $1${root}/src/`);
      evidence.strictModeRemoved = true;
      return transformWithEsbuild(code + `\nimport { install } from ${JSON.stringify(replay)};\nwindow.__vompSpeedInstall = install;\n`, main, { loader: 'tsx', jsx: 'automatic' });
    },
    transform(code, id) {
      if (id !== replay) return;
      const guard = "if (!import.meta.env.DEV) throw new Error('Speed replay requires a development build.');";
      if (!code.includes(guard)) this.error('Replay build guard changed; update dedicated production measurement override.');
      return { code: code.replace(guard, "if (!import.meta.env.PROD) throw new Error('Production speed replay requires a production measurement build.');"), map: null };
    },
    generateBundle(_options, bundle) {
      evidence.modules = [...new Set(Object.values(bundle).filter(chunk => chunk.type === 'chunk').flatMap(chunk => Object.keys(chunk.modules)))];
      evidence.productionReact = evidence.modules.some(id => id.includes('/react-dom-client.production.js'));
      evidence.developmentReact = evidence.modules.some(id => /react(?:-dom)?\/.*\.development\.js$/.test(id));
      evidence.profilingReact = evidence.modules.some(id => /react(?:-dom)?\/.*\.profiling\.js$/.test(id));
      if (!evidence.productionReact || evidence.developmentReact || evidence.profilingReact) this.error('Measurement must bundle ordinary production React.');
      for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk' && /__speedProfiler|__speedBody_|\.notify\(this\.#listeners\.size\)/.test(chunk.code)) this.error('Development speed transform leaked into production measurement.');
    },
  };
  const config = {
    configFile: false, root, base: '/', cacheDir: evidence.cacheDir,
    mode: 'production', plugins: [plugin, dependencies(), react(), tailwindcss()],
    worker: { plugins: () => [dependencies()] },
    resolve: { alias: { '@shared': join(sourceRoot, 'src/shared'), '@': join(root, 'src'), '@oh-my-pi/pi-wire': join(root, 'src/collab/wire/index.ts'), '@oh-my-pi/pi-utils/marked': 'marked', '@oh-my-pi/pi-utils/math-delimiters': join(root, 'src/collab/math-delimiters.ts'), 'tailwindcss': join(checkout, 'node_modules/tailwindcss/index.css'), '@fontsource-variable/geist': join(checkout, 'node_modules/@fontsource-variable/geist/index.css'), '@fontsource-variable/geist-mono': join(checkout, 'node_modules/@fontsource-variable/geist-mono/index.css') } },
    build: { outDir: evidence.outputDir, emptyOutDir: true, minify: true, sourcemap: true },
    preview: { host: '127.0.0.1', port: 0, strictPort: false },
  };
  await build(config);
  const evidenceFile = resolve(workspace, 'production-build.json');
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
  const server = await preview(config);
  return { url: server.resolvedUrls.local[0], evidence: { ...evidence, evidenceFile }, close: () => new Promise((done, reject) => server.httpServer.close(error => error ? reject(error) : done())) };
}
