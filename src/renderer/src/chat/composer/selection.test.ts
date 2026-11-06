import { describe, expect, it } from 'vitest';
import { shallow } from 'zustand/shallow';
import type { GuestSnapshot } from '../../collab/lib/client';
import type { SessionView } from '../../state/session';
import type { HostState } from '@shared/ipc';
import { composerSelection } from './selection';

function snapshot(): SessionView {
	const guest: GuestSnapshot = { phase: 'live', endedReason: null, header: null, entries: [], state: null, agents: [], progress: new Map(), lifecycle: new Map(), stream: null, streamDone: false, activeTools: new Map(), backgroundTools: new Map(), working: true, readOnly: false, uiRequest: null, notices: [], thinkingSelector: null, loading: null };
	return { mode: 'live', host: null, guest, history: null, queue: [], inputHistory: [], working: true, workingSince: null, readOnly: false, follow: null, ownerUnverified: false, displayLeaf: null, carryover: null, strandedImages: false, error: null };
}

describe('composer visual selection', () => {
	it('ignores text streaming and helper collections without ignoring input controls', () => {
		const before = snapshot();
		const after = { ...before, guest: { ...before.guest!, progress: new Map(), lifecycle: new Map(), streamDone: true, lastStreamingAt: 123 } };
		expect(shallow(composerSelection(before), composerSelection(after))).toBe(true);
		for (const patch of [{ working: false }, { readOnly: true }, { strandedImages: true }, { queue: [...before.queue] }, { inputHistory: [{ text: 'sent', timestamp: 1 }] }, { displayLeaf: 'rewound' }]) {
			expect(shallow(composerSelection(before), composerSelection({ ...before, ...patch }))).toBe(false);
		}
	});

	it('preserves every native readiness, editor and room input reference', () => {
		const before = snapshot();
		const host: HostState = { hostId: 'test', sessionId: 'session', sessionFile: null, cwd: '/fixture', phase: 'live', transport: 'tsp', generation: 1, link: null, pid: null, exitCode: null, error: null, tui: null, cols: 80, rows: 24, tspAvailability: { available: true, reason: null } };
		const view = { ...before, host };
		const selected = composerSelection(view);
		expect(selected.tspAvailability).toBe(host.tspAvailability);
		expect(selected.tspComposer).toBe(host.tspComposer);
		expect(selected.tspEditorRestore).toBe(host.tspEditorRestore);
		expect(shallow(selected, composerSelection({ ...view, host: { ...host, generation: 2 } }))).toBe(false);
		expect(shallow(selected, composerSelection({ ...view, host: { ...host, tspAvailability: { available: false, reason: 'Waiting for input' } } }))).toBe(false);
		expect(shallow(selected, composerSelection({ ...view, guest: { ...view.guest!, awaitingAsyncWork: true } }))).toBe(false);
	});
});
