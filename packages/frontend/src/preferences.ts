/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createVisibilityAwareInterval } from '@@/js/interval.js';
import type { StorageProvider } from '@/preferences/manager.js';
import { cloudBackup } from '@/preferences/utility.js';
import { miLocalStorage } from '@/local-storage.js';
import { isSameScope, PreferencesManager } from '@/preferences/manager.js';
import { store } from '@/store.js';
import { $i } from '@/i.js';
import { TypedBroadcastChannel as BroadcastChannel } from '@/utility/typed-broadcast-channel.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { TAB_ID } from '@/tab-id.js';

const syncGroup = 'default';

const io: StorageProvider = {
	load: () => {
		const savedProfileRaw = miLocalStorage.getItem('preferences');
		if (savedProfileRaw == null) {
			return null;
		} else {
			return JSON.parse(savedProfileRaw);
		}
	},

	save: (ctx) => {
		miLocalStorage.setItem('preferences', JSON.stringify(ctx.profile));
	},

	cloudGet: async (ctx) => {
		try {
			const cloudData = await misskeyApi('i/registry/get', {
				scope: ['client', 'preferences', 'sync'],
				key: syncGroup + ':' + ctx.key,
			}) as [any, any][];
			const target = cloudData.find(([scope]) => isSameScope(scope, ctx.scope));
			if (target == null) return null;
			return {
				value: target[1],
			};
		} catch (err: any) {
			if (err.code === 'NO_SUCH_KEY') {
				return null;
			} else {
				throw err;
			}
		}
	},

	cloudSet: async (ctx) => {
		let cloudData: [any, any][] = [];
		try {
			cloudData = await misskeyApi('i/registry/get', {
				scope: ['client', 'preferences', 'sync'],
				key: syncGroup + ':' + ctx.key,
			}) as [any, any][];
		} catch (err: any) {
			if (err.code === 'NO_SUCH_KEY') {
				cloudData = [];
			} else {
				throw err;
			}
		}

		const i = cloudData.findIndex(([scope]) => isSameScope(scope, ctx.scope));

		if (i === -1) {
			cloudData.push([ctx.scope, ctx.value]);
		} else {
			cloudData[i] = [ctx.scope, ctx.value];
		}

		await misskeyApi('i/registry/set', {
			scope: ['client', 'preferences', 'sync'],
			key: syncGroup + ':' + ctx.key,
			value: cloudData,
		});
	},

	cloudGetBulk: async (ctx) => {
		const fetchings = ctx.needs.map(need => io.cloudGet(need).then(res => [need.key, res] as const));
		const cloudDatas = await Promise.all(fetchings);

		const res = {} as Partial<Record<string, any>>;
		for (const cloudData of cloudDatas) {
			if (cloudData[1] != null) {
				res[cloudData[0]] = cloudData[1].value;
			}
		}

		return res;
	},
};

export const prefer = new PreferencesManager(io, $i);

let latestPreferencesUpdate: {
	tabId: string;
	timestamp: number;
} | null = null;

const preferencesChannel = new BroadcastChannel<{
	type: 'preferencesUpdate';
	tabId: string;
	timestamp: number;
}>('preferences');

prefer.on('committed', () => {
	latestPreferencesUpdate = {
		tabId: TAB_ID,
		timestamp: Date.now(),
	};
	preferencesChannel.postMessage({
		type: 'preferencesUpdate',
		tabId: TAB_ID,
		timestamp: latestPreferencesUpdate.timestamp,
	});
});

preferencesChannel.addEventListener('message', (ev) => {
	const msg = ev.data;
	if (msg.type === 'preferencesUpdate') {
		if (msg.tabId === TAB_ID) return;
		if (latestPreferencesUpdate != null) {
			if (msg.timestamp <= latestPreferencesUpdate.timestamp) return;
		}
		prefer.reloadProfile();
		if (_DEV_) console.log('prefer:received update from other tab');
		latestPreferencesUpdate = {
			tabId: msg.tabId,
			timestamp: msg.timestamp,
		};
	}
});

let latestBackupAt = 0;

createVisibilityAwareInterval(() => {
	if ($i == null) return;
	if (!store.s.enablePreferencesAutoCloudBackup) return;
	if (prefer.profile.modifiedAt <= latestBackupAt) return;

	cloudBackup().then(() => {
		latestBackupAt = Date.now();
	});
}, 1000 * 60 * 3);

if (_DEV_) {
	(window as any).prefer = prefer;
	(window as any).cloudBackup = cloudBackup;
}
