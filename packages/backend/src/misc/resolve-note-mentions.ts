/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type * as mfm from 'mfm-js';
import type { MiUser } from '@/models/User.js';
import { extractMentions } from '@/misc/extract-mentions.js';

export async function resolveNoteMentions(
	host: MiUser['host'],
	tokens: mfm.MfmNode[],
	resolveUser: (username: string, host: string | null) => Promise<MiUser>,
): Promise<MiUser[]> {
	const mentions = [...new Map(extractMentions(tokens).map(mention => [mention.acct.toLowerCase(), mention])).values()];
	const users = await Promise.all(mentions.map(mention => resolveUser(mention.username, mention.host ?? host).catch(() => null)));
	return [...new Map(users.filter(user => user != null).map(user => [user.id, user])).values()];
}
