// @vitest-environment happy-dom
import { act, createElement, type ReactNode, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, SessionEntry } from '@oh-my-pi/pi-wire';
import type { RiseProps } from '../../ui/motion';
import type * as MotionModule from '../../ui/motion';
import type * as PaceModule from './pace';
import { MotionProvider, TooltipProvider } from '../../ui';
import { TranscriptBody, type TranscriptBodyProps } from './Transcript';
import '../../i18n';

const observed = vi.hoisted(() => {
	Object.assign(window, { vomp: { platform: 'darwin', on: () => () => {}, invoke: async () => null } });
	return { rows: new Map<string, number>() };
});
vi.mock('../../features/projects/folders/homeDir', () => ({ useHomeDir: () => null }));
vi.mock('./pace', async importOriginal => ({ ...await importOriginal<typeof PaceModule>(), usePlayout: () => null }));
vi.mock('./FileLinks', async () => {
	// Vitest hoists mock factories before static value imports.
	const { createContext, createElement } = await import('react');
	return { FileRefContext: createContext(null), useFileRefs: () => null, LinkedMarkdown: ({ text }: { text: string }) => createElement('span', null, text) };
});
vi.mock('../../ui/motion', async importOriginal => {
	const actual = await importOriginal<typeof MotionModule>();
	// The hoisted factory cannot use static React value bindings yet.
	const { createElement, isValidElement } = await import('react');
	return {
		...actual,
		Rise: ({ children, className, onFocus, onBlur, ...props }: Omit<RiseProps, 'children'> & { children?: ReactNode; 'data-row'?: boolean }) => {
			const child = isValidElement<{ entry?: SessionEntry }>(children) ? children : null;
			const entry = child?.props.entry;
			if (entry) observed.rows.set(entry.id, (observed.rows.get(entry.id) ?? 0) + 1);
			return createElement('div', { className, onFocus, onBlur, 'data-row': props['data-row'] }, children);
		},
	};
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
const assistant = (text: string, timestamp = 5000): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }], model: 'fixture', usage, stopReason: 'stop', timestamp });
const entries: readonly SessionEntry[] = [
	{ type: 'message', id: 'user', parentId: null, timestamp: new Date(1000).toISOString(), message: { role: 'user', content: 'Check the source', timestamp: 1000 } },
	{ type: 'message', id: 'call', parentId: 'user', timestamp: new Date(2000).toISOString(), message: { ...assistant('Checking', 2000), content: [{ type: 'text', text: 'Checking' }, { type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: 'source.ts' } }] } },
	{ type: 'message', id: 'result', parentId: 'call', timestamp: new Date(3000).toISOString(), message: { role: 'toolResult', toolCallId: 'read-call', toolName: 'read', content: [{ type: 'text', text: 'export const value = 42;' }], isError: false, timestamp: 3000 } },
	{ type: 'message', id: 'reply', parentId: 'result', timestamp: new Date(4000).toISOString(), message: assistant('The check passed.', 4000) },
];
const scope = { projectPath: '/fixture', tabId: 'memo' };
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	document.documentElement.dataset.motion = 'reduced';
	observed.rows.clear();
	container = document.createElement('div');
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	delete document.documentElement.dataset.motion;
});
async function paint(stream: AssistantMessage | null, rows = entries) {
	const child: ReactNode = createElement(TranscriptBody, { scope, entries: rows, stream, mode: 'normal', working: true, ready: true, identity: 'memo' });
	await act(async () => root.render(createElement(MotionProvider, null, createElement(TooltipProvider, null, child))));
}

function QuestionTranscript({ pendingQuestion, rows = entries, onLayout }: {
	pendingQuestion: TranscriptBodyProps['pendingQuestion'];
	rows?: readonly SessionEntry[];
	onLayout?: () => void;
}) {
	useLayoutEffect(() => onLayout?.());
	return createElement(TranscriptBody, { scope, entries: rows, mode: 'normal', working: true, ready: true, identity: 'memo', pendingQuestion });
}

function paintQuestion(pendingQuestion: TranscriptBodyProps['pendingQuestion'], onLayout?: () => void, rows = entries) {
	act(() => root.render(createElement(MotionProvider, null, createElement(TooltipProvider, null, createElement(QuestionTranscript, { pendingQuestion, rows, onLayout })))));
}

function question(inPlace = true, closing = false): NonNullable<TranscriptBodyProps['pendingQuestion']> {
	return { key: 'form-call', inPlace, node: createElement('button', { 'data-question': true }, closing ? 'Question closing' : 'Choose a value') };
}

