/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type MastodonContractAuth = 'public' | 'token' | 'user';
export type MastodonContractBehavior =
	| 'implemented'
	| 'safe-array'
	| 'safe-object'
	| 'singleton-not-found'
	| 'unsupported-write';

export interface MastodonContractRoute {
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	path: string;
	samplePath: string;
	auth: MastodonContractAuth;
	scope?: string | readonly string[];
	entity: string;
	introducedIn: string;
	behavior: MastodonContractBehavior;
	transport?: 'fastify' | 'websocket';
	fallbackBody?: readonly unknown[] | Readonly<Record<string, unknown>>;
	requiredBody?: readonly string[];
	requiredQuery?: readonly string[];
}

type Method = MastodonContractRoute['method'];
type Options = Omit<MastodonContractRoute, 'method' | 'path' | 'samplePath' | 'introducedIn'> & {
	introducedIn?: string;
};

const SAMPLE_PARAMETERS: Readonly<Record<string, string>> = {
	announcement_id: 'announcement-id',
	collection_id: 'collection-id',
	date: '2026-01-01',
	filter_id: 'filter-id',
	group_key: 'favourite-123',
	hashtag: 'misskey',
	id: 'resource-id',
	list_id: 'list-id',
	name: 'misskey',
	status_id: 'status-id',
	stream: 'user',
};

function samplePath(path: string): string {
	return path.replace(/:([a-z_]+)/giu, (_match, name: string) => SAMPLE_PARAMETERS[name] ?? `${name}-id`);
}

function route(method: Method, path: string, options: Options): MastodonContractRoute {
	const { introducedIn = '1.0.0', ...contract } = options;
	return {
		method,
		path,
		samplePath: samplePath(path),
		introducedIn,
		...contract,
	};
}

const implemented = (method: Method, path: string, auth: MastodonContractAuth, scope: Options['scope'], entity: string, introducedIn?: string, transport?: Options['transport']) => route(method, path, {
	auth,
	scope,
	entity,
	behavior: 'implemented',
	introducedIn,
	transport,
});
const safeArray = (method: Method, path: string, auth: MastodonContractAuth, scope: Options['scope'], entity: string, introducedIn?: string, fallbackBody?: readonly unknown[]) => route(method, path, {
	auth,
	scope,
	entity,
	behavior: 'safe-array',
	introducedIn,
	fallbackBody,
});
const safeObject = (method: Method, path: string, auth: MastodonContractAuth, scope: Options['scope'], entity: string, introducedIn?: string, fallbackBody?: Readonly<Record<string, unknown>>) => route(method, path, {
	auth,
	scope,
	entity,
	behavior: 'safe-object',
	introducedIn,
	fallbackBody,
});
const notFound = (method: Method, path: string, auth: MastodonContractAuth, scope: Options['scope'], entity: string, introducedIn?: string, requiredQuery?: readonly string[]) => route(method, path, {
	auth,
	scope,
	entity,
	behavior: 'singleton-not-found',
	introducedIn,
	requiredQuery,
});
const unsupported = (method: Method, path: string, auth: MastodonContractAuth, scope: Options['scope'], entity: string, introducedIn?: string, requiredBody?: readonly string[]) => route(method, path, {
	auth,
	scope,
	entity,
	behavior: 'unsupported-write',
	introducedIn,
	requiredBody,
});

const NOTIFICATION_POLICY = {
	for_not_following: 'accept',
	for_not_followers: 'accept',
	for_new_accounts: 'accept',
	for_private_mentions: 'filter',
	for_limited_accounts: 'filter',
	for_bots: 'accept',
	summary: {
		pending_requests_count: 0,
		pending_notifications_count: 0,
	},
} as const;

