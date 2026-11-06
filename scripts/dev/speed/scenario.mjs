import { readFile, writeFile, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initializeFixture } from '../../live-preview-fixture/environment.mjs';

export const checkout = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const sampleDir = join(checkout, 'src/renderer/src/collab/lib/fixtures');
export async function prepareScenario(root) {
  root = root ? await realpath(root) : await realpath(await mkdtemp(join(tmpdir(), 'vomp-speed-')));
  const env = await initializeFixture(root, 'http://127.0.0.1:1/v1');
  const frames = (await Promise.all(['completion-astra', 'completion-bash', 'completion-wait'].map(async name => (await readFile(join(sampleDir, `${name}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line).frame)))).flat();
  const welcome = structuredClone(frames.find(frame => frame.t === 'welcome'));
  const recorded = frames.filter(frame => frame.t === 'entry').map(frame => frame.entry);
  const assistant = recorded.find(entry => entry.message?.role === 'assistant');
  const tool = recorded.find(entry => entry.message?.role === 'toolResult');
  if (!assistant || !tool) throw new Error('Recorded omp message templates are missing.');
  const projectPath = join(root, 'work');
  const sessionDir = join(env.PI_CODING_AGENT_DIR, 'sessions', '--speed-fixture--');
  await mkdir(sessionDir, { recursive: true });
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1cAAAAASUVORK5CYII=';
  let sequence = 0;
  function entries(count, prefix) {
    let parentId = null;
    const rows = [];
    const push = message => {
      const id = `${prefix}-${++sequence}`;
      const entry = { type: 'message', id, parentId, timestamp: new Date(1793952000000 + sequence * 1000).toISOString(), runtime: { version: '18.16.0' }, message };
      rows.push(entry); parentId = id;
    };
    for (let turn = 0; rows.length < count; turn++) {
      push({ role: 'user', content: [{ type: 'text', text: `Inspect batch ${turn}. Include code and tool evidence.` }, ...(turn % 80 === 0 ? [{ type: 'image', data: image, mimeType: 'image/png' }] : [])], timestamp: 1793952000000 + sequence * 1000 });
      const name = ['bash', 'read', 'grep', 'edit', 'write', 'eval', 'todo', 'task'][turn % 8];
      const id = `${prefix}-call-${turn}`;
      const args = name === 'bash' ? { command: 'printf "fixture evidence\\n"', i: 'Inspecting fixture evidence' }
        : name === 'eval' ? { code: 'print(42)', language: 'py', i: 'Calculating fixture result' }
        : name === 'task' ? { tasks: [{ agent: 'scout', task: 'Inspect recorded fixture', name: `PastHelper${turn}` }] }
        : name === 'todo' ? { phases: [{ name: 'Inspect', tasks: [{ content: 'Read source', status: 'completed' }] }] }
        : { path: `src/batch-${turn}.ts`, pattern: 'fixture', content: 'export const fixture = 42;', i: 'Inspecting recorded source' };
      push({ ...structuredClone(assistant.message), content: [{ type: 'thinking', thinking: `Checking batch ${turn} against the recorded session shape.` }, { type: 'text', text: `Batch ${turn} has a bounded update.\n\n\`\`\`typescript\nexport function batch${turn}(value: number) {\n  return value * 2;\n}\n\`\`\`\n\nThe next tool records the evidence.` }, { type: 'toolCall', id, name, arguments: args }], stopReason: 'toolUse', timestamp: 1793952000000 + sequence * 1000 });
      push({ ...structuredClone(tool.message), toolCallId: id, toolName: name, content: [{ type: 'text', text: `Fixture ${name} result for batch ${turn}.\n` + 'export const value = 42;\n'.repeat(12) }], details: name === 'todo' ? args : {}, isError: false, timestamp: 1793952000000 + sequence * 1000 });
      push({ ...structuredClone(assistant.message), content: [{ type: 'text', text: `Batch ${turn} is complete.\n\n- Read the source\n- Checked the tool result\n- Kept the update local\n\n\`\`\`json\n{"batch":${turn},"ok":true}\n\`\`\`` }], stopReason: 'stop', timestamp: 1793952000000 + sequence * 1000 });
    }
    return rows.slice(0, count);
  }
  const main = entries(1400, 'heavy');
  const header = { ...welcome.header, id: 'speed-heavy-1816', cwd: projectPath, title: 'Heavy speed fixture' };
  const sessionFile = join(sessionDir, '2026-11-06_speed-heavy.jsonl');
  const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(sessionFile, jsonl([header, ...main]));
  const helperDir = sessionFile.replace(/\.jsonl$/, '');
  await mkdir(helperDir, { recursive: true });
  const helpers = [];
  for (let i = 0; i < 4; i++) {
    const id = `SpeedHelper${i + 1}`;
    const file = join(helperDir, `${id}.jsonl`);
    const text = jsonl([{ ...header, id, title: id }, ...entries(350, id)]);
    await writeFile(file, text);
    helpers.push({ id, file, text });
  }
  const lightFile = join(sessionDir, '2026-11-06_speed-light.jsonl');
  const light = entries(12, 'light');
  await writeFile(lightFile, jsonl([{ ...header, id: 'speed-light', title: 'Light speed fixture' }, ...light]));
  const tabs = [{ id: 'speed-heavy', title: 'Heavy speed fixture', sessionFile, projectPath }, { id: 'speed-light', title: 'Light speed fixture', sessionFile: lightFile, projectPath }];
  const layout = { tabs, activeTabId: tabs[1].id, activeProject: projectPath, splitTabId: null, focusedSplit: 'primary', sidebarOpen: true, unseenChats: {}, docks: {} };
  const seed = join(root, 'speed-layout.json');
  await writeFile(seed, JSON.stringify(layout));
  await writeFile(join(env.VOMP_DEV_PROFILE, 'preferences.json'), JSON.stringify({ setupCompleted: true, tourCompleted: true, sendCrashReports: false, livePreview: false, newUserApproval: 'done' }));
  const data = { root, seed, projectPath, tabs, header, entries: main, light, helpers, assistant: assistant.message, state: { ...welcome.state, cwd: projectPath, sessionName: header.title, isStreaming: true }, provenance: ['completion-astra.jsonl', 'completion-bash.jsonl', 'completion-wait.jsonl'], streamIntervalMs: 20, helperIntervalMs: 250, appendIntervalMs: 2000 };
  await writeFile(join(root, 'speed-scenario.json'), JSON.stringify(data));
  return data;
}
if (process.argv.includes('--prepare')) {
  const data = await prepareScenario();
  console.log(JSON.stringify({ root: data.root, seed: data.seed, entries: data.entries.length, helpers: data.helpers.length }, null, 2));
}
