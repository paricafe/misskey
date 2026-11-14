/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import IPCIDR from 'ip-cidr';

export function getIpHash(ip: string): string {
	try {
		const prefix = IPCIDR.createAddress(ip).mask(64);
		return 'ip-' + BigInt('0b' + prefix).toString(36);
	} catch (_) {
		const prefix = IPCIDR.createAddress(ip.replace(/:[0-9]+$/, '')).mask(64);
		return 'ip-' + BigInt('0b' + prefix).toString(36);
	}
}
