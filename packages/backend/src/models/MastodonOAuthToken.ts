/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';
import { MiMastodonOAuthClient } from './MastodonOAuthClient.js';
import { MiUser } from './User.js';

@Entity('mastodon_oauth_token')
export class MiMastodonOAuthToken {
	@PrimaryColumn(id())
	public id: string;

	@Index('IDX_mastodon_oauth_token_hash', { unique: true })
	@Column('varchar', { length: 64 })
	public tokenHash: string;

	@Index('IDX_mastodon_oauth_token_user_id')
	@Column({ ...id(), nullable: true })
	public userId: MiUser['id'] | null;

	@ManyToOne(() => MiUser, { nullable: true, onDelete: 'CASCADE' })
	@JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_mastodon_oauth_token_user_id' })
	public user: MiUser | null;

	@Index('IDX_mastodon_oauth_token_client_id')
	@Column(id())
	public clientId: MiMastodonOAuthClient['id'];

	@ManyToOne(() => MiMastodonOAuthClient, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'clientId', foreignKeyConstraintName: 'FK_mastodon_oauth_token_client_id' })
	public client: MiMastodonOAuthClient;

	@Column('varchar', { length: 64, array: true })
	public scopes: string[];

	@Column('timestamp with time zone')
	public createdAt: Date;

	@Column('timestamp with time zone', { nullable: true })
	public lastUsedAt: Date | null;
}
