/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { AbuseReportService } from '@/core/AbuseReportService.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import type { MiLocalUser } from '@/models/User.js';
import { GetterService } from '@/server/api/GetterService.js';
import { MastodonApiError } from './errors.js';

export interface MastodonReportInput {
	accountId: string;
	comment: string;
	category: 'spam' | 'violation' | 'other';
	statusIds: string[];
	ruleIds: string[];
	collectionIds: string[];
	forwardToDomains: string[];
	forward: boolean;
}

type MastodonReportCreateInput = Omit<MastodonReportInput, 'comment'> & { comment?: string };

@Injectable()
export class MastodonReportService {
	constructor(
		private getterService: GetterService,
		private roleService: RoleService,
		private abuseReportService: AbuseReportService,
		private userEntityService: UserEntityService,
		private idService: IdService,
	) {}

	public async create(reporter: MiLocalUser, rawInput: MastodonReportCreateInput) {
		if (rawInput.accountId === '') {
			throw new MastodonApiError(400, 'invalid_request', 'account_id is required');
		}
		const targetUser = await this.getterService.getUser(rawInput.accountId).catch(error => {
			if (error instanceof IdentifiableError && error.id === '15348ddd-432d-49c2-8a5a-8069753becff') {
				throw new MastodonApiError(404, 'not_found', 'Record not found');
			}
			throw error;
		});
		if (targetUser.id === reporter.id) {
			throw new MastodonApiError(422, 'unprocessable_entity', 'Cannot report yourself');
		}
		if (await this.roleService.isAdministrator(targetUser)) {
			throw new MastodonApiError(422, 'unprocessable_entity', 'Cannot report an administrator');
		}

		const input: MastodonReportInput = {
			...rawInput,
			comment: rawInput.comment ?? '',
		};
		const reports = await this.abuseReportService.report([{
			targetUserId: targetUser.id,
			targetUserHost: targetUser.host,
			reporterId: reporter.id,
			reporterHost: null,
			comment: this.persistedComment(input),
		}]);
		const report = reports[0];
		if (report == null) throw new MastodonApiError(500, 'server_error', 'The report could not be created');

		return {
			report,
			createdAt: this.idService.parse(report.id).date.toISOString(),
			targetUser: await this.userEntityService.pack(targetUser, reporter, { schema: 'UserDetailed' }),
			input,
		};
	}

	private persistedComment(input: MastodonReportInput): string {
		const formatList = (values: readonly string[]) => {
			if (values.length === 0) return '(none)';
			const shown = values.slice(0, 8).map(value => this.truncateUtf16(value.replace(/\s+/gu, ' ').trim(), 40));
			return `${shown.join(', ')}${values.length > shown.length ? ` … (+${values.length - shown.length} more)` : ''}`;
		};
		const context = this.truncateUtf16([
			'',
			'',
			'--- Mastodon API report context ---',
			`Category: ${input.category}`,
			`Status IDs: ${formatList(input.statusIds)}`,
			`Rule IDs: ${formatList(input.ruleIds)}`,
			`Collection IDs: ${formatList(input.collectionIds)}`,
			`Forward requested: ${input.forward ? 'yes' : 'no'}`,
			`Forward-to domains: ${formatList(input.forwardToDomains)}`,
		].join('\n'), 2048);
		return this.truncateUtf16(input.comment, 2048 - context.length) + context;
	}

	private truncateUtf16(value: string, maximumLength: number): string {
		let truncated = value.slice(0, Math.max(0, maximumLength));
		const last = truncated.charCodeAt(truncated.length - 1);
		if (last >= 0xD800 && last <= 0xDBFF) truncated = truncated.slice(0, -1);
		return truncated;
	}
}
