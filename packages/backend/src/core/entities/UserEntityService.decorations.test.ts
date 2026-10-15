/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { UserEntityService } from './UserEntityService.js';

const decoration = { id: 'deco:remote.example', url: 'https://remote.example/deco.png' };

function setup(cached: typeof decoration[] | undefined) {
	let resolveFetch!: (value: typeof decoration[]) => void;
	const cache = {
		get: vi.fn().mockResolvedValue(cached),
		fetch: vi.fn(() => new Promise<typeof decoration[]>(resolve => { resolveFetch = resolve; })),
	};
	const service = Object.create(UserEntityService.prototype) as UserEntityService;
	Object.assign(service, {
		config: { avatarDecorationAllowedHosts: ['remote.example'] },
		cacheService: { pariRemoteUserDecorationsCache: cache },
	});
	const getDecorations = (host: string) => service['getRemoteUserDecorations']({ id: 'remote-user', host });
	return { cache, getDecorations, resolveFetch: () => resolveFetch([decoration]) };
}

describe('remote avatar decorations', () => {
	test('returns cached decorations without contacting the remote server', async () => {
		const { cache, getDecorations } = setup([decoration]);

		await expect(getDecorations('remote.example')).resolves.toEqual([decoration]);
		expect(cache.fetch).not.toHaveBeenCalled();
	});

	test('does not wait for the remote server on a cache miss', async () => {
		const { cache, getDecorations, resolveFetch } = setup(undefined);

		// The remote fetch is still pending, but packing continues without decorations.
		await expect(getDecorations('remote.example')).resolves.toEqual([]);
		expect(cache.fetch).toHaveBeenCalledWith('remote-user');
		resolveFetch();
	});

	test('skips hosts that are not allowed to provide decorations', async () => {
		const { cache, getDecorations } = setup([decoration]);

		await expect(getDecorations('other.example')).resolves.toEqual([]);
		expect(cache.get).not.toHaveBeenCalled();
	});
});
