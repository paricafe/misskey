/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { secureRndstr } from '@/misc/secure-rndstr.js';

export const generateNativeUserToken = () => secureRndstr(16);

export const isNativeUserToken = (token: string) => token.length === 16;

export const nativeTokenFingerprint = (token: string) => createHash('sha256').update(token).digest('hex');
