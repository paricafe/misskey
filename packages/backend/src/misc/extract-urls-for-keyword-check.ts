/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { domainToUnicode } from 'node:url';
import * as mfm from 'mfm-js';
import { DB_MAX_NOTE_TEXT_LENGTH } from '@/const.js';
import { safeDecodeURIComponent } from '@/misc/safe-decode-uri-component.js';

export function extractUrlsForKeyWordCheck(text: string): string[] {
	if (!text.includes('://')) return [];

	const nodes = mfm.parse(text.slice(0, DB_MAX_NOTE_TEXT_LENGTH));
	const urlNodes = mfm.extract(nodes, (node) => node.type === 'url' || node.type === 'link') as (mfm.MfmUrl | mfm.MfmLink)[];

	const urls: string[] = [];
	for (const node of urlNodes) {
		let url: URL;
		try {
			url = new URL(node.props.url);
		} catch {
			continue;
		}

		const hostname = domainToUnicode(url.hostname) || url.hostname;
		const port = url.port !== '' ? `:${url.port}` : '';
		urls.push(url.href);
		urls.push(`${url.protocol}//${hostname}${port}${safeDecodeURIComponent(url.pathname)}${safeDecodeURIComponent(url.search)}${safeDecodeURIComponent(url.hash)}`);
	}

	return urls;
}
