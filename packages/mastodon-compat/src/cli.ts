/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createGateway, createPostgresStore } from './index.js';

const publicUrl = process.env.MASTODON_PUBLIC_URL;
const nativeUrl = process.env.MISSKEY_NATIVE_URL;
const connectionString = process.env.MASTODON_DATABASE_URL;
if (!publicUrl || !nativeUrl || !connectionString) throw new Error('Set MASTODON_PUBLIC_URL, MISSKEY_NATIVE_URL and MASTODON_DATABASE_URL');
const store = await createPostgresStore({ connectionString });
const gateway = await createGateway({ publicUrl, nativeUrl, store });
await gateway.listen({ host: process.env.MASTODON_HOST ?? '127.0.0.1', port: Number(process.env.MASTODON_PORT ?? 3100) });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void gateway.close(); });
