/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { URL } from 'node:url';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import httpSignature from '@peertube/http-signature';
import * as Bull from 'bullmq';
import type Logger from '@/logger.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import ApRequestChart from '@/core/chart/charts/ap-request.js';
import FederationChart from '@/core/chart/charts/federation.js';
import { getApId, isActor, isDelete } from '@/core/activitypub/type.js';
import type { IActivity } from '@/core/activitypub/type.js';
import type { MiRemoteUser } from '@/models/User.js';
import type { MiUserPublickey } from '@/models/UserPublickey.js';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { StatusError } from '@/misc/status-error.js';
import { UtilityService } from '@/core/UtilityService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { JsonLdError, JsonLdService } from '@/core/activitypub/JsonLdService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { bindThis } from '@/decorators.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { CollapsedQueue } from '@/misc/collapsed-queue.js';
import { MiNote } from '@/models/Note.js';
import { MiMeta } from '@/models/Meta.js';
import { DI } from '@/di-symbols.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type { InboxJobData } from '../types.js';

type UpdateInstanceJob = {
	latestRequestReceivedAt: Date,
	shouldUnsuspend: boolean,
};

function isUnrecoverableJsonLdError(error: unknown): boolean {
	return error instanceof JsonLdError || (error instanceof Error && (
		error.name === 'jsonld.ValidationError' || error.name === 'jsonld.SyntaxError'
	));
}

