/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { permissions } from 'misskey-js';
import type { KeyOf, Schema } from '@/misc/json-schema.js';

import * as endpointsObject from './endpoint-list.js';

interface IEndpointMetaBase {
	readonly stability?: 'deprecated' | 'experimental' | 'stable';

	readonly tags?: ReadonlyArray<string>;

	readonly errors?: {
		readonly [key: string]: {
			readonly message: string;
			readonly code: string;
			readonly id: string;
		};
	};

	readonly res?: Schema;

	readonly requireCredential?: boolean;

	readonly requireModerator?: boolean;

	readonly requireAdmin?: boolean;

	readonly requiredRolePolicy?: KeyOf<'RolePolicies'>;

	readonly prohibitMoved?: boolean;

	readonly limit?: {

		readonly key?: string;

		readonly duration?: number;

		readonly max?: number;

		readonly minInterval?: number;
	};

	readonly requireFile?: boolean;

	readonly secure?: boolean;

	readonly kind?: string;

	readonly description?: string;

	readonly allowGet?: boolean;

	readonly cacheSec?: number;
}

export type IEndpointMeta = (Omit<IEndpointMetaBase, 'requireCrential' | 'requireModerator' | 'requireAdmin'> & {
	requireCredential?: false,
	requireAdmin?: false,
	requireModerator?: false,
}) | (Omit<IEndpointMetaBase, 'secure'> & {
	secure: true,
}) | (Omit<IEndpointMetaBase, 'requireCredential' | 'kind'> & {
	requireCredential: true,
	kind: (typeof permissions)[number],
}) | (Omit<IEndpointMetaBase, 'requireModerator' | 'kind'> & {
	requireModerator: true,
	kind: (typeof permissions)[number],
}) | (Omit<IEndpointMetaBase, 'requireAdmin' | 'kind'> & {
	requireAdmin: true,
	kind: (typeof permissions)[number],
});

export interface IEndpoint {
	name: string;
	meta: IEndpointMeta;
	params: Schema;
}

const endpoints: IEndpoint[] = Object.entries(endpointsObject).map(([name, ep]) => {
	return {
		name: name,
		get meta() {
			return ep.meta ?? {};
		},
		get params() {
			return ep.paramDef;
		},
	};
});

// eslint-disable-next-line import/no-default-export
export default endpoints;
