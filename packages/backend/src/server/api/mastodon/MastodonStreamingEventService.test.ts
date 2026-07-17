/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MastodonStreamingEventService } from './MastodonStreamingEventService.js';

describe(MastodonStreamingEventService, () => {
	test('publishes only compatibility-channel envelopes for filter, merge, and followed-tag invalidations', async () => {
		const publish = vi.fn().mockResolvedValue(1);
		const service = new MastodonStreamingEventService({ host: 'misskey.example' } as never, { publish } as never);

		await service.filtersChanged('user-id');
		await service.notificationsMerged('user-id');
		await service.followedTagChanged('user-id', { action: 'follow', tag: 'misskey' });

		expect(publish.mock.calls).toEqual([
			['misskey.example', JSON.stringify({ channel: 'mastodonCompat:user-id', message: { type: 'filters_changed', body: null } })],
			['misskey.example', JSON.stringify({ channel: 'mastodonCompat:user-id', message: { type: 'notifications_merged', body: null } })],
			['misskey.example', JSON.stringify({ channel: 'mastodonCompat:user-id', message: { type: 'followed_tag_changed', body: { action: 'follow', tag: 'misskey' } } })],
		]);
		expect(publish.mock.calls.every(([, raw]) => !raw.includes('mainStream:'))).toBe(true);
	});

	test('does not reject a committed mutation when Redis invalidation publishing fails', async () => {
		const service = new MastodonStreamingEventService(
			{ host: 'misskey.example' } as never,
			{ publish: vi.fn().mockRejectedValue(new Error('redis unavailable')) } as never,
		);
		expect(() => service.filtersChanged('user-id')).not.toThrow();
		await new Promise(resolve => setImmediate(resolve));
	});
});
