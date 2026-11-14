/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, toValue } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { normalizeCustomEmojiName } from '@@/js/emoji-name.js';
import { prefer } from '@/preferences.js';

export function makeEmojiMuteKey(props: { name: string; host?: string | null }) {
	return props.name.startsWith(':') ? props.name : `:${props.name}${props.host ? `@${props.host}` : ''}:`;
}

export function extractCustomEmojiName (name:string) {
	return normalizeCustomEmojiName(name).split('@')[0];
}

export function extractCustomEmojiHost (name:string) {
	const index = name.indexOf('@');
	if (index === -1) {
		return null;
	}
	const host = name.substring(index + 1, name.length - 1);
	if (host === '' || host === '.') {
		return null;
	}
	return host;
}

export function mute(emoji: string) {
	const isCustomEmoji = emoji.startsWith(':') && emoji.endsWith(':');
	const emojiMuteKey = isCustomEmoji ?
		makeEmojiMuteKey({ name: extractCustomEmojiName(emoji), host: extractCustomEmojiHost(emoji) }) :
		emoji;
	const mutedEmojis = prefer.r.mutingEmojis.value;
	if (!mutedEmojis.includes(emojiMuteKey)) {
		return prefer.commit('mutingEmojis', [...mutedEmojis, emojiMuteKey]);
	}
	throw new Error('Emoji is already muted', { cause: `${emojiMuteKey} is Already Muted` });
}

export function unmute(emoji:string) {
	const isCustomEmoji = emoji.startsWith(':') && emoji.endsWith(':');
	const emojiMuteKey = isCustomEmoji ?
		makeEmojiMuteKey({ name: extractCustomEmojiName(emoji), host: extractCustomEmojiHost(emoji) }) :
		emoji;
	const mutedEmojis = prefer.r.mutingEmojis.value;
	console.log('unmute', emoji, emojiMuteKey);
	console.log('mutedEmojis', mutedEmojis);
	prefer.commit('mutingEmojis', mutedEmojis.filter((e) => e !== emojiMuteKey));
}

export function checkMuted(emoji: MaybeRefOrGetter<string>) {
	return computed(() => {
		const target = toValue(emoji);
		const isCustomEmoji = target.startsWith(':') && target.endsWith(':');
		const emojiMuteKey = isCustomEmoji ?
			makeEmojiMuteKey({ name: extractCustomEmojiName(target), host: extractCustomEmojiHost(target) }) :
			target;
		return prefer.r.mutingEmojis.value.includes(emojiMuteKey);
	});
}
