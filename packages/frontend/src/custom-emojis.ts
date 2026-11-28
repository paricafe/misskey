/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { shallowRef, shallowReactive, computed, markRaw, watch } from 'vue';
import * as Misskey from 'misskey-js';
import type { CustomEmojiFolderTree } from '@@/js/emojilist.js';
import { misskeyApi, misskeyApiGet } from '@/utility/misskey-api.js';
import { get, set } from '@/utility/idb-proxy.js';

export const customEmojis = shallowRef<Misskey.entities.EmojiSimple[]>([]);
export const customEmojiCategories = computed<[ ...string[], null ]>(() => {
	const categories = new Set<string>();
	for (const emoji of customEmojis.value) {
		if (emoji.category && emoji.category !== 'null') {
			categories.add(emoji.category);
		}
	}
	return markRaw([...Array.from(categories), null]);
});

export const customEmojiNamesByCategory = computed<Map<string, string[]>>(() => {
	const map = new Map<string, string[]>();
	for (const emoji of customEmojis.value) {
		const key = (!emoji.category || emoji.category === 'null') ? '' : emoji.category;
		let list = map.get(key);
		if (list == null) {
			list = [];
			map.set(key, list);
		}
		list.push(`:${emoji.name}:`);
	}
	return markRaw(map);
});

export const customEmojiFolderRoot = computed<CustomEmojiFolderTree>(() => {
	const root: CustomEmojiFolderTree = { value: '', category: '', children: [] };
	const merge = (input: string) => {
		const parts = input.split('/').map(p => p.trim());
		let currentNode: CustomEmojiFolderTree = root;
		for (const part of parts) {
			let existingNode = currentNode.children.find(node => node.value === part);
			if (!existingNode) {
				existingNode = { value: part, category: input, children: [] };
				currentNode.children.push(existingNode);
			}
			currentNode = existingNode;
		}
	};
	for (const ec of customEmojiCategories.value) {
		if (ec !== null) merge(ec);
	}
	merge('');
	return markRaw(root);
});

let cachedTags: string[] | null = null;

export const customEmojisMap = shallowReactive(new Map<string, Misskey.entities.EmojiSimple>());
watch(customEmojis, emojis => {
	cachedTags = null;
	const names = new Set<string>();
	for (const emoji of emojis) {
		names.add(emoji.name);
		const current = customEmojisMap.get(emoji.name);
		if (current !== emoji && (current == null || JSON.stringify(current) !== JSON.stringify(emoji))) {
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
const preHydrationMutations: EmojiMutation[] = [];
let hydrated = false;
let hasAuthoritativeCatalog = false;

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
	if (!hydrated) {
		preHydrationMutations.push(mutation);
	}
	for (const queue of activeFetchMutations) {
		queue.push(mutation);
	}
}

export const customEmojisReady: Promise<void> = Promise.resolve()
	.then(() => get('emojis'))
	.then(storageCache => {
		hydrated = true;
		if (hasAuthoritativeCatalog) {
			preHydrationMutations.length = 0;
			return;
		}
		if (!Array.isArray(storageCache)) {
			preHydrationMutations.length = 0;
			return;
		}
		let nextEmojis = storageCache as Misskey.entities.EmojiSimple[];
		for (const mutation of preHydrationMutations) {
			nextEmojis = applyEmojiMutation(nextEmojis, mutation);
		}
		preHydrationMutations.length = 0;
		customEmojis.value = nextEmojis;
	})
	.catch(error => {
		hydrated = true;
		preHydrationMutations.length = 0;
		console.error('Failed to restore cached custom emojis:', error);
	});

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

	hasAuthoritativeCatalog = true;
	customEmojis.value = nextEmojis;
	set('emojis', nextEmojis);
	set('lastEmojisFetchedAt', now);
}

export async function fetchCustomEmojisForBoot(): Promise<void> {
	void fetchCustomEmojis().catch(error => console.error('Failed to refresh emojis:', error));
}

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
