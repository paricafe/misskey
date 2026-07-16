/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { MastodonReportService } from './MastodonReportService.js';

describe(MastodonReportService, () => {
	const reporter = { id: 'reporter-id', host: null, username: 'reporter' };
	const target = { id: 'target-id', host: 'remote.example', username: 'target' };
	const packedTarget = { id: 'target-id', username: 'target', acct: 'target@remote.example' };
	const insertedReport = {
		id: 'report-id',
		targetUserId: 'target-id',
		targetUserHost: 'remote.example',
		reporterId: 'reporter-id',
		reporterHost: null,
		comment: 'persisted comment',
		resolved: false,
		forwarded: false,
		assigneeId: null,
		resolvedAs: null,
		moderationNote: '',
	};

	function createService() {
		const getUser = vi.fn().mockResolvedValue(target);
		const isAdministrator = vi.fn().mockResolvedValue(false);
		const report = vi.fn().mockResolvedValue([insertedReport]);
		const pack = vi.fn().mockResolvedValue(packedTarget);
		const parse = vi.fn().mockReturnValue({ date: new Date('2026-07-16T01:02:03.000Z') });
		const service = new MastodonReportService(
			{ getUser } as never,
			{ isAdministrator } as never,
			{ report } as never,
			{ pack } as never,
			{ parse } as never,
		);
		return { service, getUser, isAdministrator, report, pack, parse };
	}

	const input = {
		accountId: 'target-id',
		comment: 'Please review this account.',
		category: 'spam' as const,
		statusIds: ['status-1', 'status-2'],
		ruleIds: ['rule-1'],
		collectionIds: ['collection-1'],
		forwardToDomains: ['moderation.example'],
		forward: true,
	};

	test('requires account_id before resolving a target', async () => {
		const { service, getUser } = createService();

		await expect(service.create(reporter as never, { ...input, accountId: '' })).rejects.toMatchObject({ statusCode: 400 });
		expect(getUser).not.toHaveBeenCalled();
	});

	test('maps a missing target to 404', async () => {
		const { service, getUser } = createService();
		getUser.mockRejectedValueOnce(new IdentifiableError('15348ddd-432d-49c2-8a5a-8069753becff', 'No such user.'));

		await expect(service.create(reporter as never, input)).rejects.toMatchObject({ statusCode: 404 });
	});

	test('rejects self reports', async () => {
		const { service, getUser } = createService();
		getUser.mockResolvedValueOnce(reporter);

		await expect(service.create(reporter as never, { ...input, accountId: reporter.id })).rejects.toMatchObject({ statusCode: 422 });
	});

	test('rejects reports against administrators', async () => {
		const { service, isAdministrator, report } = createService();
		isAdministrator.mockResolvedValueOnce(true);

		await expect(service.create(reporter as never, input)).rejects.toMatchObject({ statusCode: 422 });
		expect(report).not.toHaveBeenCalled();
	});

	test('returns the inserted report, creation time, normalized input, and packed target', async () => {
		const { service, report, pack } = createService();
		const result = await service.create(reporter as never, input);

		expect(result).toEqual({
			report: insertedReport,
			createdAt: '2026-07-16T01:02:03.000Z',
			targetUser: packedTarget,
			input,
		});
		expect(pack).toHaveBeenCalledWith(target, reporter, { schema: 'UserDetailed' });
		const persisted = report.mock.calls[0][0][0];
		expect(persisted).toMatchObject({
			targetUserId: 'target-id',
			targetUserHost: 'remote.example',
			reporterId: 'reporter-id',
			reporterHost: null,
		});
		expect(persisted.comment).toContain('Please review this account.');
		expect(persisted.comment).toContain('Mastodon API report context');
		expect(persisted.comment).toContain('Category: spam');
		expect(persisted.comment).toContain('Status IDs: status-1, status-2');
		expect(persisted.comment).toContain('Rule IDs: rule-1');
		expect(persisted.comment).toContain('Collection IDs: collection-1');
		expect(persisted.comment).toContain('Forward requested: yes');
		expect(persisted.comment).toContain('Forward-to domains: moderation.example');
	});

	test('normalizes an omitted comment and truncates without splitting a surrogate pair', async () => {
		const { service, report } = createService();
		await service.create(reporter as never, { ...input, comment: undefined } as never);
		const emptyComment = report.mock.calls[0][0][0].comment as string;
		expect(emptyComment).toMatch(/^\n\n--- Mastodon API report context ---/u);

		report.mockClear();
		await service.create(reporter as never, { ...input, comment: '😀'.repeat(2000) });
		const bounded = report.mock.calls[0][0][0].comment as string;
		expect(bounded.length).toBeLessThanOrEqual(2048);
		const comment = bounded.split('\n\n--- Mastodon API report context ---', 1)[0];
		const lastCodeUnit = comment.charCodeAt(comment.length - 1);
		expect(lastCodeUnit < 0xD800 || lastCodeUnit > 0xDBFF).toBe(true);
	});
});
