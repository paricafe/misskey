/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { id } from './util/id.js';

@Entity('credential_revocation')
export class MiCredentialRevocation {
	@PrimaryGeneratedColumn('increment', { type: 'bigint', primaryKeyConstraintName: 'PK_credential_revocation' })
	public id: string;

	@Column(id())
	public userId: string;

	@Column('varchar', { length: 32 })
	public event: 'userTokenRegenerated' | 'accessTokenRevoked';

	@Column('varchar', { length: 64 })
	public credentialId: string;
}
