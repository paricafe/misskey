/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { shallowRef, ref, watch } from 'vue';
import { getEmojiPicker, loadEmojiPicker } from '@/utility/interactive-components.js';
import { popup } from '@/os.js';
import { prefer } from '@/preferences.js';

class EmojiPicker {
	private emojisRef = ref<string[]>([]);
	private pendingShowId = 0;

	constructor() {
	}

	public init() {
		watch([prefer.r.emojiPaletteForMain, prefer.r.emojiPalettes], ([newId, newPalettes]) => {
			this.emojisRef.value = newId == null ? newPalettes[0].emojis : newPalettes.find(palette => palette.id === newId)?.emojis ?? [];
		}, {
			immediate: true,
		});
	}

	public show(
		anchorElement: HTMLElement,
		onChosen?: (emoji: string) => void,
		onClosed?: (superseded?: boolean) => void,
	): void | Promise<void> {
		const MkEmojiPickerDialog = getEmojiPicker();
		if (!MkEmojiPickerDialog) {
			const showId = ++this.pendingShowId;
			return loadEmojiPicker().then(() => {
				if (showId !== this.pendingShowId) {
					onClosed?.(true);
					return;
				}
				this.show(anchorElement, onChosen, onClosed);
			}, (err) => {
				onClosed?.(false);
				console.error('Failed to load emoji picker:', err);
			});
		}
		const anchorRef = shallowRef(anchorElement);

		const { dispose } = popup(MkEmojiPickerDialog, {
			anchorElement: anchorRef,
			pinnedEmojis: this.emojisRef,
			asReactionPicker: false,
			choseAndClose: false,
		}, {
			done: (emoji: string) => {
				if (onChosen) onChosen(emoji);
			},
			closed: () => {
				if (onClosed) onClosed(false);
				dispose();
			},
		});
	}
}

export const emojiPicker = new EmojiPicker();
