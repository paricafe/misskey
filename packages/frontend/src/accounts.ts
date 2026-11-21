/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineAsyncComponent, ref } from 'vue';
import * as Misskey from 'misskey-js';
import { apiUrl, host } from '@@/js/config.js';
import { ACCOUNT_DEVICE_STATE_KEY, readStoredAccounts } from '@@/js/stored-accounts.js';
import { withAccountLock } from '@/utility/account-storage.js';
import { getAccountFromId } from '@/utility/get-account-from-id.js';
import { get, del, usesAccountFallback } from '@/utility/idb-proxy.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import type { MenuItem } from '@/types/menu.js';
import { showSuspendedDialog } from '@/utility/show-suspended-dialog.js';
import { i18n } from '@/i18n.js';
import { miLocalStorage } from '@/local-storage.js';
import { waiting, popup, popupMenu, success, alert } from '@/os.js';
import { unisonReload, reloadChannel } from '@/utility/unison-reload.js';
import { prefer } from '@/preferences.js';
import { store } from '@/store.js';
import { $i } from '@/i.js';

type AccountWithToken = Misskey.entities.MeDetailed & { token: string };

export async function initializeAccountStorage() {
	await store.ready;
	await withAccountLock(async () => {
		const state = await get(ACCOUNT_DEVICE_STATE_KEY);
		if (state?.accountTokens == null) {
			const accounts = await readStoredAccounts(get, host);
			await store.updateDevice(current => current.accountTokens == null ? {
				accountTokens: Object.fromEntries(accounts.map(account => [host + '/' + account.id, account.token])),
			} : {});
		}
		if (state?.accountHost !== host) await store.set('accountHost', host);
		await del('accounts');
	}, true);
}

export async function getAccounts(): Promise<{
	host: string;
	id: Misskey.entities.User['id'];
	username: Misskey.entities.User['username'];
	user?: Misskey.entities.MeDetailed | null;
	token: string | null;
}[]> {
	const state = await withAccountLock(() => get(ACCOUNT_DEVICE_STATE_KEY));
	const tokens = state?.accountTokens ?? {};
	const accountInfos = state?.accountInfos ?? {};
	const accounts = prefer.s.accounts;
	return accounts.map(([host, user]) => ({
		host,
		id: user.id,
		username: user.username,
		user: accountInfos[host + '/' + user.id],
		token: tokens[host + '/' + user.id] ?? null,
	}));
}

async function addAccount(host: string, user: Misskey.entities.MeDetailed, token: string, activate = false) {
	await withAccountLock(async () => {
		const key = host + '/' + user.id;
		const previous = miLocalStorage.getItem('account');
		const accounts = prefer.s.accounts;
		const known = accounts.some(x => x[0] === host && x[1].id === user.id);
		try {
			if (activate) miLocalStorage.setItemAsJson('account', { ...user, token });
			if (!known) prefer.commit('accounts', [...accounts, [host, { id: user.id, username: user.username }]]);
			await store.updateDevice(current => {
				const removed = { ...current.removedAccountTokens };
				delete removed[key];
				return {
					accountTokens: { ...current.accountTokens, [key]: token },
					accountInfos: { ...current.accountInfos, [key]: user },
					...(usesAccountFallback() ? { removedAccountTokens: removed } : {}),
				};
			});
		} catch (error) {
			if (activate && miLocalStorage.getItemAsJson('account')?.token === token) {
				if (previous == null) miLocalStorage.removeItem('account');
				else miLocalStorage.setItem('account', previous);
			}
			if (!known) prefer.commit('accounts', accounts);
			throw error;
		}
	});
}

async function forgetAccount(host: string, id: string, expectedToken?: string) {
	let removed = false;
	const key = host + '/' + id;
	await store.updateDevice(current => {
		const token = current.accountTokens?.[key];
		if (expectedToken != null && token != null && token !== expectedToken) return {};
		const accountTokens = { ...current.accountTokens };
		const accountInfos = { ...current.accountInfos };
		delete accountTokens[key];
		delete accountInfos[key];
		removed = true;
		return {
			accountTokens,
			accountInfos,
			...(usesAccountFallback() ? { removedAccountTokens: { ...current.removedAccountTokens, [key]: expectedToken ?? null } } : {}),
		};
	});
	if (removed) {
		prefer.commit('accounts', prefer.s.accounts.filter(x => x[0] !== host || x[1].id !== id));
	}
}

export async function removeAccount(host: string, id: string) {
	await withAccountLock(() => forgetAccount(host, id));
}

const isAccountDeleted = Symbol('isAccountDeleted');

