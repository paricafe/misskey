/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import DrawBlurhash from '@/workers/draw-blurhash?worker';
import TestWebGL2 from '@/workers/test-webgl2?worker';
import { WorkerMultiDispatch } from '@@/js/worker-multi-dispatch.js';

export type BlurhashBitmapCallback = (bitmap: ImageBitmap) => void;

type BlurhashWorkerRequest = {
	id: string;
	hash: string;
};

type BlurhashWorkerMessage = {
	id?: string;
	bitmap?: ImageBitmap;
};

type WindowWithPlaywright = Window & {
	isPlaywright?: boolean;
};

export type BlurhashRendererDeps = {
	isTest: () => boolean;
	createTestWorker: () => Worker;
	createDrawWorker: () => Worker;
	getConcurrency: () => number;
	createFallbackCanvas: () => HTMLCanvasElement;
};

export function createBlurhashRenderer(deps: BlurhashRendererDeps) {
	let rendererPromise: Promise<WorkerMultiDispatch<BlurhashWorkerRequest, BlurhashWorkerMessage> | HTMLCanvasElement> | null = null;
	const pending = new Map<string, BlurhashBitmapCallback>();

	function onWorkerMessage(event: MessageEvent<BlurhashWorkerMessage>) {
		const { id, bitmap } = event.data ?? {};
		if (id == null || bitmap == null) return;
		const callback = pending.get(id);
		if (callback != null) {
			pending.delete(id);
			callback(bitmap);
		} else {
			bitmap.close?.();
		}
	}

	function getRenderer(): Promise<WorkerMultiDispatch<BlurhashWorkerRequest, BlurhashWorkerMessage> | HTMLCanvasElement> {
		return rendererPromise ??= new Promise<WorkerMultiDispatch<BlurhashWorkerRequest, BlurhashWorkerMessage> | HTMLCanvasElement>(resolve => {
			if (deps.isTest()) {
				resolve(deps.createFallbackCanvas());
				return;
			}

			const testWorker = deps.createTestWorker();
			testWorker.addEventListener('message', event => {
				if (event.data?.result) {
					const workers = new WorkerMultiDispatch<BlurhashWorkerRequest, BlurhashWorkerMessage>(
						deps.createDrawWorker,
						Math.max(1, Math.min(deps.getConcurrency() - 1, 4)),
					);
					workers.addListener(onWorkerMessage);
					resolve(workers);
				} else {
					resolve(deps.createFallbackCanvas());
				}
				testWorker.terminate();
			});
		});
	}

	async function render(
		id: string,
		hash: string,
		onResult: (image: CanvasImageSource) => void,
		isStale: () => boolean,
	): Promise<void> {
		const work = await getRenderer();
		if (isStale()) return;

		if (work instanceof WorkerMultiDispatch) {
			pending.set(id, (bitmap) => {
				if (isStale()) {
					bitmap.close?.();
					return;
				}
				onResult(bitmap);
			});
			work.postMessage({ id, hash }, undefined);
		} else {
			try {
				const { render: renderBuraha } = await import('buraha');
				if (isStale()) return;
				renderBuraha(hash, work);
				onResult(work);
			} catch (error) {
				console.error('Error occurred during drawing blurhash', error);
			}
		}
	}

	function cancel(id: string) {
		pending.delete(id);
	}

	function hasStarted() {
		return rendererPromise != null;
	}

	return {
		render,
		cancel,
		hasStarted,
	};
}

export const defaultBlurhashRenderer = createBlurhashRenderer({
	isTest: () => Boolean(import.meta.env.MODE === 'test' || (window as WindowWithPlaywright).isPlaywright),
	createTestWorker: () => new TestWebGL2(),
	createDrawWorker: () => new DrawBlurhash(),
	getConcurrency: () => navigator.hardwareConcurrency || 2,
	createFallbackCanvas: () => {
		const canvas = window.document.createElement('canvas');
		canvas.width = 64;
		canvas.height = 64;
		return canvas;
	},
});
