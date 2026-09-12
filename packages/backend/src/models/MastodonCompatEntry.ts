/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('mastodon_compat_entry')
@Index('IDX_mastodon_compat_entry_expires_at', ['expiresAt'])
export class MiMastodonCompatEntry {
	@PrimaryColumn('varchar', { length: 96, primaryKeyConstraintName: 'PK_mastodon_compat_entry' })
	public namespace: string;

	@PrimaryColumn('text', { primaryKeyConstraintName: 'PK_mastodon_compat_entry' })
	public owner: string;

	@PrimaryColumn('text', { primaryKeyConstraintName: 'PK_mastodon_compat_entry' })
	public key: string;

	@Column('jsonb')
	public value: unknown;

	@Column('bigint', { nullable: true })
	public expiresAt: string | null;
}
