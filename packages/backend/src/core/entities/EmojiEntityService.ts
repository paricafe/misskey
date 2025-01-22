/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { EmojisRepository, MiRole, RolesRepository } from '@/models/_.js';
import type { Packed } from '@/misc/json-schema.js';
import type { MiEmoji } from '@/models/Emoji.js';
import { bindThis } from '@/decorators.js';

@Injectable()
export class EmojiEntityService {
	constructor(
		@Inject(DI.emojisRepository)
		private emojisRepository: EmojisRepository,
		@Inject(DI.rolesRepository)
		private rolesRepository: RolesRepository,
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
		emojis: any[],
	): Promise<Packed<'EmojiDetailed'>[]> {
		return Promise.all(emojis.map(x => this.packDetailed(x)));
	}

	@bindThis
	public async packDetailedAdmin(
		src: MiEmoji['id'] | MiEmoji,
		hint?: {
			roles?: Map<MiRole['id'], MiRole>
		},
	): Promise<Packed<'EmojiDetailedAdmin'>> {
		const emoji = typeof src === 'object' ? src : await this.emojisRepository.findOneByOrFail({ id: src });

		const roles = Array.of<MiRole>();
		if (emoji.roleIdsThatCanBeUsedThisEmojiAsReaction.length > 0) {
			if (hint?.roles) {
				const hintRoles = hint.roles;
				roles.push(
					...emoji.roleIdsThatCanBeUsedThisEmojiAsReaction
						.filter(x => hintRoles.has(x))
						.map(x => hintRoles.get(x)!),
				);
			} else {
				roles.push(
					...await this.rolesRepository.findBy({ id: In(emoji.roleIdsThatCanBeUsedThisEmojiAsReaction) }),
				);
			}

			roles.sort((a, b) => {
				if (a.displayOrder !== b.displayOrder) {
					return b.displayOrder - a.displayOrder;
				}

				return a.id.localeCompare(b.id);
			});
		}

		return {
			id: emoji.id,
			updatedAt: emoji.updatedAt?.toISOString() ?? null,
			name: emoji.name,
			host: emoji.host,
			uri: emoji.uri,
			type: emoji.type,
			aliases: emoji.aliases,
			category: emoji.category,
			publicUrl: emoji.publicUrl,
			originalUrl: emoji.originalUrl,
			license: emoji.license,
			localOnly: emoji.localOnly,
			isSensitive: emoji.isSensitive,
			roleIdsThatCanBeUsedThisEmojiAsReaction: roles.map(it => ({ id: it.id, name: it.name })),
		};
	}

	@bindThis
	public async packDetailedAdminMany(
		emojis: MiEmoji['id'][] | MiEmoji[],
		hint?: {
			roles?: Map<MiRole['id'], MiRole>
		},
	): Promise<Packed<'EmojiDetailedAdmin'>[]> {
		// IDのみの要素をピックアップし、DBからレコードを取り出して他の値を補完する
		const emojiEntities = emojis.filter(x => typeof x === 'object') as MiEmoji[];
		const emojiIdOnlyList = emojis.filter(x => typeof x === 'string') as string[];
		if (emojiIdOnlyList.length > 0) {
			emojiEntities.push(...await this.emojisRepository.findBy({ id: In(emojiIdOnlyList) }));
		}

		// 特定ロール専用の絵文字である場合、そのロール情報をあらかじめまとめて取得しておく（pack側で都度取得も出来るが負荷が高いので）
		let hintRoles: Map<MiRole['id'], MiRole>;
		if (hint?.roles) {
			hintRoles = hint.roles;
		} else {
			const roles = Array.of<MiRole>();
			const roleIds = [...new Set(emojiEntities.flatMap(x => x.roleIdsThatCanBeUsedThisEmojiAsReaction))];
			if (roleIds.length > 0) {
				roles.push(...await this.rolesRepository.findBy({ id: In(roleIds) }));
			}

			hintRoles = new Map(roles.map(x => [x.id, x]));
		}

		return Promise.all(emojis.map(x => this.packDetailedAdmin(x, { roles: hintRoles })));
	}
}

