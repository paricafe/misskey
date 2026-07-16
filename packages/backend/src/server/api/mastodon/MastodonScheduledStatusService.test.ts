/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MastodonApiError } from './errors.js';
import { MastodonScheduledStatusService } from './MastodonScheduledStatusService.js';

describe(MastodonScheduledStatusService, () => {
	const me = { id: 'user-id' };
	const scheduledDraft = {
		id: 'draft-id',
		userId: 'user-id',
		isActuallyScheduled: true,
		scheduledAt: new Date('2099-01-02T03:04:05.000Z'),
	};

	function createService(draft: unknown) {
		const get = vi.fn().mockResolvedValue(draft);
		const pack = vi.fn().mockResolvedValue({
			...scheduledDraft,
			scheduledAt: scheduledDraft.scheduledAt.getTime(),
		});
		return {
			service: new MastodonScheduledStatusService({ get } as never, { pack } as never),
			get,
			pack,
		};
	}

	test('returns only a packed scheduled draft owned by the requesting user', async () => {
		const { service, get, pack } = createService(scheduledDraft);

		await expect(service.get(me as never, 'draft-id')).resolves.toMatchObject({ id: 'draft-id' });
		expect(get).toHaveBeenCalledWith(me, 'draft-id');
		expect(pack).toHaveBeenCalledWith(scheduledDraft, me);
	});

	test.each([
		['missing draft', null],
		['another user draft', { ...scheduledDraft, userId: 'other-user-id' }],
		['ordinary draft', { ...scheduledDraft, isActuallyScheduled: false }],
	])('returns 404 for a %s', async (_label, draft) => {
		const { service, pack } = createService(draft);

		await expect(service.get(me as never, 'draft-id')).rejects.toMatchObject({
			statusCode: 404,
			error: 'not_found',
		} satisfies Partial<MastodonApiError>);
		expect(pack).not.toHaveBeenCalled();
	});
});
