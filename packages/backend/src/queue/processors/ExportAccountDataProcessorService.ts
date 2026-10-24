/*
 * SPDX-FileCopyrightText: marie and other Sharkey contributors
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { In, IsNull, MoreThan, Not } from 'typeorm';
import type { FindOptionsOrder, FindOptionsRelations, FindOptionsWhere, Repository } from 'typeorm';
import { format as dateFormat } from 'date-fns';
import mime from 'mime-types';
import { DI } from '@/di-symbols.js';
import type { AntennasRepository, BlockingsRepository, DriveFilesRepository, FollowingsRepository, MiNote, MiNoteFavorite, MiPoll, MiUser, MutingsRepository, NoteFavoritesRepository, NotesRepository, PollsRepository, SigninsRepository, UserListMembershipsRepository, UserListsRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import type Logger from '@/logger.js';
import { DriveService } from '@/core/DriveService.js';
import { IdService } from '@/core/IdService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { createTemp, createTempDir } from '@/misc/create-temp.js';
import { ZipArchive } from '@/misc/zip.js';
import { bindThis } from '@/decorators.js';
import { Packed } from '@/misc/json-schema.js';
import { UtilityService } from '@/core/UtilityService.js';
import { DownloadService } from '@/core/DownloadService.js';
import { EmailService } from '@/core/EmailService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';

@Injectable()
export class ExportAccountDataProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.noteFavoritesRepository)
		private noteFavoritesRepository: NoteFavoritesRepository,

		@Inject(DI.pollsRepository)
		private pollsRepository: PollsRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.mutingsRepository)
		private mutingsRepository: MutingsRepository,

		@Inject(DI.blockingsRepository)
		private blockingsRepository: BlockingsRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.antennasRepository)
		private antennasRepository: AntennasRepository,

		@Inject(DI.userListsRepository)
		private userListsRepository: UserListsRepository,

		@Inject(DI.userListMembershipsRepository)
		private userListMembershipsRepository: UserListMembershipsRepository,

		@Inject(DI.signinsRepository)
		private signinsRepository: SigninsRepository,

		private utilityService: UtilityService,
		private driveService: DriveService,
		private idService: IdService,
		private driveFileEntityService: DriveFileEntityService,
		private downloadService: DownloadService,
		private emailService: EmailService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('export-account-data');
	}

	@bindThis
	public async process(job: Bull.Job): Promise<void> {
		this.logger.info('Exporting Account Data...');

		const user = await this.usersRepository.findOneBy({ id: job.data.user.id });
		if (user == null) {
			return;
		}

		const profile = await this.userProfilesRepository.findOneBy({ userId: job.data.user.id });
		if (profile == null) {
			return;
		}

		const [path, cleanup] = await createTempDir();

		this.logger.info(`Temp dir is ${path}`);

		const pushAccount = async (push: (value: unknown) => Promise<void>, userId: MiUser['id'], skip?: (u: MiUser) => boolean) => {
			const u = await this.usersRepository.findOneBy({ id: userId });
			if (u == null || skip?.(u)) return;
			await push(this.utilityService.getFullApAccount(u.username, u.host));
		};

		await this.writeJsonExport(path, 'user', async push => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { host, uri, sharedInbox, followersUri, lastFetchedAt, inbox, token, ...userTrimmed } = user;
			await push(userTrimmed);
		});

		await this.writeJsonExport(path, 'profile', async push => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { emailVerifyCode, twoFactorBackupSecret, twoFactorSecret, password, twoFactorTempSecret, userHost, moderationNote, ...profileTrimmed } = profile;
			await push(profileTrimmed);
		});

		await this.writeJsonExport(path, 'ips', async push => {
			for (const signin of await this.signinsRepository.findBy({ userId: user.id })) {
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				const { userId, id, user, ...signinTrimmed } = signin;
				await push(signinTrimmed);
			}
		});

		await this.writeJsonExport(path, 'notes', async push => {
			for await (const note of this.paginate(this.notesRepository, { userId: user.id })) {
				const poll = note.hasPoll ? await this.pollsRepository.findOneByOrFail({ noteId: note.id }) : null;
				const files = await this.driveFileEntityService.packManyByIds(note.fileIds);
				await push(this.noteSerialize(note, poll, files));
			}
		});

		await this.writeJsonExport(path, 'followings', async push => {
			const mutings = await this.mutingsRepository.findBy({ muterId: user.id });
			const where = mutings.length > 0 ? { followerId: user.id, followeeId: Not(In(mutings.map(x => x.muteeId))) } : { followerId: user.id };
			for await (const following of this.paginate(this.followingsRepository, where)) {
				await pushAccount(push, following.followeeId, u => u.updatedAt != null && Date.now() - u.updatedAt.getTime() > 1000 * 60 * 60 * 24 * 90);
			}
		});

		await this.writeJsonExport(path, 'followers', async push => {
			for await (const following of this.paginate(this.followingsRepository, { followeeId: user.id })) {
				await pushAccount(push, following.followerId);
			}
		});

		fs.mkdirSync(`${path}/files`);

		await this.writeJsonExport(path, 'drive', async push => {
			for (const file of await this.driveFilesRepository.findBy({ userId: user.id })) {
				const fileName = file.name + '.' + mime.extension(file.type);
				const filePath = path + '/files/' + fileName;
				try {
					await this.downloadService.downloadUrl(file.url, filePath);
				} catch (e) {
					this.logger.error(e instanceof Error ? e : new Error(e as string));
					fs.rmSync(filePath, { force: true });
				}
				await push({ fileName, file });
			}
		});

		await this.writeJsonExport(path, 'mutings', async push => {
			for await (const muting of this.paginate(this.mutingsRepository, { muterId: user.id, expiresAt: IsNull() })) {
				await pushAccount(push, muting.muteeId);
			}
		});

		await this.writeJsonExport(path, 'blockings', async push => {
			for await (const blocking of this.paginate(this.blockingsRepository, { blockerId: user.id })) {
				await pushAccount(push, blocking.blockeeId);
			}
		});

		await this.writeJsonExport(path, 'favorites', async push => {
			const favorites = this.paginate(this.noteFavoritesRepository, { userId: user.id }, { note: { user: true } }) as AsyncGenerator<MiNoteFavorite & { note: MiNote & { user: MiUser } }>;
			for await (const favorite of favorites) {
				const poll = favorite.note.hasPoll ? await this.pollsRepository.findOneByOrFail({ noteId: favorite.note.id }) : null;
				await push(this.favoriteSerialize(favorite, poll));
			}
		});

		await this.writeJsonExport(path, 'antennas', async push => {
			for (const antenna of await this.antennasRepository.findBy({ userId: user.id })) {
				let users: MiUser[] | undefined;
				if (antenna.userListId !== null) {
					const memberships = await this.userListMembershipsRepository.findBy({ userListId: antenna.userListId });
					users = await this.usersRepository.findBy({
						id: In(memberships.map(j => j.userId)),
					});
				}

				await push({
					name: antenna.name,
					src: antenna.src,
					keywords: antenna.keywords,
					excludeKeywords: antenna.excludeKeywords,
					users: antenna.users,
					userListAccts: users ? users.map(u => this.utilityService.getFullApAccount(u.username, u.host)) : null,
					caseSensitive: antenna.caseSensitive,
					localOnly: antenna.localOnly,
					withReplies: antenna.withReplies,
					withFile: antenna.withFile,
				});
			}
		});

		const listLines: string[] = [];
		for (const list of await this.userListsRepository.findBy({ userId: user.id })) {
			const memberships = await this.userListMembershipsRepository.findBy({ userListId: list.id });
			const users = await this.usersRepository.findBy({
				id: In(memberships.map(j => j.userId)),
			});

			for (const u of users) {
				listLines.push(`${list.name},${this.utilityService.getFullApAccount(u.username, u.host)}\n`);
			}
		}
		fs.writeFileSync(path + '/lists.csv', listLines.join(''), 'utf-8');

		// Create archive
		const [archivePath, archiveCleanup] = await createTemp();
		try {
			const archive = await ZipArchive.create(archivePath);
			try {
				for (const entry of fs.readdirSync(path, { recursive: true, withFileTypes: true })) {
					if (!entry.isFile()) continue;
					const entryPath = nodePath.join(entry.parentPath, entry.name);
					await archive.addFile(nodePath.relative(path, entryPath).split(nodePath.sep).join('/'), entryPath);
				}
			} catch (e) {
				await archive.abort();
				throw e;
			}
			await archive.close();
			this.logger.succ(`Exported to: ${archivePath}`);

			const fileName = 'data-request-' + dateFormat(new Date(), 'yyyy-MM-dd-HH-mm-ss') + '.zip';
			// The archive bundles every drive file and is a zip, so role upload policies would reject it for most users.
			const driveFile = await this.driveService.addFile({ user, path: archivePath, name: fileName, force: true, skipPolicyCheck: true });

			this.logger.succ(`Exported to: ${driveFile.id}`);
			if (profile.email && profile.emailVerified) {
				this.emailService.sendEmail(profile.email,
					'Your data archive is ready',
					`Click the following link to download the archive: ${driveFile.url}<br/>It is also available in your drive.`,
					`Click the following link to download the archive: ${driveFile.url}\r\n\r\nIt is also available in your drive.`,
				);
			}
		} finally {
			cleanup();
			archiveCleanup();
		}
	}

	private async writeJsonExport(dir: string, key: string, writeItems: (push: (value: unknown) => Promise<void>) => Promise<void>): Promise<void> {
		const stream = fs.createWriteStream(`${dir}/${key}.json`);
		const write = (text: string) => new Promise<void>((resolve, reject) => {
			stream.write(text, err => err ? reject(err) : resolve());
		});
		let first = true;
		try {
			await write(`{"metaVersion":1,"host":"${this.config.host}","exportedAt":"${new Date().toString()}","${key}":[`);
			await writeItems(async value => {
				await write((first ? '' : ',\n') + JSON.stringify(value));
				first = false;
			});
			await write(']}');
		} finally {
			await new Promise<void>(resolve => stream.end(resolve));
		}
	}

	private async *paginate<T extends { id: string }>(repository: Repository<T>, where: FindOptionsWhere<T>, relations?: FindOptionsRelations<T>): AsyncGenerator<T> {
		let cursor: string | null = null;
		while (true) {
			const page: T[] = await repository.find({
				where: cursor ? { ...where, id: MoreThan(cursor) } : where,
				take: 100,
				order: { id: 1 } as FindOptionsOrder<T>,
				relations,
			});
			if (page.length === 0) return;
			yield* page;
			cursor = page.at(-1)!.id;
		}
	}

	private noteSerialize(note: MiNote, poll: MiPoll | null = null, files: Packed<'DriveFile'>[]): Record<string, unknown> {
		return {
			id: note.id,
			text: note.text,
			createdAt: this.idService.parse(note.id).date.toISOString(),
			fileIds: note.fileIds,
			files: files,
			replyId: note.replyId,
			renoteId: note.renoteId,
			poll: poll,
			cw: note.cw,
			visibility: note.visibility,
			visibleUserIds: note.visibleUserIds,
			localOnly: note.localOnly,
			reactionAcceptance: note.reactionAcceptance,
		};
	}

	private favoriteSerialize(favorite: MiNoteFavorite & { note: MiNote & { user: MiUser } }, poll: MiPoll | null = null): Record<string, unknown> {
		return {
			id: favorite.id,
			createdAt: this.idService.parse(favorite.id).date.toISOString(),
			note: {
				id: favorite.note.id,
				text: favorite.note.text,
				createdAt: this.idService.parse(favorite.note.id).date.toISOString(),
				fileIds: favorite.note.fileIds,
				replyId: favorite.note.replyId,
				renoteId: favorite.note.renoteId,
				poll: poll,
				cw: favorite.note.cw,
				visibility: favorite.note.visibility,
				visibleUserIds: favorite.note.visibleUserIds,
				localOnly: favorite.note.localOnly,
				reactionAcceptance: favorite.note.reactionAcceptance,
				uri: favorite.note.uri,
				url: favorite.note.url,
				user: {
					id: favorite.note.user.id,
					name: favorite.note.user.name,
					username: favorite.note.user.username,
					host: favorite.note.user.host,
					uri: favorite.note.user.uri,
				},
			},
		};
	}
}
