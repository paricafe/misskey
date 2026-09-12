/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp } from 'vue';
import { useUploader } from '@/composables/use-uploader.js';
import type { UploaderItem } from '@/composables/use-uploader.js';
import { prefer } from '@/preferences.js';

const mocks = vi.hoisted(() => ({
	compressImage: vi.fn<() => Promise<Blob>>(),
	user: { policies: { watermarkAvailable: false } },
	renderWatermark: vi.fn(),
	destroyWatermark: vi.fn(),
	initializeConversion: vi.fn(),
	disposeInput: vi.fn(),
}));

vi.mock('@misskey-dev/browser-image-resizer', () => ({ readAndCompressImage: mocks.compressImage }));
vi.mock('is-file-animated', () => ({ default: async () => false }));
vi.mock('@/utility/isWebpSupported.js', () => ({ isWebpSupported: () => false }));
vi.mock('@/i.js', () => ({ ensureSignin: () => mocks.user }));
vi.mock('@/utility/drive.js', () => ({ uploadFile: vi.fn(), UploadAbortedError: class extends Error {} }));
vi.mock('@/utility/lightbox.js', () => ({ isPreviewable: () => false, getType: vi.fn() }));
vi.mock('@/os.js', () => ({}));
vi.mock('@/utility/watermark/WatermarkRenderer.js', () => ({
	WatermarkRenderer: class {
		render = mocks.renderWatermark;
		destroy = mocks.destroyWatermark;
	},
}));
vi.mock('mediabunny', () => ({
	BlobSource: class {},
	Input: class { dispose = mocks.disposeInput; },
	Output: class {
		target: { buffer: ArrayBuffer };
		format: { mimeType: string };
		constructor(options: { target: { buffer: ArrayBuffer }; format: { mimeType: string } }) {
			this.target = options.target;
			this.format = options.format;
		}
	},
	BufferTarget: class { buffer = new ArrayBuffer(5); },
	Mp4OutputFormat: class { mimeType = 'video/mp4'; },
	Conversion: { init: mocks.initializeConversion },
	ALL_FORMATS: [],
	QUALITY_VERY_HIGH: 1,
	QUALITY_MEDIUM: 2,
	QUALITY_VERY_LOW: 3,
}));

const allocatedUrls = new Set<string>();
const cleanups: (() => void)[] = [];
let nextUrl = 0;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function bitmap() {
	return { width: 4000, height: 3000, close: vi.fn() } as unknown as ImageBitmap;
}

function mountUploader() {
	let uploader!: ReturnType<typeof useUploader>;
	const app = createApp({
		setup() {
			uploader = useUploader();
			return () => null;
		},
	});
	app.mount(document.createElement('div'));
	cleanups.push(() => app.unmount());
	return uploader;
}

function compressionActions(uploader: ReturnType<typeof useUploader>, item: UploaderItem) {
	const entry = uploader.getMenu(item).find(x => typeof x === 'object' && x !== null && 'icon' in x && x.icon === 'ti ti-leaf');
	return (entry as { children: { action?: () => void }[] }).children.filter(x => x.action).map(x => x.action!);
}

beforeEach(() => {
	allocatedUrls.clear();
	mocks.user.policies.watermarkAvailable = false;
	mocks.renderWatermark.mockResolvedValue(undefined);
	Object.assign(prefer.s, {
		keepOriginalFilename: true,
		defaultImageCompressionLevel: 0,
		defaultVideoCompressionLevel: 0,
		imageFramePresets: [],
		watermarkPresets: [],
	});
	vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
		const url = `blob:upload-${nextUrl++}`;
		allocatedUrls.add(url);
		return url;
	});
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => { allocatedUrls.delete(url); });
	vi.stubGlobal('createImageBitmap', vi.fn().mockImplementation(async () => bitmap()));
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	mocks.compressImage.mockReset();
	mocks.renderWatermark.mockReset();
	mocks.destroyWatermark.mockReset();
	mocks.initializeConversion.mockReset();
	mocks.disposeInput.mockReset();
});

