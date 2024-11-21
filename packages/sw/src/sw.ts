/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { get } from 'idb-keyval';
import * as Misskey from 'misskey-js';
import type { PushNotificationDataMap } from '@/types.js';
import type { I18n } from '@@/js/i18n.js';
import type { Locale } from '../../../locales/index.js';
import { createEmptyNotification, createNotification } from '@/scripts/create-notification.js';
import { swLang } from '@/scripts/lang.js';
import * as swos from '@/scripts/operations.js';

const STATIC_CACHE_NAME = `misskey-static-${_VERSION_}`;
const PATHS_TO_CACHE = ['/assets/', '/static-assets/', '/emoji/', '/twemoji/', '/fluent-emoji/', '/vite/'];
const STORAGE_QUOTA = 2 * 1024 * 1024 * 1024; // 2GB in bytes
const EMOJI_PATH = '/emoji/';

async function requestStorageQuota() {
	try {
			if (!('storage' in navigator)) {
					throw new Error('Storage API not supported');
			}

			if ('persist' in navigator) {
					const isPersisted = await navigator.storage.persist();
					console.log(`Persisted storage granted: ${isPersisted}`);
			}

			if ('estimate' in navigator.storage) {
					const estimate = await navigator.storage.estimate();
					const currentQuota = estimate.quota || 0;
					const currentUsage = estimate.usage || 0;

					console.log(`Current storage: ${currentUsage} of ${currentQuota} bytes used`);

					if ('requestQuota' in navigator.storage) {
							try {
									const grantedQuota = await navigator.storage.requestQuota(STORAGE_QUOTA);
									console.log(`Granted quota: ${grantedQuota} bytes`);
							} catch (quotaError) {
									console.warn('Failed to request additional quota:', quotaError);
							}
					}

					return {
							quota: currentQuota,
							usage: currentUsage
					};
			} else {
					console.warn('Storage estimate API not supported');
					return {
							quota: 0,
							usage: 0
					};
			}
	} catch (error) {
			console.error('Failed to request storage quota:', error);
			return {
					quota: 0,
					usage: 0
			};
	}
}

async function manageStorageSpace(newRequestSize = 0) {
	try {
			if (!('storage' in navigator)) {
					console.warn('Storage API not supported');
					return;
			}

			const estimate = await navigator.storage.estimate();
			const currentUsage = estimate.usage || 0;
			const currentQuota = estimate.quota || STORAGE_QUOTA;

			if (currentUsage + newRequestSize > currentQuota) {
					console.log(`Storage space needed. Current usage: ${currentUsage}, Need: ${newRequestSize}, Quota: ${currentQuota}`);

					const cache = await caches.open(STATIC_CACHE_NAME);
					const keys = await cache.keys();

					const emojiKeys = keys.filter(request => request.url.includes(EMOJI_PATH));
					console.log(`Found ${emojiKeys.length} emoji caches to manage`);

					if (emojiKeys.length > 0) {
							for (const key of emojiKeys) {
									await cache.delete(key);
									console.log(`Deleted cache for: ${key.url}`);

									const newEstimate = await navigator.storage.estimate();
									const newUsage = newEstimate.usage || 0;

									if (newUsage + newRequestSize <= currentQuota) {
											console.log(`Sufficient space cleared. New usage: ${newUsage}`);
											break;
									}
							}
					} else {
							console.warn('No emoji caches available for cleanup');
					}
			}
	} catch (error) {
			console.error('Failed to manage storage space:', error);
	}
}

async function cacheWithFallback(cache, paths) {
	for (const path of paths) {
			try {
					const response = await fetch(new Request(path, { credentials: 'same-origin' }));
					const blob = await response.clone().blob();

					await manageStorageSpace(blob.size);

					await cache.put(new Request(path, { credentials: 'same-origin' }), response);
			} catch (error) {
					console.error(`Failed to cache ${path}:`, error);
			}
	}
}

globalThis.addEventListener('install', (ev) => {
	ev.waitUntil((async () => {
			await requestStorageQuota();

			const cache = await caches.open(STATIC_CACHE_NAME);
			await cacheWithFallback(cache, PATHS_TO_CACHE);
			await globalThis.skipWaiting();
	})());
});

globalThis.addEventListener('activate', ev => {
    ev.waitUntil(
        caches.keys()
            .then(cacheNames => Promise.all(
                cacheNames
                    .filter((v) => v !== STATIC_CACHE_NAME && v !== swLang.cacheName)
                    .map(name => caches.delete(name)),
            ))
            .then(() => globalThis.clients.claim()),
    );
});