describe('settled transcript memo boundaries', () => {
	it('does not re-render settled entry wrappers for text-only stream changes', async () => {
		await paint(assistant('First live words'));
		// Let the initial synchronized-history state settle before measuring token-only changes.
		await paint(assistant('First live words, synchronized'));
		const before = new Map(observed.rows);
		await paint(assistant('First live words and the next words'));
		for (const id of ['user', 'call', 'reply']) expect(observed.rows.get(id)).toBe(before.get(id));
		expect(container.textContent).toContain('First live words and the next words');
	});

	it('keeps an opened and focused tool group held across stream changes and appended entries', async () => {
		await paint(assistant('Live words'));
		const button = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find(button => /tool call/.test(button.textContent ?? ''));
		expect(button).toBeDefined();
		await act(async () => { button!.click(); button!.focus(); });
		expect(button!.getAttribute('aria-expanded')).toBe('true');
		const appended: SessionEntry = { type: 'message', id: 'next', parentId: 'reply', timestamp: new Date(6000).toISOString(), message: assistant('Saved continuation', 6000) };
		await paint(assistant('Longer live words'), [...entries, appended]);
		expect(button!.isConnected).toBe(true);
		expect(button!.getAttribute('aria-expanded')).toBe('true');
		expect(document.activeElement).toBe(button);
	});

	it('preserves a scrolled-up position when a stream and its saved entry grow below it', async () => {
		await paint(assistant('Live words'));
		const log = container.querySelector<HTMLElement>('[role=log]')!;
		let height = 1200;
		Object.defineProperties(log, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, get: () => height } });
		log.scrollTop = 400;
		await act(async () => log.dispatchEvent(new Event('scroll', { bubbles: true })));
		height = 1600;
		await paint(assistant('Longer live words'));
		expect(log.scrollTop).toBe(400);
		const appended: SessionEntry = { type: 'message', id: 'next', parentId: 'reply', timestamp: new Date(6000).toISOString(), message: assistant('Saved continuation', 6000) };
		await paint(null, [...entries, appended]);
		expect(log.scrollTop).toBe(400);
	});
});

describe('in-place form departure', () => {
	it('removes the form DOM in the departure commit without retaining an exit child', () => {
		paintQuestion(question());
		const card = container.querySelector('[data-question]')!;
		paintQuestion(question(true, true));
		expect(container.querySelector('[data-question]')).toBe(card);
		expect(card.textContent).toBe('Question closing');
		let presentInLayout: boolean | undefined;
		paintQuestion(null, () => { presentInLayout = card.isConnected; });
		expect(presentInLayout).toBe(false);
		expect(container.querySelector('[data-question]')).toBeNull();
	});

	it('retains the existing exit animation for a general question', () => {
		paintQuestion(question(false));
		const card = container.querySelector('[data-question]')!;
		let presentInLayout: boolean | undefined;
		paintQuestion(null, () => { presentInLayout = card.isConnected; });
		expect(presentInLayout).toBe(true);
	});

	it.each(['result-first', 'departure-first'])('snaps pinned form and departure geometry before parent layout (%s)', order => {
		paintQuestion(question());
		const log = container.querySelector<HTMLElement>('[role=log]')!;
		let height = 1600;
		let viewport = 200;
		Object.defineProperties(log, {
			clientHeight: { configurable: true, get: () => viewport },
			scrollHeight: { configurable: true, get: () => height },
		});
		log.scrollTop = height - viewport;
		act(() => log.dispatchEvent(new Event('scroll', { bubbles: true })));
		const result: SessionEntry = { type: 'message', id: 'form-result', parentId: 'reply', timestamp: new Date(6000).toISOString(), message: { role: 'toolResult', toolCallId: 'form-call', toolName: 'ask', content: [{ type: 'text', text: 'Answered' }], isError: false, timestamp: 6000 } };
		const completed = [...entries, result];
		if (order === 'result-first') {
			height += 180;
			let resultTop: number | undefined;
			paintQuestion(question(true, true), () => { resultTop = log.scrollTop; }, completed);
			expect(resultTop).toBe(height - viewport);
		}
		height -= 650;
		viewport += 32;
		let departureTop: number | undefined;
		let presentInLayout: boolean | undefined;
		paintQuestion(null, () => {
			departureTop = log.scrollTop;
			presentInLayout = container.querySelector('[data-question]') !== null;
		}, order === 'result-first' ? completed : entries);
		expect(presentInLayout).toBe(false);
		expect(departureTop).toBe(height - viewport);
		// A later result uses the ordinary transcript path after the native form has ended.
		if (order === 'departure-first') paintQuestion(null, undefined, completed);
	});

	it('does not write scrollTop for an unpinned reader as results arrive and the form departs', () => {
		paintQuestion(question());
		const log = container.querySelector<HTMLElement>('[role=log]')!;
		let height = 1600;
		Object.defineProperties(log, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, get: () => height } });
		log.scrollTop = 1400;
		act(() => log.dispatchEvent(new Event('scroll', { bubbles: true })));
		act(() => log.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })));
		log.scrollTop = 400;
		act(() => log.dispatchEvent(new Event('scroll', { bubbles: true })));
		let top = log.scrollTop;
		const write = vi.fn((value: number) => { top = value; });
		Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => top, set: write });
		height += 180;
		paintQuestion(question(true, true));
		expect(log.scrollTop).toBe(400);
		// Even a shrink that puts this reader at the bottom must leave the pin and position alone for this commit.
		height = 600;
		paintQuestion(null);
		expect(log.scrollTop).toBe(400);
		expect(write).not.toHaveBeenCalled();
	});
});