describe('uploader preprocessing lifecycle', () => {
	test.each(['remove', 'reset', 'dispose'] as const)('does not recreate URLs after %s during image decode', async (operation) => {
		const decoding = deferred<ImageBitmap>();
		vi.mocked(createImageBitmap).mockReturnValueOnce(decoding.promise);
		const uploader = mountUploader();
		uploader.addFiles([new File(['image'], 'large.jpg', { type: 'image/jpeg' })]);
		const item = uploader.items.value[0];
		if (operation === 'remove') uploader.removeItem(item);
		else uploader[operation]();
		expect(allocatedUrls.size).toBe(0);

		const decoded = bitmap();
		decoding.resolve(decoded);
		await vi.waitFor(() => expect(decoded.close).toHaveBeenCalledOnce());
		expect(uploader.items.value).toHaveLength(0);
		expect(allocatedUrls.size).toBe(0);
	});

	test('only the newest preprocessing run can replace the file and its metadata', async () => {
		const uploader = mountUploader();
		uploader.addFiles([new File(['original image'], 'large.jpg', { type: 'image/jpeg' })]);
		const item = uploader.items.value[0];
		await vi.waitFor(() => expect(item.preprocessing).toBe(false));
		const actions = compressionActions(uploader, item);
		const older = deferred<Blob>();
		const newer = deferred<Blob>();
		const olderBitmap = bitmap();
		vi.mocked(createImageBitmap).mockResolvedValueOnce(olderBitmap);
		mocks.compressImage.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
		actions[1]();
		await vi.waitFor(() => expect(mocks.compressImage).toHaveBeenCalledTimes(1));
		actions[3]();
		await vi.waitFor(() => expect(mocks.compressImage).toHaveBeenCalledTimes(2));
		const newestResult = new Blob(['new'], { type: 'image/jpeg' });
		newer.resolve(newestResult);
		await vi.waitFor(() => expect(item.preprocessing).toBe(false));
		const currentUrl = item.objectUrl;
		older.resolve(new Blob(['old-data'], { type: 'image/jpeg' }));
		await vi.waitFor(() => expect(olderBitmap.close).toHaveBeenCalledOnce());
		expect(item.preprocessedFile).toBe(newestResult);
		expect(item.compressedSize).toBe(3);
		expect(item.objectUrl).toBe(currentUrl);
		expect(allocatedUrls.size).toBe(1);
	});

	test('aborting a running compression preserves the previous result and releases its bitmap', async () => {
		const uploader = mountUploader();
		uploader.addFiles([new File(['original image'], 'large.jpg', { type: 'image/jpeg' })]);
		const item = uploader.items.value[0];
		await vi.waitFor(() => expect(item.preprocessing).toBe(false));
		const originalUrl = item.objectUrl;
		const originalFile = item.preprocessedFile;
		const decoding = bitmap();
		vi.mocked(createImageBitmap).mockResolvedValueOnce(decoding);
		const compression = deferred<Blob>();
		mocks.compressImage.mockReturnValueOnce(compression.promise);
		compressionActions(uploader, item)[1]();
		await vi.waitFor(() => expect(mocks.compressImage).toHaveBeenCalledOnce());
		uploader.abortAll();
		compression.resolve(new Blob(['new'], { type: 'image/jpeg' }));
		await vi.waitFor(() => expect(decoding.close).toHaveBeenCalledOnce());
		expect(item.objectUrl).toBe(originalUrl);
		expect(item.preprocessedFile).toBe(originalFile);
		expect(allocatedUrls.size).toBe(1);
		expect(item.preprocessing).toBe(false);
	});

	test('releases the renderer and bitmap if canvas export fails', async () => {
		mocks.user.policies.watermarkAvailable = true;
		Object.assign(prefer.s, { defaultWatermarkPresetId: 'watermark', watermarkPresets: [{ id: 'watermark', layers: [] }] });
		const decoded = bitmap();
		vi.mocked(createImageBitmap).mockResolvedValueOnce(decoded);
		vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(null));
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const uploader = mountUploader();
		uploader.addFiles([new File(['image'], 'large.jpg', { type: 'image/jpeg' })]);
		const item = uploader.items.value[0];
		await vi.waitFor(() => expect(item.preprocessing).toBe(false));
		expect(error).toHaveBeenCalledOnce();
		expect(mocks.destroyWatermark).toHaveBeenCalledOnce();
		expect(decoded.close).toHaveBeenCalledOnce();
		expect(allocatedUrls.size).toBe(1);
	});

	test('cancels a video conversion that initializes after disposal', async () => {
		Object.assign(prefer.s, { defaultVideoCompressionLevel: 1 });
		const initialized = deferred<{ execute: () => Promise<void>; cancel: () => Promise<void> }>();
		mocks.initializeConversion.mockReturnValueOnce(initialized.promise);
		const uploader = mountUploader();
		uploader.addFiles([new File(['video'], 'large.mp4', { type: 'video/mp4' })]);
		await vi.waitFor(() => expect(mocks.initializeConversion).toHaveBeenCalledOnce());
		uploader.dispose();
		const conversion = { execute: vi.fn().mockResolvedValue(undefined), cancel: vi.fn().mockResolvedValue(undefined) };
		initialized.resolve(conversion);
		await vi.waitFor(() => expect(mocks.disposeInput).toHaveBeenCalledOnce());
		expect(conversion.cancel).toHaveBeenCalledOnce();
		expect(conversion.execute).not.toHaveBeenCalled();
		expect(allocatedUrls.size).toBe(0);
	});

	test('commits successful video conversions and disposes their input', async () => {
		Object.assign(prefer.s, { defaultVideoCompressionLevel: 1 });
		const conversion = { execute: vi.fn().mockResolvedValue(undefined), cancel: vi.fn().mockResolvedValue(undefined) };
		mocks.initializeConversion.mockResolvedValueOnce(conversion);
		const uploader = mountUploader();
		uploader.addFiles([new File(['original video'], 'large.mov', { type: 'video/quicktime' })]);
		const item = uploader.items.value[0];
		await vi.waitFor(() => expect(item.preprocessing).toBe(false));
		expect(conversion.execute).toHaveBeenCalledOnce();
		expect(conversion.cancel).not.toHaveBeenCalled();
		expect(mocks.disposeInput).toHaveBeenCalledOnce();
		expect(item.preprocessedFile?.type).toBe('video/mp4');
		expect(item.preprocessedFile?.size).toBe(5);
		expect(item.compressedSize).toBe(5);
		expect(item.suffix).toBe('.mp4');
		expect(allocatedUrls.size).toBe(1);
	});
});
