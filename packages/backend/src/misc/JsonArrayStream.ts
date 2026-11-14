/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { TransformStream } from 'node:stream/web';

export class JsonArrayStream extends TransformStream<unknown, string> {
	constructor() {
		let isFirst = true;

		super({
			start(controller) {
				controller.enqueue('[');
			},
			flush(controller) {
				controller.enqueue(']');
			},
			transform(chunk, controller) {
				if (isFirst) {
					isFirst = false;
				} else {
					controller.enqueue(',\n');
				}

				controller.enqueue(JSON.stringify(chunk));
			},
		});
	}
}
