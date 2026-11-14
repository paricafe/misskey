/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function uniqueByKey<TItem, TKey = string>(items: Iterable<TItem>, key: (item: TItem) => TKey): TItem[] {
	const map = new Map<TKey, TItem>();
	for (const item of items) {
		const k = key(item);
		if (!map.has(k)) {
			map.set(k, item);
		}
	}
	return [...map.values()];
}
