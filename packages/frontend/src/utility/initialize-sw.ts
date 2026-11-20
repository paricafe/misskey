/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { getAccountFromId } from '@/utility/get-account-from-id.js';
import { lang } from '@@/js/config.js';

export async function initializeSw() {
	if (!('serviceWorker' in navigator)) return;

	navigator.serviceWorker.addEventListener('message', ev => {
		if (ev.source !== navigator.serviceWorker.controller || ev.data?.type !== 'confirm-push-account') return;
		const port = ev.ports[0];
		if (!port || typeof ev.data.userId !== 'string') return;
		getAccountFromId(ev.data.userId).then(
			account => port.postMessage(!!account),
			() => port.postMessage(null),
		);
	});

	navigator.serviceWorker.register('/sw.js', { scope: '/', type: 'classic' });
	navigator.serviceWorker.ready.then(registration => {
		registration.active?.postMessage({
			msg: 'initialize',
			lang,
		});
	});
}
