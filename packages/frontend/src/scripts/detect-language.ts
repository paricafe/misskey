/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { detect } from 'tinyld/heavy';
import * as mfm from 'mfm-js';
import { miLocalStorage } from '@/local-storage.js';

export default function detectLanguage(text: string): string {
	const localLang = (miLocalStorage.getItem('lang') ?? navigator.language).slice(0, 2);
	const nodes = mfm.parse(text);
	const filtered = mfm.extract(nodes, (node) => {
		return node.type === 'text' || node.type === 'quote';
	});
	const purified = mfm.toString(filtered);

	if (detect(purified) === '') return localLang;
	return detect(purified);
}
