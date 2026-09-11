/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { parse as parseMfm } from 'mfm-js';
import type { MfmNode } from 'mfm-js';
import type { Json, StatusOptions } from './types.js';

const epoch = new Date(0).toISOString();

function object(value: unknown): value is Json {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function id(value: unknown): string {
	if (typeof value !== 'string' || value === '') throw new TypeError('A native entity ID must be a non-empty string');
	return value;
}

function optionalId(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

function count(value: unknown): number {
	const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : 0;
	return Number.isFinite(number) && number > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number)) : 0;
}

function dimension(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function date(value: unknown, fallback: string | null = null): string | null {
	if (typeof value !== 'string' && !(value instanceof Date)) return fallback;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function isFavouriteReaction(reaction: unknown): boolean {
	return typeof reaction === 'string' && reaction.replace(/\ufe0f/gu, '') === '\u2764';
}

export class EntityConverter {
	readonly publicUrl: string;
	private readonly host: string;

	constructor(publicUrl: string) {
		const url = new URL(publicUrl);
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new TypeError('The public URL must be an HTTP(S) URL');
		this.publicUrl = url.origin;
		this.host = url.host;
	}

	account(user: Json, credential = false): Json {
		const userId = id(user.id);
		const username = text(user.username, userId);
		const host = this.validHost(user.host);
		const localUrl = new URL(`/@${encodeURIComponent(username)}`, this.publicUrl).toString();
		const fallbackUrl = host == null ? localUrl : new URL(`/@${encodeURIComponent(username)}`, `https://${host}`).toString();
		const url = this.safeUrl(user.url) ?? this.safeUrl(user.uri) ?? fallbackUrl;
		const avatar = this.safeUrl(user.avatarUrl) ?? new URL(`/avatar/@${encodeURIComponent(host == null ? username : `${username}@${host}`)}`, this.publicUrl).toString();
		const header = this.safeUrl(user.bannerUrl) ?? new URL('/static-assets/user-unknown.png', this.publicUrl).toString();
		const fields = Array.isArray(user.fields) ? user.fields.filter(object).map(field => ({ name: text(field.name), value: text(field.value) })) : [];
		const result: Json = {
			id: userId,
			username,
			acct: host == null ? username : `${username}@${host}`,
			display_name: text(user.name, username),
			locked: user.isLocked === true,
			bot: user.isBot === true,
			discoverable: typeof user.isExplorable === 'boolean' ? user.isExplorable : null,
			indexable: false,
			group: false,
			created_at: date(user.createdAt, epoch),
			note: this.render(text(user.description), host),
			url,
			uri: this.safeUrl(user.uri) ?? url,
			avatar,
			avatar_static: avatar,
			avatar_description: '',
			header,
			header_static: header,
			header_description: '',
			followers_count: count(user.followersCount),
			following_count: count(user.followingCount),
			statuses_count: count(user.notesCount),
			last_status_at: date(user.lastPostedAt)?.slice(0, 10) ?? null,
			hide_collections: user.followersVisibility === 'private' || user.followingVisibility === 'private',
			noindex: user.noCrawle === true,
			emojis: this.emojis(user.emojis),
			roles: [],
			fields: fields.map(field => ({ name: field.name, value: this.render(field.value, host), verified_at: null })),
		};
		if (user.isSuspended === true) result.suspended = true;
		if (user.isDeleted === true) result.limited = true;
		if (credential) {
			result.source = {
				privacy: 'public',
				sensitive: user.alwaysMarkNsfw === true,
				language: typeof user.lang === 'string' ? user.lang : null,
				note: text(user.description),
				fields,
				follow_requests_count: count(user.pendingReceivedFollowRequestsCount),
				hide_collections: result.hide_collections,
				discoverable: user.isExplorable === true,
				indexable: false,
				attribution_domains: [],
				quote_policy: 'public',
			};
			result.role = null;
		}
		return result;
	}

	status(note: Json, options: StatusOptions = {}): Json | null {
		return this.statusEntity(note, options, new Set(), 0);
	}

	notification(notification: Json): Json | null {
		const types: Record<string, string> = {
			mention: 'mention', reply: 'mention', quote: 'quote', note: 'status', renote: 'reblog',
			reaction: 'favourite', follow: 'follow', followRequestAccepted: 'follow', receiveFollowRequest: 'follow_request', pollEnded: 'poll',
		};
		const type = types[text(notification.type)];
		if (type == null || !object(notification.user)) return null;
		if (notification.type === 'reaction' && !isFavouriteReaction(notification.reaction)) return null;
		const status = object(notification.note) ? this.status(notification.note) : null;
		if (['mention', 'quote', 'status', 'reblog', 'favourite', 'poll'].includes(type) && status == null) return null;
		return {
			id: id(notification.id),
			type,
			created_at: date(notification.createdAt, epoch),
			account: this.account(notification.user),
			...(status == null ? {} : { status }),
		};
	}

	attachment(file: Json): Json {
		const fileId = id(file.id);
		const properties = object(file.properties) ? file.properties : {};
		const width = dimension(properties.width);
		const height = dimension(properties.height);
		const aspect = width == null || height == null ? null : width / height;
		const mime = text(file.type);
		const type = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'unknown';
		const url = this.safeUrl(file.url);
		return {
			id: fileId,
			type,
			url,
			preview_url: this.safeUrl(file.thumbnailUrl) ?? url,
			remote_url: null,
			preview_remote_url: null,
			text_url: null,
			description: typeof file.comment === 'string' ? file.comment : null,
			blurhash: typeof file.blurhash === 'string' ? file.blurhash : null,
			meta: {
				original: { width, height, aspect, size: width == null || height == null ? '' : `${width}x${height}` },
				small: { width, height, aspect },
				...(dimension(properties.duration) == null ? {} : { duration: properties.duration }),
			},
		};
	}

	poll(note: Json, votersCount?: number): Json | null {
		if (!object(note.poll)) return null;
		const poll = note.poll;
		const choices = Array.isArray(poll.choices) ? poll.choices.filter(object) : [];
		const votes = choices.reduce((total, choice) => total + count(choice.votes), 0);
		const ownVotes = choices.flatMap((choice, index) => choice.isVoted === true ? [index] : []);
		const expiresAt = date(poll.expiresAt);
		return {
			id: id(note.id),
			expires_at: expiresAt,
			expired: expiresAt != null && new Date(expiresAt).getTime() <= Date.now(),
			multiple: poll.multiple === true,
			votes_count: votes,
			voters_count: poll.multiple === true ? (votersCount == null ? null : count(votersCount)) : votes,
			voted: ownVotes.length > 0,
			own_votes: ownVotes,
			options: choices.map(choice => ({ title: text(choice.text), votes_count: count(choice.votes) })),
			emojis: this.emojis(note.emojis),
		};
	}

	relationship(user: Json): Json {
		return {
			id: id(user.id),
			following: user.isFollowing === true,
			showing_reblogs: user.isRenoteMuted !== true,
			notifying: user.notify === 'normal',
			languages: [],
			followed_by: user.isFollowed === true,
			blocking: user.isBlocking === true,
			blocked_by: user.isBlocked === true,
			muting: user.isMuted === true,
			muting_notifications: user.isMuted === true,
			requested: user.hasPendingFollowRequestFromYou === true,
			requested_by: user.hasPendingFollowRequestToYou === true,
			domain_blocking: false,
			endorsed: false,
			note: text(user.memo),
		};
	}

	instance(meta: Json, stats: Json = {}, version: 1 | 2 = 2): Json {
		const streaming = new URL('/api/v1/streaming', this.publicUrl);
		streaming.protocol = streaming.protocol === 'https:' ? 'wss:' : 'ws:';
		const image = this.safeUrl(meta.bannerUrl) ?? this.safeUrl(meta.iconUrl) ?? new URL('/favicon.ico', this.publicUrl).toString();
		const rules = Array.isArray(meta.serverRules) ? meta.serverRules.filter((rule: unknown): rule is string => typeof rule === 'string').map((rule: string, index: number) => ({ id: `${index + 1}`, text: rule, hint: '' })) : [];
		const configuration = {
			urls: { streaming: streaming.toString() },
			vapid: { public_key: text(meta.vapidPublicKey) },
			accounts: { max_pinned_statuses: count(meta.policies?.pinLimit) || 5 },
			statuses: { max_characters: count(meta.maxNoteTextLength) || 3000, max_media_attachments: count(meta.maxNoteFiles) || 16, characters_reserved_per_url: 23 },
			media_attachments: {
				supported_mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/ogg', 'video/mp4', 'video/webm'],
				image_size_limit: count(meta.maxFileSize) || 10 * 1024 * 1024,
				video_size_limit: count(meta.maxFileSize) || 10 * 1024 * 1024,
			},
			polls: { max_options: 10, max_characters_per_option: 50, min_expiration: 300, max_expiration: 2629746 },
		};
		const common = {
			title: text(meta.name, this.host),
			version: `4.3.0 (compatible; Misskey ${text(meta.version, 'unknown')})`,
			description: text(meta.description),
			languages: Array.isArray(meta.langs) ? meta.langs.filter((lang: unknown) => typeof lang === 'string') : [],
			configuration,
			rules,
		};
		if (version === 1) return {
			...common,
			uri: this.host,
			short_description: text(meta.description),
			email: text(meta.maintainerEmail),
			urls: { streaming_api: streaming.toString() },
			stats: { user_count: count(stats.originalUsersCount ?? stats.usersCount), status_count: count(stats.originalNotesCount ?? stats.notesCount), domain_count: count(stats.instancesCount) },
			thumbnail: image,
			registrations: meta.disableRegistration !== true,
			approval_required: meta.approvalRequiredForSignup === true,
			invites_enabled: false,
			contact_account: null,
		};
		return {
			...common,
			domain: this.host,
			api_versions: { mastodon: 1 },
			source_url: this.safeUrl(meta.repositoryUrl) ?? 'https://github.com/misskey-dev/misskey',
			usage: { users: { active_month: count(stats.activeUsersCount) } },
			thumbnail: { url: image },
			registrations: { enabled: meta.disableRegistration !== true, approval_required: meta.approvalRequiredForSignup === true, reason_required: meta.approvalRequiredForSignup === true, message: null },
			contact: { email: text(meta.maintainerEmail), account: null },
		};
	}

	/** A small, explicit HTML vocabulary. MFM arguments and user HTML never become markup. */
	render(value: string, defaultHost: string | null = null): string {
		if (value === '') return '';
		let nodes: MfmNode[];
		try {
			nodes = parseMfm(value, { nestLimit: 12 });
		} catch {
			return `<p>${escapeHtml(value).replace(/\r?\n/gu, '<br>')}</p>`;
		}
		const renderInline = (node: MfmNode): string => {
			switch (node.type) {
				case 'text': return escapeHtml(node.props.text).replace(/\r?\n/gu, '<br>');
				case 'unicodeEmoji': return escapeHtml(node.props.emoji);
				case 'emojiCode': return escapeHtml(`:${node.props.name}:`);
				case 'inlineCode': return `<code>${escapeHtml(node.props.code)}</code>`;
				case 'mathInline': return `<code>${escapeHtml(node.props.formula)}</code>`;
				case 'bold': return `<strong>${node.children.map(renderInline).join('')}</strong>`;
				case 'italic': return `<em>${node.children.map(renderInline).join('')}</em>`;
				case 'strike': return `<del>${node.children.map(renderInline).join('')}</del>`;
				case 'small': return `<small>${node.children.map(renderInline).join('')}</small>`;
				case 'plain': return node.children.map(renderInline).join('');
				case 'fn': return node.children.map(renderInline).join('');
				case 'url': return this.anchor(node.props.url, escapeHtml(node.props.url));
				case 'link': return this.anchor(node.props.url, node.children.map(renderInline).join(''));
				case 'mention': {
					const host = this.validHost(node.props.host) ?? defaultHost;
					const acct = host == null ? node.props.username : `${node.props.username}@${host}`;
					const url = new URL(`/@${encodeURIComponent(node.props.username)}`, host == null ? this.publicUrl : `https://${host}`).toString();
					return this.anchor(url, `@<span>${escapeHtml(acct)}</span>`, 'u-url mention');
				}
				case 'hashtag': return this.anchor(new URL(`/tags/${encodeURIComponent(node.props.hashtag)}`, this.publicUrl).toString(), `#<span>${escapeHtml(node.props.hashtag)}</span>`, 'mention hashtag');
				case 'search': return escapeHtml(node.props.content);
				case 'blockCode': return `<pre><code>${escapeHtml(node.props.code)}</code></pre>`;
				case 'mathBlock': return `<pre>${escapeHtml(node.props.formula)}</pre>`;
				case 'quote': return `<blockquote>${renderNodes(node.children)}</blockquote>`;
				case 'center': return `<p>${node.children.map(renderInline).join('')}</p>`;
			}
		};
		const renderNodes = (items: MfmNode[]): string => {
			let output = '';
			let inline = '';
			for (const node of items) {
				if (['quote', 'blockCode', 'mathBlock', 'center'].includes(node.type)) {
					if (inline !== '') output += `<p>${inline}</p>`;
					inline = '';
					output += renderInline(node);
				} else inline += renderInline(node);
			}
			return output + (inline === '' ? '' : `<p>${inline}</p>`);
		};
		return renderNodes(nodes);
	}

	private statusEntity(note: Json, options: StatusOptions, seen: Set<string>, depth: number): Json | null {
		if (!this.visible(note, options) || !object(note.user)) return null;
		const noteId = id(note.id);
		if (seen.has(noteId)) return null;
		const path = new Set(seen).add(noteId);
		const maximum = Math.max(0, Math.min(8, options.maxDepth ?? 2));
		const hasRenote = object(note.renote);
		const pure = hasRenote && note.text == null && note.cw == null && (note.files?.length ?? 0) === 0 && note.poll == null && note.replyId == null;
		const renote = hasRenote && depth < maximum ? this.statusEntity(note.renote, options, path, depth + 1) : null;
		if (pure && renote == null) return null;
		const fallback = new URL(`/notes/${encodeURIComponent(noteId)}`, this.publicUrl).toString();
		const url = this.safeUrl(note.url) ?? this.safeUrl(note.uri) ?? fallback;
		const files = Array.isArray(note.files) ? note.files.filter(object) : [];
		const voterCount = typeof options.votersCount === 'number' ? (depth === 0 ? options.votersCount : undefined) : options.votersCount?.get(noteId);
		return {
			id: noteId,
			created_at: date(note.createdAt, epoch),
			edited_at: date(note.updatedAt),
			in_reply_to_id: optionalId(note.replyId),
			in_reply_to_account_id: object(note.reply) && note.reply.isHidden !== true ? optionalId(note.reply.userId ?? note.reply.user?.id) : null,
			sensitive: files.some(file => file.isSensitive === true) || note.channel?.isSensitive === true,
			spoiler_text: text(note.cw),
			visibility: ({ public: 'public', home: 'unlisted', followers: 'private', specified: 'direct' } as Record<string, string>)[text(note.visibility)] ?? 'direct',
			language: null,
			uri: this.safeUrl(note.uri) ?? url,
			url,
			replies_count: count(note.repliesCount),
			reblogs_count: count(note.renoteCount),
			favourites_count: object(note.reactions) ? Object.entries(note.reactions).reduce((total, [reaction, value]) => total + (isFavouriteReaction(reaction) ? count(value) : 0), 0) : 0,
			quotes_count: count(note.quoteCount),
			content: this.render(text(note.text), this.validHost(note.user.host)),
			reblog: pure ? renote : null,
			quote: !pure && renote != null ? { state: 'accepted', quoted_status: renote } : null,
			application: null,
			account: this.account(note.user),
			media_attachments: files.map(file => this.attachment(file)),
			mentions: this.mentions(note),
			tags: Array.isArray(note.tags) ? note.tags.filter((tag: unknown): tag is string => typeof tag === 'string').map((tag: string) => ({ name: tag, url: new URL(`/tags/${encodeURIComponent(tag)}`, this.publicUrl).toString() })) : [],
			emojis: this.emojis(note.emojis),
			card: null,
			poll: this.poll(note, voterCount),
			favourited: isFavouriteReaction(note.myReaction),
			reblogged: note.myRenoteId != null || note.isRenoted === true,
			muted: note.isThreadMuted === true,
			bookmarked: note.isFavorited === true,
			pinned: note.isPinned === true,
			filtered: [],
		};
	}

	private visible(note: Json, options: StatusOptions): boolean {
		if (note.isHidden === true || note.isDeleted === true || note.deletedAt != null) return false;
		if (options.allowLocalOnly === false && note.localOnly === true) return false;
		if ((options.viewerId === null || options.viewerId === '') && ['followers', 'specified'].includes(note.visibility)) return false;
		if (typeof options.viewerId === 'string' && note.visibility === 'specified' && note.userId !== options.viewerId && Array.isArray(note.visibleUserIds) && !note.visibleUserIds.includes(options.viewerId)) return false;
		return true;
	}

	private mentions(note: Json): Json[] {
		const ids: string[] = Array.isArray(note.mentions) ? note.mentions.filter((value: unknown): value is string => typeof value === 'string' && value !== '') : [];
		const mentions: Array<{ username: string; host: string | null }> = [];
		const seen = new Set<string>();
		const visit = (nodes: MfmNode[]): void => {
			for (const node of nodes) {
				if (node.type === 'mention') {
					const host = this.validHost(node.props.host) ?? this.validHost(note.user?.host);
					const key = `${node.props.username.toLowerCase()}@${host ?? this.host}`;
					if (!seen.has(key)) mentions.push({ username: node.props.username, host });
					seen.add(key);
				}
				if (node.children) visit(node.children);
			}
		};
		try { visit(parseMfm(text(note.text), { nestLimit: 12 })); } catch { return []; }
		// When names could not be matched unambiguously, do not fabricate an account identifier.
		if (ids.length !== mentions.length) return [];
		return ids.map((mentionId, index) => {
			const mention = mentions[index]!;
			return {
				id: mentionId,
				username: mention.username,
				acct: mention.host == null ? mention.username : `${mention.username}@${mention.host}`,
				url: new URL(`/@${encodeURIComponent(mention.username)}`, mention.host == null ? this.publicUrl : `https://${mention.host}`).toString(),
			};
		});
	}

	private emojis(value: unknown): Json[] {
		if (!object(value)) return [];
		return Object.entries(value).flatMap(([shortcode, source]) => {
			const url = this.safeUrl(typeof source === 'string' ? source : source?.url);
			return url == null ? [] : [{ shortcode, url, static_url: url, visible_in_picker: false }];
		});
	}

	private anchor(url: string, content: string, className?: string): string {
		const safe = this.safeUrl(url);
		if (safe == null) return content;
		return `<a href="${escapeHtml(safe)}" rel="nofollow noopener noreferrer"${className == null ? '' : ` class="${className}"`}>${content}</a>`;
	}

	private safeUrl(value: unknown): string | null {
		if (typeof value !== 'string' || value === '' || /[\u0000-\u001f\u007f]/u.test(value)) return null;
		try {
			const url = new URL(value, this.publicUrl);
			return ['https:', 'http:'].includes(url.protocol) && url.username === '' && url.password === '' ? url.toString() : null;
		} catch {
			return null;
		}
	}

	private validHost(value: unknown): string | null {
		if (typeof value !== 'string' || value === '') return null;
		try {
			const url = new URL(`https://${value}`);
			return url.pathname === '/' && url.username === '' && url.password === '' && url.search === '' && url.hash === '' ? url.host : null;
		} catch {
			return null;
		}
	}
}

export type { StatusOptions } from './types.js';
