/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import OAuthPage from '@/pages/oauth.vue';
import { i18n } from '@/i18n.js';
import { mastodonScopeDescription } from '@/utility/mastodon-scope-description.js';

const fixtures = vi.hoisted(() => ({ popup: vi.fn(), alert: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { id: 'alice', username: 'alice', token: 'cached-token' } }));
vi.mock('@/accounts.js', () => ({ getAccounts: vi.fn().mockResolvedValue([]), getAccountWithSigninDialog: vi.fn(), getAccountWithSignupDialog: vi.fn() }));
vi.mock('@/os.js', () => ({ popup: fixtures.popup, alert: fixtures.alert, popupMenu: vi.fn(), success: vi.fn() }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/utility/media-proxy.js', () => ({ getProxiedImageUrl: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));

function metadata(name: string, content: string): void {
	const element = document.createElement('meta');
	element.name = `misskey:oauth:${name}`;
	element.content = content;
	document.head.appendChild(element);
}

async function consent() {
	const screen = render(OAuthPage, {
		global: {
			stubs: {
				PageWithAnimBg: { template: '<div><slot/></div>' },
				MkAvatar: true, MkUserName: true, MkAcct: true, MkLoading: true,
			},
		},
	});
	await fireEvent.click(screen.getByRole('radio'));
	await fireEvent.click(screen.getByRole('button', { name: new RegExp(i18n.ts.continue, 'u') }));
	return screen;
}

describe('OAuth consent', () => {
	beforeEach(() => {
		metadata('transaction-id', 'mastodon:transaction');
		metadata('client-name', 'Example app');
		metadata('scope', 'read:account');
		vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
		fixtures.popup.mockReset();
		fixtures.alert.mockReset();
	});

	afterEach(() => {
		cleanup();
		for (const meta of document.head.querySelectorAll('meta[name^="misskey:oauth:"]')) meta.remove();
		for (const form of document.body.querySelectorAll('form[action="/oauth/decision"]')) form.remove();
		vi.restoreAllMocks();
	});

	test('shows push and collection scopes as readable permissions', async () => {
		metadata('mastodon-scopes', 'push read:collections write:collections');
		const screen = await consent();
		for (const scope of ['push', 'read:collections', 'write:collections']) screen.getByText(mastodonScopeDescription(scope));
		expect(screen.queryByText(i18n.ts._permissions['read:account'])).toBeNull();
	});

	test('preserves native consent and submits the selected account without reauthentication by default', async () => {
		const screen = await consent();
		screen.getByText(i18n.ts._permissions['read:account']);
		await fireEvent.click(screen.getByRole('button', { name: i18n.ts.accept }));
		expect(fixtures.popup).not.toHaveBeenCalled();
		expect(document.querySelector<HTMLInputElement>('input[name="login_token"]')?.value).toBe('cached-token');
		expect(HTMLFormElement.prototype.submit).toHaveBeenCalledOnce();
	});

	test('honors force_login and submits only after reauthenticating the selected account', async () => {
		metadata('mastodon-scopes', 'profile');
		metadata('force-login', 'true');
		let finish: ((value: { id: string; i: string; finished: true }) => void) | undefined;
		fixtures.popup.mockImplementation((_component, _props, events) => {
			finish = events.done;
			return { dispose: vi.fn() };
		});
		const screen = await consent();
		await fireEvent.click(screen.getByRole('button', { name: i18n.ts.accept }));
		expect(fixtures.popup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ initialUsername: 'alice' }), expect.anything());
		expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
		finish?.({ id: 'alice', i: 'reauthenticated-token', finished: true });
		await waitFor(() => expect(HTMLFormElement.prototype.submit).toHaveBeenCalledOnce());
		expect(document.querySelector<HTMLInputElement>('input[name="login_token"]')?.value).toBe('reauthenticated-token');
	});

	test('does not authorize a different account after a forced sign-in', async () => {
		metadata('mastodon-scopes', 'profile');
		metadata('force-login', 'true');
		fixtures.popup.mockImplementation((_component, _props, events) => {
			queueMicrotask(() => events.done({ id: 'bob', i: 'bob-token', finished: true }));
			return { dispose: vi.fn() };
		});
		const screen = await consent();
		await fireEvent.click(screen.getByRole('button', { name: i18n.ts.accept }));
		await waitFor(() => expect(fixtures.alert).toHaveBeenCalledWith({ type: 'error', text: i18n.ts._auth.accountMismatch }));
		expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
	});

	test('lets the user retry after cancelling a forced sign-in without authorizing', async () => {
		metadata('mastodon-scopes', 'profile');
		metadata('force-login', 'true');
		fixtures.popup.mockImplementation((_component, _props, events) => {
			queueMicrotask(() => events.cancelled());
			return { dispose: vi.fn() };
		});
		const screen = await consent();
		await fireEvent.click(screen.getByRole('button', { name: i18n.ts.accept }));
		expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: i18n.ts.accept }));
		expect(fixtures.popup).toHaveBeenCalledTimes(2);
		expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
	});
});
