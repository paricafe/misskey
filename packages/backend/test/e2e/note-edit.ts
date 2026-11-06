/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import type { DataSource } from 'typeorm';
import type * as Misskey from 'misskey-js';
import { MiNote } from '@/models/Note.js';
import { api, initTestDb, post, signup, uploadFile } from '../utils.js';

describe('note editing regressions', () => {
	let db: DataSource;
	let alice: Misskey.entities.SignupResponse;
	let bob: Misskey.entities.SignupResponse;
	let carol: Misskey.entities.SignupResponse;

	beforeAll(async () => {
		db = await initTestDb(true);
		alice = await signup({ username: 'edit_alice' });
		bob = await signup({ username: 'edit_bob' });
		carol = await signup({ username: 'edit_carol' });
	});
	afterAll(async () => { await db?.destroy(); });

	test('allows editing the CW of a poll-only note without changing its poll', async () => {
		const original = await post(alice, { poll: { choices: ['A', 'B'], multiple: false } });
		const edited = await api('notes/update', { noteId: original.id, text: null, cw: 'Warning', fileIds: [] }, alice);
		assert.equal(edited.status, 200, JSON.stringify(edited.body));
		assert.equal(edited.body.updatedNote.text, null);
		assert.equal(edited.body.updatedNote.cw, 'Warning');
		assert.deepEqual(edited.body.updatedNote.poll, original.poll);
	});

	test('persists replacement mentions from text and CW and records the previous IDs', async () => {
		const original = await post(alice, { text: '@edit_bob Hello' });
		const edited = await api('notes/update', { noteId: original.id, text: 'Edited', cw: '@edit_carol Warning' }, alice);
		assert.equal(edited.status, 200, JSON.stringify(edited.body));
		const saved = await db.getRepository(MiNote).createQueryBuilder('note').addSelect('note.history').where('note.id = :id', { id: original.id }).getOneOrFail();
		assert.deepEqual(saved.mentions, [carol.id]);
		assert.deepEqual(saved.history?.[0].mentions, [bob.id]);
		assert.deepEqual(edited.body.updatedNote.mentions, [carol.id]);

		const deleted = await api('notes/delete', { noteId: original.id }, alice);
		assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
		assert.equal(await db.getRepository(MiNote).countBy({ id: original.id }), 0);
	});

	test('keeps the audience of a direct note when its edited text mentions another user', async () => {
		const original = await post(alice, { text: '@edit_bob Private', visibility: 'specified', visibleUserIds: [bob.id] });
		const edited = await api('notes/update', { noteId: original.id, text: '@edit_carol Edited', cw: null }, alice);
		assert.equal(edited.status, 200, JSON.stringify(edited.body));
		assert.deepEqual(edited.body.updatedNote.visibleUserIds, [bob.id]);
		assert.deepEqual((await db.getRepository(MiNote).findOneByOrFail({ id: original.id })).mentions, [bob.id]);
		const hidden = await api('notes/show', { noteId: original.id }, carol);
		assert.equal(hidden.status, 200);
		assert.equal(hidden.body.isHidden, true);
		assert.equal(hidden.body.text, null);
		assert.equal((await api('notes/show', { noteId: original.id }, bob)).body.text, '@edit_carol Edited');
	});

	test('removes the final attachment when an edit explicitly supplies an empty list', async () => {
		const file = await uploadFile(alice);
		assert.equal(file.status, 200);
		const original = await post(alice, { text: 'With attachment', fileIds: [file.body!.id] });
		const edited = await api('notes/update', { noteId: original.id, text: 'Without attachment', cw: null, fileIds: [] }, alice);
		assert.equal(edited.status, 200, JSON.stringify(edited.body));
		assert.deepEqual(edited.body.updatedNote.fileIds, []);
		assert.deepEqual((await db.getRepository(MiNote).findOneByOrFail({ id: original.id })).fileIds, []);
	});

	test('matches each independent tag in AND and OR search groups', async () => {
		const both = await post(alice, { text: '#reviewalpha #reviewbeta' });
		await post(alice, { text: '#reviewbeta' });
		const alternative = await post(alice, { text: '#reviewgamma' });
		const result = await api('notes/search-by-tag', { query: [['reviewalpha', 'reviewbeta'], ['reviewgamma']] }, alice);
		assert.equal(result.status, 200, JSON.stringify(result.body));
		assert.deepEqual(result.body.map(note => note.id).sort(), [both.id, alternative.id].sort());
	});
});
