/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type { MiMastodonUserState } from '@/models/MastodonUserState.js';
import type { MiUser } from '@/models/User.js';
import { MastodonApiError } from './errors.js';
import { MastodonApiStateService } from './MastodonApiStateService.js';

export const MASTODON_MARKER_TIMELINES = ['home', 'notifications'] as const;
export type MastodonMarkerTimeline = typeof MASTODON_MARKER_TIMELINES[number];

export type MastodonMarker = {
	last_read_id: string;
	version: number;
	updated_at: string;
};

export type MastodonMarkers = Partial<Record<MastodonMarkerTimeline, MastodonMarker>>;

type Dictionary = Record<string, unknown>;
const MARKER_KIND = 'marker';

@Injectable()
export class MastodonMarkerService {
	constructor(
		private mastodonApiStateService: MastodonApiStateService,
	) {}

	public async get(userId: MiUser['id'], timelines: MastodonMarkerTimeline[]): Promise<MastodonMarkers> {
		const unique = this.timelines(timelines);
		const rows = await Promise.all(unique.map(async timeline => ({
			timeline,
			row: await this.mastodonApiStateService.get(userId, MARKER_KIND, timeline),
		})));
		return Object.fromEntries(rows.flatMap(({ timeline, row }) => row == null ? [] : [[timeline, this.marker(row)]]));
	}

	public async update(userId: MiUser['id'], body: Dictionary): Promise<MastodonMarkers> {
		const keys = Object.keys(body);
		if (keys.some(key => !MASTODON_MARKER_TIMELINES.includes(key as MastodonMarkerTimeline))) {
			this.invalid(`Markers support only ${MASTODON_MARKER_TIMELINES.join(', ')}`);
		}
		const updated = await Promise.all(keys.map(async key => {
			const timeline = key as MastodonMarkerTimeline;
			const input = this.dictionary(body[timeline], timeline);
			const lastReadId = input.last_read_id;
			if (typeof lastReadId !== 'string' || lastReadId === '') this.invalid(`${timeline}[last_read_id] cannot be blank`);
			const suppliedVersion = input.version == null || input.version === '' ? null : Number(input.version);
			if (suppliedVersion != null && (!Number.isInteger(suppliedVersion) || suppliedVersion < 0)) {
				this.invalid(`${timeline}[version] must be a non-negative integer`);
			}
			const current = await this.mastodonApiStateService.get(userId, MARKER_KIND, timeline);
			let row: MiMastodonUserState;
			if (current == null) {
				if (suppliedVersion != null && suppliedVersion !== 0) this.conflict();
				row = await this.mastodonApiStateService.put({
					userId,
					kind: MARKER_KIND,
					key: timeline,
					value: { lastReadId },
				});
			} else {
				row = await this.mastodonApiStateService.compareAndSet({
					userId,
					kind: MARKER_KIND,
					key: timeline,
					expectedVersion: suppliedVersion ?? current.version,
					value: { lastReadId },
				});
			}
			return [timeline, this.marker(row)] as const;
		}));
		return Object.fromEntries(updated);
	}

	private timelines(value: unknown): MastodonMarkerTimeline[] {
		if (!Array.isArray(value) || value.some(timeline => typeof timeline !== 'string' || !MASTODON_MARKER_TIMELINES.includes(timeline as MastodonMarkerTimeline))) {
			this.invalid(`timeline must contain only ${MASTODON_MARKER_TIMELINES.join(', ')}`);
		}
		return [...new Set(value)] as MastodonMarkerTimeline[];
	}

	private marker(row: MiMastodonUserState): MastodonMarker {
		const value = this.dictionary(row.value, 'marker state');
		if (typeof value.lastReadId !== 'string') throw new Error('Invalid Mastodon marker state');
		return {
			last_read_id: value.lastReadId,
			version: row.version,
			updated_at: row.updatedAt.toISOString(),
		};
	}

	private dictionary(value: unknown, name: string): Dictionary {
		if (value == null || typeof value !== 'object' || Array.isArray(value)) this.invalid(`${name} must be an object`);
		return value as Dictionary;
	}

	private invalid(message: string): never {
		throw new MastodonApiError(422, 'unprocessable_entity', message);
	}

	private conflict(): never {
		throw Object.assign(
			new MastodonApiError(409, 'conflict', 'The compatibility state has changed'),
			{ code: 'conflict' as const },
		);
	}
}
