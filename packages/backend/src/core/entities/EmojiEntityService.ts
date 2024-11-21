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

@Injectable()
export class EmojiEntityService {
	constructor(
		@Inject(DI.emojisRepository)
		private emojisRepository: EmojisRepository,
	) {
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
			url: emoji.publicUrl || emoji.originalUrl,
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
			url: emoji.publicUrl || emoji.originalUrl,
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

