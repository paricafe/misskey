/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { MastodonFavouriteService, isMastodonFavourite } from './MastodonFavouriteService.js';
import { MastodonScopeService } from './MastodonScopeService.js';
import type { MastodonUserAuth } from './types.js';

const auth = { user: { id: 'viewer' }, token: { scopes: ['write:favourites'] } } as MastodonUserAuth;
const request = {} as never;

function createService(current: string | null = null) {
	const repository = { findOneBy: vi.fn().mockResolvedValue(current == null ? null : { reaction: current }) };
	const note = { id: 'note' };
	const getter = { getNote: vi.fn().mockResolvedValue(note) };
	const entity = { isVisibleForMe: vi.fn().mockResolvedValue(true) };
	const reaction = { create: vi.fn(), delete: vi.fn() };
	const api = { invoke: vi.fn().mockResolvedValue({ id: 'note', myReaction: current }) };
	const limiter = { limit: vi.fn().mockResolvedValue(null) };
	const roles = { getUserPolicies: vi.fn().mockResolvedValue({ rateLimitFactor: 1 }) };
	const service = new MastodonFavouriteService(repository as never, getter as never, entity as never, reaction as never, api as never, new MastodonScopeService(), limiter as never, roles as never);
	return { service, repository, note, getter, entity, reaction, api, limiter, roles };
}

describe(MastodonFavouriteService, () => {
	test.each(['❤', '❤️'])('recognizes only heart form %s as a favourite', reaction => {
		expect(isMastodonFavourite(reaction)).toBe(true);
	});

	test.each(['👍', ':heart:', '💗', '❤️‍🔥', '', null, undefined])('does not mistake emoji %s for a favourite', reaction => {
		expect(isMastodonFavourite(reaction)).toBe(false);
	});

	test('creates an absent favourite through the guarded native reaction service', async () => {
		const { service, note, reaction, api } = createService();
		await expect(service.set('note', true, auth, request)).resolves.toMatchObject({ id: 'note' });
		expect(reaction.create).toHaveBeenCalledWith(auth.user, note, '❤', { replaceExisting: false });
		expect(api.invoke).toHaveBeenCalledWith('notes/show', { noteId: 'note' }, auth, request);
	});

	test.each(['❤', '❤️'])('repeating an existing favourite %s is idempotent', async current => {
		const { service, reaction } = createService(current);
		await service.set('note', true, auth, request);
		expect(reaction.create).not.toHaveBeenCalled();
		expect(reaction.delete).not.toHaveBeenCalled();
	});

	test('rejects liking over an existing native emoji and leaves it untouched', async () => {
		const { service, reaction } = createService('👍');
		await expect(service.set('note', true, auth, request)).rejects.toMatchObject({ statusCode: 422 });
		expect(reaction.create).not.toHaveBeenCalled();
		expect(reaction.delete).not.toHaveBeenCalled();
	});

	test.each([null, '👍'])('unfavourite preserves an absent or non-heart native reaction %s', async current => {
		const { service, reaction, limiter } = createService(current);
		await service.set('note', false, auth, request);
		expect(reaction.delete).not.toHaveBeenCalled();
		expect(limiter.limit).not.toHaveBeenCalled();
	});

	test.each(['❤', '❤️'])('unfavourite conditionally removes the matching heart form %s', async current => {
		const { service, reaction, note, limiter } = createService(current);
		await service.set('note', false, auth, request);
		expect(reaction.delete).toHaveBeenCalledWith(auth.user, note, current);
		expect(limiter.limit).toHaveBeenCalledWith({ key: 'notes/reactions/delete', duration: 3_600_000, max: 60, minInterval: 3000 }, auth.user.id, 1);
	});

	test('a native emoji added during creation remains an explicit conflict', async () => {
		const { service, repository, reaction } = createService();
		reaction.create.mockRejectedValueOnce(new IdentifiableError('51c42bb4-931a-456b-bff7-e5a8a70dd298'));
		repository.findOneBy.mockResolvedValueOnce(null).mockResolvedValueOnce({ reaction: '👍' });
		await expect(service.set('note', true, auth, request)).rejects.toMatchObject({ statusCode: 422 });
		expect(reaction.delete).not.toHaveBeenCalled();
	});

	test('a concurrent identical favourite is idempotent', async () => {
		const { service, repository, reaction } = createService();
		reaction.create.mockRejectedValueOnce(new IdentifiableError('51c42bb4-931a-456b-bff7-e5a8a70dd298'));
		repository.findOneBy.mockResolvedValueOnce(null).mockResolvedValueOnce({ reaction: '❤️' });
		await expect(service.set('note', true, auth, request)).resolves.toMatchObject({ id: 'note' });
	});

	test('conditional removal failure is idempotent and returns the current native status', async () => {
		const { service, reaction, api } = createService('❤');
		reaction.delete.mockRejectedValueOnce(new IdentifiableError('60527ec9-b4cb-4a88-a6bd-32d3ad26817d'));
		api.invoke.mockResolvedValueOnce({ id: 'note', myReaction: '👍' });
		await expect(service.set('note', false, auth, request)).resolves.toMatchObject({ myReaction: '👍' });
		expect(reaction.delete).toHaveBeenCalledOnce();
	});

	test('rejects inaccessible posts before reading or mutating their reactions', async () => {
		const { service, entity, repository, reaction } = createService();
		entity.isVisibleForMe.mockResolvedValueOnce(false);
		await expect(service.set('note', true, auth, request)).rejects.toMatchObject({ statusCode: 404 });
		expect(repository.findOneBy).not.toHaveBeenCalled();
		expect(reaction.create).not.toHaveBeenCalled();
	});

	test('checks the favourite scope before bypassing native endpoint dispatch', async () => {
		const { service, getter } = createService();
		await expect(service.set('note', true, { ...auth, token: { scopes: ['read'] } } as MastodonUserAuth, request)).rejects.toMatchObject({ statusCode: 403 });
		expect(getter.getNote).not.toHaveBeenCalled();
	});

	test.each([{ isSuspended: true }, { isDeleted: true }, { movedToUri: 'https://remote.example/users/new' }])('preserves native account restrictions %s', async state => {
		const { service, reaction } = createService();
		await expect(service.set('note', true, { ...auth, user: { ...auth.user, ...state } }, request)).rejects.toMatchObject({ statusCode: 403 });
		expect(reaction.create).not.toHaveBeenCalled();
	});

	test('enforces the native deletion rate limit before removing a favourite', async () => {
		const { service, limiter, reaction } = createService('❤');
		limiter.limit.mockResolvedValueOnce({ info: { resetMs: 123 } });
		await expect(service.set('note', false, auth, request)).rejects.toMatchObject({ httpStatusCode: 429 });
		expect(reaction.delete).not.toHaveBeenCalled();
	});
});
