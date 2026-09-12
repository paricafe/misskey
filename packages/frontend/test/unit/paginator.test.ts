/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Misskey from 'misskey-js';
import { Paginator } from '@/utility/paginator.js';
import { misskeyApi } from '@/utility/misskey-api.js';

vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: vi.fn(),
}));

type Note = Misskey.entities.Note;
type PendingRequest = {
	resolve: (items: Note[]) => void;
	reject: (error: Error) => void;
	signal: AbortSignal | undefined;
};

let requests: PendingRequest[];

function notes(start: number, count = 1): Note[] {
	return Array.from({ length: count }, (_, i) => ({
		id: String(start + i).padStart(4, '0'),
		createdAt: new Date(start + i).toISOString(),
	}) as Note);
}

async function initialize(paginator: { init: () => Promise<void> }, items = notes(100, 15).toReversed()): Promise<void> {
	const loading = paginator.init();
	requests.at(-1)!.resolve(items);
	await loading;
}

function finish(request: PendingRequest, outcome: 'success' | 'failure', items: Note[]) {
	if (outcome === 'success') {
		request.resolve(items);
	} else {
		request.reject(new Error('Request failed'));
	}
}

beforeEach(() => {
	requests = [];
	vi.mocked(misskeyApi).mockReset();
	vi.mocked(misskeyApi).mockImplementation((_endpoint, _data, _token, signal) => new Promise((resolve, reject) => {
		requests.push({ resolve, reject, signal });
	}));
});

describe('Paginator request generations', () => {
	test('aborts requests from the previous generation without aborting or failing the replacement', async () => {
		const paginator = new Paginator('notes/timeline', { useShallowRef: true });
		await initialize(paginator);
		const initialSignal = requests[0].signal!;
		const olderLoad = paginator.fetchOlder();
		const olderRequest = requests.at(-1)!;
		const newerLoad = paginator.fetchNewer({ toQueue: true });
		const newerRequest = requests.at(-1)!;
		expect(olderRequest.signal).toBe(initialSignal);
		expect(newerRequest.signal).toBe(initialSignal);
		initialSignal.addEventListener('abort', () => {
			olderRequest.reject(new Error('Request aborted'));
			newerRequest.reject(new Error('Request aborted'));
		});

		const replacementLoad = paginator.reload();
		const replacement = requests.at(-1)!;
		expect(initialSignal.aborted).toBe(true);
		expect(replacement.signal).not.toBe(initialSignal);
		expect(replacement.signal!.aborted).toBe(false);
		await Promise.all([olderLoad, newerLoad]);
		expect(paginator.fetching.value).toBe(true);
		expect(paginator.fetchingOlder.value).toBe(false);
		expect(paginator.fetchingNewer.value).toBe(false);
		expect(paginator.error.value).toBe(false);
		expect(paginator.items.value).toEqual([]);

		replacement.resolve(notes(200));
		await replacementLoad;
		expect(paginator.items.value.map(item => item.id)).toEqual(['0200']);
		expect(paginator.error.value).toBe(false);
	});

	test.each(['success', 'failure'] as const)('ignores an obsolete initial request %s while the replacement loads', async (outcome) => {
		const paginator = new Paginator('notes/timeline', { useShallowRef: true });
		const firstLoad = paginator.init();
		const obsolete = requests[0];
		const replacementLoad = paginator.reload();

		finish(obsolete, outcome, notes(1));
		await firstLoad;
		expect(paginator.items.value).toEqual([]);
		expect(paginator.fetching.value).toBe(true);
		expect(paginator.error.value).toBe(false);

		requests[1].resolve(notes(200));
		await replacementLoad;
		expect(paginator.items.value.map(item => item.id)).toEqual(['0200']);
		expect(paginator.fetching.value).toBe(false);
	});

	test.each(['success', 'failure'] as const)('ignores an obsolete initial request %s after the replacement completes', async (outcome) => {
		const paginator = new Paginator('notes/timeline', { useShallowRef: true });
		const firstLoad = paginator.init();
		const obsolete = requests[0];
		await initialize(paginator, notes(200));

		finish(obsolete, outcome, notes(1));
		await firstLoad;
		expect(paginator.items.value.map(item => item.id)).toEqual(['0200']);
		expect(paginator.fetching.value).toBe(false);
		expect(paginator.error.value).toBe(false);
		expect(paginator.canFetchOlder.value).toBe(true);
	});

	test.each([
		['older', 'success'],
		['older', 'failure'],
		['newer', 'success'],
		['newer', 'failure'],
	] as const)('keeps current pagination flags and data after an obsolete %s request %s', async (direction, outcome) => {
		const paginator = new Paginator('notes/timeline', { useShallowRef: true });
		const fetchPage = () => direction === 'older' ? paginator.fetchOlder() : paginator.fetchNewer({ toQueue: true });
		await initialize(paginator);
		const obsoleteLoad = fetchPage();
		const obsolete = requests.at(-1)!;
		await initialize(paginator, notes(200));

		const currentLoad = fetchPage();
		const current = requests.at(-1)!;
		expect(current).not.toBe(obsolete);
		finish(obsolete, outcome, notes(1));
		await obsoleteLoad;

		expect(paginator.items.value.map(item => item.id)).toEqual(['0200']);
		expect(paginator.queuedAheadItemsCount.value).toBe(0);
		expect((direction === 'older' ? paginator.fetchingOlder : paginator.fetchingNewer).value).toBe(true);
		expect(paginator.canFetchOlder.value).toBe(true);
		expect(paginator.error.value).toBe(false);

		current.resolve(notes(direction === 'older' ? 199 : 201));
		await currentLoad;
		expect((direction === 'older' ? paginator.fetchingOlder : paginator.fetchingNewer).value).toBe(false);
		if (direction === 'older') {
			expect(paginator.items.value.map(item => item.id)).toEqual(['0200', '0199']);
		} else {
			expect(paginator.queuedAheadItemsCount.value).toBe(1);
			paginator.releaseQueue();
			expect(paginator.items.value.map(item => item.id)).toEqual(['0201', '0200']);
		}
	});
});

