/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, Column, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';

type CondFormulaValueAnd = {
	type: 'and';
	values: RoleCondFormulaValue[];
};

type CondFormulaValueOr = {
	type: 'or';
	values: RoleCondFormulaValue[];
};

type CondFormulaValueNot = {
	type: 'not';
	value: RoleCondFormulaValue;
};

type CondFormulaValueIsLocal = {
	type: 'isLocal';
};

type CondFormulaValueIsRemote = {
	type: 'isRemote';
};

type CondFormulaValueRoleAssignedTo = {
	type: 'roleAssignedTo';
	roleId: string;
};

type CondFormulaValueIsSuspended = {
	type: 'isSuspended';
};

type CondFormulaValueIsLocked = {
	type: 'isLocked';
};

type CondFormulaValueIsBot = {
	type: 'isBot';
};

type CondFormulaValueIsCat = {
	type: 'isCat';
};

type CondFormulaValueIsExplorable = {
	type: 'isExplorable';
};

type CondFormulaValueCreatedLessThan = {
	type: 'createdLessThan';
	sec: number;
};

type CondFormulaValueCreatedMoreThan = {
	type: 'createdMoreThan';
	sec: number;
};

type CondFormulaValueFollowersLessThanOrEq = {
	type: 'followersLessThanOrEq';
	value: number;
};

type CondFormulaValueFollowersMoreThanOrEq = {
	type: 'followersMoreThanOrEq';
	value: number;
};

type CondFormulaValueFollowingLessThanOrEq = {
	type: 'followingLessThanOrEq';
	value: number;
};

type CondFormulaValueFollowingMoreThanOrEq = {
	type: 'followingMoreThanOrEq';
	value: number;
};

type CondFormulaValueNotesLessThanOrEq = {
	type: 'notesLessThanOrEq';
	value: number;
};

type CondFormulaValueNotesMoreThanOrEq = {
	type: 'notesMoreThanOrEq';
	value: number;
};

export type RoleCondFormulaValue = { id: string } & (
	CondFormulaValueAnd |
	CondFormulaValueOr |
	CondFormulaValueNot |
	CondFormulaValueIsLocal |
	CondFormulaValueIsRemote |
	CondFormulaValueIsSuspended |
	CondFormulaValueIsLocked |
	CondFormulaValueIsBot |
	CondFormulaValueIsCat |
	CondFormulaValueIsExplorable |
	CondFormulaValueRoleAssignedTo |
	CondFormulaValueCreatedLessThan |
	CondFormulaValueCreatedMoreThan |
	CondFormulaValueFollowersLessThanOrEq |
	CondFormulaValueFollowersMoreThanOrEq |
	CondFormulaValueFollowingLessThanOrEq |
	CondFormulaValueFollowingMoreThanOrEq |
	CondFormulaValueNotesLessThanOrEq |
	CondFormulaValueNotesMoreThanOrEq
);

@Entity('role')
export class MiRole {
	@PrimaryColumn(id())
	public id: string;

	@Column('timestamp with time zone', {
		comment: 'The updated date of the Role.',
	})
	public updatedAt: Date;

	@Column('timestamp with time zone', {
		comment: 'The last used date of the Role.',
	})
	public lastUsedAt: Date;

	@Column('varchar', {
		length: 256,
	})
	public name: string;

	@Column('varchar', {
		length: 1024,
	})
	public description: string;

	@Column('varchar', {
		length: 256, nullable: true,
	})
	public color: string | null;

	@Column('varchar', {
		length: 512, nullable: true,
	})
	public iconUrl: string | null;

	@Column('enum', {
		enum: ['manual', 'conditional'],
		default: 'manual',
	})
	public target: 'manual' | 'conditional';

	@Column('jsonb', {
		default: { },
	})
	public condFormula: RoleCondFormulaValue;

	@Column('boolean', {
		default: false,
	})
	public isPublic: boolean;

	@Column('boolean', {
		default: false,
	})
	public asBadge: boolean;

	@Column('boolean', {
		default: false,
	})
	public isModerator: boolean;

	@Column('boolean', {
		default: false,
	})
	public isAdministrator: boolean;

	@Column('boolean', {
		default: false,
	})
	public isExplorable: boolean;

	@Column('boolean', {
		default: false,
	})
	public preserveAssignmentOnMoveAccount: boolean;

	@Column('boolean', {
		default: false,
	})
	public canEditMembersByModerator: boolean;

	@Column('integer', {
		default: 0,
	})
	public displayOrder: number;

	@Column('jsonb', {
		default: { },
	})
	public policies: Record<string, {
		useDefault: boolean;
		priority: number;
		value: any;
	}>;
}
