/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { MastodonEntityService } from './MastodonEntityService.js';

const user = {
	id: 'user-id',
	username: 'alice',
	host: null,
	name: 'Alice',
	avatarUrl: 'https://cdn.example/avatar.png',
	bannerUrl: 'https://cdn.example/banner.png',
	description: 'Hello **world**',
	fields: [{ name: 'site', value: 'https://example.com' }],
	followersCount: 12,
	followingCount: 3,
	notesCount: 42,
	createdAt: '2025-01-02T03:04:05.000Z',
	isLocked: true,
	isBot: false,
	isExplorable: true,
	emojis: { party: 'https://cdn.example/party.webp' },
};

const note = {
	id: 'note-id',
	createdAt: '2025-02-03T04:05:06.000Z',
	updatedAt: '2025-02-03T05:05:06.000Z',
	text: 'Hello #fediverse',
	cw: 'CW',
	userId: 'user-id',
	user,
	replyId: null,
	renoteId: null,
	visibility: 'home',
	files: [{
		id: 'file-id',
		type: 'image/png',
		url: 'https://cdn.example/image.png',
		thumbnailUrl: 'https://cdn.example/thumb.webp',
		comment: 'alt text',
		blurhash: 'blur',
		properties: { width: 800, height: 600 },
		isSensitive: true,
	}],
	tags: ['fediverse'],
	poll: {
		expiresAt: '2025-02-04T04:05:06.000Z',
		multiple: true,
		choices: [
			{ text: 'A', votes: 2, isVoted: true },
			{ text: 'B', votes: 1, isVoted: false },
		],
	},
	emojis: { party: 'https://cdn.example/party.webp' },
	reactions: { ':party:': 2, '👍': 3 },
	reactionCount: 5,
	renoteCount: 4,
	repliesCount: 2,
	myReaction: '👍',
};

describe(MastodonEntityService, () => {
	const service = new MastodonEntityService(
		{ url: 'https://misskey.example/' } as never,
		{ toHtml: (nodes: unknown) => `<p>${String(nodes)}</p>` } as never,
	);

	test('converts a Misskey user to a Mastodon account', () => {
		const account = service.account(user as never);

		expect(account).toMatchObject({
			id: 'user-id',
			username: 'alice',
			acct: 'alice',
			display_name: 'Alice',
			locked: true,
			url: 'https://misskey.example/@alice',
			avatar: 'https://cdn.example/avatar.png',
			header: 'https://cdn.example/banner.png',
			followers_count: 12,
			following_count: 3,
			statuses_count: 42,
		});
		expect(account.emojis).toEqual([expect.objectContaining({ shortcode: 'party' })]);
		expect(account.fields).toEqual([expect.objectContaining({ name: 'site', value: expect.any(String) })]);
	});

	test('uses an absolute local header fallback for an account without a banner', () => {
		const userWithoutBanner = {
			...user,
			bannerUrl: null,
		};
		const account = service.account(userWithoutBanner as never);

		expect(account.header).not.toBe('');
		expect(account.header_static).toBe(account.header);
		expect(new URL(account.header).origin).toBe('https://misskey.example');
	});

	test('converts a tag name to a Mastodon tag entity', () => {
		expect(service.tag('Fediverse')).toEqual({
			name: 'Fediverse',
			url: 'https://misskey.example/tags/Fediverse',
			history: [],
		});
	});

	test('converts a URL to a complete Mastodon trend link entity', () => {
		expect(service.trendLink('https://example.com/article')).toEqual({
			url: 'https://example.com/article',
			title: 'https://example.com/article',
			description: '',
			language: '',
			type: 'link',
			authors: [],
			author_name: '',
			author_url: '',
			provider_name: '',
			provider_url: '',
			html: '',
			width: 0,
			height: 0,
			image: null,
			image_description: '',
			embed_url: '',
			blurhash: null,
			published_at: null,
			history: [],
		});
	});

	test('returns credential source fields and status mentions required by Mastodon clients', () => {
		const credential = service.credentialAccount(user as never);
		expect(credential.source).toMatchObject({
			privacy: 'public',
			sensitive: false,
			note: 'Hello **world**',
			fields: [{ name: 'site', value: 'https://example.com' }],
		});

		const status = service.status({
			...note,
			text: 'Hi @bob@example.com',
			mentions: ['bob-id'],
		} as never);
		expect(status.mentions).toEqual([{
			id: 'bob-id',
			username: 'bob',
			acct: 'bob@example.com',
			url: 'https://example.com/@bob',
		}]);
	});

	test('converts a Misskey note, attachment, and poll to a Mastodon status', () => {
		const status = service.status(note as never);

		expect(status).toMatchObject({
			id: 'note-id',
			created_at: '2025-02-03T04:05:06.000Z',
			edited_at: '2025-02-03T05:05:06.000Z',
			spoiler_text: 'CW',
			visibility: 'unlisted',
			sensitive: true,
			url: 'https://misskey.example/notes/note-id',
			replies_count: 2,
			reblogs_count: 4,
			favourites_count: 5,
			favourited: true,
		});
		expect(status.media_attachments).toEqual([expect.objectContaining({
			id: 'file-id', type: 'image', description: 'alt text', width: 800, height: 600,
		})]);
		expect(status.poll).toMatchObject({ votes_count: 3, voters_count: 3, multiple: true, voted: true });
		expect(status.tags).toEqual([expect.objectContaining({ name: 'fediverse' })]);
	});

	test('exposes poll conversion for the poll retrieval route', () => {
		const poll = service.poll('note-id', note.poll as never);

		expect(poll).toMatchObject({
			id: 'note-id',
			votes_count: 3,
			voters_count: 3,
			multiple: true,
			voted: true,
			own_votes: [0],
			options: [
				{ title: 'A', votes_count: 2 },
				{ title: 'B', votes_count: 1 },
			],
		});
	});

	test('converts relation flags and supported notifications', () => {
		expect(service.relationship({
			...user,
			isFollowing: true,
			isFollowed: true,
			hasPendingFollowRequestFromYou: false,
			isBlocking: false,
			isMuted: true,
		} as never)).toMatchObject({ id: 'user-id', following: true, followed_by: true, muting: true });

		expect(service.notification({
			id: 'notification-id',
			createdAt: '2025-02-03T06:00:00.000Z',
			type: 'reaction',
			user,
			note,
		} as never)).toMatchObject({ id: 'notification-id', type: 'favourite', status: { id: 'note-id' } });
		expect(service.notification({
			id: 'status-notification-id',
			createdAt: '2025-02-03T06:00:00.000Z',
			type: 'note',
			user,
			note,
		} as never)).toMatchObject({ id: 'status-notification-id', type: 'status', status: { id: 'note-id' } });
		expect(service.notification({ id: 'ignored', type: 'achievementEarned' } as never)).toBeNull();
	});
});
