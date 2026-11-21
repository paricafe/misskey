/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { assert, describe, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import { Autocomplete } from '@/utility/autocomplete.js';
import * as os from '@/os.js';
import { searchEmoji } from '@/utility/search-emoji.js';

vi.mock('@/os.js', () => ({ popup: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('textarea-caret', () => ({ default: () => ({ left: 1, top: 1 }) }));

test('dismissed autocomplete suggestions cannot edit a replacement draft', () => {
	const input = document.createElement('textarea');
	const text = ref('@alice');
	const completion = new Autocomplete(input, text);

	function open(value: string) {
		input.value = value;
		input.setSelectionRange(value.length, value.length);
		input.dispatchEvent(new Event('input'));
		return vi.mocked(os.popup).mock.lastCall![2]!.done as unknown as (entry: { type: 'user'; value: { username: string; host: null } }) => void;
	}

	try {
		const oldSelection = open(text.value);
		completion.close();
		text.value = '@bob';
		const newSelection = open(text.value);
		oldSelection({ type: 'user', value: { username: 'private-alice', host: null } });
		expect(text.value).toBe('@bob');
		newSelection({ type: 'user', value: { username: 'bob-recipient', host: null } });
		expect(text.value).toBe('@bob-recipient ');
	} finally {
		completion.detach();
	}
});

describe('emoji autocomplete', () => {
	test('名前の完全一致は名前の前方一致より優先される', async () => {
		const result = searchEmoji('foooo', [{ emoji: ':foooo:', name: 'foooo' }, { emoji: ':foooobaaar:', name: 'foooobaaar' }]);
		assert.equal(result[0].emoji, ':foooo:');
	});

	test('名前の前方一致は名前の部分一致より優先される', async () => {
		const result = searchEmoji('baaa', [{ emoji: ':baaar:', name: 'baaar' }, { emoji: ':foooobaaar:', name: 'foooobaaar' }]);
		assert.equal(result[0].emoji, ':baaar:');
	});

	test('名前の完全一致はタグの完全一致より優先される', async () => {
		const result = searchEmoji('foooo', [{ emoji: ':foooo:', name: 'foooo' }, { emoji: ':baaar:', name: 'foooo', aliasOf: 'baaar' }]);
		assert.equal(result[0].emoji, ':foooo:');
	});

	test('名前の前方一致はタグの前方一致より優先される', async () => {
		const result = searchEmoji('foo', [{ emoji: ':foooo:', name: 'foooo' }, { emoji: ':baaar:', name: 'foooo', aliasOf: 'baaar' }]);
		assert.equal(result[0].emoji, ':foooo:');
	});

	test('名前の部分一致はタグの部分一致より優先される', async () => {
		const result = searchEmoji('oooo', [{ emoji: ':foooo:', name: 'foooo' }, { emoji: ':baaar:', name: 'foooo', aliasOf: 'baaar' }]);
		assert.equal(result[0].emoji, ':foooo:');
	});
});
