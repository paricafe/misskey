/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EntityConverter, isFavouriteReaction } from '../src/entities.js';
import type { Json } from '../src/types.js';

const entities = new EntityConverter('https://social.example');
const user = { id: 'user-nonnumeric', username: 'alice', name: 'Alice', host: null };
const baseNote = { id: '18446744073709551617', userId: user.id, user, visibility: 'public', text: 'Hello', createdAt: '2026-09-11T00:00:00Z' };

function assertNoUndefined(value: unknown): void {
	assert.notEqual(value, undefined);
	if (value != null && typeof value === 'object') {
		for (const child of Object.values(value)) assertNoUndefined(child);
	}
}

test('produces complete account and credential-account JSON from a public user DTO', () => {
	const account = entities.account(user, true);
	assert.equal(account.id, user.id);
	assert.equal(account.username, 'alice');
	assert.equal(account.acct, 'alice');
	assert.equal(account.avatar, 'https://social.example/avatar/@alice');
	assert.equal(account.header, 'https://social.example/static-assets/user-unknown.png');
	assert.equal(account.followers_count, 0);
	assert.equal(account.note, '');
	assert.deepEqual(account.fields, []);
	assert.deepEqual(account.source.fields, []);
	assert.equal(account.source.note, '');
	const preferences = entities.account({ ...user, alwaysMarkNsfw: true, lang: 'ja' }, true).source;
	assert.equal(preferences.sensitive, true);
	assert.equal(preferences.language, 'ja');
	assertNoUndefined(account);
});

