/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

let postForm: Promise<typeof import('@/components/MkPostFormDialog.vue')> | null = null;
let emojiPicker: Promise<typeof import('@/components/MkEmojiPickerDialog.vue')> | null = null;
let loadedPostForm: typeof import('@/components/MkPostFormDialog.vue')['default'] | undefined;
let loadedEmojiPicker: typeof import('@/components/MkEmojiPickerDialog.vue')['default'] | undefined;

export function getPostForm() {
	return loadedPostForm;
}

export function getEmojiPicker() {
	return loadedEmojiPicker;
}

export function loadPostForm() {
	return postForm ??= import('@/components/MkPostFormDialog.vue').then(module => {
		loadedPostForm = module.default;
		return module;
	}).catch(error => {
		postForm = null;
		throw error;
	});
}

export function loadEmojiPicker() {
	return emojiPicker ??= import('@/components/MkEmojiPickerDialog.vue').then(module => {
		loadedEmojiPicker = module.default;
		return module;
	}).catch(error => {
		emojiPicker = null;
		throw error;
	});
}

/** Finish before authenticated controls mount, keeping iOS focus within the user gesture. */
export function preloadInteractiveComponents() {
	return Promise.all([loadPostForm(), loadEmojiPicker()]);
}
