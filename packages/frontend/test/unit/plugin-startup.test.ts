/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	plugins: [] as { installId: string; name: string; active: boolean; src: string; version: string; configData: Record<string, never> }[],
}));
vi.mock('@/preferences.js', () => ({ prefer: { s: { plugins: mocks.plugins }, commit: vi.fn() } }));
vi.mock('@/store.js', () => ({ store: { s: { pluginTokens: {} } } }));
vi.mock('@/os.js', () => ({}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/utility/idb-proxy.js', () => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('@/aiscript/api.js', () => ({ createAiScriptEnv: () => ({}), aiScriptReadline: vi.fn() }));

beforeEach(() => {
	vi.resetModules();
	mocks.plugins.length = 0;
	vi.spyOn(console, 'info').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function plugin(id: string, src: string) {
	return { installId: id, name: id, active: true, src, version: '1.0.0', configData: {} };
}

const register = 'Plugin:register:note_view_interruptor(@(note) { note })';

test('the startup gate is ready immediately when no plugin is active', async () => {
	const { pluginsReady } = await import('@/plugin.js');
	expect(pluginsReady.value).toBe(true);
});

test('aborts a slow plugin, removes failed handlers and preserves a successful plugin', async () => {
	mocks.plugins.push(plugin('slow', `${register}\nCore:sleep(6000)\n${register}`), plugin('fast', register), plugin('fail', `${register}\nCore:abort("failed")`));
	const { launchPlugins, pluginsReady, getPluginHandlers, pluginLogs } = await import('@/plugin.js');
	expect(pluginsReady.value).toBe(false);
	const launching = launchPlugins();
	await vi.waitFor(() => expect(getPluginHandlers('note_view_interruptor')).toHaveLength(2));
	expect(pluginsReady.value).toBe(false);
	await launching;
	expect(pluginsReady.value).toBe(true);
	expect(getPluginHandlers('note_view_interruptor')).toHaveLength(1);
	expect(pluginLogs.value.get('slow')?.some(log => log.message.includes('exceeded 5000ms'))).toBe(true);
	expect(pluginLogs.value.get('fast')?.some(log => log.message === 'Plugin started')).toBe(true);
	expect(pluginLogs.value.get('fail')?.some(log => log.isError)).toBe(true);
	await new Promise(resolve => setTimeout(resolve, 1200));
	expect(getPluginHandlers('note_view_interruptor')).toHaveLength(1);
}, 12000);
