// Headless-only Electron boundary. The full application and controllers remain real.
(() => {
  const data = window.__speedScenario;
  const listeners = new Map();
  const prefs = { setupCompleted: true, tourCompleted: true, sendCrashReports: false, livePreview: false, livePreviewOpenOutputs: false, liveThinking: true, visualProofs: false, ompPath: null, newUserApproval: 'done', transcriptMode: 'normal', theme: 'light', textScale: 100, reducedMotion: 'off', pinnedProjects: [], archivedSessions: [], extraProjects: [], projectColors: {}, notifications: false, voiceInput: false, classicPresentation: false, sidebarSort: { by: 'recent', groupByProject: true }, statusBar: undefined };
  const layout = { tabs: data.tabs, activeTabId: 'speed-light', activeProject: data.projectPath, splitTabId: null, focusedSplit: 'primary', sidebarOpen: true, unseenChats: {}, docks: {} };
  window.__speedUnhandled = new Set();
  window.vomp = {
    platform: 'darwin',
    on(channel, callback) { const set = listeners.get(channel) || new Set(); listeners.set(channel, set); set.add(callback); return () => set.delete(callback); },
    async invoke(channel, ...args) {
      switch (channel) {
        case 'app:prefs:get': return prefs;
        case 'app:prefs:set': return Object.assign(prefs, args[0]);
        case 'app:info': return { version: '0.7.8', platform: 'darwin', homePath: data.root + '/home', defaultChatFolder: data.projectPath, tourLayout: layout, isDev: true };
        case 'omp:status': return { found: true, supported: true, version: '18.16.0', path: '/fixture/omp' };
        case 'sessions:projects': return [{ path: data.projectPath, name: 'Speed fixture', count: 2 }];
        case 'sessions:recent': case 'sessions:list': return data.tabs.map(tab => ({ ...tab, file: tab.sessionFile, cwd: data.projectPath, timestamp: new Date().toISOString(), messageCount: tab.id === 'speed-heavy' ? 1400 : 12 }));
        case 'sessions:read': return JSON.stringify(data.header) + '\n' + (args[0] === data.tabs[0].sessionFile ? data.entries : data.light).map(row => JSON.stringify(row)).join('\n') + '\n';
        case 'sessions:resolve': return args[0];
        case 'sessions:promptHistory': case 'composer:predictionCaptures': return [];
        case 'config:roles': return { roles: [], defaultThinkingLevel: 'off' };
        case 'sessions:ownership': return 'free';
        case 'host:list': return [];
        case 'host:tsp-snapshot': return null;
        case 'native:snapshot': return { jobs: [], agents: [], cwd: data.projectPath };
        case 'config:get': return {};
        case 'session:tools': return { model: null, thinking: null };
        case 'git:status': return { repo: false, files: [], branch: null };
        case 'app:metrics': return { cpuPercent: 0, memoryBytes: 0 };
        case 'commands:list': case 'models:list': case 'config:models': case 'panes:scanMade': return [];
        case 'app:window:setTitle': case 'app:setTitle': case 'host:tsp-resize': case 'app:attention': return;
        default: window.__speedUnhandled.add(channel); return null;
      }
    },
  };
})();
