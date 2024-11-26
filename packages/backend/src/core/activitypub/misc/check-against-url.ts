/*
 * SPDX-FileCopyrightText: dakkar and sharkey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { IObject } from '../type.js';

function getHrefsFrom(one: IObject | string | undefined | (IObject | string | undefined)[]): (string | undefined)[] {
	if (Array.isArray(one)) {
		return one.flatMap(h => getHrefsFrom(h));
	}
	return [
		typeof(one) === 'object' ? one.href : one,
	];
}

export function assertActivityMatchesUrls(activity: IObject, urls: string[]) {
	const expectedUrls = new Set(urls
		.filter(u => URL.canParse(u))
		.map(u => new URL(u).href),
	);

	const actualUrls = [activity.id, ...getHrefsFrom(activity.url)]
		.filter(u => u && URL.canParse(u))
		.map(u => new URL(u as string).href);

	if (!actualUrls.some(u => expectedUrls.has(u))) {
		throw new Error(`bad Activity: neither id(${activity.id}) nor url(${JSON.stringify(activity.url)}) match location(${urls})`);
	}
}
