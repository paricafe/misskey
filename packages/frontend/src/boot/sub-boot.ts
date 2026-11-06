/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createApp, defineAsyncComponent } from 'vue';
import { common } from './common.js';
import { emojiPicker } from '@/utility/emoji-picker.js';
import UiMinimum from '@/ui/minimum.vue';
import { $i } from '@/i.js';
import { preloadInteractiveComponents } from '@/utility/interactive-components.js';

export async function subBoot() {
	const { isClientUpdated } = await common(async () => {
		if ($i) await preloadInteractiveComponents();
		return createApp(UiMinimum);
	});

	emojiPicker.init();
}
