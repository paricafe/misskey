/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';

@Entity('mastodon_oauth_client')
export class MiMastodonOAuthClient {
	@PrimaryColumn(id())
	public id: string;

	@Index('IDX_mastodon_oauth_client_secret_hash', { unique: true })
	@Column('varchar', { length: 64 })
	public secretHash: string;

	@Column('varchar', { length: 256 })
	public name: string;

	@Column('varchar', { length: 2048, nullable: true })
	public website: string | null;

	@Column('varchar', { length: 2048, array: true })
	public redirectUris: string[];

	@Column('varchar', { length: 64, array: true })
	public scopes: string[];

	@Column('timestamp with time zone')
	public createdAt: Date;
}
