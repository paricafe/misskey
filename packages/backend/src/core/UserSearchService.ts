/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Brackets, SelectQueryBuilder } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { type FollowingsRepository, MiUser, type MutingsRepository, type UserProfilesRepository, type UsersRepository } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import { sqlLikeEscape } from '@/misc/sql-like-escape.js';
import type { Config } from '@/config.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { Packed } from '@/misc/json-schema.js';

function defaultActiveThreshold() {
	return new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
}

@Injectable()
export class UserSearchService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.mutingsRepository)
		private mutingsRepository: MutingsRepository,

		private userEntityService: UserEntityService,
	) {
	}

	@bindThis
	public async searchByUsernameAndHost(
		params: {
			username?: string | null,
			host?: string | null,
			activeThreshold?: Date,
		},
		opts?: {
			limit?: number,
			detail?: boolean,
		},
		me?: MiUser | null,
	): Promise<Packed<'User'>[]> {
		const queries = me ? this.buildSearchUserQueries(me, params) : this.buildSearchUserNoLoginQueries(params);

		let resultSet = new Set<MiUser['id']>();
		const limit = opts?.limit ?? 10;
		for (const query of queries) {
			const ids = await query
				.select('user.id')
				.limit(limit - resultSet.size)
				.orderBy('user.usernameLower', 'ASC')
				.getRawMany<{ user_id: MiUser['id'] }>()
				.then(res => res.map(x => x.user_id));

			resultSet = new Set([...resultSet, ...ids]);
			if (resultSet.size >= limit) {
				break;
			}
		}

		return this.userEntityService.packMany<'UserLite' | 'UserDetailed'>(
			[...resultSet].slice(0, limit),
			me,
			{ schema: opts?.detail ? 'UserDetailed' : 'UserLite' },
		);
	}

	@bindThis
	private buildSearchUserQueries(
		me: MiUser,
		params: {
			username?: string | null,
			host?: string | null,
			activeThreshold?: Date,
		},
	) {
		const activeThreshold = params.activeThreshold ?? defaultActiveThreshold();

		const followingUserQuery = this.followingsRepository.createQueryBuilder('following')
			.select('following.followeeId')
			.where('following.followerId = :followerId', { followerId: me.id });

		const activeFollowingUsersQuery = this.generateUserQueryBuilder(params)
			.andWhere(`user.id IN (${followingUserQuery.getQuery()})`)
			.andWhere('user.updatedAt > :activeThreshold', { activeThreshold });
		activeFollowingUsersQuery.setParameters(followingUserQuery.getParameters());

		const inactiveFollowingUsersQuery = this.generateUserQueryBuilder(params)
			.andWhere(`user.id IN (${followingUserQuery.getQuery()})`)
			.andWhere(new Brackets(qb => {
				qb
					.where('user.updatedAt IS NULL')
					.orWhere('user.updatedAt <= :activeThreshold', { activeThreshold });
			}));
		inactiveFollowingUsersQuery.setParameters(followingUserQuery.getParameters());

		const activeUserQuery = this.generateUserQueryBuilder(params)
			.andWhere(`user.id NOT IN (${followingUserQuery.getQuery()})`)
			.andWhere('user.updatedAt > :activeThreshold', { activeThreshold });
		activeUserQuery.setParameters(followingUserQuery.getParameters());

		const inactiveUserQuery = this.generateUserQueryBuilder(params)
			.andWhere(`user.id NOT IN (${followingUserQuery.getQuery()})`)
			.andWhere('user.updatedAt <= :activeThreshold', { activeThreshold });
		inactiveUserQuery.setParameters(followingUserQuery.getParameters());

		return [activeFollowingUsersQuery, inactiveFollowingUsersQuery, activeUserQuery, inactiveUserQuery];
	}

	@bindThis
	private buildSearchUserNoLoginQueries(params: {
		username?: string | null,
		host?: string | null,
		activeThreshold?: Date,
	}) {
		const activeThreshold = params.activeThreshold ?? defaultActiveThreshold();

		const activeUserQuery = this.generateUserQueryBuilder(params)
			.andWhere(new Brackets(qb => {
				qb
					.where('user.updatedAt IS NULL')
					.orWhere('user.updatedAt > :activeThreshold', { activeThreshold });
			}));

		const inactiveUserQuery = this.generateUserQueryBuilder(params)
			.andWhere('user.updatedAt <= :activeThreshold', { activeThreshold });

		return [activeUserQuery, inactiveUserQuery];
	}

	@bindThis
	private generateUserQueryBuilder(params: {
		username?: string | null,
		host?: string | null,
	}): SelectQueryBuilder<MiUser> {
		const userQuery = this.usersRepository.createQueryBuilder('user');

		if (params.username) {
			userQuery.andWhere('user.usernameLower LIKE :username', { username: sqlLikeEscape(params.username.toLowerCase()) + '%' });
		}

		if (params.host) {
			if (params.host === this.config.hostname || params.host === '.') {
				userQuery.andWhere('user.host IS NULL');
			} else {
				userQuery.andWhere('user.host LIKE :host', {
					host: sqlLikeEscape(params.host.toLowerCase()) + '%',
				});
			}
		}

		userQuery.andWhere('user.isSuspended = FALSE');

		return userQuery;
	}

	@bindThis
	public async search(query: string, meId: MiUser['id'] | null, options: Partial<{
		limit: number;
		offset: number;
		origin: 'local' | 'remote' | 'combined';
	}> = {}) {
		const activeThreshold = new Date(Date.now() - (1000 * 60 * 60 * 24 * 30));

		const isUsername = query.startsWith('@') && !query.includes(' ') && query.indexOf('@', 1) === -1;

		let users: MiUser[] = [];

		const mutingQuery = meId == null ? null : this.mutingsRepository.createQueryBuilder('muting')
			.select('muting.muteeId')
			.where('muting.muterId = :muterId', { muterId: meId });

		const nameQuery = this.usersRepository.createQueryBuilder('user')
			.where(new Brackets(qb => {
				qb.where('user.name &@ :query', { query });

				if (isUsername) {
					qb.orWhere('user.usernameLower LIKE :username', { username: sqlLikeEscape(query.replace('@', '').toLowerCase()) + '%' });
				} else if (this.userEntityService.validateLocalUsername(query)) {
					qb.orWhere('user.usernameLower LIKE :username', { username: '%' + sqlLikeEscape(query.toLowerCase()) + '%' });
				}
			}))
			.andWhere(new Brackets(qb => {
				qb
					.where('user.updatedAt IS NULL')
					.orWhere('user.updatedAt > :activeThreshold', { activeThreshold: activeThreshold });
			}))
			.andWhere('user.isSuspended = FALSE');

		if (mutingQuery) {
			nameQuery.andWhere(`user.id NOT IN (${mutingQuery.getQuery()})`);
			nameQuery.setParameters(mutingQuery.getParameters());
		}

		if (options.origin === 'local') {
			nameQuery.andWhere('user.host IS NULL');
		} else if (options.origin === 'remote') {
			nameQuery.andWhere('user.host IS NOT NULL');
		}

		users = await nameQuery
			.orderBy('user.updatedAt', 'DESC', 'NULLS LAST')
			.limit(options.limit)
			.offset(options.offset)
			.getMany();

		if (users.length < (options.limit ?? 30)) {
			const profQuery = this.userProfilesRepository.createQueryBuilder('prof')
				.select('prof.userId')
				.where('prof.description &@ :query', { query });

			if (mutingQuery) {
				profQuery.andWhere(`prof.userId NOT IN (${mutingQuery.getQuery()})`);
				profQuery.setParameters(mutingQuery.getParameters());
			}

			if (options.origin === 'local') {
				profQuery.andWhere('prof.userHost IS NULL');
			} else if (options.origin === 'remote') {
				profQuery.andWhere('prof.userHost IS NOT NULL');
			}

			const userQuery = this.usersRepository.createQueryBuilder('user')
				.where(`user.id IN (${ profQuery.getQuery() })`)
				.andWhere(new Brackets(qb => {
					qb
						.where('user.updatedAt IS NULL')
						.orWhere('user.updatedAt > :activeThreshold', { activeThreshold: activeThreshold });
				}))
				.andWhere('user.isSuspended = FALSE')
				.setParameters(profQuery.getParameters());

			users = users.concat(await userQuery
				.orderBy('user.updatedAt', 'DESC', 'NULLS LAST')
				.limit(options.limit)
				.offset(options.offset)
				.getMany(),
			);
		}

		return users;
	}
}
