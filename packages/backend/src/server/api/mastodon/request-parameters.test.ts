/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { describe, expect, test } from 'vitest';
import { normalizeMastodonParameters, parseMastodonForm, readMastodonRequestBody } from './request-parameters.js';

describe('Mastodon request parameters', () => {
	test('normalizes bracket arrays and nested fields without losing existing aliases', () => {
		const result = parseMastodonForm('redirect_uris[]=https%3A%2F%2Fclient.example%2Fcallback&poll[options][]=one&poll[options][]=two&poll[multiple]=false');
		expect(result).toMatchObject({
			redirect_uris: ['https://client.example/callback'],
			poll: { options: ['one', 'two'], multiple: 'false' },
			'redirect_uris[]': 'https://client.example/callback',
			'poll[options][]': ['one', 'two'],
		});
		expect(normalizeMastodonParameters(result)).toEqual(result);
	});

	test.each([
		['any%5B%5D=&any=activitypub', { any: ['activitypub', ''], 'any[]': '' }],
		['any%5B%5D=&any=%20%20&all=&none%5B%5D=%20', { any: ['  ', ''], all: '', none: [' '], 'none[]': ' ' }],
		['id=a&id[]=b&id[]=b', { id: ['a', 'b', 'b'], 'id[]': ['b', 'b'] }],
	])('merges scalar and bracket array aliases without changing repeated normalization: %s', (input, expected) => {
		const result = parseMastodonForm(input);
		expect(result).toMatchObject(expected);
		expect(normalizeMastodonParameters(result)).toEqual(result);
	});

	test('keeps nested push form parameters identical across repeated normalization', () => {
		const result = parseMastodonForm('subscription[endpoint]=https%3A%2F%2Fpush.example%2Fform&subscription[keys][p256dh]=public-key&subscription[keys][auth]=auth-key&data[policy]=followed&data[alerts][quote]=true');
		expect(result).toMatchObject({
			subscription: { endpoint: 'https://push.example/form', keys: { p256dh: 'public-key', auth: 'auth-key' } },
			data: { policy: 'followed', alerts: { quote: 'true' } },
		});
		expect(normalizeMastodonParameters(result)).toEqual(result);
	});

	test('groups unindexed hash arrays and preserves indexed attributes', () => {
		expect(parseMastodonForm('keywords_attributes[][keyword]=one&keywords_attributes[][keyword]=two&keywords_attributes[][whole_word]=true&keywords_attributes[][whole_word]=false')).toMatchObject({
			keywords_attributes: [{ keyword: 'one', whole_word: 'true' }, { keyword: 'two', whole_word: 'false' }],
		});
		expect(parseMastodonForm('fields_attributes[0][name]=website&fields_attributes[0][value]=example')).toMatchObject({
			fields_attributes: { 0: { name: 'website', value: 'example' } },
		});
	});

	test('preserves JSON booleans, arrays, null and explicit empty values without mutation', () => {
		const original = { poll: { options: ['one', 'two'], multiple: false }, source: { language: null }, status: '' };
		const result = normalizeMastodonParameters(original);
		expect(result).toEqual(original);
		expect(result.poll).not.toBe(original.poll);
	});

	test.each([
		'__proto__[polluted]=true',
		'data[constructor][prototype][polluted]=true',
		'a[b][c][d][e][f][g][h][i]=too-deep',
		'poll=scalar&poll[options][]=one',
	])('rejects unsafe or conflicting parameters: %s', input => {
		expect(() => parseMastodonForm(input)).toThrow();
		expect(Object.prototype).not.toHaveProperty('polluted');
	});

	test('reads equivalent text multipart and JSON bodies', async () => {
		const server = Fastify();
		server.register(multipart);
		server.post('/text', request => readMastodonRequestBody(request));
		try {
			const form = new FormData();
			form.append('client_name', '日本語 App');
			form.append('redirect_uris[]', 'https://client.example/callback');
			form.append('redirect_uris[]', 'client://callback');
			const encoded = new Request('https://server.example/text', { method: 'POST', body: form });
			const response = await server.inject({
				method: 'POST', url: '/text',
				headers: { 'content-type': encoded.headers.get('content-type')! },
				payload: Buffer.from(await encoded.arrayBuffer()),
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({ client_name: '日本語 App', redirect_uris: ['https://client.example/callback', 'client://callback'] });
			const json = await server.inject({ method: 'POST', url: '/text', payload: { client_name: '日本語 App', redirect_uris: ['https://client.example/callback', 'client://callback'] } });
			expect(response.json()).toMatchObject(json.json());
		} finally {
			await server.close();
		}
	});

	test('rejects files on text endpoints without buffering them into request parameters', async () => {
		const server = Fastify();
		server.register(multipart);
		server.post('/text', request => readMastodonRequestBody(request));
		try {
			const form = new FormData();
			form.append('file', new Blob(['contents']), 'file.txt');
			const encoded = new Request('https://server.example/text', { method: 'POST', body: form });
			const response = await server.inject({ method: 'POST', url: '/text', headers: { 'content-type': encoded.headers.get('content-type')! }, payload: Buffer.from(await encoded.arrayBuffer()) });
			expect(response.statusCode).toBe(422);
		} finally {
			await server.close();
		}
	});
});
