/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

// A separate process exercises WAL recovery and reloads the encryption key. The
// native consent response is fixed; all OAuth requests use the real HTTP routes.
const program = `
const { createGateway } = await import(process.env.TEST_GATEWAY_MODULE);
const { resolve } = await import('node:path');
const gateway = await createGateway({
  publicUrl: 'https://social.example', nativeUrl: 'https://native.example',
  database: resolve('.mastodon-compat/compat.sqlite'),
  transport: async () => ({ status: 200, body: JSON.stringify({ ok: true, token: 'native-test-grant', user: { id: 'alice' } }) }),
});
console.log(await gateway.listen({ host: '127.0.0.1', port: 0 }));
`;

async function start(t: TestContext, directory: string) {
	mkdirSync(directory, { recursive: true });
	const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
		cwd: directory,
		env: { ...process.env, TEST_GATEWAY_MODULE: new URL('../src/index.js', import.meta.url).href },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let errors = '';
	child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
	const exited = once(child, 'exit');
	const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; };
	t.after(stop);
	const output = await Promise.race([
		once(child.stdout, 'data').then(([chunk]) => String(chunk).trim()),
		exited.then(() => { throw new Error(`Gateway exited before listening: ${errors}`); }),
	]);
	assert.match(output, /^http:\/\/127\.0\.0\.1:\d+$/u);
	const request = (path: string, body?: unknown, bearer?: string) => fetch(new URL(path, output), {
		method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
		headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { request, stop };
}

const registration = { client_name: 'Persistence regression', redirect_uris: 'test-app://callback', scopes: 'read' };
type Client = { client_id: string; client_secret: string };
const authorizePath = (client: Client) => `/oauth/authorize?${new URLSearchParams({ client_id: client.client_id, redirect_uri: registration.redirect_uris, response_type: 'code' })}`;
const callbackPath = (response: Response) => {
	assert.equal(response.status, 302);
	const callback = new URL(new URL(response.headers.get('location')!).searchParams.get('callback')!);
	return callback.pathname + callback.search;
};

test('replacing an unmounted writable directory reproduces Unknown application and invalidates tokens', { timeout: 20000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), 'mastodon-unmounted-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const directory = join(root, 'container');
	const before = await start(t, directory);
	const created = await before.request('/api/v1/apps', registration);
	assert.equal(created.status, 200);
	const client = await created.json() as Client;
	const issued = await before.request('/oauth/token', { ...client, grant_type: 'client_credentials' });
	assert.equal(issued.status, 200);
	const { access_token: token } = await issued.json() as { access_token: string };
	await before.stop();
	rmSync(directory, { recursive: true });
	const after = await start(t, directory);
	const failed = await after.request(authorizePath(client));
	assert.equal(failed.status, 400);
	assert.deepEqual(await failed.json(), { error: 'invalid_client', error_description: 'Unknown application' });
	assert.equal((await after.request('/api/v1/apps/verify_credentials', undefined, token)).status, 401);
	await after.stop();
});

test('a persistent directory retains clients, pending authorization, encrypted grants and revocation across replacement', { timeout: 20000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), 'mastodon-mounted-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const volume = join(root, 'volume');
	mkdirSync(volume, { mode: 0o700 });
	let generation = 0;
	const replacement = () => {
		const directory = join(root, `container-${generation++}`);
		mkdirSync(directory);
		// Model a private mounted directory without requiring a Docker daemon.
		symlinkSync(volume, join(directory, '.mastodon-compat'));
		return start(t, directory);
	};
	const first = await replacement();
	const created = await first.request('/api/v1/apps', registration);
	assert.equal(created.status, 200);
	const client = await created.json() as Client;
	const issued = await first.request('/oauth/token', { ...client, grant_type: 'client_credentials' });
	assert.equal(issued.status, 200);
	const { access_token: token } = await issued.json() as { access_token: string };
	const pendingCallback = callbackPath(await first.request(authorizePath(client)));
	await first.stop();
	rmSync(join(root, 'container-0'), { recursive: true });
	const second = await replacement();
	assert.equal((await second.request('/api/v1/apps/verify_credentials', undefined, token)).status, 200);
	const accepted = await second.request(pendingCallback);
	assert.equal(accepted.status, 302);
	const code = new URL(accepted.headers.get('location')!).searchParams.get('code');
	assert.ok(code);
	await second.stop();
	rmSync(join(root, 'container-1'), { recursive: true });
	const third = await replacement();
	const exchange = { ...client, grant_type: 'authorization_code', code, redirect_uri: registration.redirect_uris };
	const exchanged = await third.request('/oauth/token', exchange);
	assert.equal(exchanged.status, 200);
	const { access_token: userToken } = await exchanged.json() as { access_token: string };
	assert.equal((await third.request('/oauth/token', exchange)).status, 400);
	assert.equal((await third.request(authorizePath(client))).status, 302);
	assert.equal((await third.request('/oauth/revoke', { ...client, token })).status, 200);
	await third.stop();
	rmSync(join(root, 'container-2'), { recursive: true });
	const fourth = await replacement();
	assert.equal((await fourth.request('/api/v1/apps/verify_credentials', undefined, token)).status, 401);
	assert.equal((await fourth.request('/api/v1/apps/verify_credentials', undefined, userToken)).status, 200);
	await fourth.stop();
});
