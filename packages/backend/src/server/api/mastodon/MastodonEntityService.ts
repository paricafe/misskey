/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { parse as mfmParse } from 'mfm-js';
import { MfmService } from '@/core/MfmService.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import type { Packed } from '@/misc/json-schema.js';
import type { MiAbuseUserReport } from '@/models/AbuseUserReport.js';
import { extractMentions } from '@/misc/extract-mentions.js';
import type { MastodonReportInput } from './MastodonReportService.js';

type PackedUser = Packed<'UserLite'> & Partial<Packed<'UserDetailedNotMeOnly'>>;

@Injectable()
export class MastodonEntityService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		private mfmService: MfmService,
	) {}

	public account(user: PackedUser) {
		const host = user.host;
		const localUrl = new URL(`/@${user.username}`, this.config.url).toString();
		const url = host == null ? localUrl : user.url ?? user.uri ?? `https://${host}/@${user.username}`;
		const description = user.description ?? '';
		const fields = user.fields ?? [];
		const avatar = user.avatarUrl ?? new URL(`/avatar/@${encodeURIComponent(host == null ? user.username : `${user.username}@${host}`)}`, this.config.url).toString();
		const header = user.bannerUrl ?? new URL('/static-assets/user-unknown.png', this.config.url).toString();

		return {
			id: user.id,
			username: user.username,
			acct: host == null ? user.username : `${user.username}@${host}`,
			display_name: user.name ?? user.username,
			locked: user.isLocked ?? false,
			bot: user.isBot ?? false,
			discoverable: null,
			indexable: false,
			group: false,
			created_at: user.createdAt ?? new Date(0).toISOString(),
			note: this.render(description),
			url,
			uri: user.uri ?? url,
			avatar,
			avatar_static: avatar,
			avatar_description: '',
			header,
			header_static: header,
			header_description: '',
			followers_count: user.followersCount ?? 0,
			following_count: user.followingCount ?? 0,
			statuses_count: user.notesCount ?? 0,
			last_status_at: null,
			hide_collections: false,
			noindex: true,
			show_media: true,
			show_media_replies: true,
			show_featured: true,
			feature_approval: {
				automatic: [],
				manual: [],
				current_user: null,
			},
			emojis: this.emojis(user.emojis),
			roles: [],
			fields: fields.map(field => ({
				name: field.name,
				value: this.render(field.value),
				verified_at: user.verifiedLinks?.includes(field.value) ? user.createdAt ?? null : null,
			})),
		};
	}

	public profile(user: Packed<'MeDetailed'>) {
		const note = user.description ?? '';
		const fields = (user.fields ?? []).map(field => ({ name: field.name, value: field.value }));
		const formattedFields = fields.map(field => ({ name: field.name, value: this.render(field.value) }));

		return {
			id: user.id,
			display_name: user.name ?? user.username,
			note,
			fields,
			formatted_note: this.render(note),
			formatted_fields: formattedFields,
			avatar: user.avatarUrl ?? null,
			avatar_static: user.avatarUrl ?? null,
			avatar_description: '',
			header: user.bannerUrl ?? null,
			header_static: user.bannerUrl ?? null,
			header_description: '',
			locked: user.isLocked ?? false,
			bot: user.isBot ?? false,
			hide_collections: false,
			discoverable: user.isExplorable ?? false,
			indexable: false,
			show_media: true,
			show_media_replies: true,
			show_featured: true,
			attribution_domains: [],
			featured_tags: [],
		};
	}

	public credentialAccount(user: Packed<'MeDetailed'>) {
		return {
			...this.account(user),
			source: {
				privacy: 'public',
				sensitive: false,
				language: null,
				note: user.description ?? '',
				fields: (user.fields ?? []).map(field => ({ name: field.name, value: field.value })),
				follow_requests_count: 0,
				hide_collections: false,
				discoverable: user.isExplorable ?? false,
				indexable: false,
				attribution_domains: [],
				quote_policy: 'public',
			},
			role: null,
		};
	}

	public status(note: Packed<'Note'>): Record<string, unknown> {
		const localUrl = new URL(`/notes/${note.id}`, this.config.url).toString();
		const url = note.url ?? note.uri ?? localUrl;
		const files = note.files ?? [];
		const isPureRenote = note.renote != null && note.text == null && files.length === 0 && note.poll == null && note.replyId == null;

		return {
			id: note.id,
			created_at: note.createdAt,
			edited_at: note.updatedAt ?? null,
			in_reply_to_id: note.replyId ?? null,
			in_reply_to_account_id: note.reply?.userId ?? null,
			sensitive: files.some(file => file.isSensitive) || note.channel?.isSensitive === true,
			spoiler_text: note.cw ?? '',
			visibility: this.visibility(note.visibility),
			language: null,
			uri: note.uri ?? url,
			url,
			replies_count: note.repliesCount,
			reblogs_count: note.renoteCount,
			favourites_count: note.reactionCount,
			content: this.render(note.text ?? ''),
			reblog: isPureRenote ? this.status(note.renote!) : null,
			quote: !isPureRenote && note.renote != null ? this.status(note.renote) : null,
			application: null,
			account: this.account(note.user),
			media_attachments: files.map(file => this.attachment(file)),
			mentions: this.mentions(note),
			tags: (note.tags ?? []).map(tag => ({
				name: tag,
				url: new URL(`/tags/${encodeURIComponent(tag)}`, this.config.url).toString(),
			})),
			emojis: this.emojis(note.emojis),
			card: null,
			poll: note.poll == null ? null : this.poll(note.id, note.poll),
			favourited: note.myReaction != null,
			reblogged: false,
			muted: false,
			bookmarked: false,
			pinned: false,
			filtered: [],
		};
	}

	public attachment(file: Packed<'DriveFile'>) {
		const width = file.properties.width ?? null;
		const height = file.properties.height ?? null;
		const aspect = width != null && height != null && height !== 0 ? width / height : null;
		const type = file.type.startsWith('image/')
			? 'image'
			: file.type.startsWith('video/')
				? 'video'
				: file.type.startsWith('audio/')
					? 'audio'
					: 'unknown';

		return {
			id: file.id,
			type,
			url: file.url,
			preview_url: file.thumbnailUrl ?? file.url,
			remote_url: null,
			preview_remote_url: null,
			text_url: null,
			description: file.comment,
			blurhash: file.blurhash,
			width,
			height,
			meta: {
				original: { width, height, aspect },
				small: { width, height, aspect },
			},
		};
	}

	public relationship(user: PackedUser) {
		return {
			id: user.id,
			following: user.isFollowing ?? false,
			showing_reblogs: !(user.isRenoteMuted ?? false),
			notifying: user.notify === 'normal',
			languages: [],
			followed_by: user.isFollowed ?? false,
			blocking: user.isBlocking ?? false,
			blocked_by: user.isBlocked ?? false,
			muting: user.isMuted ?? false,
			muting_notifications: false,
			requested: user.hasPendingFollowRequestFromYou ?? false,
			domain_blocking: false,
			endorsed: false,
			note: user.memo ?? '',
		};
	}

	public notification(notification: Packed<'Notification'>) {
		const type = this.notificationType(notification.type);
		if (type == null || !('user' in notification) || notification.user == null) return null;

		const status = 'note' in notification && notification.note != null
			? this.status(notification.note)
			: undefined;
		if (['favourite', 'mention', 'reblog', 'poll', 'status'].includes(type) && status == null) return null;

		return {
			id: notification.id,
			type,
			created_at: notification.createdAt,
			account: this.account(notification.user),
			...(status != null ? { status } : {}),
		};
	}

	public list(list: { id: string; name: string }) {
		return {
			id: list.id,
			title: list.name,
			replies_policy: 'list',
			exclusive: false,
		};
	}

	public report(report: MiAbuseUserReport, createdAt: string, targetUser: PackedUser, input: MastodonReportInput) {
		return {
			id: report.id,
			action_taken: report.resolved,
			action_taken_at: null,
			category: input.category,
			comment: input.comment,
			forwarded: report.forwarded,
			created_at: createdAt,
			status_ids: input.statusIds,
			rule_ids: input.ruleIds,
			collection_ids: input.collectionIds,
			target_account: this.account(targetUser),
		};
	}

	public tag(name: string) {
		return {
			name,
			url: new URL(`/tags/${encodeURIComponent(name)}`, this.config.url).toString(),
			history: [],
		};
	}

	public trendLink(url: string) {
		return {
			url,
			title: url,
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
		};
	}

	public poll(noteId: string, poll: NonNullable<Packed<'Note'>['poll']>) {
		const votesCount = poll.choices.reduce((total, choice) => total + choice.votes, 0);
		const ownVotes = poll.choices.flatMap((choice, index) => choice.isVoted ? [index] : []);

		return {
			id: noteId,
			expires_at: poll.expiresAt,
			expired: poll.expiresAt != null && new Date(poll.expiresAt).getTime() <= Date.now(),
			multiple: poll.multiple,
			votes_count: votesCount,
			voters_count: votesCount,
			voted: ownVotes.length > 0,
			own_votes: ownVotes,
			options: poll.choices.map(choice => ({ title: choice.text, votes_count: choice.votes })),
			emojis: [],
		};
	}

	private emojis(emojis: Record<string, string> | undefined) {
		return Object.entries(emojis ?? {}).map(([shortcode, url]) => ({
			shortcode,
			url,
			static_url: url,
			visible_in_picker: false,
		}));
	}

	private mentions(note: Packed<'Note'>) {
		const ids = note.mentions ?? [];
		const parsed = extractMentions(mfmParse(note.text ?? ''));
		return ids.map((id, index) => {
			const mention = parsed[index];
			const username = mention?.username ?? id;
			const host = mention?.host ?? null;
			const acct = host == null ? username : `${username}@${host}`;
			return {
				id,
				username,
				acct,
				url: host == null
					? new URL(`/@${username}`, this.config.url).toString()
					: `https://${host}/@${username}`,
			};
		});
	}

	private render(text: string): string {
		return this.mfmService.toHtml(mfmParse(text)) ?? '';
	}

	private visibility(visibility: Packed<'Note'>['visibility']): 'public' | 'unlisted' | 'private' | 'direct' {
		switch (visibility) {
			case 'public': return 'public';
			case 'home': return 'unlisted';
			case 'followers': return 'private';
			case 'specified': return 'direct';
		}
	}

	private notificationType(type: Packed<'Notification'>['type']): string | null {
		if (['mention', 'reply', 'quote'].includes(type)) return 'mention';
		if (type === 'note') return 'status';
		if (type === 'renote' || type === 'renote:grouped') return 'reblog';
		if (type === 'reaction' || type === 'reaction:grouped') return 'favourite';
		if (type === 'follow' || type === 'followRequestAccepted') return 'follow';
		if (type === 'receiveFollowRequest') return 'follow_request';
		if (type === 'pollEnded') return 'poll';
		return null;
	}
}
