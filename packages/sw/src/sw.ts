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

const CACHE_NAME = 'pari-cache-${_VERSION_}';
const urlsToCache = [
  '/',
  '/emoji',
  '/twemoji',
  '/fluent-emoji',
  '/vite',
];

globalThis.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
});

globalThis.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME, swLang.cacheName];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => globalThis.clients.claim())
  );
});

globalThis.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        if (response) {
          return response;
        }
        return fetch(event.request).then(
          (response) => {
            if(!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }

            const responseToCache = response.clone();

            caches.open(CACHE_NAME)
              .then((cache) => {
                cache.put(event.request, responseToCache);
              });

            return response;
          }
        );
      })
  );
});

async function offlineContentHTML() {
  const i18n = await (swLang.i18n ?? swLang.fetchLocale()) as Partial<I18n<Locale>>;
  const messages = {
    title: i18n.ts?._offlineScreen.title ?? 'Offline - Could not connect to server',
    header: i18n.ts?._offlineScreen.header ?? 'Could not connect to server',
    reload: i18n.ts?.reload ?? 'Reload',
  };

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta content="width=device-width,initial-scale=1"name="viewport"><title>${messages.title}</title><style>body{background-color:#0c1210;color:#dee7e4;font-family:Hiragino Maru Gothic Pro,BIZ UDGothic,Roboto,HelveticaNeue,Arial,sans-serif;line-height:1.35;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}.icon{max-width:120px;width:100%;height:auto;margin-bottom:20px;}.message{text-align:center;font-size:20px;font-weight:700;margin-bottom:20px}.version{text-align:center;font-size:90%;margin-bottom:20px}button{padding:7px 14px;min-width:100px;font-weight:700;font-family:Hiragino Maru Gothic Pro,BIZ UDGothic,Roboto,HelveticaNeue,Arial,sans-serif;line-height:1.35;border-radius:99rem;background-color:#ff82ab;color:#192320;border:none;cursor:pointer;-webkit-tap-highlight-color:transparent}button:hover{background-color:#fac5eb}</style></head><body><svg class="icon"fill="none"height="24"stroke="currentColor"stroke-linecap="round"stroke-linejoin="round"stroke-width="2"viewBox="0 0 24 24"width="24"xmlns="http://www.w3.org/2000/svg"><path d="M0 0h24v24H0z"fill="none"stroke="none"/><path d="M9.58 5.548c.24 -.11 .492 -.207 .752 -.286c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 .957 -.383 1.824 -1.003 2.454m-2.997 1.033h-11.343c-2.572 -.004 -4.657 -2.011 -4.657 -4.487c0 -2.475 2.085 -4.482 4.657 -4.482c.13 -.582 .37 -1.128 .7 -1.62"/><path d="M3 3l18 18"/></svg><div class="message">${messages.header}</div><div class="version">v${_VERSION_}</div><button onclick="reloadPage()">${messages.reload}</button><script>function reloadPage(){location.reload(!0)}</script></body></html>`;
}

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
            if (data.body.type === 'receiveFollowRequest') {
              await swos.api('following/requests/accept', loginId, { userId: data.body.userId });
            }
            break;
          case 'reject':
            if (data.body.type === 'receiveFollowRequest') {
              await swos.api('following/requests/reject', loginId, { userId: data.body.userId });
            }
            break;
          case 'showFollowRequests':
            client = await swos.openClient('push', '/my/follow-requests', loginId);
            break;
          default:
            if (data.body.type === 'receiveFollowRequest') {
              client = await swos.openClient('push', '/my/follow-requests', loginId);
            } else if (data.body.type === 'reaction') {
              client = await swos.openNote(data.body.note.id, loginId);
            } else if ('note' in data.body) {
              client = await swos.openNote(data.body.note.id, loginId);
            } else if ('user' in data.body) {
              client = await swos.openUser(Misskey.acct.toString(data.body.user), loginId);
            }
            break;
        }
        break;
      case 'unreadAntennaNote':
        client = await swos.openAntenna(data.body.antenna.id, loginId);
        break;
      default:
        if (action === 'markAllAsRead') {
          await globalThis.registration.getNotifications()
            .then(notifications => notifications.forEach(n => n.tag !== 'read_notification' && n.close()));
          await get<Pick<Misskey.entities.SignupResponse, 'id' | 'token'>[]>('accounts').then(accounts => {
            return Promise.all((accounts ?? []).map(async account => {
              await swos.sendMarkAllAsRead(account.id);
            }));
          });
        } else if (action === 'settings') {
          client = await swos.openClient('push', '/settings/notifications', loginId);
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