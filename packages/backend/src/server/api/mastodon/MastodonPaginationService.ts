/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';

export type MastodonPaginationQuery = {
	limit?: string | number;
	max_id?: string;
	min_id?: string;
	since_id?: string;
};

@Injectable()
export class MastodonPaginationService {
	public toMisskey(query: MastodonPaginationQuery, maximum = 40): { limit: number; untilId?: string; sinceId?: string } {
		const parsedLimit = typeof query.limit === 'number' ? query.limit : Number.parseInt(query.limit ?? '', 10);
		const limit = Number.isFinite(parsedLimit) ? Math.min(maximum, Math.max(1, parsedLimit)) : 20;
		const minId = query.min_id || undefined;

		return {
			limit,
			// Misskey's single sinceId cursor selects the immediately newer page in ascending order.
			// Mastodon's since_id is only a lower bound on the latest descending page. Keep that
			// bound for normalizePage rather than accidentally selecting the oldest unseen items.
			...(minId != null ? { sinceId: minId } : query.max_id ? { untilId: query.max_id } : {}),
		};
	}

	public normalizePage<T extends { id: string }>(items: readonly T[], query: MastodonPaginationQuery, maximum = 40): T[] {
		const { limit } = this.toMisskey(query, maximum);
		const minId = query.min_id || undefined;
		const lowerBound = minId ?? (query.since_id || undefined);
		const upperBound = query.max_id || undefined;
		const ordered = [...new Map(items.map(item => [item.id, item])).values()]
			.filter(item => (lowerBound == null || item.id > lowerBound) && (upperBound == null || item.id < upperBound))
			.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
		return (minId != null ? ordered.slice(0, limit) : ordered.slice(-limit)).reverse();
	}

	public linkHeader(requestUrl: string, items: readonly { id: string }[]): string | null {
		const ids = items.map(item => item.id).sort();
		const newest = ids.at(-1);
		const oldest = ids[0];
		if (newest == null || oldest == null) return null;

		const next = new URL(requestUrl);
		next.searchParams.delete('min_id');
		next.searchParams.delete('since_id');
		next.searchParams.set('max_id', oldest);

		const previous = new URL(requestUrl);
		previous.searchParams.delete('max_id');
		previous.searchParams.delete('since_id');
		previous.searchParams.set('min_id', newest);

		return `<${next.toString()}>; rel="next", <${previous.toString()}>; rel="prev"`;
	}

	public offsetLinkHeader(requestUrl: string, offset: number, limit: number, hasMore: boolean): string | null {
		const links: string[] = [];
		const createLink = (targetOffset: number, relation: 'next' | 'prev'): string => {
			const url = new URL(requestUrl);
			if (targetOffset === 0) {
				url.searchParams.delete('offset');
			} else {
				url.searchParams.set('offset', targetOffset.toString());
			}
			return `<${url.toString()}>; rel="${relation}"`;
		};

		if (hasMore) links.push(createLink(offset + limit, 'next'));
		if (offset > 0) links.push(createLink(Math.max(0, offset - limit), 'prev'));

		return links.length === 0 ? null : links.join(', ');
	}
}