async function offlineContentHTML() {
    const i18n = await (swLang.i18n ?? swLang.fetchLocale()) as Partial<I18n<Locale>>;
    const messages = {
        title: i18n.ts?._offlineScreen.title ?? 'Offline - Could not connect to server',
        header: i18n.ts?._offlineScreen.header ?? 'Could not connect to server',
        reload: i18n.ts?.reload ?? 'Reload',
    };

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta content="width=device-width,initial-scale=1"name="viewport"><title>${messages.title}</title><style>body{background-color:#0c1210;color:#dee7e4;font-family:Hiragino Maru Gothic Pro,BIZ UDGothic,Roboto,HelveticaNeue,Arial,sans-serif;line-height:1.35;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}.icon{max-width:120px;width:100%;height:auto;margin-bottom:20px;}.message{text-align:center;font-size:20px;font-weight:700;margin-bottom:20px}.version{text-align:center;font-size:90%;margin-bottom:20px}button{padding:7px 14px;min-width:100px;font-weight:700;font-family:Hiragino Maru Gothic Pro,BIZ UDGothic,Roboto,HelveticaNeue,Arial,sans-serif;line-height:1.35;border-radius:99rem;background-color:#ff82ab;color:#192320;border:none;cursor:pointer;-webkit-tap-highlight-color:transparent}button:hover{background-color:#fac5eb}</style></head><body><svg class="icon"fill="none"height="24"stroke="currentColor"stroke-linecap="round"stroke-linejoin="round"stroke-width="2"viewBox="0 0 24 24"width="24"xmlns="http://www.w3.org/2000/svg"><path d="M0 0h24v24H0z"fill="none"stroke="none"/><path d="M9.58 5.548c.24 -.11 .492 -.207 .752 -.286c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 .957 -.383 1.824 -1.003 2.454m-2.997 1.033h-11.343c-2.572 -.004 -4.657 -2.011 -4.657 -4.487c0 -2.475 2.085 -4.482 4.657 -4.482c.13 -.582 .37 -1.128 .7 -1.62"/><path d="M3 3l18 18"/></svg><div class="message">${messages.header}</div><div class="version">v${_VERSION_}</div><button onclick="reloadPage()">${messages.reload}</button><script>function reloadPage(){location.reload(!0)}</script></body></html>`;
}

globalThis.addEventListener('fetch', ev => {
	const shouldCache = PATHS_TO_CACHE.some(path => ev.request.url.includes(path));

	if (shouldCache) {
			ev.respondWith(
					caches.match(ev.request)
							.then(async response => {
									if (response) return response;

									const fetchResponse = await fetch(ev.request);
									if (!fetchResponse || fetchResponse.status !== 200 || fetchResponse.type !== 'basic') {
											return fetchResponse;
									}

									const blob = await fetchResponse.clone().blob();
									await manageStorageSpace(blob.size);

									const responseToCache = fetchResponse.clone();
									const cache = await caches.open(STATIC_CACHE_NAME);
									await cache.put(ev.request, responseToCache);

									return fetchResponse;
							})
			);
			return;
	}

    let isHTMLRequest = false;
    if (ev.request.headers.get('sec-fetch-dest') === 'document') {
        isHTMLRequest = true;
    } else if (ev.request.headers.get('accept')?.includes('/html')) {
        isHTMLRequest = true;
    } else if (ev.request.url.endsWith('/')) {
        isHTMLRequest = true;
    }

    if (!isHTMLRequest) return;
    ev.respondWith(
        fetch(ev.request)
            .catch(async () => {
                const html = await offlineContentHTML();
                return new Response(html, {
                    status: 200,
                    headers: {
                        'content-type': 'text/html',
                    },
                });
            }),
    );
});

globalThis.addEventListener('push', ev => {
    ev.waitUntil(globalThis.clients.matchAll({
        includeUncontrolled: true,
        type: 'window',
    }).then(async () => {
        const data: PushNotificationDataMap[keyof PushNotificationDataMap] = ev.data?.json();

        switch (data.type) {
            case 'notification':
            case 'unreadAntennaNote':
                if (Date.now() - data.dateTime > 1000 * 60 * 60 * 24) break;

                return createNotification(data);
            case 'readAllNotifications':
                await globalThis.registration.getNotifications()
                    .then(notifications => notifications.forEach(n => n.tag !== 'read_notification' && n.close()));
                break;
        }

        await createEmptyNotification();
        return;
    }));
});

globalThis.addEventListener('notificationclick', (ev: ServiceWorkerGlobalScopeEventMap['notificationclick']) => {
    ev.waitUntil((async (): Promise<void> => {
        if (_DEV_) {
            console.log('notificationclick', ev.action, ev.notification.data);
        }

        const { action, notification } = ev;
        const data: PushNotificationDataMap[keyof PushNotificationDataMap] = notification.data ?? {};
        const { userId: loginId } = data;
        let client: WindowClient | null = null;

        switch (data.type) {
            case 'notification':
                switch (action) {
                    case 'follow':
                        if ('userId' in data.body) await swos.api('following/create', loginId, { userId: data.body.userId });
                        break;
                    case 'showUser':
                        if ('user' in data.body) client = await swos.openUser(Misskey.acct.toString(data.body.user), loginId);
                        break;
                    case 'reply':
                        if ('note' in data.body) client = await swos.openPost({ reply: data.body.note }, loginId);
                        break;
                    case 'renote':
                        if ('note' in data.body) await swos.api('notes/create', loginId, { renoteId: data.body.note.id });
                        break;
                    case 'accept':
                        switch (data.body.type) {
                            case 'receiveFollowRequest':
                                await swos.api('following/requests/accept', loginId, { userId: data.body.userId });
                                break;
                        }
                        break;
                    case 'reject':
                        switch (data.body.type) {
                            case 'receiveFollowRequest':
                                await swos.api('following/requests/reject', loginId, { userId: data.body.userId });
                                break;
                        }
                        break;
                    case 'showFollowRequests':
                        client = await swos.openClient('push', '/my/follow-requests', loginId);
                        break;
                    default:
                        switch (data.body.type) {
                            case 'receiveFollowRequest':
                                client = await swos.openClient('push', '/my/follow-requests', loginId);
                                break;
                            case 'reaction':
                                client = await swos.openNote(data.body.note.id, loginId);
                                break;
                            default:
                                if ('note' in data.body) {
                                    client = await swos.openNote(data.body.note.id, loginId);
                                } else if ('user' in data.body) {
                                    client = await swos.openUser(Misskey.acct.toString(data.body.user), loginId);
                                }
                                break;
                        }
                }
                break;
            case 'unreadAntennaNote':
                client = await swos.openAntenna(data.body.antenna.id, loginId);
                break;
            default:
                switch (action) {
                    case 'markAllAsRead':
                        await globalThis.registration.getNotifications()
                            .then(notifications => notifications.forEach(n => n.tag !== 'read_notification' && n.close()));
                        await get<Pick<Misskey.entities.SignupResponse, 'id' | 'token'>[]>('accounts').then(accounts => {
                            return Promise.all((accounts ?? []).map(async account => {
                                await swos.sendMarkAllAsRead(account.id);
                            }));
                        });
                        break;
                    case 'settings':
                        client = await swos.openClient('push', '/settings/notifications', loginId);
                        break;
                }
        }

        if (client) {
            client.focus();
        }
        if (data.type === 'notification') {
            await swos.sendMarkAllAsRead(loginId);
        }

        notification.close();
    })());
});

globalThis.addEventListener('notificationclose', (ev: ServiceWorkerGlobalScopeEventMap['notificationclose']) => {
    const data: PushNotificationDataMap[keyof PushNotificationDataMap] = ev.notification.data;

    ev.waitUntil((async (): Promise<void> => {
        if (data.type === 'notification') {
            await swos.sendMarkAllAsRead(data.userId);
        }
        return;
    })());
});

globalThis.addEventListener('message', (ev: ServiceWorkerGlobalScopeEventMap['message']) => {
    ev.waitUntil((async (): Promise<void> => {
        if (ev.data === 'clear') {
            await caches.keys()
                .then(cacheNames => Promise.all(
                    cacheNames.map(name => caches.delete(name)),
                ));
            return;
        }

        if (typeof ev.data === 'object') {
            const otype = Object.prototype.toString.call(ev.data).slice(8, -1).toLowerCase();

            if (otype === 'object') {
                if (ev.data.msg === 'initialize') {
                    swLang.setLang(ev.data.lang);
                }
            }
        }
    })());
});
