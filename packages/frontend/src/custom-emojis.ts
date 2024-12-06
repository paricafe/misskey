/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { shallowRef, computed, markRaw, watch } from 'vue';
import * as Misskey from 'misskey-js';
import { misskeyApi, misskeyApiGet } from '@/scripts/misskey-api.js';
import { get, set } from '@/scripts/idb-proxy.js';

const CACHE_EXPIRE_TIME = 12 * 60 * 60 * 1000;
const BATCH_SIZE = 1000;

const storageCache = await get('emojis');
export const customEmojis = shallowRef<Misskey.entities.EmojiSimple[]>(
	Array.isArray(storageCache) ? storageCache : [],
);

const categoriesMap = new Map<string, Misskey.entities.EmojiSimple[]>();

export const customEmojiCategories = computed<[...string[], null]>(() => {
	if (categoriesMap.size === 0 && customEmojis.value.length > 0) {
		for (const emoji of customEmojis.value) {
			const category = emoji.category && emoji.category !== 'null'
				? emoji.category
				: 'null';

			if (!categoriesMap.has(category)) {
				categoriesMap.set(category, []);
			}
			categoriesMap.get(category)?.push(emoji);
		}
	}
	return markRaw([...Array.from(categoriesMap.keys()), null]);
});

export const customEmojisMap = new Map<string, Misskey.entities.EmojiSimple>();

function batchUpdateMap(emojis: Misskey.entities.EmojiSimple[]): void {
	customEmojisMap.clear();
	categoriesMap.clear();

	for (let i = 0; i < emojis.length; i += BATCH_SIZE) {
		const batch = emojis.slice(i, i + BATCH_SIZE);
		for (const emoji of batch) {
			customEmojisMap.set(emoji.name, emoji);
		}
	}
}

watch(customEmojis, emojis => {
	batchUpdateMap(emojis);
}, { immediate: true });

export function addCustomEmoji(emoji: Misskey.entities.EmojiSimple): void {
	const newEmojis = [emoji, ...customEmojis.value];
	customEmojis.value = newEmojis;
	customEmojisMap.set(emoji.name, emoji);
	void set('emojis', newEmojis);
}

export function updateCustomEmojis(emojis: Misskey.entities.EmojiSimple[]): void {
	const updateMap = new Map(emojis.map(emoji => [emoji.name, emoji]));

	const newEmojis = customEmojis.value.map(item =>
		updateMap.get(item.name) ?? item,
	);

	customEmojis.value = newEmojis;
	batchUpdateMap(newEmojis);
	void set('emojis', newEmojis);
}

export function removeCustomEmojis(emojis: Misskey.entities.EmojiSimple[]): void {
	const removedNames = new Set(emojis.map(e => e.name));

	const filteredEmojis = customEmojis.value.filter(
		item => !removedNames.has(item.name),
	);

	customEmojis.value = filteredEmojis;
	batchUpdateMap(filteredEmojis);
	void set('emojis', filteredEmojis);
}

export async function fetchCustomEmojis(force = false): Promise<void> {
	const now = Date.now();

	if (!force) {
		const lastFetchedAt = await get('lastEmojisFetchedAt');
		if (lastFetchedAt && (now - lastFetchedAt) < CACHE_EXPIRE_TIME) {
			return;
		}
	}

	try {
		const res = await (force ? misskeyApi : misskeyApiGet)('emojis', {});

		if (res.emojis.length > 0) {
			customEmojis.value = res.emojis;
			await Promise.all([
				set('emojis', res.emojis),
				set('lastEmojisFetchedAt', now),
			]);
		}
	} catch (error) {
		console.error('Failed to fetch emojis:', error);
	}
}

const tagsCache = new Map<string, string[]>();

export function getCustomEmojiTags(): string[] {
	const cacheKey = `${customEmojis.value.length}`;

	if (tagsCache.has(cacheKey)) {
		const cached = tagsCache.get(cacheKey);
		if (cached) return cached;
	}

	const tags = new Set<string>();

	for (let i = 0; i < customEmojis.value.length; i += BATCH_SIZE) {
		const batch = customEmojis.value.slice(i, i + BATCH_SIZE);
		for (const emoji of batch) {
			for (const tag of emoji.aliases) {
				tags.add(tag);
			}
		}
	}

	const result = Array.from(tags);
	tagsCache.set(cacheKey, result);
	return result;
}
