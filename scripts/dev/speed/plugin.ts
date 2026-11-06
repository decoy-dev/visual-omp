import type { Plugin } from 'vite';
import { parse } from '@babel/parser';

const timed: Record<string, true> = { helpersOf: true, helpersByCall: true, transcriptItems: true, backgroundJobs: true, parseSessionHistory: true, transcriptLayout: true, liveLayoutEntries: true, nativeRuns: true };
const profiled: Record<string, true> = { ChatView: true, SessionHeader: true, Composer: true, Transcript: true, TranscriptBody: true, TasksPane: true, HelperList: true, HelperRow: true };
/** Opt-in serve transform. No probe calls or Profiler wrappers enter a production build. */
export function speedProbe(): Plugin {
  return {
    name: 'vomp:speed-probe', apply: 'serve', enforce: 'pre',
    transform(code, id) {
      const path = id.replaceAll('\\', '/');
      if (!path.includes('/src/renderer/src/') || !/\.(ts|tsx)$/.test(path) || /\.(test|spec)\./.test(path)) return null;
      if (!/\/(session|derive|history|turns|localRuns|ChatView|SessionHeader|Composer|Transcript|TasksPane)\.tsx?$/.test(path)) return null;
      let result = code;
      if (path.endsWith('/state/session.ts')) {
        const needle = 'for (const listener of this.#listeners) listener();';
        if (!code.includes(needle)) this.error('SessionController notification boundary changed. Update the speed probe.');
        result = code.replace(needle, '(window as unknown as { __vompSpeed?: { notify(count: number): void } }).__vompSpeed?.notify(this.#listeners.size);\n\t\t' + needle);
      }
      const ast = parse(result, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
      const edits: { start: number; end: number; text: string }[] = [];
      const wrappers: string[] = [];
      let hasProfiled = false;
      for (const statement of ast.program.body) {
        const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        const functions = declaration?.type === 'FunctionDeclaration' ? [declaration]
          : declaration?.type === 'VariableDeclaration' ? declaration.declarations.flatMap(item => item.init?.type === 'CallExpression' && item.init.callee.type === 'Identifier' && item.init.callee.name === 'memo' ? item.init.arguments.filter(argument => argument.type === 'FunctionExpression') : []) : [];
        for (const node of functions) {
          if (!node.id || !node.body) continue;
          const name = node.id.name;
          if (timed[name]) {
            edits.push({ start: node.body.start! + 1, end: node.body.start! + 1, text: '\nconst __speedStart = performance.now(); try {\n' });
            edits.push({ start: node.body.end! - 1, end: node.body.end! - 1, text: `\n} finally { (window as unknown as { __vompSpeed?: { cost(name: string, ms: number): void } }).__vompSpeed?.cost(${JSON.stringify(name)}, performance.now() - __speedStart); }\n` });
          }
          if (profiled[name]) {
            hasProfiled = true;
            const callback = `onRender: (id: string, phase: string, ms: number) => (window as unknown as { __vompSpeed?: { profile(id: string, phase: string, ms: number): void } }).__vompSpeed?.profile(id, phase, ms)`;
            const body = `return __speedCreate(__speedProfiler, { id: ${JSON.stringify(name)}, ${callback} }, __speedCreate(__speedBody_${name}, props));`;
            if (node.type === 'FunctionExpression') {
              // Keep memo at the original binding: only its render callback gains a
              // Profiler boundary. The original named function remains in its closure.
              edits.push({ start: node.start!, end: node.start!, text: `((__speedBody_${name}) => function ${name}(props: Parameters<typeof __speedBody_${name}>[0]) { ${body} })(` });
              edits.push({ start: node.end!, end: node.end!, text: ')' });
            } else {
              edits.push({ start: node.id.start!, end: node.id.end!, text: `__speedBody_${name}` });
              wrappers.push(`${statement.type === 'ExportNamedDeclaration' ? 'export ' : ''}function ${name}(props: Parameters<typeof __speedBody_${name}>[0]) { ${body} }`);
            }
            edits.push({ start: node.body.start! + 1, end: node.body.start! + 1, text: `\n(window as unknown as { __vompSpeed?: { render(name: string): void } }).__vompSpeed?.render(${JSON.stringify(name)});\n` });
          }
        }
      }
      for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
      if (hasProfiled) result = 'import { Profiler as __speedProfiler, createElement as __speedCreate } from "react";\n' + result + '\n' + wrappers.join('\n');
      return { code: result, map: null };
    },
  };
}
