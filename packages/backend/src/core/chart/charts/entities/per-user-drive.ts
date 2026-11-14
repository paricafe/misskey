/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Chart from '../../core.js';

export const name = 'perUserDrive';

export const schema = {
	'totalCount': { accumulate: true },
	'totalSize': { accumulate: true },
	'incCount': { range: 'small' },
	'incSize': {},
	'decCount': { range: 'small' },
	'decSize': {},
} as const;

export const entity = Chart.schemaToEntity(name, schema, true);
