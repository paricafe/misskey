/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import 'vite/modulepreload-polyfill';
import '@/style.scss';

const subBootPaths = ['/share', '/auth', '/miauth', '/oauth', '/signup-complete', '/verify-email', '/install-extensions'];
const boot = subBootPaths.some(path => window.location.pathname === path || window.location.pathname.startsWith(path + '/'))
	? import('@/boot/sub-boot.js').then(module => module.subBoot)
	: import('@/boot/main-boot.js').then(module => module.mainBoot);

// Fetch boot modules alongside the icon stylesheet rather than adding another network waterfall.
const icons = import.meta.env.DEV
	? import('@tabler/icons-webfont/dist/tabler-icons.scss')
	: import('icons-subsetter/built/tabler-icons-frontend.css');
const [start] = await Promise.all([boot, icons]);
await start();
