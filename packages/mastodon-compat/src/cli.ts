/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { resolve } from 'node:path';
import { createGateway } from './index.js';

const publicUrl = process.env.MASTODON_PUBLIC_URL;
const nativeUrl = process.env.MISSKEY_NATIVE_URL;
if (!publicUrl || !nativeUrl) throw new Error('Set MASTODON_PUBLIC_URL and MISSKEY_NATIVE_URL');
const gateway = await createGateway({ publicUrl, nativeUrl, database: resolve(process.env.MASTODON_DATABASE ?? '.mastodon-compat/compat.sqlite') });
await gateway.listen({ host: process.env.MASTODON_HOST ?? '127.0.0.1', port: Number(process.env.MASTODON_PORT ?? 3100) });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void gateway.close(); });
