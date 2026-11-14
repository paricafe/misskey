/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { MiNote } from '@/models/Note.js';
import { Packed } from '@/misc/json-schema.js';

export function isChannelRelated(note: MiNote | Packed<'Note'>, channelIds: Set<string>, ignoreAuthor = false): boolean {
	if (!ignoreAuthor && note.channelId && channelIds.has(note.channelId)) {
		return true;
	}

	const renoteChannelId = note.renote?.channelId;
	if (renoteChannelId != null && renoteChannelId !== note.channelId && channelIds.has(renoteChannelId)) {
		return true;
	}

	return false;
}
