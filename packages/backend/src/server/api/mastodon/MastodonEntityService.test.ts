/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { parse as mfmParse } from 'mfm-js';
import { describe, expect, test, vi } from 'vitest';
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

	test('converts profile, account, and credential account with consistent Mastodon 4.6 fields', () => {
		const profile = service.profile(user as never);
		const account = service.account(user as never);
		const credential = service.credentialAccount(user as never);

		expect(profile).toEqual({
			id: 'user-id',
			display_name: 'Alice',
			note: 'Hello **world**',
			fields: [{ name: 'site', value: 'https://example.com' }],
			formatted_note: expect.any(String),
			formatted_fields: [{ name: 'site', value: expect.any(String) }],
			avatar: 'https://cdn.example/avatar.png',
			avatar_static: 'https://cdn.example/avatar.png',
			avatar_description: '',
			header: 'https://cdn.example/banner.png',
			header_static: 'https://cdn.example/banner.png',
			header_description: '',
			locked: true,
			bot: false,
			hide_collections: false,
			discoverable: true,
			indexable: false,
			show_media: true,
			show_media_replies: true,
			show_featured: true,
			attribution_domains: [],
			featured_tags: [],
		});
		expect(service.profile({ ...user, avatarUrl: null, bannerUrl: null } as never)).toMatchObject({
			avatar: null,
			avatar_static: null,
			header: null,
			header_static: null,
		});
		expect(account).toMatchObject({
			avatar_description: '',
			header_description: '',
			show_media: true,
			show_media_replies: true,
			show_featured: true,
			feature_approval: { automatic: [], manual: [], current_user: null },
		});
		expect(credential.source).toMatchObject({
			hide_collections: false,
			discoverable: true,
			indexable: false,
			attribution_domains: [],
			quote_policy: 'public',
		});
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
		expect(service.tag('Fediverse', { following: true, featuring: false })).toEqual({
			id: 'fediverse',
			name: 'Fediverse',
			url: 'https://misskey.example/tags/Fediverse',
			history: [],
			following: true,
			featuring: false,
		});
	});

	test('converts featured-tag state and bounded note statistics', () => {
		expect(service.featuredTag(
			{ id: 'state-id', name: 'fediverse' },
			'https://misskey.example/@alice',
			{ statusesCount: 3, lastStatusAt: '2026-07-17' },
		)).toEqual({
			id: 'state-id',
			name: 'fediverse',
			url: 'https://misskey.example/@alice/tagged/fediverse',
			statuses_count: '3',
			last_status_at: '2026-07-17',
		});
	});

	test('converts the persisted abuse record to the Mastodon Report entity', () => {
		const report = service.report({
			id: 'report-id',
			resolved: false,
			forwarded: true,
		} as never, '2026-07-16T01:02:03.000Z', user as never, {
			accountId: 'user-id',
			comment: 'Please review this account.',
			category: 'violation',
			statusIds: ['status-1'],
			ruleIds: ['rule-1'],
			collectionIds: ['collection-1'],
			forwardToDomains: ['moderation.example'],
			forward: true,
		});

		expect(report).toEqual({
			id: 'report-id',
			action_taken: false,
			action_taken_at: null,
			category: 'violation',
			comment: 'Please review this account.',
			forwarded: true,
			created_at: '2026-07-16T01:02:03.000Z',
			status_ids: ['status-1'],
			rule_ids: ['rule-1'],
			collection_ids: ['collection-1'],
			target_account: expect.objectContaining({ id: 'user-id', username: 'alice' }),
		});
	});

	test('converts a Misskey announcement to Mastodon without concatenating unescaped HTML', () => {
		const toHtml = vi.fn().mockReturnValue('<p>safe announcement</p>');
		const announcementService = new MastodonEntityService(
			{ url: 'https://misskey.example/' } as never,
			{ toHtml } as never,
		);

		const announcement = announcementService.announcement({
			id: 'announcement-id',
			createdAt: '2026-07-15T01:02:03.000Z',
			updatedAt: '2026-07-16T04:05:06.000Z',
			title: 'Notice <script>',
			text: 'Body **bold**',
			isRead: true,
		} as never);

		expect(toHtml).toHaveBeenCalledWith(mfmParse('Notice <script>\n\nBody **bold**'));
		expect(announcement).toEqual({
			id: 'announcement-id',
			content: '<p>safe announcement</p>',
			starts_at: null,
			ends_at: null,
			all_day: false,
			published_at: '2026-07-15T01:02:03.000Z',
			updated_at: '2026-07-16T04:05:06.000Z',
			read: true,
			mentions: [],
			statuses: [],
			tags: [],
			emojis: [],
			reactions: [],
		});
		expect(announcementService.announcement({
			id: 'unread-announcement-id',
			createdAt: '2026-07-15T01:02:03.000Z',
			updatedAt: null,
			title: 'Unread',
			text: 'Announcement',
		} as never)).toMatchObject({
			updated_at: '2026-07-15T01:02:03.000Z',
			read: false,
		});
	});

	test('converts a scheduled Note draft to a complete Mastodon ScheduledStatus', () => {
		const draft = {
			id: 'draft-id',
			isActuallyScheduled: true,
			scheduledAt: Date.parse('2099-01-02T03:04:05.000Z'),
			text: 'Scheduled text',
			fileIds: ['file-id'],
			files: note.files,
			cw: 'CW',
			visibility: 'home',
			replyId: 'reply-id',
			renoteId: 'quote-id',
			poll: {
				choices: ['A', 'B'],
				multiple: true,
				expiredAfter: 3500,
			},
		};

		expect(service.scheduledStatus(draft as never)).toEqual({
			id: 'draft-id',
			scheduled_at: '2099-01-02T03:04:05.000Z',
			params: {
				text: 'Scheduled text',
				media_ids: ['file-id'],
				sensitive: true,
				spoiler_text: 'CW',
				visibility: 'unlisted',
				in_reply_to_id: 'reply-id',
				language: null,
				application_id: null,
				poll: {
					options: ['A', 'B'],
					multiple: true,
					expires_in: 4,
				},
				idempotency: null,
				with_rate_limit: false,
				quoted_status_id: 'quote-id',
				quote_approval_policy: 'nobody',
			},
			media_attachments: [expect.objectContaining({ id: 'file-id', type: 'image', description: 'alt text' })],
		});
		expect(() => service.scheduledStatus({ ...draft, isActuallyScheduled: false } as never)).toThrow('scheduled Note draft');
		expect(() => service.scheduledStatus({ ...draft, scheduledAt: null } as never)).toThrow('scheduled Note draft');
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
		expect(status).toMatchObject({
			quotes_count: 0,
			tagged_collections: [],
			quote_approval: { automatic: ['public'], manual: [], current_user: null },
			filtered: [],
		});
	});

	test('wraps quoted statuses in the Mastodon 4.6 quote envelope without recursive expansion', () => {
		const quoted = {
			...note,
			id: 'quoted-note-id',
			text: 'Quoted note',
			renoteId: null,
			renote: null,
		};
		const status = service.status({
			...note,
			text: 'My comment',
			renoteId: quoted.id,
			renote: quoted,
		} as never);

		expect(status.quote).toEqual({
			state: 'accepted',
			quoted_status: expect.objectContaining({
				id: 'quoted-note-id',
				quote: null,
				reblog: null,
			}),
		});
	});

	test('converts stored Note revisions oldest-to-newest and includes the current revision', () => {
		const edits = service.statusEdits({
			...note,
			history: [
				{ createdAt: '2025-02-03T03:00:00.000Z', text: 'Second', cw: null },
				{ createdAt: '2025-02-03T02:00:00.000Z', text: 'First', cw: 'Old CW' },
			],
		} as never);

		expect(edits.map(edit => edit.created_at)).toEqual([
			'2025-02-03T02:00:00.000Z',
			'2025-02-03T03:00:00.000Z',
			'2025-02-03T05:05:06.000Z',
		]);
		expect(edits[0]).toMatchObject({
			account: expect.objectContaining({ id: 'user-id' }),
			content: expect.any(String),
			spoiler_text: 'Old CW',
			sensitive: false,
			media_attachments: [],
			emojis: [],
		});
		expect(edits[0]).not.toHaveProperty('poll');
		expect(edits[0]).not.toHaveProperty('quote');
		expect(edits.at(-1)).toMatchObject({
			spoiler_text: 'CW',
			sensitive: true,
			media_attachments: [expect.objectContaining({ id: 'file-id' })],
			poll: expect.objectContaining({ id: 'note-id' }),
		});
	});

	test('converts native translation results to Mastodon Translation', () => {
		expect(service.translation({ sourceLang: 'JA', text: 'Translated **text**' }, 'en')).toEqual({
			detected_source_language: 'JA',
			language: 'en',
			provider: null,
			spoiler_text: '',
			content: expect.any(String),
			poll: null,
			media_attachments: [],
		});
	});

	test('groups complete daily charts into twelve weeks and documents unavailable logins as zero', () => {
		const notes = { local: { inc: Array.from({ length: 84 }, (_, index) => index + 1) } };
		const users = { local: { inc: Array.from({ length: 84 }, () => 2) } };
		const activity = service.instanceActivity(notes, users, new Date('2026-07-16T18:00:00.000Z'));

		expect(activity).toHaveLength(12);
		expect(activity[0]).toEqual({
			week: (Date.UTC(2026, 6, 10) / 1000).toString(),
			statuses: '28',
			logins: '0',
			registrations: '14',
		});
		expect(activity[1]).toMatchObject({ statuses: '77', logins: '0', registrations: '14' });
		expect(service.instanceActivity({ local: { inc: [] } }, { local: { inc: [] } })).toEqual([]);
		expect(service.instanceActivity(notes, { local: { inc: users.local.inc.slice(1) } })).toEqual([]);
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
		expect(service.notification({
			id: 'quote-notification-id',
			createdAt: '2025-02-03T06:00:00.000Z',
			type: 'quote',
			user,
			note,
		} as never)).toMatchObject({ id: 'quote-notification-id', type: 'quote', status: { id: 'note-id' } });
		expect(service.notification({ id: 'ignored', type: 'achievementEarned' } as never)).toBeNull();
	});
});