describe('Paginator new items', () => {
	test('shares the pending fetch and lets every caller await its completion', async () => {
		const paginator = new Paginator('notes/timeline', {});
		await initialize(paginator);
		const first = paginator.fetchNewer({ toQueue: true });
		const second = paginator.fetchNewer({ toQueue: true });
		expect(second).toBe(first);
		expect(requests).toHaveLength(2);
		expect(paginator.fetchingNewer.value).toBe(true);

		requests[1].resolve(notes(200));
		await Promise.all([first, second]);
		expect(paginator.fetchingNewer.value).toBe(false);
		expect(paginator.queuedAheadItemsCount.value).toBe(1);
	});

	test('skips new-page requests during initialization and allows retries after a failed new-page request', async () => {
		const paginator = new Paginator('notes/timeline', {});
		const initialLoad = paginator.init();
		await paginator.fetchNewer();
		expect(requests).toHaveLength(1);
		requests[0].resolve(notes(100));
		await initialLoad;

		const failedLoad = paginator.fetchNewer();
		requests[1].reject(new Error('Request failed'));
		await failedLoad;
		expect(paginator.fetchingNewer.value).toBe(false);
		const retry = paginator.fetchNewer();
		requests[2].resolve(notes(101));
		await retry;
		expect(paginator.items.value.map(item => item.id)).toEqual(['0101', '0100']);
	});

	test('deduplicates queue batches, streaming items and already displayed items', async () => {
		const paginator = new Paginator('notes/timeline', { useShallowRef: true });
		await initialize(paginator, notes(100));
		paginator.enqueue(notes(101)[0]);
		paginator.enqueue(notes(101)[0]);
		paginator.enqueue(notes(100)[0]);
		const loading = paginator.fetchNewer({ toQueue: true });
		requests.at(-1)!.resolve([...notes(100, 3), ...notes(102)]);
		await loading;
		expect(paginator.queuedAheadItemsCount.value).toBe(2);
		paginator.releaseQueue();
		expect(paginator.items.value.map(item => item.id)).toEqual(['0102', '0101', '0100']);
		expect(paginator.queuedAheadItemsCount.value).toBe(0);
	});

	test.each(['newest', 'oldest'] as const)('deduplicates overlapping pages in %s order without trimming', async (order) => {
		const paginator = new Paginator('notes/timeline', { order, useShallowRef: true });
		await initialize(paginator, notes(100, 30));
		const loading = paginator.fetchNewer();
		requests.at(-1)!.resolve([...notes(129, 3), ...notes(131)]);
		await loading;
		expect(paginator.items.value).toHaveLength(32);
		expect(new Set(paginator.items.value.map(item => item.id)).size).toBe(32);
	});
});

describe('Paginator streaming trim', () => {
	test('keeps only the latest 30 items when the streaming caller opts into trimming', async () => {
		const paginator = new Paginator('notes/timeline', { useShallowRef: true });
		await initialize(paginator);
		for (let i = 0; i < 3; i++) {
			const loading = paginator.fetchNewer({ trim: true });
			requests.at(-1)!.resolve(notes(115 + i * 15, 15));
			await loading;
		}
		expect(paginator.items.value.map(item => item.id)).toEqual(notes(130, 30).toReversed().map(item => item.id));
		expect(paginator.canFetchOlder.value).toBe(true);
	});

	test('queues the response if the reader moves away from the top during the request', async () => {
		const paginator = new Paginator('notes/timeline', { useShallowRef: true });
		await initialize(paginator, notes(100, 45).toReversed());
		let readingOlderItems = false;
		const loading = paginator.fetchNewer({ toQueue: () => readingOlderItems, trim: true });
		readingOlderItems = true;
		requests.at(-1)!.resolve(notes(145, 15));
		await loading;

		expect(paginator.items.value.map(item => item.id)).toEqual(notes(100, 45).toReversed().map(item => item.id));
		expect(paginator.queuedAheadItemsCount.value).toBe(15);
	});
});
