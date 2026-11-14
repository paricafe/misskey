/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Misskey from 'misskey-js';
import type { UnicodeEmojiDef } from '@@/js/emojilist.js';

export function checkReactionPermissions(me: Misskey.entities.MeDetailed, note: Misskey.entities.Note, emoji: Misskey.entities.EmojiSimple | UnicodeEmojiDef | string): boolean {
	if (typeof emoji === 'string') return true;
	if ('char' in emoji) return true;

	const roleIdsThatCanBeUsedThisEmojiAsReaction = emoji.roleIdsThatCanBeUsedThisEmojiAsReaction ?? [];
	const canUseLocalOnlyEmoji = note.user.host === me.host && (note.renote?.user.host == null || note.renote.user.host === me.host);

	return (!emoji.localOnly || canUseLocalOnlyEmoji)
		&& !(emoji.isSensitive && (note.reactionAcceptance === 'nonSensitiveOnly' || note.reactionAcceptance === 'nonSensitiveOnlyForLocalLikeOnlyForRemote'))
		&& (roleIdsThatCanBeUsedThisEmojiAsReaction.length === 0 || me.roles.some(role => roleIdsThatCanBeUsedThisEmojiAsReaction.includes(role.id)));
}
