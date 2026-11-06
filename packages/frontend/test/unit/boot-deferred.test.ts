/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import type { App } from 'vue';

const probes = vi.hoisted(() => ({
	emoji: vi.fn(),
	telemetry: vi.fn(),
	plugins: vi.fn(),
}));

vi.mock('@/widgets/index.js', () => ({ default: vi.fn() }));
vi.mock('@/directives/index.js', () => ({ default: vi.fn() }));
vi.mock('@/components/index.js', () => ({ default: vi.fn() }));
vi.mock('@/theme.js', () => ({ themeManager: { updateTheme: vi.fn() } }));
vi.mock('@/accounts.js', () => ({ refreshCurrentAccount: vi.fn(), login: vi.fn() }));
vi.mock('@/store.js', async () => {
	const { ref } = await import('vue');
	return { store: { ready: Promise.resolve(), r: { darkMode: ref(false) }, s: { darkMode: false }, set: vi.fn() } };
});
vi.mock('@/instance.js', () => ({ fetchInstance: vi.fn().mockResolvedValue(undefined), instance: { version: 'test' } }));
vi.mock('@/utility/device-kind.js', () => ({ updateDeviceKind: vi.fn() }));
vi.mock('@/utility/unison-reload.js', () => ({ reloadChannel: { addEventListener: vi.fn() } }));
vi.mock('@/utility/login-id.js', () => ({ getUrlWithoutLoginId: vi.fn() }));
vi.mock('@/utility/get-account-from-id.js', () => ({ getAccountFromId: vi.fn() }));
vi.mock('@/ui/deck/deck-store.js', () => ({ deckStore: { ready: Promise.resolve() } }));
vi.mock('@/analytics.js', () => ({ analytics: { identify: vi.fn(), page: vi.fn() }, initAnalytics: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/local-storage.js', () => ({ miLocalStorage: { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() } }));
vi.mock('@/custom-emojis.js', () => ({ fetchCustomEmojisForBoot: probes.emoji }));
vi.mock('@/utility/load-font.js', () => ({ loadFontStyle: vi.fn() }));
vi.mock('@/utility/text-autospace.js', () => ({ applyTextAutospacePreference: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: null }));
vi.mock('@/plugin.js', () => ({ launchPlugins: probes.plugins }));
vi.mock('@/telemetry.js', () => ({ initTelemetry: probes.telemetry }));
vi.mock('@@/js/store-boot-errors', () => ({ storeBootloaderErrors: vi.fn() }));
vi.mock('@/preferences.js', async () => {
	const { ref } = await import('vue');
	return { prefer: { s: {}, r: { darkTheme: ref(null), lightTheme: ref(null), overridedDeviceKind: ref(null), useBlurEffectForModal: ref(false), useBlurEffect: ref(false), autoSpacing: ref(false) }, commit: vi.fn() } };
});

const pending = () => new Promise<void>(() => {});
afterEach(() => {
	document.getElementById('misskey_app')?.remove();
	document.getElementById('splash')?.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test('mounts before idle startup tasks and does not await their pending promises', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('_DEV_', true);
	vi.stubGlobal('matchMedia', () => ({ addEventListener: vi.fn() }));
	const callbacks: IdleRequestCallback[] = [];
	vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => { callbacks.push(callback); return 1; });
	probes.emoji.mockReset().mockImplementation(pending);
	probes.telemetry.mockReset().mockImplementation(pending);
	probes.plugins.mockReset().mockImplementation(pending);
	const splash = document.createElement('div');
	splash.id = 'splash';
	document.body.append(splash);
	const mount = vi.fn();
	const app = { config: {}, mount } as unknown as App<Element>;
	const { common } = await import('@/boot/common.js');
	const result = await common(async () => app);
	expect(result.app).toBe(app);
	expect(mount).toHaveBeenCalledOnce();
	expect(splash.style.pointerEvents).toBe('none');
	expect(probes.emoji).not.toHaveBeenCalled();
	expect(probes.telemetry).not.toHaveBeenCalled();
	expect(probes.plugins).not.toHaveBeenCalled();
	expect(callbacks).toHaveLength(1);
	callbacks[0]({ didTimeout: false, timeRemaining: () => 50 });
	await Promise.resolve();
	expect(probes.emoji).toHaveBeenCalledOnce();
	expect(probes.telemetry).toHaveBeenCalledOnce();
	expect(probes.plugins).toHaveBeenCalledOnce();
});

test('starts background tasks after mount without requestIdleCallback', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('_DEV_', true);
	vi.stubGlobal('matchMedia', () => ({ addEventListener: vi.fn() }));
	vi.stubGlobal('requestIdleCallback', undefined);
	probes.emoji.mockReset().mockImplementation(pending);
	probes.telemetry.mockReset().mockImplementation(pending);
	probes.plugins.mockReset().mockImplementation(pending);
	const mount = vi.fn();
	const app = { config: {}, mount } as unknown as App<Element>;
	const { common } = await import('@/boot/common.js');
	await common(async () => app);
	expect(mount).toHaveBeenCalledOnce();
	expect(probes.emoji).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(0);
	expect(probes.emoji).toHaveBeenCalledOnce();
	expect(probes.telemetry).toHaveBeenCalledOnce();
	expect(probes.plugins).toHaveBeenCalledOnce();
});
