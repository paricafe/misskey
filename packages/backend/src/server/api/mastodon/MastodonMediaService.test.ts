/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MastodonMediaService } from './MastodonMediaService.js';

type StateRow = { userId: string; kind: string; key: string; value: Record<string, unknown> };

describe(MastodonMediaService, () => {
	function createService() {
		const rows = new Map<string, StateRow>();
		const rowKey = (userId: string, kind: string, key: string) => `${userId}:${kind}:${key}`;
		const state = {
			get: vi.fn(async (userId: string, kind: string, key: string) => rows.get(rowKey(userId, kind, key)) ?? null),
			put: vi.fn(async (row: StateRow) => {
				rows.set(rowKey(row.userId, row.kind, row.key), structuredClone(row));
				return row;
			}),
			withUserKindLock: vi.fn(async (_userId: string, _kind: string, callback: (transaction: object) => Promise<unknown>) => await callback(state)),
		};
		const file = { id: 'file-id', comment: 'Original description' };
		const api = {
			invoke: vi.fn(async (_endpoint: string, body: { comment?: string | null }) => {
				if (Object.hasOwn(body, 'comment')) file.comment = body.comment ?? '';
				return { ...file };
			}),
		};
		const entities = {
			attachment: vi.fn((input: typeof file) => ({ id: input.id, description: input.comment, meta: { original: { width: 100, height: 50 } } })),
		};
		const notes = { query: vi.fn(async () => [{ used: false }]) };
		const service = new MastodonMediaService(state as never, api as never, entities as never, notes as never);
		const auth = { user: { id: 'owner' } } as never;
		const request = {} as never;
		return { service, state, api, notes, file, auth, request };
	}

	test.each(['update', 'remove'] as const)('rejects %s of another account attachment before any native mutation', async operation => {
		const { service, api, notes, file, request } = createService();
		await service.register(file as never, 'owner', {});
		const stranger = { user: { id: 'stranger' } } as never;
		const result = operation === 'update'
			? service.update(file.id, { description: 'Replaced' }, stranger, request)
			: service.remove(file.id, stranger);

		await expect(result).rejects.toMatchObject({ statusCode: 404 });
		expect(notes.query).not.toHaveBeenCalled();
		expect(api.invoke).not.toHaveBeenCalled();
		expect(file.comment).toBe('Original description');
	});

	test.each(['update', 'remove'] as const)('rejects %s of an attachment referenced by native content', async operation => {
		const { service, state, api, notes, file, auth, request } = createService();
		await service.register(file as never, 'owner', { focus: { x: 0, y: 0 } });
		notes.query.mockResolvedValueOnce([{ used: true }]);
		const result = operation === 'update'
			? service.update(file.id, { description: 'Replaced' }, auth, request)
			: service.remove(file.id, auth);

		await expect(result).rejects.toMatchObject({ statusCode: 422 });
		expect(api.invoke).not.toHaveBeenCalled();
		expect((await state.get('owner', 'media_attachment', file.id))?.value).toEqual({ focus: { x: 0, y: 0 } });
		expect(file.comment).toBe('Original description');
	});

	test('logical deletion revokes the compatibility attachment without deleting the native Drive file', async () => {
		const { service, state, api, file, auth, request } = createService();
		await service.register(file as never, 'owner', { focus: { x: 0.5, y: -0.25 } });

		await service.remove(file.id, auth);

		expect(api.invoke).not.toHaveBeenCalled();
		expect(file).toEqual({ id: 'file-id', comment: 'Original description' });
		expect((await state.get('owner', 'media_attachment', file.id))?.value).toEqual({ deleted: true, focus: { x: 0.5, y: -0.25 } });
		await expect(service.show(file.id, auth, request)).rejects.toMatchObject({ statusCode: 404 });
		await expect(service.update(file.id, { description: 'Replaced' }, auth, request)).rejects.toMatchObject({ statusCode: 404 });
		await expect(service.assertAvailable([file.id], 'owner')).rejects.toMatchObject({ statusCode: 422 });
		expect(api.invoke).not.toHaveBeenCalled();
	});

	test('a focus-only update preserves the description and persists focus for later reads', async () => {
		const { service, api, file, auth, request } = createService();
		await service.register(file as never, 'owner', { focus: { x: 0, y: 0 } });

		const updated = await service.update(file.id, { focus: '-0.5,0.75' }, auth, request);

		expect(api.invoke).toHaveBeenCalledWith('drive/files/show', { fileId: file.id }, auth, request);
		expect(file.comment).toBe('Original description');
		expect(updated).toMatchObject({ description: 'Original description', meta: { original: { width: 100 }, focus: { x: -0.5, y: 0.75 } } });
		expect(await service.show(file.id, auth, request)).toEqual(updated);
		const attachment = { id: file.id, meta: { original: { width: 200 } } };
		expect(await service.decorate('owner', attachment)).toEqual({ id: file.id, meta: { original: { width: 200 }, focus: { x: -0.5, y: 0.75 } } });
		expect(await service.decorate('stranger', attachment)).toEqual(attachment);
		expect(attachment).toEqual({ id: file.id, meta: { original: { width: 200 } } });
	});

	test('description edits stay in compatibility metadata and later focus edits preserve them', async () => {
		const { service, state, api, file, auth, request } = createService();
		await service.register(file as never, 'owner', {});

		const updated = await service.update(file.id, { description: 'Compatibility description' }, auth, request);

		expect(updated).toMatchObject({ description: 'Compatibility description' });
		expect((await state.get('owner', 'media_attachment', file.id))?.value).toEqual({ description: 'Compatibility description' });
		expect(await service.show(file.id, auth, request)).toEqual(updated);
		expect(await service.decorate('owner', { id: file.id, description: file.comment })).toEqual({ id: file.id, description: 'Compatibility description' });
		expect(await service.update(file.id, { focus: '0.5,-0.5' }, auth, request)).toMatchObject({ description: 'Compatibility description', meta: { focus: { x: 0.5, y: -0.5 } } });
		expect(file.comment).toBe('Original description');
		expect(api.invoke.mock.calls.every(([endpoint]) => endpoint === 'drive/files/show')).toBe(true);
	});

	test.each(['update', 'remove'] as const)('%s keeps external reads outside the short compatibility state transaction', async operation => {
		const { service, state, notes, api, file, auth, request } = createService();
		await service.register(file as never, 'owner', {});
		state.withUserKindLock.mockImplementationOnce(async (_userId, _kind, callback) => {
			notes.query.mockRejectedValue(new Error('No external database connection available'));
			api.invoke.mockRejectedValue(new Error('No external database connection available'));
			return await callback(state);
		});

		if (operation === 'update') {
			expect(await service.update(file.id, { description: 'Compatibility description' }, auth, request)).toMatchObject({ description: 'Compatibility description' });
		} else {
			await expect(service.remove(file.id, auth)).resolves.toBeUndefined();
		}
		expect(file.comment).toBe('Original description');
	});

	test.each(['update', 'remove'] as const)('%s rechecks a tombstone committed during its external reads', async operation => {
		const { service, state, notes, file, auth, request } = createService();
		await service.register(file as never, 'owner', {});
		notes.query.mockImplementationOnce(async () => {
			await state.put({ userId: 'owner', kind: 'media_attachment', key: file.id, value: { deleted: true } });
			return [{ used: false }];
		});
		const result = operation === 'update'
			? service.update(file.id, { description: 'Compatibility description' }, auth, request)
			: service.remove(file.id, auth);

		await expect(result).rejects.toMatchObject({ statusCode: 404 });
		expect((await state.get('owner', 'media_attachment', file.id))?.value).toEqual({ deleted: true });
		expect(file.comment).toBe('Original description');
	});

	test('accepts the native description limit measured in Unicode code points', () => {
		const { service } = createService();
		const description = '🎵'.repeat(512);
		expect(service.validate({ description })).toEqual({ description });
	});

	test('an explicit null description clears only the compatibility description and preserves focus', async () => {
		const { service, api, file, auth, request } = createService();
		await service.register(file as never, 'owner', { focus: { x: 1, y: -1 } });

		const updated = await service.update(file.id, { description: null }, auth, request);

		expect(api.invoke).toHaveBeenCalledWith('drive/files/show', { fileId: file.id }, auth, request);
		expect(updated).toMatchObject({ description: null, meta: { focus: { x: 1, y: -1 } } });
		expect(await service.decorate('owner', { id: file.id, description: file.comment })).toMatchObject({ description: null });
		expect(file.comment).toBe('Original description');
	});

	test.each([
		{ focus: '1.01,0' }, { focus: '0,-1.01' }, { focus: '0' }, { focus: '0,0,0' },
		{ focus: ',0' }, { focus: '0, ' }, { focus: 'NaN,0' }, { focus: [0, 0] },
		{ description: 42 }, { description: 'x'.repeat(513) }, { thumbnail: 'custom-thumbnail' },
	])('rejects malformed media metadata before mutation: %j', async body => {
		const { service, api, notes, auth, request } = createService();
		await expect(service.update('file-id', body, auth, request)).rejects.toMatchObject({ statusCode: 422 });
		expect(api.invoke).not.toHaveBeenCalled();
		expect(notes.query).not.toHaveBeenCalled();
	});
});