function fetchAccount(token: string, id?: string, forceShowDialog?: boolean): Promise<Misskey.entities.MeDetailed> {
	return new Promise((done, fail) => {
		window.fetch(`${apiUrl}/i`, {
			method: 'POST',
			body: JSON.stringify({
				i: token,
			}),
			headers: {
				'Content-Type': 'application/json',
			},
		})
			.then(res => new Promise<Misskey.entities.MeDetailed | { error: Record<string, any> }>((done2, fail2) => {
				if (res.status >= 500 && res.status < 600) {
					return fail2(res);
				}
				res.json().then(done2, fail2);
			}))
			.then(async res => {
				if ('error' in res) {
					if (res.error.id === 'a8c724b3-6e9c-4b46-b1a8-bc3ed6258370') {
						if (forceShowDialog || $i && (token === $i.token || id === $i.id)) {
							await showSuspendedDialog();
						}
					} else if (res.error.id === 'e5b3b9f0-2b8f-4b9f-9c1f-8c5c1b2e1b1a') {
						if (forceShowDialog || $i && (token === $i.token || id === $i.id)) {
							await alert({
								type: 'error',
								title: i18n.ts.accountDeleted,
								text: i18n.ts.accountDeletedDescription,
							});
						}
					} else if (res.error.id === 'b0a7f5f8-dc2f-4171-b91f-de88ad238e14') {
						if (forceShowDialog || $i && (token === $i.token || id === $i.id)) {
							await alert({
								type: 'error',
								title: i18n.ts.tokenRevoked,
								text: i18n.ts.tokenRevokedDescription,
							});
						}
					} else {
						await alert({
							type: 'error',
							title: i18n.ts.failedToFetchAccountInformation,
							text: JSON.stringify(res.error),
						});
					}

					fail(isAccountDeleted);
				} else {
					done(res);
				}
			})
			.catch(fail);
	});
}

function persistCurrentAccount() {
	if (!$i) return;
	const { token, ...user } = $i;
	const key = host + '/' + user.id;
	void withAccountLock(async () => {
		if (miLocalStorage.getItemAsJson('account')?.token !== token) return;
		miLocalStorage.setItemAsJson('account', { ...user, token });
		await store.updateDevice(current => current.accountTokens?.[key] === token ? {
			accountInfos: { ...current.accountInfos, [key]: user },
		} : {});
	}).catch(error => console.error('Failed to save account information', error));
}

export function replaceCurrentAccountData(accountData: Misskey.entities.MeDetailed) {
	if (!$i) return;
	const token = $i.token;
	for (const key of Object.keys($i)) {
		delete $i[key as keyof typeof $i];
	}
	for (const [key, value] of Object.entries(accountData)) {
		($i[key as keyof typeof accountData] as any) = value;
	}
	$i.token = token;
	persistCurrentAccount();
}

export function updateCurrentAccount(accountData: Partial<Misskey.entities.MeDetailed>) {
	if (!$i) return;
	for (const [key, value] of Object.entries(accountData)) {
		($i[key as keyof typeof accountData] as any) = value;
	}

	persistCurrentAccount();
}

export async function refreshCurrentAccount() {
	if (!$i) return;
	const me = $i;
	return fetchAccount($i.token, $i.id).then(replaceCurrentAccountData).catch(async reason => {
		if (reason === isAccountDeleted) {
			await leaveRevokedAccount(me);
		}
	});
}

export async function leaveRevokedAccount(me: Pick<AccountWithToken, 'id' | 'token'>) {
	try {
		await withAccountLock(async () => {
			if (miLocalStorage.getItemAsJson('account')?.token === me.token) miLocalStorage.removeItem('account');
			await forgetAccount(host, me.id, me.token);
		});
		const candidates = await withAccountLock(() => readStoredAccounts(get, host));
		for (const { id, token } of candidates) {
			if (miLocalStorage.getItem('account')) break;
			const next = await misskeyApi('i', {}, token, AbortSignal.timeout(5000)).catch(() => null);
			if (!next || next.id !== id) continue;
			await withAccountLock(async () => {
				const latest = await readStoredAccounts(get, host);
				if (miLocalStorage.getItem('account') || !latest.some(account => account.id === id && account.token === token)) return;
				miLocalStorage.setItemAsJson('account', { ...next, token });
			});
		}
	} catch (error) {
		console.error('Failed to update saved accounts after token revocation', error);
	}
	unisonReload(miLocalStorage.getItem('account') ? undefined : '/');
}

export async function login(token: AccountWithToken['token'], redirect?: string) {
	const showing = ref(true);
	const { dispose } = popup(defineAsyncComponent(() => import('@/components/MkWaitingDialog.vue')), {
		success: false,
		showing: showing,
	}, {
		closed: () => dispose(),
	});

	try {
		const me = await fetchAccount(token, undefined, true);
		await addAccount(host, me, token, true);
	} catch (error) {
		showing.value = false;
		dispose();
		throw error;
	}

	if (redirect) {
		reloadChannel.postMessage(null);
		window.location.href = redirect;
		return;
	}

	unisonReload();
}

