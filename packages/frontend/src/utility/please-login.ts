/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { $i } from '@/i.js';
import { instance } from '@/instance.js';
import { i18n } from '@/i18n.js';
import { popupAsyncWithDialog } from '@/os.js';

export type OpenOnRemoteOptions = {
	type: 'web';

	path: string;
} | {
	type: 'lookup';

	url: string;
} | {
	type: 'share';

	params: Record<string, string>;
};

export async function pleaseLogin(opts: {
	path?: string;
	message?: string;
	openOnRemote?: OpenOnRemoteOptions;
} = {}): Promise<boolean> {
	if ($i != null) return true;

	let _openOnRemote: OpenOnRemoteOptions | undefined = undefined;

	if (opts.openOnRemote != null && (instance.federation !== 'none' || opts.openOnRemote.type === 'share')) {
		_openOnRemote = opts.openOnRemote;
	}

	const { dispose } = await popupAsyncWithDialog(import('@/components/MkSigninDialog.vue').then(x => x.default), {
		autoSet: true,
		message: opts.message ?? (_openOnRemote ? i18n.ts.signinOrContinueOnRemote : i18n.ts.signinRequired),
		openOnRemote: _openOnRemote,
	}, {
		cancelled: () => {
			if (opts.path) {
				window.location.href = opts.path;
			}
		},
		closed: () => dispose(),
	});

	return false;
}
