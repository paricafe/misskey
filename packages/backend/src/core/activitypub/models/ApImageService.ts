/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository, MiMeta } from '@/models/_.js';
import type { MiRemoteUser } from '@/models/User.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import { truncate } from '@/misc/truncate.js';
import { DB_MAX_IMAGE_COMMENT_LENGTH } from '@/const.js';
import { DriveService } from '@/core/DriveService.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { checkHttps } from '@/misc/check-https.js';
import { ApResolverService } from '../ApResolverService.js';
import { ApLoggerService } from '../ApLoggerService.js';
import { isDocument, type IObject } from '../type.js';

@Injectable()
export class ApImageService {
	private logger: Logger;

	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private apResolverService: ApResolverService,
		private driveService: DriveService,
		private apLoggerService: ApLoggerService,
	) {
		this.logger = this.apLoggerService.logger;
	}

	@bindThis
	public async createImage(actor: MiRemoteUser, value: string | IObject): Promise<MiDriveFile | null> {
		if (actor.isSuspended) {
			throw new Error('actor has been suspended');
		}

		const image = await (await this.apResolverService.createResolver()).resolve(value);

		if (!isDocument(image)) return null;

		if (image.url == null) {
			return null;
		}

		if (typeof image.url !== 'string') {
			return null;
		}

		if (!checkHttps(image.url)) {
			return null;
		}

		this.logger.info(`Creating the Image: ${image.url}`);

		const shouldBeCached = this.meta.cacheRemoteFiles && (this.meta.cacheRemoteSensitiveFiles || !image.sensitive);

		const file = await this.driveService.uploadFromUrl({
			url: image.url,
			user: actor,
			uri: image.url,
			sensitive: image.sensitive,
			isLink: !shouldBeCached,
			comment: truncate(image.name ?? undefined, DB_MAX_IMAGE_COMMENT_LENGTH),
		});
		if (!file.isLink || file.url === image.url) return file;

		await this.driveFilesRepository.update({ id: file.id }, { url: image.url, uri: image.url });
		return await this.driveFilesRepository.findOneByOrFail({ id: file.id });
	}

	@bindThis
	public async resolveImage(actor: MiRemoteUser, value: string | IObject): Promise<MiDriveFile | null> {
		return await this.createImage(actor, value);
	}
}
