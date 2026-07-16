/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { AbuseReportService } from './AbuseReportService.js';

const input = {
	targetUserId: 'target-id',
	targetUserHost: 'remote.example',
	reporterId: 'reporter-id',
	reporterHost: null,
	comment: 'Please review this account.',
};

function createService() {
	const insertedReport = {
		id: 'report-id',
		...input,
		resolved: false,
		forwarded: false,
		assigneeId: null,
		resolvedAs: null,
		moderationNote: '',
	};
	const repository = {
		insertOne: vi.fn().mockResolvedValue(insertedReport),
	};
	const notifications = {
		notifyAdminStream: vi.fn().mockResolvedValue('admin'),
		notifySystemWebhook: vi.fn().mockResolvedValue('webhook'),
		notifyMail: vi.fn().mockResolvedValue('mail'),
	};
	const service = new AbuseReportService(
		repository as never,
		{} as never,
		{ gen: vi.fn().mockReturnValue('report-id') } as never,
		notifications as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
	);
	return { service, repository, notifications, insertedReport };
}

describe(AbuseReportService, () => {
	test('report returns the original ordered notification results', async () => {
		const { service, notifications } = createService();

		await expect(service.report([input])).resolves.toEqual(['admin', 'webhook', 'mail']);
		expect(notifications.notifyAdminStream).toHaveBeenCalledTimes(1);
		expect(notifications.notifySystemWebhook).toHaveBeenCalledTimes(1);
		expect(notifications.notifyMail).toHaveBeenCalledTimes(1);
	});

	test('reportAndGetCreated returns inserted reports after notifying once', async () => {
		const { service, repository, notifications, insertedReport } = createService();

		await expect(service.reportAndGetCreated([input])).resolves.toEqual([insertedReport]);
		expect(repository.insertOne).toHaveBeenCalledTimes(1);
		expect(notifications.notifyAdminStream).toHaveBeenCalledTimes(1);
		expect(notifications.notifySystemWebhook).toHaveBeenCalledTimes(1);
		expect(notifications.notifyMail).toHaveBeenCalledTimes(1);
	});
});
