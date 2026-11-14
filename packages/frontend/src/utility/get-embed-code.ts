/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { defineAsyncComponent } from 'vue';
import { url } from '@@/js/config.js';
import { defaultEmbedParams, embedRouteWithScrollbar } from '@@/js/embed-page.js';
import type { EmbedParams, EmbeddableEntity } from '@@/js/embed-page.js';
import { genId } from '@/utility/id.js';
import * as os from '@/os.js';
import { copyToClipboard } from '@/utility/copy-to-clipboard.js';

const MOBILE_THRESHOLD = 500;

export function normalizeEmbedParams(params: EmbedParams): Record<string, string> {
	const normalizedParams: Record<string, string> = {};
	for (const key in params) {
		const k = key as keyof EmbedParams;
		if (params[k] == null || params[k] === defaultEmbedParams[k]) {
			continue;
		}
		switch (typeof params[k]) {
			case 'number':
				normalizedParams[k] = params[k].toString();
				break;
			case 'boolean':
				normalizedParams[k] = params[k] ? 'true' : 'false';
				break;
			default:
				normalizedParams[k] = params[k];
				break;
		}
	}
	return normalizedParams;
}

export function getEmbedCode(path: string, params?: EmbedParams): string {
	const iframeId = 'v1_' + genId();

	let paramString = '';
	if (params) {
		const searchParams = new URLSearchParams(normalizeEmbedParams(params));
		paramString = searchParams.toString() === '' ? '' : '?' + searchParams.toString();
	}

	const iframeCode = [
		`<iframe src="${url + path + paramString}" data-misskey-embed-id="${iframeId}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" style="border: none; width: 100%; max-width: 500px; height: 300px; color-scheme: light dark;"></iframe>`,
		`<script defer src="${url}/embed.js"></script>`,
	];
	return iframeCode.join('\n');
}

export async function genEmbedCode(entity: EmbeddableEntity, id: string, params?: EmbedParams) {
	const _params = { ...params };

	if (embedRouteWithScrollbar.includes(entity) && _params.maxHeight == null) {
		_params.maxHeight = 700;
	}

	if (window.innerWidth < MOBILE_THRESHOLD) {
		copyToClipboard(getEmbedCode(`/embed/${entity}/${id}`, _params));
	} else {
		const { dispose } = await os.popupAsyncWithDialog(import('@/components/MkEmbedCodeGenDialog.vue').then(x => x.default), {
			entity,
			id,
			params: _params,
		}, {
			closed: () => dispose(),
		});
	}
}
