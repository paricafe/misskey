/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { NoteDraftService } from '@/core/NoteDraftService.js';
import { NoteDraftEntityService } from '@/core/entities/NoteDraftEntityService.js';
import type { Packed } from '@/misc/json-schema.js';
import type { MiLocalUser } from '@/models/User.js';
import { MastodonApiError } from './errors.js';

@Injectable()
export class MastodonScheduledStatusService {
	constructor(
		private noteDraftService: NoteDraftService,
		private noteDraftEntityService: NoteDraftEntityService,
	) {}

	public async get(me: MiLocalUser, id: string): Promise<Packed<'NoteDraft'>> {
		const draft = await this.noteDraftService.get(me, id);
		if (draft == null || draft.userId !== me.id || !draft.isActuallyScheduled) {
			throw new MastodonApiError(404, 'not_found', 'Record not found');
		}
		return await this.noteDraftEntityService.pack(draft, me);
	}
}
