/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiNote } from '@/models/Note.js';
import type { MiUser } from '@/models/User.js';

export function shouldCountRenote(
	target: Pick<MiNote, 'userId'>,
	renoter: Pick<MiUser, 'id' | 'isBot'>,
): boolean {
	return target.userId !== renoter.id && !renoter.isBot;
}