export const MASTODON_4_6_USER_ROUTES: readonly MastodonContractRoute[] = [
	// Root and streaming
	notFound('GET', '/api/oembed', 'public', undefined, 'OEmbed', '1.6.0', ['url']),
	implemented('GET', '/api/v1/streaming', 'user', 'read:statuses', 'StreamingEvent', '1.0.0', 'websocket'),
	implemented('GET', '/api/v1/streaming/:stream', 'user', 'read:statuses', 'StreamingEvent', '1.0.0', 'websocket'),

	// Statuses and timelines
	implemented('GET', '/api/v1/statuses', 'token', 'read:statuses', 'Status[]', '4.6.0'),
	implemented('POST', '/api/v1/statuses', 'user', 'write:statuses', 'Status', '1.0.0'),
	implemented('GET', '/api/v1/statuses/:id', 'public', 'read:statuses', 'Status'),
	implemented('PUT', '/api/v1/statuses/:id', 'user', 'write:statuses', 'Status', '3.5.0'),
	implemented('DELETE', '/api/v1/statuses/:id', 'user', 'write:statuses', 'Status'),
	implemented('GET', '/api/v1/statuses/:id/context', 'public', 'read:statuses', 'Context'),
	implemented('GET', '/api/v1/statuses/:id/reblogged_by', 'public', 'read:statuses', 'Account[]'),
	implemented('GET', '/api/v1/statuses/:id/favourited_by', 'public', 'read:statuses', 'Account[]'),
	implemented('GET', '/api/v1/statuses/:id/history', 'public', 'read:statuses', 'StatusEdit[]', '3.5.0'),
	implemented('GET', '/api/v1/statuses/:id/source', 'token', 'read:statuses', 'StatusSource', '3.5.0'),
	implemented('GET', '/api/v1/statuses/:id/quotes', 'token', 'read:statuses', 'Status[]', '4.6.0'),
	implemented('POST', '/api/v1/statuses/:id/reblog', 'user', 'write:statuses', 'Status'),
	implemented('POST', '/api/v1/statuses/:id/unreblog', 'user', 'write:statuses', 'Status'),
	implemented('POST', '/api/v1/statuses/:id/favourite', 'user', 'write:favourites', 'Status'),
	implemented('POST', '/api/v1/statuses/:id/unfavourite', 'user', 'write:favourites', 'Status'),
	implemented('POST', '/api/v1/statuses/:id/bookmark', 'user', 'write:bookmarks', 'Status', '3.1.0'),
	implemented('POST', '/api/v1/statuses/:id/unbookmark', 'user', 'write:bookmarks', 'Status', '3.1.0'),
	implemented('POST', '/api/v1/statuses/:id/mute', 'user', 'write:mutes', 'Status', '1.4.2'),
	implemented('POST', '/api/v1/statuses/:id/unmute', 'user', 'write:mutes', 'Status', '1.4.2'),
	implemented('POST', '/api/v1/statuses/:id/pin', 'user', 'write:accounts', 'Status', '1.6.0'),
	implemented('POST', '/api/v1/statuses/:id/unpin', 'user', 'write:accounts', 'Status', '1.6.0'),
	implemented('POST', '/api/v1/statuses/:id/translate', 'user', 'read:statuses', 'Translation', '4.0.0'),
	unsupported('POST', '/api/v1/statuses/:status_id/quotes/:id/revoke', 'user', 'write:statuses', 'Status', '4.6.0'),
	unsupported('PUT', '/api/v1/statuses/:id/interaction_policy', 'user', 'write:statuses', 'Status', '4.4.0'),
	implemented('GET', '/api/v1/timelines/home', 'user', 'read:statuses', 'Status[]'),
	implemented('GET', '/api/v1/timelines/public', 'public', 'read:statuses', 'Status[]'),
	safeArray('GET', '/api/v1/timelines/link', 'token', 'read:statuses', 'Status[]', '4.3.0'),
	implemented('GET', '/api/v1/timelines/tag/:tag', 'public', 'read:statuses', 'Status[]'),
	implemented('GET', '/api/v1/timelines/list/:id', 'user', 'read:statuses', 'Status[]', '2.1.0'),

	// Media, polls, and scheduled statuses
	implemented('POST', '/api/v1/media', 'user', 'write:media', 'MediaAttachment'),
	implemented('POST', '/api/v2/media', 'user', 'write:media', 'MediaAttachment', '3.2.0'),
	implemented('GET', '/api/v1/media/:id', 'user', 'write:media', 'MediaAttachment'),
	implemented('PUT', '/api/v1/media/:id', 'user', 'write:media', 'MediaAttachment'),
	implemented('DELETE', '/api/v1/media/:id', 'user', 'write:media', 'Object', '4.2.0'),
	implemented('GET', '/api/v1/polls/:id', 'public', 'read:statuses', 'Poll', '2.8.0'),
	implemented('POST', '/api/v1/polls/:id/votes', 'user', 'write:statuses', 'Poll', '2.8.0'),
	implemented('GET', '/api/v1/scheduled_statuses', 'user', 'read:statuses', 'ScheduledStatus[]', '2.7.0'),
	implemented('GET', '/api/v1/scheduled_statuses/:id', 'user', 'read:statuses', 'ScheduledStatus', '2.7.0'),
	implemented('PUT', '/api/v1/scheduled_statuses/:id', 'user', 'write:statuses', 'ScheduledStatus', '2.7.0'),
	implemented('DELETE', '/api/v1/scheduled_statuses/:id', 'user', 'write:statuses', 'Object', '2.7.0'),

	// Accounts and profile
	implemented('GET', '/api/v1/accounts', 'token', 'read:accounts', 'Account[]', '4.6.0'),
	unsupported('POST', '/api/v1/accounts', 'token', 'write:accounts', 'Token', '2.7.0', ['username', 'email', 'password', 'agreement']),
	implemented('GET', '/api/v1/accounts/:id', 'public', 'read:accounts', 'Account'),
	implemented('GET', '/api/v1/accounts/verify_credentials', 'user', 'read:accounts', 'CredentialAccount'),
	implemented('PATCH', '/api/v1/accounts/update_credentials', 'user', 'write:accounts', 'CredentialAccount'),
	implemented('GET', '/api/v1/accounts/search', 'user', 'read:accounts', 'Account[]'),
	implemented('GET', '/api/v1/accounts/lookup', 'user', 'read:accounts', 'Account'),
	implemented('GET', '/api/v1/accounts/relationships', 'user', 'read:follows', 'Relationship[]'),
	safeArray('GET', '/api/v1/accounts/familiar_followers', 'user', 'read:follows', 'FamiliarFollowers[]', '3.5.0'),
	implemented('GET', '/api/v1/accounts/:id/statuses', 'public', 'read:statuses', 'Status[]'),
	implemented('GET', '/api/v1/accounts/:id/followers', 'public', 'read:follows', 'Account[]'),
	implemented('GET', '/api/v1/accounts/:id/following', 'public', 'read:follows', 'Account[]'),
	implemented('GET', '/api/v1/accounts/:id/lists', 'user', 'read:lists', 'List[]'),
	safeArray('GET', '/api/v1/accounts/:id/identity_proofs', 'public', 'read:accounts', 'IdentityProof[]', '2.8.0'),
	implemented('GET', '/api/v1/accounts/:id/featured_tags', 'public', 'read:accounts', 'FeaturedTag[]', '3.3.0'),
	implemented('GET', '/api/v1/accounts/:id/endorsements', 'public', 'read:accounts', 'Account[]', '4.4.0'),
	safeArray('GET', '/api/v1/accounts/:id/collections', 'user', 'read:collections', 'Collection[]', '4.6.0'),
	safeArray('GET', '/api/v1/accounts/:id/in_collections', 'user', 'read:collections', 'Collection[]', '4.6.0'),
	implemented('POST', '/api/v1/accounts/:id/follow', 'user', 'write:follows', 'Relationship'),
	implemented('POST', '/api/v1/accounts/:id/unfollow', 'user', 'write:follows', 'Relationship'),
	implemented('POST', '/api/v1/accounts/:id/remove_from_followers', 'user', 'write:follows', 'Relationship', '3.5.0'),
	implemented('POST', '/api/v1/accounts/:id/block', 'user', 'write:blocks', 'Relationship'),
	implemented('POST', '/api/v1/accounts/:id/unblock', 'user', 'write:blocks', 'Relationship'),
	implemented('POST', '/api/v1/accounts/:id/mute', 'user', 'write:mutes', 'Relationship'),
	implemented('POST', '/api/v1/accounts/:id/unmute', 'user', 'write:mutes', 'Relationship'),
	implemented('POST', '/api/v1/accounts/:id/pin', 'user', 'write:accounts', 'Relationship', '2.5.0'),
	implemented('POST', '/api/v1/accounts/:id/endorse', 'user', 'write:accounts', 'Relationship', '4.4.0'),
	implemented('POST', '/api/v1/accounts/:id/unpin', 'user', 'write:accounts', 'Relationship', '2.5.0'),
	implemented('POST', '/api/v1/accounts/:id/unendorse', 'user', 'write:accounts', 'Relationship', '4.4.0'),
	implemented('POST', '/api/v1/accounts/:id/note', 'user', 'write:accounts', 'Relationship', '3.2.0'),
	unsupported('POST', '/api/v1/accounts/:id/email_subscriptions', 'user', 'write:accounts', 'Object', '4.6.0'),
	implemented('GET', '/api/v1/profile', 'user', ['profile', 'read:accounts'], 'Profile', '4.6.0'),
	implemented('PATCH', '/api/v1/profile', 'user', 'write:accounts', 'Profile', '4.6.0'),
	implemented('DELETE', '/api/v1/profile/avatar', 'user', 'write:accounts', 'Profile', '4.6.0'),
	implemented('DELETE', '/api/v1/profile/header', 'user', 'write:accounts', 'Profile', '4.6.0'),

	// Follow requests and lists
	implemented('GET', '/api/v1/follow_requests', 'user', 'read:follows', 'Account[]'),
	implemented('POST', '/api/v1/follow_requests/:id/authorize', 'user', 'write:follows', 'Relationship'),
	implemented('POST', '/api/v1/follow_requests/:id/reject', 'user', 'write:follows', 'Relationship'),
	implemented('GET', '/api/v1/lists', 'user', 'read:lists', 'List[]'),
	implemented('POST', '/api/v1/lists', 'user', 'write:lists', 'List'),
	implemented('GET', '/api/v1/lists/:id', 'user', 'read:lists', 'List'),
	implemented('PUT', '/api/v1/lists/:id', 'user', 'write:lists', 'List'),
	implemented('DELETE', '/api/v1/lists/:id', 'user', 'write:lists', 'Object'),
	implemented('GET', '/api/v1/lists/:id/accounts', 'user', 'read:lists', 'Account[]'),
	implemented('POST', '/api/v1/lists/:id/accounts', 'user', 'write:lists', 'Object'),
	implemented('DELETE', '/api/v1/lists/:id/accounts', 'user', 'write:lists', 'Object'),
	implemented('GET', '/api/v1/endorsements', 'user', 'read:accounts', 'Account[]', '2.5.0'),

	// Notifications and conversations
	implemented('GET', '/api/v1/notifications', 'user', 'read:notifications', 'Notification[]'),
	implemented('GET', '/api/v1/notifications/:id', 'user', 'read:notifications', 'Notification'),
	implemented('POST', '/api/v1/notifications/clear', 'user', 'write:notifications', 'Object'),
	safeObject('GET', '/api/v1/notifications/unread_count', 'user', 'read:notifications', 'UnreadCount', '4.3.0', { count: 0 }),
	implemented('POST', '/api/v1/notifications/:id/dismiss', 'user', 'write:notifications', 'Object'),
	safeArray('GET', '/api/v1/notifications/requests', 'user', 'read:notifications', 'NotificationRequest[]', '4.3.0'),
	notFound('GET', '/api/v1/notifications/requests/:id', 'user', 'read:notifications', 'NotificationRequest', '4.3.0'),
	notFound('GET', '/api/v1/notifications/requests/:id/merged', 'user', 'read:notifications', 'NotificationRequest', '4.3.0'),
	unsupported('POST', '/api/v1/notifications/requests/accept', 'user', 'write:notifications', 'Object', '4.3.0'),
	unsupported('POST', '/api/v1/notifications/requests/dismiss', 'user', 'write:notifications', 'Object', '4.3.0'),
	unsupported('POST', '/api/v1/notifications/requests/:id/accept', 'user', 'write:notifications', 'Object', '4.3.0'),
	unsupported('POST', '/api/v1/notifications/requests/:id/dismiss', 'user', 'write:notifications', 'Object', '4.3.0'),
	safeObject('GET', '/api/v1/notifications/policy', 'user', 'read:notifications', 'NotificationPolicy', '4.3.0', NOTIFICATION_POLICY),
	unsupported('PUT', '/api/v1/notifications/policy', 'user', 'write:notifications', 'NotificationPolicy', '4.3.0'),
	safeArray('GET', '/api/v2/notifications', 'user', 'read:notifications', 'NotificationGroup[]', '4.3.0'),
	notFound('GET', '/api/v2/notifications/:group_key', 'user', 'read:notifications', 'NotificationGroup', '4.3.0'),
	unsupported('POST', '/api/v2/notifications/clear', 'user', 'write:notifications', 'Object', '4.3.0'),
	safeObject('GET', '/api/v2/notifications/unread_count', 'user', 'read:notifications', 'UnreadCount', '4.3.0', { count: 0 }),
	unsupported('POST', '/api/v2/notifications/:group_key/dismiss', 'user', 'write:notifications', 'Object', '4.3.0'),
	safeArray('GET', '/api/v2/notifications/:group_key/accounts', 'user', 'read:notifications', 'Account[]', '4.3.0'),
	safeObject('GET', '/api/v2/notifications/policy', 'user', 'read:notifications', 'NotificationPolicy', '4.3.0', NOTIFICATION_POLICY),
	unsupported('PUT', '/api/v2/notifications/policy', 'user', 'write:notifications', 'NotificationPolicy', '4.3.0'),
	safeArray('GET', '/api/v1/conversations', 'user', 'read:statuses', 'Conversation[]', '2.6.0'),
	unsupported('DELETE', '/api/v1/conversations/:id', 'user', 'write:conversations', 'Object', '2.6.0'),
	unsupported('POST', '/api/v1/conversations/:id/read', 'user', 'write:conversations', 'Conversation', '2.6.0'),
	unsupported('POST', '/api/v1/conversations/:id/unread', 'user', 'write:conversations', 'Conversation', '4.3.0'),

	// Discovery and instance information
	implemented('GET', '/api/v1/custom_emojis', 'public', undefined, 'CustomEmoji[]'),
	implemented('GET', '/api/v1/suggestions', 'user', 'read:accounts', 'Account[]'),
	unsupported('DELETE', '/api/v1/suggestions/:id', 'user', 'write:accounts', 'Object'),
	implemented('GET', '/api/v2/suggestions', 'user', 'read:accounts', 'Suggestion[]', '3.4.0'),
	implemented('GET', '/api/v1/trends', 'public', undefined, 'Tag[]', '3.0.0'),
	implemented('GET', '/api/v1/trends/tags', 'public', undefined, 'Tag[]', '3.0.0'),
	implemented('GET', '/api/v1/trends/links', 'public', undefined, 'PreviewCard[]', '3.5.0'),
	implemented('GET', '/api/v1/trends/statuses', 'public', 'read:statuses', 'Status[]', '3.5.0'),
	implemented('GET', '/api/v1/directory', 'public', undefined, 'Account[]', '3.0.0'),
	implemented('GET', '/api/v1/instance', 'public', undefined, 'Instance'),
	implemented('GET', '/api/v1/instance/peers', 'public', undefined, 'string[]'),
	implemented('GET', '/api/v1/instance/rules', 'public', undefined, 'Rule[]', '3.4.0'),
	safeArray('GET', '/api/v1/instance/domain_blocks', 'public', undefined, 'DomainBlock[]', '4.0.0'),
	safeArray('GET', '/api/v1/instance/terms_of_service', 'public', undefined, 'TermsOfService[]', '4.4.0'),
	notFound('GET', '/api/v1/instance/terms_of_service/:date', 'public', undefined, 'TermsOfService', '4.4.0'),
	notFound('GET', '/api/v1/instance/privacy_policy', 'public', undefined, 'PrivacyPolicy', '4.4.0'),
	notFound('GET', '/api/v1/instance/extended_description', 'public', undefined, 'ExtendedDescription', '4.4.0'),
	safeObject('GET', '/api/v1/instance/translation_languages', 'public', undefined, 'TranslationLanguages', '4.0.0'),
	safeArray('GET', '/api/v1/instance/languages', 'public', undefined, 'Language[]', '4.4.0'),
	implemented('GET', '/api/v1/instance/activity', 'public', undefined, 'InstanceActivity[]'),
	safeArray('GET', '/api/v1/peers/search', 'public', undefined, 'Peer[]', '4.4.0'),
	implemented('GET', '/api/v2/instance', 'public', undefined, 'Instance', '4.0.0'),
	implemented('GET', '/api/v2/search', 'public', 'read:search', 'Search', '2.4.1'),

	// Tags, announcements, reports, and preferences
	implemented('GET', '/api/v1/tags/:name', 'public', undefined, 'Tag', '4.0.0'),
	implemented('POST', '/api/v1/tags/:name/follow', 'user', 'write:follows', 'Tag', '4.0.0'),
	implemented('POST', '/api/v1/tags/:name/unfollow', 'user', 'write:follows', 'Tag', '4.0.0'),
	implemented('POST', '/api/v1/tags/:name/feature', 'user', 'write:accounts', 'Tag', '4.4.0'),
	implemented('POST', '/api/v1/tags/:name/unfeature', 'user', 'write:accounts', 'Tag', '4.4.0'),
	implemented('GET', '/api/v1/followed_tags', 'user', 'read:follows', 'Tag[]', '4.0.0'),
	implemented('GET', '/api/v1/featured_tags', 'user', 'read:accounts', 'FeaturedTag[]', '3.0.0'),
	implemented('POST', '/api/v1/featured_tags', 'user', 'write:accounts', 'FeaturedTag', '3.0.0'),
	implemented('DELETE', '/api/v1/featured_tags/:id', 'user', 'write:accounts', 'Object', '3.0.0'),
	implemented('GET', '/api/v1/featured_tags/suggestions', 'user', 'read:accounts', 'Tag[]', '3.0.0'),
	implemented('GET', '/api/v1/announcements', 'user', undefined, 'Announcement[]', '3.1.0'),
	implemented('POST', '/api/v1/announcements/:id/dismiss', 'user', 'write:accounts', 'Object', '3.1.0'),
	unsupported('PUT', '/api/v1/announcements/:announcement_id/reactions/:id', 'user', 'write:accounts', 'Object', '3.1.0'),
	unsupported('DELETE', '/api/v1/announcements/:announcement_id/reactions/:id', 'user', 'write:accounts', 'Object', '3.1.0'),
	implemented('POST', '/api/v1/reports', 'user', 'write:reports', 'Report', '1.1.0'),
	implemented('GET', '/api/v1/preferences', 'user', 'read:accounts', 'Preferences', '2.8.0'),
	safeArray('GET', '/api/v1/donation_campaigns', 'user', undefined, 'DonationCampaign[]', '4.6.0'),
	safeArray('GET', '/api/v1/annual_reports', 'user', undefined, 'AnnualReport[]', '4.6.0'),
	notFound('GET', '/api/v1/annual_reports/:id', 'user', undefined, 'AnnualReport', '4.6.0'),
	unsupported('POST', '/api/v1/annual_reports/:id/read', 'user', undefined, 'Object', '4.6.0'),
	unsupported('POST', '/api/v1/annual_reports/:id/generate', 'user', undefined, 'Object', '4.6.0'),
	notFound('GET', '/api/v1/annual_reports/:id/state', 'user', undefined, 'AnnualReportState', '4.6.0'),

	// Filters, markers, collections, and push
	implemented('GET', '/api/v1/filters', 'user', 'read:filters', 'Filter[]'),
	implemented('POST', '/api/v1/filters', 'user', 'write:filters', 'Filter', '1.1.0'),
	implemented('GET', '/api/v1/filters/:id', 'user', 'read:filters', 'Filter'),
	implemented('PUT', '/api/v1/filters/:id', 'user', 'write:filters', 'Filter'),
	implemented('DELETE', '/api/v1/filters/:id', 'user', 'write:filters', 'Object'),
	implemented('GET', '/api/v2/filters', 'user', 'read:filters', 'Filter[]', '4.0.0'),
	implemented('POST', '/api/v2/filters', 'user', 'write:filters', 'Filter', '4.0.0'),
	implemented('GET', '/api/v2/filters/:id', 'user', 'read:filters', 'Filter', '4.0.0'),
	implemented('PUT', '/api/v2/filters/:id', 'user', 'write:filters', 'Filter', '4.0.0'),
	implemented('DELETE', '/api/v2/filters/:id', 'user', 'write:filters', 'Object', '4.0.0'),
	implemented('GET', '/api/v2/filters/:filter_id/keywords', 'user', 'read:filters', 'FilterKeyword[]', '4.0.0'),
	implemented('POST', '/api/v2/filters/:filter_id/keywords', 'user', 'write:filters', 'FilterKeyword', '4.0.0'),
	implemented('GET', '/api/v2/filters/keywords/:id', 'user', 'read:filters', 'FilterKeyword', '4.0.0'),
	implemented('PUT', '/api/v2/filters/keywords/:id', 'user', 'write:filters', 'FilterKeyword', '4.0.0'),
	implemented('DELETE', '/api/v2/filters/keywords/:id', 'user', 'write:filters', 'Object', '4.0.0'),
	implemented('GET', '/api/v2/filters/:filter_id/statuses', 'user', 'read:filters', 'FilterStatus[]', '4.0.0'),
	implemented('POST', '/api/v2/filters/:filter_id/statuses', 'user', 'write:filters', 'FilterStatus', '4.0.0'),
	implemented('GET', '/api/v2/filters/statuses/:id', 'user', 'read:filters', 'FilterStatus', '4.0.0'),
	implemented('DELETE', '/api/v2/filters/statuses/:id', 'user', 'write:filters', 'Object', '4.0.0'),
	implemented('GET', '/api/v1/markers', 'user', 'read:statuses', 'Markers', '3.0.0'),
	implemented('POST', '/api/v1/markers', 'user', 'write:statuses', 'Markers', '3.0.0'),
	unsupported('POST', '/api/v1/push/subscription', 'user', 'push', 'WebPushSubscription', '2.4.0', ['subscription']),
	notFound('GET', '/api/v1/push/subscription', 'user', 'push', 'WebPushSubscription', '2.4.0'),
	unsupported('PUT', '/api/v1/push/subscription', 'user', 'push', 'WebPushSubscription', '2.4.0'),
	unsupported('DELETE', '/api/v1/push/subscription', 'user', 'push', 'Object', '2.4.0'),
	unsupported('POST', '/api/v1/collections', 'user', 'write:collections', 'Collection', '4.6.0', ['title']),
	notFound('GET', '/api/v1/collections/:id', 'user', 'read:collections', 'Collection', '4.6.0'),
	unsupported('PUT', '/api/v1/collections/:id', 'user', 'write:collections', 'Collection', '4.6.0'),
	unsupported('DELETE', '/api/v1/collections/:id', 'user', 'write:collections', 'Object', '4.6.0'),
	unsupported('POST', '/api/v1/collections/:collection_id/items/:id', 'user', 'write:collections', 'Collection', '4.6.0'),
	unsupported('DELETE', '/api/v1/collections/:collection_id/items/:id', 'user', 'write:collections', 'Collection', '4.6.0'),
	unsupported('POST', '/api/v1/collections/:collection_id/items/:id/revoke', 'user', 'write:collections', 'Collection', '4.6.0'),

	// Domain blocks and applications
	implemented('POST', '/api/v1/apps', 'public', undefined, 'CredentialApplication'),
	implemented('GET', '/api/v1/apps/verify_credentials', 'token', undefined, 'Application'),
	unsupported('GET', '/api/v1/domain_blocks/preview', 'user', 'read:blocks', 'DomainBlock[]', '4.0.0'),
	implemented('GET', '/api/v1/domain_blocks', 'user', 'read:blocks', 'String[]', '1.4.0'),
	implemented('POST', '/api/v1/domain_blocks', 'user', 'write:blocks', 'Object', '1.4.0'),
	implemented('DELETE', '/api/v1/domain_blocks', 'user', 'write:blocks', 'Object', '1.4.0'),
	implemented('GET', '/api/v1/blocks', 'user', 'read:blocks', 'Account[]'),
	implemented('GET', '/api/v1/mutes', 'user', 'read:mutes', 'Account[]'),
	implemented('GET', '/api/v1/favourites', 'user', 'read:favourites', 'Status[]'),
	implemented('GET', '/api/v1/bookmarks', 'user', 'read:bookmarks', 'Status[]', '3.1.0'),
];
