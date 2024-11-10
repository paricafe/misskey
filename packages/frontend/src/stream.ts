/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Misskey from 'misskey-js';
import { markRaw } from 'vue';
import { $i } from '@/account.js';
import { wsOrigin } from '@@/js/config.js';
import { DEFAULT_DEVICE_KIND } from '@/scripts/device-kind.js';
// TODO: No WebsocketモードでStreamMockが使えそう
//import { StreamMock } from '@/scripts/stream-mock.js';

// heart beat interval in ms
const HEART_BEAT_INTERVAL = DEFAULT_DEVICE_KIND === 'desktop' ? 1000 * 15 : 1000 * 30;

const RECONNECT_MAX_ATTEMPTS = 10;
const RECONNECT_INITIAL_DELAY = 1000;
const RECONNECT_MAX_DELAY = 1000 * 30;

let stream: Misskey.IStream | null = null;
let timeoutHeartBeat: number | null = null;
let lastHeartbeatCall = 0;
let reconnectAttempts = 0;
let reconnectTimeout: number | null = null;

function getReconnectDelay(): number {
    const delay = RECONNECT_INITIAL_DELAY * Math.pow(2, reconnectAttempts);
    return Math.min(delay, RECONNECT_MAX_DELAY);
}

function createStream(): Misskey.IStream {
    const newStream = markRaw(new Misskey.Stream(wsOrigin, $i ? {
        token: $i.token,
    } : null));

    newStream.on('_disconnected_', () => {
        console.log('Stream disconnected, attempting to reconnect...');
        if (reconnectAttempts < RECONNECT_MAX_ATTEMPTS) {
            const delay = getReconnectDelay();
            reconnectTimeout = window.setTimeout(() => {
                reconnectAttempts++;
                stream = null;
                useStream();
            }, delay);
        } else {
            console.error('Max reconnection attempts reached');
        }
    });

    newStream.on('_connected_', () => {
        console.log('Stream connected successfully');
        reconnectAttempts = 0;
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }
    });

    return newStream;
}

export function useStream(): Misskey.IStream {
    if (stream) return stream;

    stream = createStream();

    if (timeoutHeartBeat) window.clearTimeout(timeoutHeartBeat);
    timeoutHeartBeat = window.setTimeout(heartbeat, HEART_BEAT_INTERVAL);

    // send heartbeat right now when last send time is over HEART_BEAT_INTERVAL
    document.addEventListener('visibilitychange', () => {
        if (
            !stream
            || document.visibilityState !== 'visible'
            || Date.now() - lastHeartbeatCall < HEART_BEAT_INTERVAL
        ) return;
        heartbeat();
    });

    return stream;
}

function heartbeat(): void {
    if (stream != null && document.visibilityState === 'visible') {
        stream.heartbeat();
    }
    lastHeartbeatCall = Date.now();
    if (timeoutHeartBeat) window.clearTimeout(timeoutHeartBeat);
    timeoutHeartBeat = window.setTimeout(heartbeat, HEART_BEAT_INTERVAL);
}
