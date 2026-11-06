/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { getEmojiPicker, getPostForm, loadEmojiPicker, loadPostForm, preloadInteractiveComponents } from '@/utility/interactive-components.js';
import { emojiPicker as emojiPickerSingleton } from '@/utility/emoji-picker.js';
import { reactionPicker } from '@/utility/reaction-picker.js';
import { popup } from '@/os.js';

vi.mock('@/components/MkPostFormDialog.vue', () => ({ default: { name: 'PostFormProbe' } }));
vi.mock('@/components/MkEmojiPickerDialog.vue', () => ({ default: { name: 'EmojiPickerProbe' } }));
vi.mock('@/os.js', () => ({ popup: vi.fn(() => ({ dispose: vi.fn() })) }));

test('shares pending and resolved component loads with preloading, then opens pickers synchronously', async () => {
	expect(getPostForm()).toBeUndefined();
	expect(getEmojiPicker()).toBeUndefined();
	const postForm = loadPostForm();
	const emojiPicker = loadEmojiPicker();
	expect(loadPostForm()).toBe(postForm);
	expect(loadEmojiPicker()).toBe(emojiPicker);
	const [post, emoji] = await preloadInteractiveComponents();
	expect(post).toBe(await postForm);
	expect(emoji).toBe(await emojiPicker);
	expect(getPostForm()).toBe(post.default);
	expect(getEmojiPicker()).toBe(emoji.default);
	expect(loadPostForm()).toBe(postForm);
	expect(loadEmojiPicker()).toBe(emojiPicker);
	const anchor = document.createElement('button');
	expect(emojiPickerSingleton.show(anchor)).toBeUndefined();
	expect(popup).toHaveBeenCalledTimes(1);
	expect(popup).toHaveBeenLastCalledWith(emoji.default, expect.objectContaining({ asReactionPicker: false }), expect.any(Object));
	expect(reactionPicker.show(anchor, null)).toBeUndefined();
	expect(popup).toHaveBeenCalledTimes(2);
	expect(popup).toHaveBeenLastCalledWith(emoji.default, expect.objectContaining({ asReactionPicker: true }), expect.any(Object));
});
