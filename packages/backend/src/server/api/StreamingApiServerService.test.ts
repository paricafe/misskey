/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { isNativeStreamingPath } from './StreamingApiServerService.js';

describe('native streaming path isolation', () => {
	test('does not claim Mastodon WebSocket upgrades', () => {
		expect(isNativeStreamingPath('/streaming')).toBe(true);
		expect(isNativeStreamingPath('/streaming?i=token')).toBe(true);
		expect(isNativeStreamingPath('/api/v1/streaming')).toBe(false);
		expect(isNativeStreamingPath('http://[')).toBe(false);
	});
});
