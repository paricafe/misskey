/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Chart from '../../core.js';

export const name = 'drive';

export const schema = {
	'local.incCount': {},
	'local.incSize': {},
	'local.decCount': {},
	'local.decSize': {},
	'remote.incCount': {},
	'remote.incSize': {},
	'remote.decCount': {},
	'remote.decSize': {},
} as const;

export const entity = Chart.schemaToEntity(name, schema);
