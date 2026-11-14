/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { markRaw } from 'vue';
import * as Misskey from 'misskey-js';
import { prefersReducedMotion } from '@@/js/config.js';
import { hemisphere } from '@@/js/intl-const.js';
import type { DeviceKind } from '@/utility/device-kind.js';
import type { TIPS } from '@/tips.js';
import { Pizzax } from '@/lib/pizzax.js';
import { DEFAULT_DEVICE_KIND } from '@/utility/device-kind.js';

export const store = markRaw(new Pizzax('base', {
	accountSetupWizard: {
		where: 'account',
		default: 0,
	},
	tips: {
		where: 'device',
		default: {} as Partial<Record<typeof TIPS[number], boolean>>,
	},
	memo: {
		where: 'account',
		default: null as string | null,
	},
	reactionAcceptance: {
		where: 'account',
		default: 'nonSensitiveOnly' as 'likeOnly' | 'likeOnlyForRemote' | 'nonSensitiveOnly' | 'nonSensitiveOnlyForLocalLikeOnlyForRemote' | null,
	},
	like: {
		where: 'account',
		default: null as string | null,
	},
	mutedAds: {
		where: 'account',
		default: [] as string[],
	},
	visibility: {
		where: 'deviceAccount',
		default: 'public' as (typeof Misskey.noteVisibilities)[number],
	},
	localOnly: {
		where: 'deviceAccount',
		default: false,
	},
	showPreview: {
		where: 'device',
		default: false,
	},
	tl: {
		where: 'deviceAccount',
		default: {
			src: 'home' as 'home' | 'local' | 'social' | 'global' | `list:${string}`,
			userList: null as Misskey.entities.UserList | null,
			filter: {
				withReplies: true,
				withRenotes: true,
				withSensitive: true,
				onlyFiles: false,
			},
		},
	},
	darkMode: {
		where: 'device',
		default: false,
	},
	realtimeMode: {
		where: 'device',
		default: true,
	},
	recentlyUsedEmojis: {
		where: 'device',
		default: [] as string[],
	},
	recentlyUsedUsers: {
		where: 'device',
		default: [] as string[],
	},
	menuDisplay: {
		where: 'device',
		default: 'sideFull' as 'sideFull' | 'sideIcon',
	},
	postFormWithHashtags: {
		where: 'device',
		default: false,
	},
	postFormHashtags: {
		where: 'device',
		default: '',
	},
	additionalUnicodeEmojiIndexes: {
		where: 'device',
		default: {} as Record<string, Record<string, string[]>>,
	},
	pluginTokens: {
		where: 'deviceAccount',
		default: {} as Record<string, string>,
	},
	accountTokens: {
		where: 'device',
		default: {} as Record<string, string>,
	},
	accountInfos: {
		where: 'device',
		default: {} as Record<string, Misskey.entities.MeDetailed>,
	},

	enablePreferencesAutoCloudBackup: {
		where: 'device',
		default: false,
	},
	showPreferencesAutoCloudBackupSuggestion: {
		where: 'device',
		default: true,
	},
	showStoragePersistenceSuggestion: {
		where: 'device',
		default: true,
	},
}));

const PREFIX = 'miux:' as const;

interface Watcher {
	key: string;
	callback: (value: unknown) => void;
}
