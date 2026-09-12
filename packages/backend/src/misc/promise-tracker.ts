/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const promises = new Set<Promise<unknown>>();

/**
 * This tracks promises that other modules decided not to wait for,
 * and makes sure they are all settled before fully closing down the server.
 */
export function trackPromise(promise: Promise<unknown>) {
	promises.add(promise);
	// Handle both outcomes without producing an unobserved rejected promise,
	// which Promise.finally() would do when the tracked work rejects.
	void promise.then(() => promises.delete(promise), () => promises.delete(promise));
}

export async function allSettled(): Promise<void> {
	// A completing task may register more work; drain until that work also ends.
	while (promises.size > 0) {
		await Promise.allSettled(promises);
	}
}
