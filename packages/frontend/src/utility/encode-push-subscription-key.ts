/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function encodePushSubscriptionKey(buffer: ArrayBuffer | null): string {
	return btoa(String.fromCharCode(...(buffer != null ? new Uint8Array(buffer) : [])));
}
