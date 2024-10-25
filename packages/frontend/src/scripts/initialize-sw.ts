/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { lang } from '@@/js/config.js';

export async function initializeSw() {
  if (!('serviceWorker' in navigator)) return;

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations.map(registration => registration.unregister())
    );

    console.info('Successfully unregistered old service worker(s)');

    const registration = await navigator.serviceWorker.register('/sw.js', { 
      scope: '/', 
      type: 'classic' 
    });

    await navigator.serviceWorker.ready;

    registration.active?.postMessage({
      msg: 'initialize',
      lang,
    });

    console.info('Successfully registered and initialized new service worker');
  } catch (error) {
    console.error('Service worker registration/initialization failed:', error);
  }
}
