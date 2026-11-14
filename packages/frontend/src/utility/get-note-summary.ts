/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Misskey from 'misskey-js';
import { i18n } from '@/i18n.js';

export const getNoteSummary = (note?: Misskey.entities.Note | Misskey.entities.NoteDraft | null, opts?: {
	showFiles?: boolean;
	showPoll?: boolean;
	showReply?: boolean;
	showRenote?: boolean;
}): string => {
	const _opts = Object.assign({
		showFiles: true,
		showPoll: true,
		showReply: true,
		showRenote: true,
	}, opts);

	if (note == null) {
		return '';
	}

	if ('deletedAt' in note && note.deletedAt) {
		return `(${i18n.ts.deletedNote})`;
	}

	if ('isHidden' in note && note.isHidden) {
		return `(${i18n.ts.invisibleNote})`;
	}

	let summary = '';

	if (note.cw != null) {
		summary += note.cw;
	} else {
		summary += note.text ? note.text : '';
	}

	if (_opts.showFiles && (note.files || []).length !== 0) {
		summary += ` (${i18n.tsx.withNFiles({ n: note.files!.length })})`;
	}

	if (_opts.showPoll && note.poll) {
		summary += ` (${i18n.ts.poll})`;
	}

	if (_opts.showReply && note.replyId) {
		if (note.reply) {
			summary += `\n\nRE: ${getNoteSummary(note.reply)}`;
		} else {
			summary += '\n\nRE: ...';
		}
	}

	if (_opts.showRenote && note.renoteId) {
		if (note.renote) {
			summary += `\n\nRN: ${getNoteSummary(note.renote)}`;
		} else {
			summary += '\n\nRN: ...';
		}
	}

	return summary.trim();
};
