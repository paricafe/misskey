/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiUserProfile } from '@/models/UserProfile.js';

export function shouldRequireFollowApprovalByAccountAge(
	profile: Pick<MiUserProfile, 'followApprovalLocalSeconds' | 'followApprovalRemoteSeconds'>,
	isRemote: boolean,
	createdAt: Date,
	now = Date.now(),
): boolean {
	const seconds = (isRemote ? profile.followApprovalRemoteSeconds : profile.followApprovalLocalSeconds) ?? 0;
	return seconds > 0 && now - createdAt.getTime() < seconds * 1000;
}
