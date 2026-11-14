/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { instance } from '@/instance.js';
import { $i } from '@/i.js';

export const notesSearchAvailable = (
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	($i == null && instance.policies != null && instance.policies.canSearchNotes) ||
	($i != null && $i.policies.canSearchNotes) ||
	false
) as boolean;

export const canSearchNonLocalNotes = (
	instance.noteSearchableScope === 'global'
);

export const usersSearchAvailable = (
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	($i == null && instance.policies != null && instance.policies.canSearchUsers) ||
	($i != null && $i.policies.canSearchUsers) ||
	false
);
