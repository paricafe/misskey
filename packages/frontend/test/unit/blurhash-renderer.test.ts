/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { createBlurhashRenderer } from '@/utility/blurhash-renderer.js';

class FakeWorker {
	listeners: Array<(ev: MessageEvent) => void> = [];
	posted: unknown[] = [];
	terminated = false;

	addEventListener(type: string, listener: (ev: MessageEvent) => void) {
		if (type === 'message') this.listeners.push(listener);
	}

	removeEventListener(type: string, listener: (ev: MessageEvent) => void) {
		if (type === 'message') {
			this.listeners = this.listeners.filter(fn => fn !== listener);
		}
	}

	postMessage(data: unknown) {
		this.posted.push(data);
	}

	emitMessage(data: unknown) {
		const ev = { data } as MessageEvent;
		for (const listener of [...this.listeners]) listener(ev);
	}

	terminate() {
		this.terminated = true;
	}
}

describe('createBlurhashRenderer', () => {
	test('does not create any workers until render is requested', () => {
		const createTestWorker = vi.fn(() => new FakeWorker() as unknown as Worker);
		const createDrawWorker = vi.fn(() => new FakeWorker() as unknown as Worker);
		const renderer = createBlurhashRenderer({
			isTest: () => false,
			createTestWorker,
			createDrawWorker,
			getConcurrency: () => 8,
			createFallbackCanvas: () => document.createElement('canvas'),
		});

		expect(renderer.hasStarted()).toBe(false);
		expect(createTestWorker).not.toHaveBeenCalled();
		expect(createDrawWorker).not.toHaveBeenCalled();
	});

	test('registers one shared listener per draw worker, unicasts by id, and closes canceled bitmaps', async () => {
		const testWorkers: FakeWorker[] = [];
		const drawWorkers: FakeWorker[] = [];
		const renderer = createBlurhashRenderer({
			isTest: () => false,
			createTestWorker: () => {
				const w = new FakeWorker();
				testWorkers.push(w);
				return w as unknown as Worker;
			},
			createDrawWorker: () => {
				const w = new FakeWorker();
				drawWorkers.push(w);
				return w as unknown as Worker;
			},
			getConcurrency: () => 8,
			createFallbackCanvas: () => document.createElement('canvas'),
		});

		const cb1 = vi.fn();
		const cb2 = vi.fn();
		const cb3 = vi.fn();
		const p1 = renderer.render('req-1', 'hash-1', cb1, () => false);
		const p2 = renderer.render('req-2', 'hash-2', cb2, () => false);
		const p3 = renderer.render('req-3', 'hash-3', cb3, () => false);

		expect(testWorkers).toHaveLength(1);
		testWorkers[0].emitMessage({ result: true });
		await Promise.all([p1, p2, p3]);

		expect(testWorkers[0].terminated).toBe(true);
		expect(drawWorkers).toHaveLength(4);
		for (const w of drawWorkers) {
			expect(w.listeners).toHaveLength(1);
		}

		const bmp1 = { close: vi.fn() } as unknown as ImageBitmap;
		drawWorkers[0].emitMessage({ id: 'req-1', bitmap: bmp1 });
		expect(cb1).toHaveBeenCalledOnce();
		expect(cb1).toHaveBeenCalledWith(bmp1);
		expect(cb2).not.toHaveBeenCalled();
		expect(cb3).not.toHaveBeenCalled();

		renderer.cancel('req-2');
		const bmp2 = { close: vi.fn() } as unknown as ImageBitmap;
		drawWorkers[1].emitMessage({ id: 'req-2', bitmap: bmp2 });
		expect(cb2).not.toHaveBeenCalled();
		expect(bmp2.close).toHaveBeenCalledOnce();
	});
});
