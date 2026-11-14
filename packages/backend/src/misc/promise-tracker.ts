/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const promises = new Set<Promise<unknown>>();

export function trackPromise(promise: Promise<unknown>) {
	promises.add(promise);
	void promise.then(() => promises.delete(promise), () => promises.delete(promise));
}

export async function allSettled(): Promise<void> {
	while (promises.size > 0) {
		await Promise.allSettled(promises);
	}
}
