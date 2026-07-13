/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function applyTextAutospacePreference(enabled: boolean, root: HTMLElement = window.document.documentElement): void {
	root.style.setProperty('--MI-textAutospace', enabled ? 'normal' : 'no-autospace');
}
