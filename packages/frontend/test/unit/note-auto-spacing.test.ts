/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, assert, describe, test } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { defineComponent } from 'vue';
import * as Misskey from 'misskey-js';
import Mfm from '@/components/global/MkMfm.js';
import MkNotePreview from '@/components/MkNotePreview.vue';

const UserNameStub = defineComponent({
	template: '<span data-testid="user-name">Alice</span>',
});

describe('note auto spacing scope', () => {
	afterEach(() => {
		cleanup();
	});

	test('applies auto spacing to note MFM but not header UI', async () => {
		const result = render(MkNotePreview, {
			props: {
				text: '\u65e5\u672c\u8a9eEnglish',
				files: [],
				useCw: true,
				cw: '\u8b66\u544aWarning',
				user: {
					id: 'user',
					username: 'alice',
					name: 'Alice',
					host: null,
				} as Misskey.entities.User,
			},
			global: {
				components: {
					Mfm,
				},
				stubs: {
					MkAvatar: true,
					MkUserName: UserNameStub,
					MkCwButton: { template: '<button data-testid="expand" @click="$emit(\'update:modelValue\', true)">expand</button>' },
				},
			},
		});

		assert.strictEqual(result.container.querySelectorAll('._textAutoSpacing').length, 1);
		await fireEvent.click(result.getByTestId('expand'));
		const mfmElements = Array.from(result.container.querySelectorAll('._textAutoSpacing'));
		assert.strictEqual(mfmElements.length, 2);
		assert.strictEqual(result.getByTestId('user-name').closest('._textAutoSpacing'), null);
	});
});
