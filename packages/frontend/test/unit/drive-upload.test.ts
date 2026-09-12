/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { uploadFile, UploadAbortedError } from '@/utility/drive.js';
import { i18n } from '@/i18n.js';

const mocks = vi.hoisted(() => ({
	alert: vi.fn(),
	emit: vi.fn(),
}));

vi.mock('@/os.js', () => ({ alert: mocks.alert }));
vi.mock('@/i.js', () => ({ $i: { token: 'test-token', policies: { maxFileSizeMb: 100 } } }));
vi.mock('@/instance.js', () => ({ instance: { maxFileSize: 100 * 1024 * 1024 } }));
vi.mock('@/events.js', () => ({ globalEvents: { emit: mocks.emit } }));
vi.mock('@/stream.js', () => ({ useStream: vi.fn() }));

class MockXMLHttpRequest {
	static instances: MockXMLHttpRequest[] = [];
	status = 0;
	response = '';
	onload: ((event: ProgressEvent<XMLHttpRequest>) => void) | null = null;
	onerror: (() => void) | null = null;
	ontimeout: (() => void) | null = null;
	onabort: (() => void) | null = null;
	upload = { onprogress: null };
	open = vi.fn();
	send = vi.fn();
	abort = vi.fn(() => this.onabort?.());

	constructor() {
		MockXMLHttpRequest.instances.push(this);
	}

	respond(status: number, response: string) {
		this.status = status;
		this.response = response;
		this.onload?.({ target: this } as unknown as ProgressEvent<XMLHttpRequest>);
	}
}

function startUpload() {
	const upload = uploadFile(new File(['upload'], 'test.txt', { type: 'text/plain' }));
	return { ...upload, xhr: MockXMLHttpRequest.instances.at(-1)! };
}

beforeEach(() => {
	MockXMLHttpRequest.instances = [];
	mocks.alert.mockReset();
	mocks.emit.mockReset();
	vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('drive upload transport failures', () => {
	test.each(['error', 'timeout'] as const)('rejects a transport %s without retrying', async (event) => {
		const { filePromise, xhr } = startUpload();
		const rejected = expect(filePromise).rejects.toThrow(i18n.ts.serverIsDead);
		xhr[event === 'error' ? 'onerror' : 'ontimeout']?.();
		await rejected;
		expect(mocks.alert).toHaveBeenCalledOnce();
		expect(mocks.emit).not.toHaveBeenCalled();
		expect(xhr.send).toHaveBeenCalledOnce();
		expect(MockXMLHttpRequest.instances).toHaveLength(1);
	});

	test.each([
		[502, '<html>Bad Gateway</html>'],
		[504, '<html>Gateway Timeout</html>'],
		[200, '<html>Unexpected proxy page</html>'],
		[200, ''],
		[400, '{invalid JSON'],
	] as const)('rejects an invalid response with HTTP %i', async (status, response) => {
		const { filePromise, xhr } = startUpload();
		const rejected = expect(filePromise).rejects.toThrow(`HTTP ${status}`);
		expect(() => xhr.respond(status, response)).not.toThrow();
		await rejected;
		expect(mocks.alert).toHaveBeenCalledOnce();
		expect(mocks.emit).not.toHaveBeenCalled();
	});

	test.each(['null', 'true', '0', '"file"', '[]', '{}', '{"id":1}', '{"id":""}'])('rejects a success response that is not a drive file: %s', async (response) => {
		const { filePromise, xhr } = startUpload();
		const rejected = expect(filePromise).rejects.toThrow(i18n.ts.somethingHappened);
		expect(() => xhr.respond(200, response)).not.toThrow();
		await rejected;
		expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ text: `${i18n.ts.somethingHappened} (HTTP 200)` }));
		expect(mocks.emit).not.toHaveBeenCalled();
	});

	test('keeps the file-size error for an HTML 413 response', async () => {
		const { filePromise, xhr } = startUpload();
		const rejected = expect(filePromise).rejects.toBeUndefined();
		xhr.respond(413, '<html>Payload Too Large</html>');
		await rejected;
		expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ text: i18n.ts.cannotUploadBecauseExceedsFileSizeLimit }));
	});

	test('keeps the API error message for insufficient drive space', async () => {
		const { filePromise, xhr } = startUpload();
		const rejected = expect(filePromise).rejects.toBeUndefined();
		xhr.respond(400, JSON.stringify({ error: { id: 'd08dbc37-a6a9-463a-8c47-96c32ab5f064' } }));
		await rejected;
		expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ text: i18n.ts.cannotUploadBecauseNoFreeSpace }));
	});

	test('rejects a JSON null error response', async () => {
		const { filePromise, xhr } = startUpload();
		const rejected = expect(filePromise).rejects.toBeUndefined();
		expect(() => xhr.respond(500, 'null')).not.toThrow();
		await rejected;
		expect(mocks.alert).toHaveBeenCalledOnce();
	});

	test('preserves cancellation without showing an upload error', async () => {
		const { filePromise, abort, xhr } = startUpload();
		const rejected = expect(filePromise).rejects.toBeInstanceOf(UploadAbortedError);
		abort();
		await rejected;
		expect(xhr.abort).toHaveBeenCalledOnce();
		expect(mocks.alert).not.toHaveBeenCalled();
		expect(mocks.emit).not.toHaveBeenCalled();
	});

	test('resolves a successful upload and publishes its file', async () => {
		const { filePromise, xhr } = startUpload();
		const file = { id: 'uploaded-file', name: 'test.txt' };
		xhr.respond(200, JSON.stringify(file));
		await expect(filePromise).resolves.toEqual(file);
		expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('driveFileCreated', file);
		expect(mocks.alert).not.toHaveBeenCalled();
	});
});
