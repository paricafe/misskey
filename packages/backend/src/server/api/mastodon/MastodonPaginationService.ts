/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';

type PaginationQuery = {
	limit?: string | number;
	max_id?: string;
	min_id?: string;
	since_id?: string;
};

@Injectable()
export class MastodonPaginationService {
	public toMisskey(query: PaginationQuery, maximum = 40): { limit: number; untilId?: string; sinceId?: string } {
		const parsedLimit = typeof query.limit === 'number' ? query.limit : Number.parseInt(query.limit ?? '', 10);
		const limit = Number.isFinite(parsedLimit) ? Math.min(maximum, Math.max(1, parsedLimit)) : 20;

		return {
			limit,
			...(query.max_id != null && query.max_id !== '' ? { untilId: query.max_id } : {}),
		...((query.min_id ?? query.since_id) != null && (query.min_id ?? query.since_id) !== ''
				? { sinceId: query.min_id ?? query.since_id }
				: {}),
		};
	}

	public linkHeader(requestUrl: string, items: readonly { id: string }[]): string | null {
		const newest = items[0]?.id;
		const oldest = items.at(-1)?.id;
		if (newest == null || oldest == null) return null;

		const next = new URL(requestUrl);
		next.searchParams.delete('min_id');
		next.searchParams.delete('since_id');
		next.searchParams.set('max_id', oldest);

		const previous = new URL(requestUrl);
		previous.searchParams.delete('max_id');
		previous.searchParams.delete('min_id');
		previous.searchParams.set('since_id', newest);

		return `<${next.toString()}>; rel="next", <${previous.toString()}>; rel="prev"`;
	}
}
