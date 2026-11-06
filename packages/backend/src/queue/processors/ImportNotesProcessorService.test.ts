/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fsp from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { ImportNotesProcessorService } from './ImportNotesProcessorService.js';

async function buildZip(entries: Record<string, string>): Promise<Uint8Array> {
	const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false });
	for (const [name, data] of Object.entries(entries)) {
		await writer.add(name, new TextReader(data));
	}
	return new Uint8Array(await (await writer.close()).arrayBuffer());
}

function tweetsJs(tweets: { id_str: string; in_reply_to_status_id_str?: string }[]): string {
	return `window.YTD.tweets.part0 = ${JSON.stringify(tweets.map(tweet => ({ tweet })))}`;
}

function setup(zip: Uint8Array) {
	const logger = { info: vi.fn(), succ: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const queueService = { createImportTweetsToDbJob: vi.fn() };
	const service = new ImportNotesProcessorService(
		{} as never,
		{ findOneBy: vi.fn().mockResolvedValue({ id: 'user' }) } as never,
		{ findOneBy: vi.fn().mockResolvedValue({ id: 'file', name: 'twitter.zip', url: 'https://files.example/twitter.zip' }) } as never,
		{ findOneBy: vi.fn().mockResolvedValue({ id: 'folder' }) } as never,
		{} as never,
		queueService as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{ downloadUrl: vi.fn(async (_url: string, path: string) => fsp.writeFile(path, zip)) } as never,
		{} as never,
		{ logger: { createSubLogger: () => logger } } as never,
	);
	const job = { data: { user: { id: 'user' }, fileId: 'file', type: 'Twitter' } } as never;
	return { service, queueService, job };
}

describe('ImportNotesProcessorService archive limits', () => {
	test('imports tweets from data/tweets.js and ignores unrelated entries', async () => {
		const zip = await buildZip({
			'data/tweets.js': tweetsJs([{ id_str: '1' }, { id_str: '2', in_reply_to_status_id_str: '1' }]),
			'data/unrelated.bin': 'x'.repeat(1024),
		});
		const { service, queueService, job } = setup(zip);

		await service.process(job);

		expect(queueService.createImportTweetsToDbJob).toHaveBeenCalledOnce();
		const [, roots] = queueService.createImportTweetsToDbJob.mock.calls[0];
		expect(roots).toHaveLength(1);
		expect(roots[0].childNotes).toHaveLength(1);
	});

	test('rejects reply chains deeper than the limit without queueing jobs', async () => {
		const tweets = Array.from({ length: 201 }, (_, i) => ({
			id_str: String(i),
			...(i > 0 ? { in_reply_to_status_id_str: String(i - 1) } : {}),
		}));
		const { service, queueService, job } = setup(await buildZip({ 'data/tweets.js': tweetsJs(tweets) }));

		await expect(service.process(job)).rejects.toThrow('reply chain is too deep');
		expect(queueService.createImportTweetsToDbJob).not.toHaveBeenCalled();
	});
});

describe('Pleroma import visibility', () => {
	test.each([
		[['https://www.w3.org/ns/activitystreams#Public'], [], 'public'],
		[['https://remote.example/users/alice/followers'], ['https://www.w3.org/ns/activitystreams#Public'], 'home'],
		[['https://remote.example/users/alice/followers'], [], 'followers'],
		[['https://remote.example/users/bob'], [], null],
		[[], [], null],
	] as const)('maps to=%j cc=%j to %s without widening the audience', async (to, cc, visibility) => {
		const service = Object.create(ImportNotesProcessorService.prototype) as ImportNotesProcessorService;
		const importNote = vi.fn().mockResolvedValue({ id: 'imported' });
		Object.assign(service, {
			usersRepository: { findOneBy: vi.fn().mockResolvedValue({ id: 'alice' }) },
			driveFoldersRepository: { findOneBy: vi.fn().mockResolvedValue({ id: 'imports' }) },
			mfmService: { fromHtml: vi.fn().mockResolvedValue('Original text') },
			noteCreateService: { import: importNote },
		});
		await service.processPleroToDb({ data: { user: { id: 'alice' }, target: {
			type: 'Create',
			object: { type: 'Note', published: '2026-01-01T00:00:00Z', content: '<p>Original text</p>', to, cc },
		} } } as never);
		if (visibility == null) expect(importNote).not.toHaveBeenCalled();
		else expect(importNote).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: 'Original text', visibility }));
	});
});
