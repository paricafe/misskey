/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { shallowRef, shallowReactive, computed, markRaw, watch } from 'vue';
import * as Misskey from 'misskey-js';
import { misskeyApi, misskeyApiGet } from '@/utility/misskey-api.js';
import { get, set } from '@/utility/idb-proxy.js';

const storageCache = await get('emojis');
export const customEmojis = shallowRef<Misskey.entities.EmojiSimple[]>(Array.isArray(storageCache) ? storageCache : []);
export const customEmojiCategories = computed<[ ...string[], null ]>(() => {
	const categories = new Set<string>();
	for (const emoji of customEmojis.value) {
		if (emoji.category && emoji.category !== 'null') {
			categories.add(emoji.category);
		}
	}
	return markRaw([...Array.from(categories), null]);
});

export const customEmojisMap = shallowReactive(new Map<string, Misskey.entities.EmojiSimple>());
watch(customEmojis, emojis => {
	const names = new Set<string>();
	for (const emoji of emojis) {
		names.add(emoji.name);
		const current = customEmojisMap.get(emoji.name);
		if (current == null || JSON.stringify(current) !== JSON.stringify(emoji)) {
			customEmojisMap.set(emoji.name, emoji);
		}
	}
	for (const name of customEmojisMap.keys()) {
		if (!names.has(name)) customEmojisMap.delete(name);
	}
}, { immediate: true });

type EmojiMutation =
	| { type: 'add'; emoji: Misskey.entities.EmojiSimple }
	| { type: 'update'; emojis: Misskey.entities.EmojiSimple[] }
	| { type: 'remove'; emojis: Misskey.entities.EmojiSimple[] };

const activeFetchMutations = new Set<EmojiMutation[]>();

function applyEmojiMutation(list: Misskey.entities.EmojiSimple[], mutation: EmojiMutation): Misskey.entities.EmojiSimple[] {
	switch (mutation.type) {
		case 'add':
			return [mutation.emoji, ...list.filter(item => item.name !== mutation.emoji.name)];
		case 'update':
			return list.map(item => mutation.emojis.find(search => search.name === item.name) ?? item);
		case 'remove':
			return list.filter(item => !mutation.emojis.some(search => search.name === item.name));
	}
}

function recordEmojiMutation(mutation: EmojiMutation) {
	for (const queue of activeFetchMutations) {
		queue.push(mutation);
	}
}

export function addCustomEmoji(emoji: Misskey.entities.EmojiSimple) {
	recordEmojiMutation({ type: 'add', emoji });
	customEmojis.value = [emoji, ...customEmojis.value];
	set('emojis', customEmojis.value);
}

export function updateCustomEmojis(emojis: Misskey.entities.EmojiSimple[]) {
	recordEmojiMutation({ type: 'update', emojis });
	customEmojis.value = customEmojis.value.map(item => emojis.find(search => search.name === item.name) ?? item);
	set('emojis', customEmojis.value);
}

export function removeCustomEmojis(emojis: Misskey.entities.EmojiSimple[]) {
	recordEmojiMutation({ type: 'remove', emojis });
	customEmojis.value = customEmojis.value.filter(item => !emojis.some(search => search.name === item.name));
	set('emojis', customEmojis.value);
}

export async function fetchCustomEmojis(force = false) {
	const now = Date.now();
	const mutations: EmojiMutation[] = [];
	activeFetchMutations.add(mutations);

	let res;
	try {
		if (force) {
			res = await misskeyApi('emojis', {});
		} else {
			const lastFetchedAt = await get('lastEmojisFetchedAt');
			if (lastFetchedAt && (now - lastFetchedAt) < 1000 * 60 * 60) return;
			res = await misskeyApiGet('emojis', {});
		}
	} finally {
		activeFetchMutations.delete(mutations);
	}

	let nextEmojis = res.emojis;
	for (const mutation of mutations) {
		nextEmojis = applyEmojiMutation(nextEmojis, mutation);
	}

	customEmojis.value = nextEmojis;
	set('emojis', nextEmojis);
	set('lastEmojisFetchedAt', now);
}

export async function fetchCustomEmojisForBoot(): Promise<void> {
	void fetchCustomEmojis().catch(error => console.error('Failed to refresh emojis:', error));
}

let cachedTags: string[] | null = null;
export function getCustomEmojiTags() {
	if (cachedTags) return cachedTags;

	const tags = new Set<string>();
	for (const emoji of customEmojis.value) {
		for (const tag of emoji.aliases) {
			tags.add(tag);
		}
	}
	const res = Array.from(tags);
	cachedTags = res;
	return res;
}
