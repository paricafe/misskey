/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';
import { MiMastodonOAuthToken } from './MastodonOAuthToken.js';
import { MiUser } from './User.js';

@Entity('mastodon_user_state')
@Index('IDX_mastodon_user_state_user_kind_key', ['userId', 'kind', 'key'], { unique: true })
@Index('IDX_mastodon_user_state_user_kind_updated_at', ['userId', 'kind', 'updatedAt'])
@Index('IDX_mastodon_user_state_token_id', ['tokenId'])
@Index('IDX_mastodon_user_state_expires_at', ['expiresAt'])
export class MiMastodonUserState {
	@PrimaryColumn(id())
	public id: string;

	@Column(id())
	public userId: MiUser['id'];

	@ManyToOne(() => MiUser, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_mastodon_user_state_user_id' })
	public user: MiUser | null;

	@Column({ ...id(), nullable: true })
	public tokenId: MiMastodonOAuthToken['id'] | null;

	@ManyToOne(() => MiMastodonOAuthToken, { nullable: true, onDelete: 'CASCADE' })
	@JoinColumn({ name: 'tokenId', foreignKeyConstraintName: 'FK_mastodon_user_state_token_id' })
	public token: MiMastodonOAuthToken | null;

	@Column('varchar', { length: 64 })
	public kind: string;

	@Column('varchar', { length: 512 })
	public key: string;

	@Column('jsonb')
	public value: unknown;

	@Column('integer', { default: 1 })
	public version: number;

	@Column('timestamp with time zone')
	public createdAt: Date;

	@Column('timestamp with time zone')
	public updatedAt: Date;

	@Column('timestamp with time zone', { nullable: true })
	public expiresAt: Date | null;
}