test('uses remote account identities and rejects executable image or profile URLs', () => {
	const account = entities.account({ ...user, host: 'REMOTE.example', url: 'javascript:alert(1)', avatarUrl: 'data:image/svg+xml,<svg/>', bannerUrl: 'file:///private/image', description: '<img src=x onerror=alert(1)>', fields: [{ name: '<name>', value: '[click](javascript:alert(1))' }] });
	assert.equal(account.acct, 'alice@remote.example');
	assert.equal(account.url, 'https://remote.example/@alice');
	assert.match(account.avatar, /^https:\/\/social\.example\//u);
	assert.ok(!account.note.includes('<img'));
	assert.ok(!account.fields[0].value.includes('href="javascript:'));
	assertNoUndefined(account);
});

test('IDs remain strings in every nested entity without numeric conversion', () => {
	const note = { ...baseNote, replyId: 'abc-reply', reply: { userId: '18446744073709551619' }, files: [{ id: 'media+opaque', type: 'image/png', url: 'https://cdn.example/file' }], poll: { multiple: false, choices: [{ text: 'One', votes: 1, isVoted: true }] } };
	const status = entities.status(note)!;
	assert.equal(status.id, '18446744073709551617');
	assert.equal(status.account.id, 'user-nonnumeric');
	assert.equal(status.in_reply_to_id, 'abc-reply');
	assert.equal(status.in_reply_to_account_id, '18446744073709551619');
	assert.equal(status.media_attachments[0].id, 'media+opaque');
	assert.equal(status.poll.id, status.id);
	assert.equal(JSON.parse(JSON.stringify(status)).id, status.id);
	assertNoUndefined(status);
	assert.throws(() => entities.account({ ...user, id: 123 }), /non-empty string/u);
});

test('supplies required status defaults instead of undefined fields', () => {
	const status = entities.status(baseNote)!;
	for (const key of ['replies_count', 'reblogs_count', 'favourites_count']) assert.equal(status[key], 0);
	for (const key of ['media_attachments', 'mentions', 'tags', 'emojis', 'filtered']) assert.deepEqual(status[key], []);
	for (const key of ['reblog', 'quote', 'application', 'poll', 'card', 'edited_at', 'language']) assert.equal(status[key], null);
	assert.equal(status.created_at, '2026-09-11T00:00:00.000Z');
	assert.equal(status.url, 'https://social.example/notes/18446744073709551617');
	assert.equal(status.content, '<p>Hello</p>');
	assertNoUndefined(status);
});

test('maps only Unicode hearts to favourites, never another native emoji', () => {
	const status = entities.status({ ...baseNote, myReaction: '👍', reactions: { '❤': 2, '❤️': 3, '👍': 20, ':heart:': 10 } })!;
	assert.equal(status.favourited, false);
	assert.equal(status.favourites_count, 5);
	for (const reaction of ['❤', '❤️']) assert.equal(entities.status({ ...baseNote, myReaction: reaction })?.favourited, true);
	for (const reaction of ['❤️‍🔥', ':heart:', null, undefined, 1]) assert.equal(isFavouriteReaction(reaction), false);
});

test('renders supported MFM through an explicit safe HTML vocabulary', () => {
	const html = entities.render('**bold** *italic* ~~strike~~ `a < b`\n[link](https://safe.example/a?x=1&y=2) @bob #topic :custom:');
	assert.match(html, /<strong>bold<\/strong>/u);
	assert.match(html, /<em>italic<\/em>/u);
	assert.match(html, /<del>strike<\/del>/u);
	assert.match(html, /<code>a &lt; b<\/code>/u);
	assert.ok(html.includes('href="https://safe.example/a?x=1&amp;y=2"'));
	assert.ok(html.includes('href="https://social.example/@bob"'));
	assert.ok(html.includes('href="https://social.example/tags/topic"'));
	assert.ok(html.includes(':custom:'));
});

test('does not create active HTML from unsafe links, raw tags, or MFM function arguments', () => {
	const html = entities.render('<script>alert(1)</script> [x](javascript:alert(1)) [y](data:text/html,evil) $[xss.onclick=alert(1) safe]');
	assert.ok(!html.includes('<script'));
	assert.ok(!html.includes('href="javascript:'));
	assert.ok(!html.includes('href="data:'));
	assert.ok(!html.includes(' onclick='));
	assert.ok(html.includes('&lt;script&gt;'));
});

test('keeps block code as escaped text and renders quotes with safe descendants', () => {
	const html = entities.render('```html\n<img onerror="evil()">\n```\n\n> **quoted**');
	assert.ok(html.includes('<pre><code>'));
	assert.ok(html.includes('&lt;img onerror=&quot;evil()&quot;&gt;'));
	assert.ok(html.includes('<blockquote>'));
	assert.ok(!html.includes('<img'));
});

test('does not leak hidden roots, boosts, quotes, or direct statuses to anonymous viewers', () => {
	const hidden = { ...baseNote, id: 'secret', isHidden: true, text: 'private content', cw: 'private CW', files: [{ id: 'secret-file', url: 'https://cdn.example/private' }] };
	assert.equal(entities.status(hidden), null);
	assert.equal(entities.status({ ...baseNote, text: null, renote: hidden }), null);
	const quote = entities.status({ ...baseNote, text: 'Public comment', renote: hidden });
	assert.equal(quote?.quote, null);
	assert.ok(!JSON.stringify(quote).includes('private content'));
	assert.ok(!JSON.stringify(quote).includes('secret-file'));
	assert.equal(entities.status({ ...baseNote, visibility: 'followers' }, { viewerId: null }), null);
	assert.equal(entities.status({ ...baseNote, visibility: 'followers' }, { viewerId: '' }), null);
	assert.equal(entities.status({ ...baseNote, visibility: 'specified', visibleUserIds: ['bob'] }, { viewerId: 'charlie' }), null);
	assert.notEqual(entities.status({ ...baseNote, visibility: 'specified', visibleUserIds: ['bob'] }, { viewerId: user.id }), null);
});

test('recursively converts visible reblogs and quotes, terminating malformed cycles', () => {
	const original = { ...baseNote, id: 'original', text: 'Original' };
	const boost = entities.status({ ...baseNote, text: null, renote: original });
	assert.equal(boost?.reblog.id, 'original');
	assert.equal(boost?.reblog.content, '<p>Original</p>');
	const quote = entities.status({ ...baseNote, text: 'Comment', renote: original });
	assert.equal(quote?.quote.quoted_status.id, 'original');
	const cycle: Json = { ...baseNote, text: 'Cycle' };
	cycle.renote = cycle;
	assert.equal(entities.status(cycle)?.quote, null);
	assertNoUndefined(boost);
	assertNoUndefined(quote);
});

test('does not conflate poll votes and voters when multiple selections are possible', () => {
	const note = { ...baseNote, poll: { multiple: true, expiresAt: '2000-01-01T00:00:00Z', choices: [{ text: 'A', votes: 2, isVoted: true }, { text: 'B', votes: 2, isVoted: true }] } };
	const poll = entities.poll(note)!;
	assert.equal(poll.votes_count, 4);
	assert.equal(poll.voters_count, null);
	assert.equal(poll.expired, true);
	assert.deepEqual(poll.own_votes, [0, 1]);
	assert.equal(entities.status(note, { votersCount: new Map([[note.id, 3]]) })?.poll.voters_count, 3);
	assertNoUndefined(poll);
});

test('keeps follow and follow-request notifications that have no status', () => {
	for (const [nativeType, mastodonType] of [['follow', 'follow'], ['followRequestAccepted', 'follow'], ['receiveFollowRequest', 'follow_request']]) {
		const notification = entities.notification({ id: 'notification-opaque', type: nativeType, user, createdAt: '2026-09-11T00:00:00Z' });
		assert.equal(notification?.type, mastodonType);
		assert.equal(notification?.account.id, user.id);
		assert.equal(notification?.status, undefined);
		assertNoUndefined(notification);
	}
});

test('filters non-favourite emoji notifications and notifications whose required status is hidden', () => {
	assert.equal(entities.notification({ id: 'notification', type: 'reaction', reaction: '👍', user, note: baseNote }), null);
	assert.equal(entities.notification({ id: 'notification', type: 'mention', user, note: { ...baseNote, isHidden: true } }), null);
	assert.equal(entities.notification({ id: 'notification', type: 'reaction', reaction: '❤', user, note: baseNote })?.type, 'favourite');
	assert.equal(entities.notification({ id: 'notification', type: 'app', user }), null);
});

test('handles minimal attachments without dereferencing missing native properties', () => {
	const file = entities.attachment({ id: 'file-id', type: 'image/png', url: 'https://cdn.example/image.png' });
	assert.equal(file.url, file.preview_url);
	assert.equal(file.type, 'image');
	assert.equal(file.description, null);
	assert.equal(file.blurhash, null);
	assert.equal(file.meta.original.width, null);
	assertNoUndefined(file);
	assert.equal(entities.attachment({ id: 'unsafe-file', url: 'javascript:alert(1)' }).url, null);
});

test('maps native relationship state without claiming unsupported settings', () => {
	const relationship = entities.relationship({ ...user, isFollowing: true, isMuted: true, notify: 'normal', isRenoteMuted: true });
	assert.equal(relationship.following, true);
	assert.equal(relationship.muting_notifications, true);
	assert.equal(relationship.notifying, true);
	assert.equal(relationship.showing_reblogs, false);
	assertNoUndefined(relationship);
});

test('provides both instance entity versions with complete collection fields', () => {
	const meta = { name: 'Pari', version: 'test', description: 'A server', serverRules: ['Be kind'], disableRegistration: true };
	const first = entities.instance(meta, { originalUsersCount: 12, originalNotesCount: 50, instancesCount: 3 }, 1);
	assert.equal(first.uri, 'social.example');
	assert.equal(first.stats.user_count, 12);
	assert.equal(first.registrations, false);
	assert.equal(first.urls.streaming_api, 'wss://social.example/api/v1/streaming');
	const second = entities.instance(meta, {}, 2);
	assert.equal(second.domain, 'social.example');
	assert.equal(second.registrations.enabled, false);
	assert.equal(typeof second.thumbnail.url, 'string');
	assert.deepEqual(second.languages, []);
	assert.equal(second.rules[0].id, '1');
	assertNoUndefined(first);
	assertNoUndefined(second);
});
