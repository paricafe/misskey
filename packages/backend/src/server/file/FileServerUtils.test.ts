/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { handleRangeRequest } from './FileServerUtils.js';

describe('file range responses', () => {
	const app = Fastify();
	let directory: string;

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'misskey-range-'));
		await writeFile(join(directory, 'file'), '0123456789');
		await writeFile(join(directory, 'empty'), '');
		app.get('/file', (request, reply) => handleRangeRequest(reply, request.headers.range, 10, join(directory, 'file')));
		app.get('/empty', (request, reply) => handleRangeRequest(reply, request.headers.range, 0, join(directory, 'empty')));
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	});

	test.each([
		{ range: 'bytes=-5', start: 5, end: 9, body: '56789' },
		{ range: 'bytes=-15', start: 0, end: 9, body: '0123456789' },
		{ range: 'bytes=4-', start: 4, end: 9, body: '456789' },
		{ range: 'bytes=0-10', start: 0, end: 9, body: '0123456789' },
		{ range: 'bytes=7-999', start: 7, end: 9, body: '789' },
		{ range: 'bytes=0-999999999999999999999999', start: 0, end: 9, body: '0123456789' },
		{ range: 'bytes=-999999999999999999999999', start: 0, end: 9, body: '0123456789' },
		{ range: 'bytes=0-0', start: 0, end: 0, body: '0' },
	])('serves $range with consistent body and headers', async ({ range, start, end, body }) => {
		const response = await app.inject({ url: '/file', headers: { range } });
		expect(response.statusCode).toBe(206);
		expect(response.body).toBe(body);
		expect(response.headers['content-range']).toBe(`bytes ${start}-${end}/10`);
		expect(response.headers['content-length']).toBe(String(body.length));
	});

	test.each(['bytes=-0', 'bytes=10-', 'bytes=8-2', 'bytes=abc', 'bytes=-', 'bytes=0-1,3-4', 'bytes=9007199254740992-'])('rejects %s with 416 and the actual size', async range => {
		const response = await app.inject({ url: '/file', headers: { range } });
		expect(response.statusCode).toBe(416);
		expect(response.headers['content-range']).toBe('bytes */10');
	});

	test('returns 416 for ranges on an empty file', async () => {
		const response = await app.inject({ url: '/empty', headers: { range: 'bytes=0-' } });
		expect(response.statusCode).toBe(416);
		expect(response.headers['content-range']).toBe('bytes */0');
	});

	test('serves a complete file without Range', async () => {
		const response = await app.inject('/file');
		expect(response.statusCode).toBe(200);
		expect(response.body).toBe('0123456789');
		expect(response.headers['content-length']).toBe('10');
		expect(response.headers['content-range']).toBeUndefined();
	});
});
