import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// The launcher supplies all configuration in argv. No owner profile or network is used.
const [role, directory, executable, ...args] = process.argv.slice(2);
if (!['node', 'unrelated'].includes(role) || !directory || (role === 'node' && !executable)) throw new Error('Invalid sentinel arguments');
const creationUpperMs = Date.now();
const retained = [];
let omp;
let pressure;
if (role === 'node') {
  // Match the production worker's ignored stdio; the presentation protocol uses its private HTTP bridge.
  omp = spawn(executable, args, { env: process.env, stdio: 'ignore', windowsHide: true });
  omp.on('error', error => { throw error; });
  omp.on('exit', (code, signal) => {
    clearInterval(pressure);
    process.exitCode = signal ? 1 : code ?? 1;
  });
}
function publish() {
  const path = join(directory, `${role}.json`);
  writeFileSync(`${path}.pending`, JSON.stringify({ pid: process.pid, parentPid: process.ppid, role, creationUpperMs, ompPid: omp?.pid, ompExecutable: executable, ompArgs: args, retainedBytes: retained.reduce((sum, buffer) => sum + buffer.length, 0) }));
  renameSync(`${path}.pending`, path);
}
if (omp) omp.once('spawn', publish); else publish();
pressure = setInterval(() => {
  if (role === 'node' && existsSync(join(directory, 'pressure-start')) && retained.length < 16) {
    retained.push(Buffer.alloc(32 * 1024 * 1024, 127));
    publish();
  }
}, 100);
