/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { bindThis } from '@/decorators.js';
import { NoteStreamingHidingService } from '../NoteStreamingHidingService.js';
import { DI } from '@/di-symbols.js';
import type { RolesRepository } from '@/models/_.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import type { JsonObject } from '@/misc/json-value.js';
import Channel, { type ChannelRequest } from '../channel.js';
import { REQUEST } from '@nestjs/core';

const pendingRoleAvailability = new WeakMap<RolesRepository, Map<string, Promise<boolean>>>();

@Injectable({ scope: Scope.TRANSIENT })
export class RoleTimelineChannel extends Channel {
	public readonly chName = 'roleTimeline';
	public static shouldShare = false;
	public static requireCredential = false as const;
	private roleId: string;

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		@Inject(DI.rolesRepository)
		private rolesRepository: RolesRepository,

		private noteEntityService: NoteEntityService,
		private noteStreamingHidingService: NoteStreamingHidingService,
	) {
		super(request);
	}

	@bindThis
	public async init(params: JsonObject) {
		if (typeof params.roleId !== 'string') return false;
		this.roleId = params.roleId;

		if (!await this.isAvailable()) return false;

		this.subscriber.on(`roleTimelineStream:${this.roleId}`, this.onEvent);
		return true;
	}

	@bindThis
	private isAvailable(): Promise<boolean> {
		const repo = this.rolesRepository;
		let byRole = pendingRoleAvailability.get(repo);
		if (byRole == null) {
			byRole = new Map();
			pendingRoleAvailability.set(repo, byRole);
		}

		const roleId = this.roleId;
		const existing = byRole.get(roleId);
		if (existing != null) return existing;

		const check = new Promise<boolean>((resolve, reject) => {
			queueMicrotask(() => {
				if (byRole.get(roleId) === check) {
					byRole.delete(roleId);
				}
				try {
					repo.exists({
						where: { id: roleId, isPublic: true, isExplorable: true },
					}).then(resolve, reject);
				} catch (error) {
					reject(error);
				}
			});
		});
		byRole.set(roleId, check);
		return check;
	}

	@bindThis
	private async onEvent(data: GlobalEvents['roleTimeline']['payload']) {
		if (!await this.isAvailable()) return;

		if (data.type === 'note') {
			let note = data.body;

			if (note.visibility !== 'public') return;
			if (note.user.requireSigninToViewContents && this.user == null) return;
			if (note.renote && note.renote.user.requireSigninToViewContents && this.user == null) return;
			if (note.reply && note.reply.user.requireSigninToViewContents && this.user == null) return;

			if (this.isNoteMutedOrBlocked(note)) return;

			const filtered = await this.noteStreamingHidingService.filter(note, this.user?.id ?? null);
			if (!filtered) return;
			note = filtered;

			this.send('note', await this.noteEntityService.withMyRenoteReaction(note, this.user?.id ?? null));
		} else {
			this.send(data.type, data.body);
		}
	}

	@bindThis
	public dispose() {
		this.subscriber.off(`roleTimelineStream:${this.roleId}`, this.onEvent);
	}
}
