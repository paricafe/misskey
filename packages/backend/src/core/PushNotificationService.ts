/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import push from 'web-push';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { Packed } from '@/misc/json-schema.js';
import { getNoteSummary } from '@/misc/get-note-summary.js';
import type { MiMeta, SwSubscriptionsRepository } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import { readFromPrimary } from '@/misc/read-from-primary.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';

type PushNotificationsTypes = {
	'notification': Packed<'Notification'>;
	'unreadAntennaNote': {
		antenna: { id: string, name: string };
		note: Packed<'Note'>;
	};
	'readAllNotifications': undefined;
	newChatMessage: Packed<'ChatMessage'>;
};

function truncateBody<T extends keyof PushNotificationsTypes>(type: T, body: PushNotificationsTypes[T]): PushNotificationsTypes[T] {
	if (typeof body !== 'object') return body;

	return {
		...body,
		...(('note' in body && body.note) ? {
			note: {
				...body.note,
				text: getNoteSummary(('type' in body && body.type === 'renote') ? body.note.renote as Packed<'Note'> : body.note),

				cw: undefined,
				reply: undefined,
				renote: undefined,
				user: type === 'notification' ? undefined as any : body.note.user,
			},
		} : {}),
	};
}

@Injectable()
export class PushNotificationService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.swSubscriptionsRepository)
		private swSubscriptionsRepository: SwSubscriptionsRepository,

		private httpRequestService: HttpRequestService,
	) {
	}

	@bindThis
	public isValidEndpoint(endpoint: string): boolean {
		let url: URL;
		try {
			url = new URL(endpoint);
		} catch {
			return false;
		}

		if (url.protocol !== 'https:') return false;
		if (url.username !== '' || url.password !== '') return false;

		return true;
	}

	@bindThis
	public async pushNotification<T extends keyof PushNotificationsTypes>(userId: string, type: T, body: PushNotificationsTypes[T]) {
		if (!this.meta.enableServiceWorker || this.meta.swPublicKey == null || this.meta.swPrivateKey == null) return;

		push.setVapidDetails(this.config.url,
			this.meta.swPublicKey,
			this.meta.swPrivateKey);

		const subscriptions = await readFromPrimary(this.swSubscriptionsRepository.manager, primary => primary.withRepository(this.swSubscriptionsRepository).findBy({ userId }));

		for (const subscription of subscriptions) {
			if ([
				'readAllNotifications',
			].includes(type) && !subscription.sendReadMessage) continue;

			if (!this.isValidEndpoint(subscription.endpoint)) continue;

			const pushSubscription = {
				endpoint: subscription.endpoint,
				keys: {
					auth: subscription.auth,
					p256dh: subscription.publickey,
				},
			};

			push.sendNotification(pushSubscription, JSON.stringify({
				type,
				body: (type === 'notification' || type === 'unreadAntennaNote') ? truncateBody(type, body) : body,
				userId,
				dateTime: Date.now(),
			}), {
				agent: this.httpRequestService.getAgentForHttps(new URL(subscription.endpoint)),
			}).catch(async (err: any) => {
				if (err.statusCode === 410 || err.statusCode === 404) {
					await this.swSubscriptionsRepository.delete({
						userId: userId,
						endpoint: subscription.endpoint,
						auth: subscription.auth,
						publickey: subscription.publickey,
					});
				}
			});
		}
	}
}
