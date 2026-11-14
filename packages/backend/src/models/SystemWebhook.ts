/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { Serialized } from '@/types.js';
import { id } from './util/id.js';

export const systemWebhookEventTypes = [
	'abuseReport',
	'abuseReportResolved',
	'userCreated',
	'inactiveModeratorsWarning',
	'inactiveModeratorsInvitationOnlyChanged',
] as const;
export type SystemWebhookEventType = typeof systemWebhookEventTypes[number];

@Entity('system_webhook')
export class MiSystemWebhook {
	@PrimaryColumn(id())
	public id: string;

	@Index('IDX_system_webhook_isActive', { synchronize: false })
	@Column('boolean', {
		default: true,
	})
	public isActive: boolean;

	@Column('timestamp with time zone', {
		default: () => 'CURRENT_TIMESTAMP',
	})
	public updatedAt: Date;

	@Column('timestamp with time zone', {
		nullable: true,
	})
	public latestSentAt: Date | null;

	@Column('integer', {
		nullable: true,
	})
	public latestStatus: number | null;

	@Column('varchar', {
		length: 255,
	})
	public name: string;

	@Index('IDX_system_webhook_on', { synchronize: false })
	@Column('varchar', {
		length: 128,
		array: true,
		default: '{}',
	})
	public on: SystemWebhookEventType[];

	@Column('varchar', {
		length: 1024,
	})
	public url: string;

	@Column('varchar', {
		length: 1024,
	})
	public secret: string;

	static deserialize(obj: Serialized<MiSystemWebhook>): MiSystemWebhook {
		return {
			...obj,
			updatedAt: new Date(obj.updatedAt),
			latestSentAt: obj.latestSentAt ? new Date(obj.latestSentAt) : null,
		};
	}
}
