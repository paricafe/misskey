/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Brackets, In, IsNull, Not } from 'typeorm';
import * as Redis from 'ioredis';
import sanitizeHtml from 'sanitize-html';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { GlobalEvents, GlobalEventService } from '@/core/GlobalEventService.js';
import type {
	AbuseReportNotificationRecipientRepository,
	MiAbuseReportNotificationRecipient,
	MiAbuseUserReport,
	MiMeta,
	MiUser,
} from '@/models/_.js';
import { EmailService } from '@/core/EmailService.js';
import { RoleService } from '@/core/RoleService.js';
import { RecipientMethod } from '@/models/AbuseReportNotificationRecipient.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { SystemWebhookService } from '@/core/SystemWebhookService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { IdService } from './IdService.js';

@Injectable()
export class AbuseReportNotificationService implements OnApplicationShutdown {
	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.abuseReportNotificationRecipientRepository)
		private abuseReportNotificationRecipientRepository: AbuseReportNotificationRecipientRepository,

		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		private idService: IdService,
		private roleService: RoleService,
		private systemWebhookService: SystemWebhookService,
		private emailService: EmailService,
		private moderationLogService: ModerationLogService,
		private globalEventService: GlobalEventService,
		private userEntityService: UserEntityService,
	) {
		this.redisForSub.on('message', this.onMessage);
	}

	@bindThis
	public async notifyAdminStream(abuseReports: MiAbuseUserReport[]) {
		if (abuseReports.length <= 0) {
			return;
		}

		const moderatorIds = await this.roleService.getModeratorIds({
			includeAdmins: true,
			excludeExpire: true,
		});

		for (const moderatorId of moderatorIds) {
			for (const abuseReport of abuseReports) {
				this.globalEventService.publishAdminStream(
					moderatorId,
					'newAbuseUserReport',
					{
						id: abuseReport.id,
						targetUserId: abuseReport.targetUserId,
						reporterId: abuseReport.reporterId,
						comment: abuseReport.comment,
					},
				);
			}
		}
	}

	@bindThis
	public async notifyMail(abuseReports: MiAbuseUserReport[]) {
		if (abuseReports.length <= 0) {
			return;
		}

		const recipientEMailAddresses = await this.fetchEMailRecipients().then(it => it
			.filter(it => it.isActive && it.userProfile?.emailVerified)
			.map(it => it.userProfile?.email)
			.filter(x => x != null),
		);

		recipientEMailAddresses.push(
			...(this.meta.email ? [this.meta.email] : []),
		);

		if (recipientEMailAddresses.length <= 0) {
			return;
		}

		for (const mailAddress of recipientEMailAddresses) {
			await Promise.all(
				abuseReports.map(it => {
					return this.emailService.sendEmail(
						mailAddress,
						'New Abuse Report',
						sanitizeHtml(it.comment),
						sanitizeHtml(it.comment),
					);
				}),
			);
		}
	}

	@bindThis
	public async notifySystemWebhook(
		abuseReports: MiAbuseUserReport[],
		type: 'abuseReport' | 'abuseReportResolved',
	) {
		if (abuseReports.length <= 0) {
			return;
		}

		const usersMap = await this.userEntityService.packMany(
			[
				...new Set([
					...abuseReports.map(it => it.reporter ?? it.reporterId),
					...abuseReports.map(it => it.targetUser ?? it.targetUserId),
					...abuseReports.map(it => it.assignee ?? it.assigneeId),
				].filter(x => x != null)),
			],
			null,
			{ schema: 'UserLite' },
		).then(it => new Map(it.map(it => [it.id, it])));
		const convertedReports = abuseReports.map(it => {
			return {
				...it,
				reporter: usersMap.get(it.reporterId) ?? null,
				targetUser: usersMap.get(it.targetUserId) ?? null,
				assignee: it.assigneeId ? (usersMap.get(it.assigneeId) ?? null) : null,
			};
		});

		const inactiveRecipients = await this.fetchWebhookRecipients()
			.then(it => it.filter(it => !it.isActive));
		const withoutWebhookIds = inactiveRecipients
			.map(it => it.systemWebhookId)
			.filter(x => x != null);
		return Promise.all(
			convertedReports.map(it => {
				return this.systemWebhookService.enqueueSystemWebhook(
					type,
					it,
					{
						excludes: withoutWebhookIds,
					},
				);
			}),
		);
	}

	@bindThis
	public async fetchRecipients(
		params?: {
			ids?: MiAbuseReportNotificationRecipient['id'][],
			method?: RecipientMethod[],
		},
		opts?: {
			removeUnauthorized?: boolean,
			joinUser?: boolean,
			joinSystemWebhook?: boolean,
		},
	): Promise<MiAbuseReportNotificationRecipient[]> {
		const query = this.abuseReportNotificationRecipientRepository.createQueryBuilder('recipient');

		if (opts?.joinUser) {
			query.innerJoinAndSelect('user', 'user', 'recipient.userId = user.id');
			query.innerJoinAndSelect('recipient.userProfile', 'userProfile');
		}

		if (opts?.joinSystemWebhook) {
			query.innerJoinAndSelect('recipient.systemWebhook', 'systemWebhook');
		}

		if (params?.ids) {
			query.andWhere({ id: In(params.ids) });
		}

		if (params?.method) {
			query.andWhere(new Brackets(qb => {
				if (params.method?.includes('email')) {
					qb.orWhere({ method: 'email', userId: Not(IsNull()) });
				}
				if (params.method?.includes('webhook')) {
					qb.orWhere({ method: 'webhook', userId: IsNull() });
				}
			}));
		}

		const recipients = await query.getMany();
		if (recipients.length <= 0) {
			return [];
		}

		return (opts?.removeUnauthorized ?? true)
			? await this.removeUnauthorizedRecipientUsers(recipients)
			: recipients;
	}

	@bindThis
	public async fetchEMailRecipients(opts?: {
		removeUnauthorized?: boolean
	}): Promise<MiAbuseReportNotificationRecipient[]> {
		return this.fetchRecipients({ method: ['email'] }, { joinUser: true, ...opts });
	}

	@bindThis
	public fetchWebhookRecipients(): Promise<MiAbuseReportNotificationRecipient[]> {
		return this.fetchRecipients({ method: ['webhook'] }, { joinSystemWebhook: true });
	}

	@bindThis
	public async createRecipient(
		params: {
			isActive: MiAbuseReportNotificationRecipient['isActive'];
			name: MiAbuseReportNotificationRecipient['name'];
			method: MiAbuseReportNotificationRecipient['method'];
			userId: MiAbuseReportNotificationRecipient['userId'];
			systemWebhookId: MiAbuseReportNotificationRecipient['systemWebhookId'];
		},
		updater: MiUser,
	): Promise<MiAbuseReportNotificationRecipient> {
		const id = this.idService.gen();
		await this.abuseReportNotificationRecipientRepository.insert({
			...params,
			id,
		});

		const created = await this.abuseReportNotificationRecipientRepository.findOneByOrFail({ id: id });

		this.moderationLogService
			.log(updater, 'createAbuseReportNotificationRecipient', {
				recipientId: id,
				recipient: created,
			});

		return created;
	}

	@bindThis
	public async updateRecipient(
		params: {
			id: MiAbuseReportNotificationRecipient['id'];
			isActive: MiAbuseReportNotificationRecipient['isActive'];
			name: MiAbuseReportNotificationRecipient['name'];
			method: MiAbuseReportNotificationRecipient['method'];
			userId: MiAbuseReportNotificationRecipient['userId'];
			systemWebhookId: MiAbuseReportNotificationRecipient['systemWebhookId'];
		},
		updater: MiUser,
	): Promise<MiAbuseReportNotificationRecipient> {
		const beforeEntity = await this.abuseReportNotificationRecipientRepository.findOneByOrFail({ id: params.id });

		await this.abuseReportNotificationRecipientRepository.update(params.id, {
			isActive: params.isActive,
			updatedAt: new Date(),
			name: params.name,
			method: params.method,
			userId: params.userId,
			systemWebhookId: params.systemWebhookId,
		});

		const afterEntity = await this.abuseReportNotificationRecipientRepository.findOneByOrFail({ id: params.id });

		this.moderationLogService
			.log(updater, 'updateAbuseReportNotificationRecipient', {
				recipientId: params.id,
				before: beforeEntity,
				after: afterEntity,
			});

		return afterEntity;
	}

	@bindThis
	public async deleteRecipient(
		id: MiAbuseReportNotificationRecipient['id'],
		updater: MiUser,
	) {
		const entity = await this.abuseReportNotificationRecipientRepository.findBy({ id });

		await this.abuseReportNotificationRecipientRepository.delete(id);

		this.moderationLogService
			.log(updater, 'deleteAbuseReportNotificationRecipient', {
				recipientId: id,
				recipient: entity,
			});
	}

	@bindThis
	private async removeUnauthorizedRecipientUsers(recipients: MiAbuseReportNotificationRecipient[]): Promise<MiAbuseReportNotificationRecipient[]> {
		const userRecipients = recipients.filter(it => it.userId !== null);
		const recipientUserIds = new Set(userRecipients.map(it => it.userId).filter(x => x != null));
		if (recipientUserIds.size <= 0) {
			return recipients;
		}

		const authorizedUserIds = await this.roleService.getModeratorIds({
			includeAdmins: true,
			excludeExpire: true,
		});
		const authorizedUserRecipients = Array.of<MiAbuseReportNotificationRecipient>();
		const unauthorizedUserRecipients = Array.of<MiAbuseReportNotificationRecipient>();
		for (const recipient of userRecipients) {
			// eslint-disable-next-line
			if (authorizedUserIds.includes(recipient.userId!)) {
				authorizedUserRecipients.push(recipient);
			} else {
				unauthorizedUserRecipients.push(recipient);
			}
		}

		if (unauthorizedUserRecipients.length > 0) {
			await this.abuseReportNotificationRecipientRepository.delete(unauthorizedUserRecipients.map(it => it.id));
		}
		const nonUserRecipients = recipients.filter(it => it.userId === null);
		return [...nonUserRecipients, ...authorizedUserRecipients].sort((a, b) => a.id.localeCompare(b.id));
	}

	@bindThis
	private async onMessage(_: string, data: string): Promise<void> {
		const obj = JSON.parse(data);
		if (obj.channel !== 'internal') {
			return;
		}

		const { type } = obj.message as GlobalEvents['internal']['payload'];
		switch (type) {
			case 'roleUpdated':
			case 'roleDeleted':
			case 'userRoleUnassigned': {
				process.nextTick(async () => {
					const recipients = await this.abuseReportNotificationRecipientRepository.findBy({
						userId: Not(IsNull()),
					});
					await this.removeUnauthorizedRecipientUsers(recipients);
				});
				break;
			}
			default: {
				break;
			}
		}
	}

	@bindThis
	public dispose(): void {
		this.redisForSub.off('message', this.onMessage);
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