@Injectable()
export class InboxProcessorService implements OnApplicationShutdown {
	private logger: Logger;
	private updateInstanceQueue: CollapsedQueue<MiNote['id'], UpdateInstanceJob>;

	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		private utilityService: UtilityService,
		private apInboxService: ApInboxService,
		private federatedInstanceService: FederatedInstanceService,
		private fetchInstanceMetadataService: FetchInstanceMetadataService,
		private jsonLdService: JsonLdService,
		private apPersonService: ApPersonService,
		private apDbResolverService: ApDbResolverService,
		private instanceChart: InstanceChart,
		private apRequestChart: ApRequestChart,
		private federationChart: FederationChart,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('inbox');
		this.updateInstanceQueue = new CollapsedQueue(process.env.NODE_ENV !== 'test' ? 60 * 1000 * 5 : 0, this.collapseUpdateInstanceJobs, this.performUpdateInstance);
	}

	@bindThis
	public async process(job: Bull.Job<InboxJobData>): Promise<string> {
		const signature = job.data.signature;
		let activity = job.data.activity;

		const info = Object.assign({}, activity);
		delete info['@context'];
		this.logger.debug(JSON.stringify(info, null, 2));

		const host = this.utilityService.toPuny(new URL(signature.keyId).hostname);

		if (!this.utilityService.isFederationAllowedHost(host)) {
			return `Blocked request: ${host}`;
		}

		const keyIdLower = signature.keyId.toLowerCase();
		if (keyIdLower.startsWith('acct:')) {
			return `Old keyId is no longer supported. ${keyIdLower}`;
		}

		{
			let userExistenceCheckApId: string | null = null;

			if (isDelete(activity) && typeof activity.object === 'object' && (isActor(activity.object) || getApId(activity.actor) === getApId(activity.object))) {
				userExistenceCheckApId = getApId(activity.object);
			}

			if (userExistenceCheckApId != null) {
				const user = await this.apDbResolverService.getUserFromApId(userExistenceCheckApId);
				if (user == null) {
					return `skip: user not found for delete activity. ${getApId(userExistenceCheckApId)}`;
				}
			}
		}

		let authUser: {
			user: MiRemoteUser;
			key: MiUserPublickey | null;
		} | null = await this.apDbResolverService.getAuthUserFromKeyId(signature.keyId);

		if (authUser == null) {
			try {
				authUser = await this.apDbResolverService.getAuthUserFromApId(getApId(activity.actor));
			} catch (err) {
				if (err instanceof StatusError && !err.isRetryable) {
					throw new Bull.UnrecoverableError(`skip: Ignored deleted actors on both ends ${getApId(activity.actor)} - ${err.statusCode}`);
				}
				throw err;
			}
		}

		if (authUser == null) {
			throw new Bull.UnrecoverableError(`skip: failed to resolve user ${getApId(activity.actor)}`);
		}

		if (authUser.key == null) {
			throw new Bull.UnrecoverableError(`skip: failed to resolve user publicKey ${getApId(activity.actor)}`);
		}

		const httpSignatureValidated = httpSignature.verifySignature(signature, authUser.key.keyPem);

		if (!httpSignatureValidated || authUser.user.uri !== getApId(activity.actor)) {
			const ldSignature = activity.signature;
			if (ldSignature) {
				if (ldSignature.type !== 'RsaSignature2017') {
					throw new Bull.UnrecoverableError(`skip: unsupported LD-signature type ${ldSignature.type}`);
				}

				if (ldSignature.creator) {
					const candicate = ldSignature.creator.replace(/#.*/, '');
					await this.apPersonService.resolvePerson(candicate).catch(() => null);
				}

				authUser = await this.apDbResolverService.getAuthUserFromKeyId(ldSignature.creator);
				if (authUser == null) {
					throw new Bull.UnrecoverableError('skip: LD-Signatureのユーザーが取得できませんでした');
				}

				if (authUser.key == null) {
					throw new Bull.UnrecoverableError('skip: LD-SignatureのユーザーはpublicKeyを持っていませんでした');
				}

				const jsonLd = this.jsonLdService.use();

				delete activity.signature;
				try {
					activity = await jsonLd.compact(activity) as IActivity;
				} catch (error) {
					if (isUnrecoverableJsonLdError(error)) {
						throw new Bull.UnrecoverableError(`skip: failed to compact activity: ${error}`);
					}
					throw error;
				}
				try {
					jsonLd.checkForForbiddenDirectives(activity);
				} catch (error) {
					throw new Bull.UnrecoverableError(`skip: ${error}`);
				}

				const compactedInfo = Object.assign({}, activity);
				delete compactedInfo['@context'];
				this.logger.debug(`compacted: ${JSON.stringify(compactedInfo, null, 2)}`);

				activity.signature = ldSignature;

				jsonLd.freeze();

				let verified;
				try {
					verified = await jsonLd.verifyRsaSignature2017(activity, authUser.key.keyPem);
					if (!verified) {
						throw new Bull.UnrecoverableError('skip: LD-Signatureの検証に失敗しました');
					}
				} catch (error) {
					if (isUnrecoverableJsonLdError(error)) {
						throw new Bull.UnrecoverableError(`skip: encountered a JSON-LD error while verifying signature: ${error}`);
					} else {
						throw error;
					}
				}

				if (authUser.user.uri !== getApId(activity.actor)) {
					throw new Bull.UnrecoverableError(`skip: LD-Signature user(${authUser.user.uri}) !== activity.actor(${getApId(activity.actor)})`);
				}

				const ldHost = this.utilityService.extractDbHost(authUser.user.uri);
				if (!this.utilityService.isFederationAllowedHost(ldHost)) {
					throw new Bull.UnrecoverableError(`Blocked request: ${ldHost}`);
				}
			} else {
				throw new Bull.UnrecoverableError(`skip: http-signature verification failed and no LD-Signature. keyId=${signature.keyId}`);
			}
		}

		if (typeof activity.id === 'string') {
			const signerHost = this.utilityService.extractDbHost(authUser.user.uri!);
			const activityIdHost = this.utilityService.extractDbHost(activity.id);
			if (signerHost !== activityIdHost) {
				throw new Bull.UnrecoverableError(`skip: signerHost(${signerHost}) !== activity.id host(${activityIdHost}`);
			}
		} else {
			delete activity.id;
		}

		this.apRequestChart.inbox();
		this.federationChart.inbox(authUser.user.host);

		process.nextTick(async () => {
			const i = await (this.meta.enableStatsForFederatedInstances
				? this.federatedInstanceService.fetchOrRegister(authUser.user.host)
				: this.federatedInstanceService.fetch(authUser.user.host));

			if (i == null) return;

			this.updateInstanceQueue.enqueue(i.id, {
				latestRequestReceivedAt: new Date(),
				shouldUnsuspend: i.suspensionState === 'autoSuspendedForNotResponding',
			});

			if (this.meta.enableChartsForFederatedInstances) {
				this.instanceChart.requestReceived(i.host);
			}

			this.fetchInstanceMetadataService.fetchInstanceMetadata(i);
		});

		try {
			const result = await this.apInboxService.performActivity(authUser.user, activity);
			if (result && !result.startsWith('ok')) {
				if (result.startsWith('skip:')) {
					this.logger.info(`inbox activity ignored: id=${activity.id} reason=${result}`);
				} else {
					this.logger.warn(`inbox activity failed: id=${activity.id} reason=${result}`);
				}
				return result;
			}
		} catch (e) {
			if (e instanceof StatusError && !e.isRetryable) {
				throw new Bull.UnrecoverableError(`skip: activity object is unavailable - ${e.statusCode}`);
			}
			if (e instanceof IdentifiableError) {
				switch (e.id) {
					case '689ee33f-f97c-479a-ac49-1b9f8140af99':
						return 'blocked notes with prohibited words';
					case '85ab9bd7-3a41-4530-959d-f07073900109':
						return 'actor has been suspended';
					case 'd450b8a9-48e4-4dab-ae36-f4db763fda7c':
						return e.message;
					case '9f466dab-c856-48cd-9e65-ff90ff750580':
						return 'note contains too many mentions';
					case '09d79f9e-64f1-4316-9cfa-e75c4d091574':
						return 'skip: blocked instance';
				}
			}
			throw e;
		}
		return 'ok';
	}

	@bindThis
	public collapseUpdateInstanceJobs(oldJob: UpdateInstanceJob, newJob: UpdateInstanceJob) {
		const latestRequestReceivedAt = oldJob.latestRequestReceivedAt < newJob.latestRequestReceivedAt
			? newJob.latestRequestReceivedAt
			: oldJob.latestRequestReceivedAt;
		const shouldUnsuspend = oldJob.shouldUnsuspend || newJob.shouldUnsuspend;
		return {
			latestRequestReceivedAt,
			shouldUnsuspend,
		};
	}

	@bindThis
	public async performUpdateInstance(id: string, job: UpdateInstanceJob) {
		await this.federatedInstanceService.update(id, {
			latestRequestReceivedAt: new Date(),
			isNotResponding: false,
			suspensionState: job.shouldUnsuspend
				? () => `CASE WHEN "suspensionState" = 'autoSuspendedForNotResponding' THEN 'none' ELSE "suspensionState" END`
				: undefined,
		});
	}

	@bindThis
	public async dispose(): Promise<void> {
		await this.updateInstanceQueue.performAllNow();
	}

	@bindThis
	async onApplicationShutdown(signal?: string) {
		await this.dispose();
	}
}
