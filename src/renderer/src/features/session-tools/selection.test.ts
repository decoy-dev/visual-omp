import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@oh-my-pi/pi-wire';
import { sameStreamModel } from './selection';

const message = (text: string): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }], model: 'fixture', provider: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, stopReason: 'stop', timestamp: 1 });

describe('model control stream selection', () => {
	it('ignores ordinary text, thinking and token-usage revisions', () => {
		const before = message('First');
		const after = { ...message('First and later tokens'), content: [{ type: 'thinking' as const, thinking: 'More reasoning' }, ...message('Text').content], usage: { ...before.usage, output: 100 } };
		expect(sameStreamModel(before, after)).toBe(true);
	});
	it('observes stream start/end, provider changes and fallback chains without allocating text copies', () => {
		const before = message('First');
		expect(sameStreamModel(null, before)).toBe(false);
		expect(sameStreamModel(before, null)).toBe(false);
		expect(sameStreamModel(before, { ...before, provider: 'other' })).toBe(false);
		const fallback: AssistantMessage = { ...before, content: [...before.content, { type: 'fallback', from: { model: 'fixture/primary' }, to: { model: 'fixture/backup' } }] };
		expect(sameStreamModel(before, fallback)).toBe(false);
		expect(sameStreamModel(fallback, { ...fallback, content: [{ type: 'text', text: 'Changed prose' }, ...fallback.content.slice(1)] })).toBe(true);
		expect(sameStreamModel(fallback, { ...fallback, content: [...fallback.content, { type: 'fallback', from: { model: 'fixture/backup' }, to: { model: 'fixture/third' } }] })).toBe(false);
	});
});
