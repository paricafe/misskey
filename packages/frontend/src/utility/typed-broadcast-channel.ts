/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */

const CHANNEL_NAME_PREFIX = 'native:';

export interface TypedBroadcastChannel<T> extends BroadcastChannel {
	onmessage: ((this: TypedBroadcastChannel<T>, ev: MessageEvent<T>) => any) | null;
	postMessage(message: T): void;
	addEventListener(type: 'message', listener: (this: TypedBroadcastChannel<T>, ev: MessageEvent<T>) => any, options?: boolean | AddEventListenerOptions): void;
	addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
	removeEventListener(type: 'message', listener: (this: TypedBroadcastChannel<T>, ev: MessageEvent<T>) => any, options?: boolean | EventListenerOptions): void;
	removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

export class TypedBroadcastChannel<T> extends BroadcastChannel {
	constructor(name: string) {
		super(`${CHANNEL_NAME_PREFIX}${name}`);
	}
}
