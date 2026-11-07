/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import httpSignature from '@peertube/http-signature';
import { UnrecoverableError } from 'bullmq';
import { JsonLd } from '@/core/activitypub/JsonLdService.js';
import { StatusError } from '@/misc/status-error.js';
import { InboxProcessorService } from './InboxProcessorService.js';

function createService() {
	const actor = { id: 'remote-user', uri: 'https://remote.example/users/alice', host: 'remote.example' };
	const auth = { user: actor, key: { keyPem: 'test-key' } };
	const verifyHttp = vi.spyOn(httpSignature, 'verifySignature').mockReturnValue(true);
	const performActivity = vi.fn().mockResolvedValue('ok');
	const getAuthUserFromKeyId = vi.fn().mockResolvedValue(auth);
	const getAuthUserFromApId = vi.fn().mockResolvedValue(auth);
	const jsonLd = {
		compact: vi.fn(async (activity: unknown) => activity),
		checkForForbiddenDirectives: vi.fn(),
		freeze: vi.fn(),
		verifyRsaSignature2017: vi.fn().mockResolvedValue(true),
	};
	const service = Object.create(InboxProcessorService.prototype) as InboxProcessorService;
	Object.assign(service, {
		meta: { enableStatsForFederatedInstances: false },
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
		utilityService: { toPuny: (host: string) => host, isFederationAllowedHost: () => true, extractDbHost: () => actor.host },
		apDbResolverService: { getAuthUserFromKeyId, getAuthUserFromApId },
		apPersonService: { resolvePerson: vi.fn().mockResolvedValue(actor) },
		apInboxService: { performActivity },
		apRequestChart: { inbox: vi.fn() },
		federationChart: { inbox: vi.fn() },
		federatedInstanceService: { fetch: vi.fn().mockResolvedValue(null) },
		jsonLdService: { use: () => jsonLd },
	});
	const job = {
		data: {
			signature: { keyId: `${actor.uri}#main-key` },
			activity: {
				type: 'Create', id: 'https://remote.example/activities/1', actor: actor.uri,
				object: 'https://remote.example/notes/1',
				signature: { type: 'RsaSignature2017', creator: `${actor.uri}#main-key` },
			},
		},
	};
	return { service, job, verifyHttp, performActivity, getAuthUserFromKeyId, getAuthUserFromApId, jsonLd };
}

const temporaryErrors = [
	new StatusError('Too Many Requests', 429),
	new StatusError('Service Unavailable', 503),
	Object.assign(new Error('request timed out'), { name: 'TimeoutError' }),
	new Error('unexpected failure'),
];

describe('inbox failure retry classification', () => {
	test('processes an authenticated activity normally', async () => {
		const { service, job, performActivity } = createService();
		await expect(service.process(job as never)).resolves.toBe('ok');
		expect(performActivity).toHaveBeenCalledOnce();
	});

	test.each([404, 410])('does not retry activity-object HTTP %s failures', async (status) => {
		const { service, job, performActivity } = createService();
		performActivity.mockRejectedValueOnce(new StatusError('Unavailable', status));
		await expect(service.process(job as never)).rejects.toBeInstanceOf(UnrecoverableError);
	});

	test.each(temporaryErrors)('preserves retryable activity-object failure: $message', async (error) => {
		const { service, job, performActivity } = createService();
		performActivity.mockRejectedValueOnce(error);
		await expect(service.process(job as never)).rejects.toBe(error);
	});

	test.each(temporaryErrors)('preserves retryable actor lookup failure: $message', async (error) => {
		const { service, job, getAuthUserFromKeyId, getAuthUserFromApId } = createService();
		getAuthUserFromKeyId.mockResolvedValueOnce(null);
		getAuthUserFromApId.mockRejectedValueOnce(error);
		await expect(service.process(job as never)).rejects.toBe(error);
	});

	test.each([404, 410])('does not retry an actor lookup returning HTTP %s', async (status) => {
		const { service, job, getAuthUserFromKeyId, getAuthUserFromApId } = createService();
		getAuthUserFromKeyId.mockResolvedValueOnce(null);
		getAuthUserFromApId.mockRejectedValueOnce(new StatusError('Unavailable', status));
		await expect(service.process(job as never)).rejects.toBeInstanceOf(UnrecoverableError);
	});

	test.each(temporaryErrors)('preserves a temporary JSON-LD compaction failure: $message', async (error) => {
		const { service, job, verifyHttp, jsonLd, performActivity } = createService();
		verifyHttp.mockReturnValue(false);
		jsonLd.compact.mockRejectedValueOnce(error);
		await expect(service.process(job as never)).rejects.toBe(error);
		expect(performActivity).not.toHaveBeenCalled();
	});

	test('does not retry a JSON-LD syntax failure or accept its activity', async () => {
		const { service, job, verifyHttp, jsonLd, performActivity } = createService();
		verifyHttp.mockReturnValue(false);
		jsonLd.compact.mockRejectedValueOnce(Object.assign(new Error('invalid context'), { name: 'jsonld.SyntaxError' }));
		await expect(service.process(job as never)).rejects.toBeInstanceOf(UnrecoverableError);
		expect(performActivity).not.toHaveBeenCalled();
	});

	test('rejects an invalid LD signature without dispatching its activity', async () => {
		const { service, job, verifyHttp, jsonLd, performActivity } = createService();
		verifyHttp.mockReturnValue(false);
		jsonLd.verifyRsaSignature2017.mockResolvedValueOnce(false);
		await expect(service.process(job as never)).rejects.toBeInstanceOf(UnrecoverableError);
		expect(performActivity).not.toHaveBeenCalled();
	});

	test('does not retry the installed JSON-LD library\'s safe-mode validation error', async () => {
		const { service, job, verifyHttp, jsonLd, performActivity } = createService();
		const invalidDocument = { '@id': 'relative-id', 'https://remote.example/name': [{ '@value': 'Alice' }] };
		const error = await new JsonLd({} as never).normalize(invalidDocument).catch(reason => reason);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('jsonld.ValidationError');
		verifyHttp.mockReturnValue(false);
		jsonLd.verifyRsaSignature2017.mockRejectedValueOnce(error);

		await expect(service.process(job as never)).rejects.toBeInstanceOf(UnrecoverableError);
		expect(performActivity).not.toHaveBeenCalled();
	});

	test.each(temporaryErrors)('preserves a non-validation signature-processing failure: $message', async (error) => {
		const { service, job, verifyHttp, jsonLd, performActivity } = createService();
		verifyHttp.mockReturnValue(false);
		jsonLd.verifyRsaSignature2017.mockRejectedValueOnce(error);
		await expect(service.process(job as never)).rejects.toBe(error);
		expect(performActivity).not.toHaveBeenCalled();
	});
});
