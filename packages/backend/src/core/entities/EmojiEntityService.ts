/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { EmojisRepository } from '@/models/_.js';
import type { Packed } from '@/misc/json-schema.js';
import type { } from '@/models/Blocking.js';
import type { MiEmoji } from '@/models/Emoji.js';
import { bindThis } from '@/decorators.js';
import { In } from 'typeorm';
import type { Config } from '@/config.js';

@Injectable()
export class EmojiEntityService {
	constructor(
		@Inject(DI.emojisRepository)
		private emojisRepository: EmojisRepository,

		@Inject(DI.config)
		private config: Config,
	) {
	}

	private stripProxyIfOrigin(url: string): string {
		try {
			const u = new URL(url);
			let origin = u.origin;
			if (u.origin === new URL(this.config.mediaProxy).origin) {
				const innerUrl = u.searchParams.get('url');
				if (innerUrl) {
					origin = new URL(innerUrl).origin;
				}
			}
			if (origin === u.origin) {
				return url;
			}
		} catch (e) {
			return url;
		}

		return url;
	}

	@bindThis
	public packSimpleNoQuery(
		emoji: MiEmoji,
	): Packed<'EmojiSimple'> {
		return {
			aliases: emoji.aliases,
			name: emoji.name,
			category: emoji.category,
			// || emoji.originalUrl してるのは後方互換性のため（publicUrlはstringなので??はだめ）
			url: this.stripProxyIfOrigin(emoji.publicUrl || emoji.originalUrl),
			localOnly: emoji.localOnly ? true : undefined,
			isSensitive: emoji.isSensitive ? true : undefined,
			roleIdsThatCanBeUsedThisEmojiAsReaction: emoji.roleIdsThatCanBeUsedThisEmojiAsReaction.length > 0 ? emoji.roleIdsThatCanBeUsedThisEmojiAsReaction : undefined,
		};
	}

	@bindThis
	public async packSimple(
		src: MiEmoji['id'] | MiEmoji,
	): Promise<Packed<'EmojiSimple'>> {
		const emoji = typeof src === 'object' ? src : await this.emojisRepository.findOneByOrFail({ id: src });

		return this.packSimpleNoQuery(emoji);
	}

	@bindThis
	public async packSimpleMany(
		emojis: MiEmoji['id'][] | MiEmoji[],
	): Promise<Packed<'EmojiSimple'>[]> {
		if (emojis.length === 0) {
			return [];
		}
		
		if (typeof emojis[0] === 'string') {
			const res = await this.emojisRepository.findBy({ id: In(emojis as MiEmoji['id'][]) });
			return res.map(this.packSimpleNoQuery);
		}

		return (emojis as MiEmoji[]).map(this.packSimpleNoQuery);
	}

	@bindThis
	public packDetailedNoQuery(
		emoji: MiEmoji,
	): Packed<'EmojiDetailed'> {
		return {
			id: emoji.id,
			aliases: emoji.aliases,
			name: emoji.name,
			category: emoji.category,
			host: emoji.host,
			// || emoji.originalUrl してるのは後方互換性のため（publicUrlはstringなので??はだめ）
			url: this.stripProxyIfOrigin(emoji.publicUrl || emoji.originalUrl),
			license: emoji.license,
			isSensitive: emoji.isSensitive,
			localOnly: emoji.localOnly,
			roleIdsThatCanBeUsedThisEmojiAsReaction: emoji.roleIdsThatCanBeUsedThisEmojiAsReaction,
		};
	}

	@bindThis
	public async packDetailed(
		src: MiEmoji['id'] | MiEmoji,
	): Promise<Packed<'EmojiDetailed'>> {
		const emoji = typeof src === 'object' ? src : await this.emojisRepository.findOneByOrFail({ id: src });

		return this.packDetailedNoQuery(emoji);
	}

	@bindThis
	public async packDetailedMany(
		emojis: MiEmoji['id'][] | MiEmoji[],
	) : Promise<Packed<'EmojiDetailed'>[]> {
		if (emojis.length === 0) {
			return [];
		}
		
		if (typeof emojis[0] === 'string') {
			const res = await this.emojisRepository.findBy({ id: In(emojis as MiEmoji['id'][]) });
			return res.map(this.packDetailedNoQuery);
		}

		return (emojis as MiEmoji[]).map(this.packDetailedNoQuery);
	}
}