export async function switchAccount(accountHost: string, id: string) {
	if (accountHost !== host) throw new Error('Cannot sign in to an account from another host');
	const token = (await getAccountFromId(id))?.token;
	if (token) {
		login(token);
	} else {
		const { dispose } = popup(defineAsyncComponent(() => import('@/components/MkSigninDialog.vue')), {}, {
			done: async (res: Misskey.entities.SigninFlowResponse & { finished: true }) => {
				await login(res.i);
			},
			closed: () => {
				dispose();
			},
		});
	}
}

export async function getAccountMenu(opts: {
	includeCurrentAccount?: boolean;
	withExtraOperation: boolean;
	active?: Misskey.entities.User['id'];
	onChoose?: (account: Misskey.entities.MeDetailed) => void;
}) {
	if ($i == null) throw new Error('No current account');
	const me = $i;

	const callback = opts.onChoose;

	function createItem(host: string, id: Misskey.entities.User['id'], username: Misskey.entities.User['username'], account: Misskey.entities.MeDetailed | null | undefined, token: string | null): MenuItem {
		if (account) {
			return {
				type: 'user' as const,
				user: account,
				active: opts.active != null ? opts.active === id : false,
				action: async () => {
					if (callback) {
						callback(account);
					} else {
						switchAccount(host, id);
					}
				},
			};
		} else if (token != null) {
			return {
				type: 'button' as const,
				text: username,
				active: opts.active != null ? opts.active === id : false,
				action: async () => {
					if (callback) {
						fetchAccount(token, id).then(account => {
							callback(account);
						});
					} else {
						switchAccount(host, id);
					}
				},
			};
		} else {
			return {
				type: 'button' as const,
				text: username,
				active: opts.active != null ? opts.active === id : false,
				action: async () => {
					const { dispose } = popup(defineAsyncComponent(() => import('@/components/MkSigninDialog.vue')), {
						initialUsername: username,
					}, {
						done: async (res: Misskey.entities.SigninFlowResponse & { finished: true }) => {
							if (callback) {
								const account = await fetchAccount(res.i, res.id);
								await addAccount(host, account, res.i);
								callback(account);
							} else {
								await login(res.i);
							}
						},
						closed: () => {
							dispose();
						},
					});
				},
			};
		}
	}

	const menuItems: MenuItem[] = [];

	const accountItems = (await getAccounts().then(accounts => accounts.filter(x => x.host === host && x.id !== me.id))).map(a => createItem(a.host, a.id, a.username, a.user, a.token));

	if (opts.withExtraOperation) {
		menuItems.push({
			type: 'link',
			text: i18n.ts.profile,
			to: `/@${$i.username}`,
			avatar: $i,
		}, {
			type: 'divider',
		});

		if (opts.includeCurrentAccount) {
			menuItems.push(createItem(host, $i.id, $i.username, $i, $i.token));
		}

		menuItems.push(...accountItems);

		menuItems.push({
			type: 'parent',
			icon: 'ti ti-plus',
			text: i18n.ts.addAccount,
			children: [{
				text: i18n.ts.existingAccount,
				action: () => {
					getAccountWithSigninDialog().then(res => {
						if (res != null) {
							success();
						}
					});
				},
			}, {
				text: i18n.ts.createAccount,
				action: () => {
					getAccountWithSignupDialog().then(res => {
						if (res != null) {
							switchAccount(host, res.id);
						}
					});
				},
			}],
		}, {
			type: 'link',
			icon: 'ti ti-users',
			text: i18n.ts.manageAccounts,
			to: '/settings/accounts',
		});
	} else {
		if (opts.includeCurrentAccount) {
			menuItems.push(createItem(host, $i.id, $i.username, $i, $i.token));
		}

		menuItems.push(...accountItems);
	}

	return menuItems;
}

export function getAccountWithSigninDialog(): Promise<{ id: string, token: string } | null> {
	return new Promise((resolve) => {
		const { dispose } = popup(defineAsyncComponent(() => import('@/components/MkSigninDialog.vue')), {}, {
			done: async (res: Misskey.entities.SigninFlowResponse & { finished: true }) => {
				const user = await fetchAccount(res.i, res.id, true);
				await addAccount(host, user, res.i);
				resolve({ id: res.id, token: res.i });
			},
			cancelled: () => {
				resolve(null);
			},
			closed: () => {
				dispose();
			},
		});
	});
}

export function getAccountWithSignupDialog(): Promise<{ id: string, token: string } | null> {
	return new Promise((resolve) => {
		const { dispose } = popup(defineAsyncComponent(() => import('@/components/MkSignupDialog.vue')), {}, {
			done: async (res: Misskey.entities.SignupResponse) => {
				const user = JSON.parse(JSON.stringify(res));
				delete user.token;
				await addAccount(host, user, res.token);
				resolve({ id: res.id, token: res.token });
			},
			cancelled: () => {
				resolve(null);
			},
			closed: () => {
				dispose();
			},
		});
	});
}
