/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { CompatStore } from './store.js';
import type { Json } from './types.js';
import { NativeError } from './native-client.js';

/** Shared by REST and streaming; only compatibility-owned properties come from this store. */
export function decorateStatus(store: Pick<CompatStore, 'get'>, status: Json, userId?: string): Json {
	const result = { ...status };
	const owner = String(status.account.id);
	const metadata = store.get<Json>('status', owner, status.id);
	if (metadata) Object.assign(result, { language: metadata.language ?? null, sensitive: status.sensitive || metadata.sensitive === true });
	result.media_attachments = status.media_attachments.map((file: Json) => {
		const media = store.get<Json>('media', owner, file.id);
		return media?.focus ? { ...file, meta: { ...file.meta, focus: media.focus } } : file;
	});
	// Bookmark, mute, reblog and pin state can change in native clients. Stored
	// compatibility metadata must never override values obtained from the native API.
	if (status.reblog) result.reblog = decorateStatus(store, status.reblog, userId);
	if (status.quote?.quoted_status) result.quote = { ...status.quote, quoted_status: decorateStatus(store, status.quote.quoted_status, userId) };
	return result;
}

type NativeRead = (endpoint: string, body: Json) => Promise<Json>;

/** A stored renote ID is only a lookup hint; the native note decides whether it still exists. */
export async function liveReblog(store: Pick<CompatStore, 'get' | 'delete'>, userId: string, noteId: string, call: NativeRead): Promise<string | undefined> {
	const hint = store.get<string>('reblog', userId, noteId);
	if (!hint) return undefined;
	let note: Json;
	try { note = await call('notes/show', { noteId: hint }); } catch (error) {
		if (!(error instanceof NativeError && (error.status === 404 || error.code === 'NO_SUCH_NOTE'))) throw error;
		store.delete('reblog', userId, noteId);
		return undefined;
	}
	if (note.isHidden !== true && (note.userId ?? note.user?.id) === userId && note.renoteId === noteId && !note.text && !note.cw && !note.replyId && !note.poll && !(note.files?.length || note.fileIds?.length)) return hint;
	store.delete('reblog', userId, noteId);
	return undefined;
}

/** Optional viewer state is omitted when the granted native permissions cannot read it. */
export async function hydrateStatus(store: Pick<CompatStore, 'get' | 'delete'>, status: Json, userId: string | undefined, canReadAccount: boolean, call: NativeRead): Promise<Json> {
	const result = { ...status };
	if (userId && canReadAccount) {
		const state = await call('notes/state', { noteId: status.id });
		result.bookmarked = state.isFavorited === true;
		result.muted = state.isMutedThread === true;
	} else {
		delete result.bookmarked;
		delete result.muted;
	}
	if (userId) {
		const reblog = await liveReblog(store, userId, status.id, call);
		if (reblog) result.reblogged = true;
		else delete result.reblogged;
	} else delete result.reblogged;
	const author = await call('users/show', { userId: status.account.id });
	if (Array.isArray(author.pinnedNoteIds)) result.pinned = author.pinnedNoteIds.includes(status.id);
	else if (Array.isArray(author.pinnedNotes)) result.pinned = author.pinnedNotes.some((note: Json) => note.id === status.id);
	else delete result.pinned;
	if (status.reblog) result.reblog = await hydrateStatus(store, status.reblog, userId, canReadAccount, call);
	if (status.quote?.quoted_status) result.quote = { ...status.quote, quoted_status: await hydrateStatus(store, status.quote.quoted_status, userId, canReadAccount, call) };
	return result;
}
