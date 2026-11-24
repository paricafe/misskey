/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { onRequestHookHandler } from "fastify";

export function makeHstsHook(host: string, preload: boolean = false): onRequestHookHandler {
    if (preload) {
        return (request, reply, done) => {
            if (
                (request.host === host || request.hostname === host) &&
                request.protocol === 'http') {
                const redirectHost = request.host || request.hostname;
                reply.redirect(`https://${redirectHost}${request.url}`, 301);
            } else {
                reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
            }
            done();
        };
    } else {
        return (request, reply, done) => {
            reply.header('strict-transport-security', 'max-age=15552000');
            done();
        };
    }
}
