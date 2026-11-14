/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { FILE_TYPE_BROWSERSAFE } from '@/const.js';
import { contentDisposition } from '@/misc/content-disposition.js';
import { StatusError } from '@/misc/status-error.js';
import type { IImageStreamable } from '@/core/ImageProcessingService.js';
import type { FastifyReply } from 'fastify';

export type RangeStream = {
	stream: fs.ReadStream;
	start: number;
	end: number;
	chunksize: number;
};

export function createRangeStream(rangeHeader: string, size: number, path: string): RangeStream {
	const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
	if (!match || (!match[1] && !match[2]) || size === 0) throw new StatusError('Range not satisfiable', 416);
	const first = match[1] ? Number(match[1]) : null;
	const last = match[2] ? Number(match[2]) : null;
	if (first != null && !Number.isSafeInteger(first)) {
		throw new StatusError('Range not satisfiable', 416);
	}
	const start = first ?? Math.max(0, size - last!);
	const end = first == null || last == null ? size - 1 : Math.min(last, size - 1);
	if (start >= size || start > end) throw new StatusError('Range not satisfiable', 416);
	const chunksize = end - start + 1;

	return {
		stream: fs.createReadStream(path, { start, end }),
		start,
		end,
		chunksize,
	};
}

export function attachStreamCleanup(data: IImageStreamable['data'], cleanup: () => void): void {
	if ('pipe' in data && typeof data.pipe === 'function') {
		data.on('end', cleanup);
		data.on('close', cleanup);
	} else {
		cleanup();
	}
}

export function getSafeContentType(mime: string): string {
	return FILE_TYPE_BROWSERSAFE.includes(mime) ? mime : 'application/octet-stream';
}

export function handleRangeRequest(
	reply: FastifyReply,
	rangeHeader: string | undefined,
	size: number,
	path: string,
): fs.ReadStream {
	reply.header('Accept-Ranges', 'bytes');
	if (rangeHeader) {
		let range: RangeStream;
		try {
			range = createRangeStream(rangeHeader, size, path);
		} catch (error) {
			if (error instanceof StatusError && error.statusCode === 416) reply.header('Content-Range', `bytes */${size}`);
			throw error;
		}
		const { stream, start, end, chunksize } = range;
		reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
		reply.header('Content-Length', chunksize);
		reply.code(206);
		return stream;
	}
	reply.header('Content-Length', size);
	return fs.createReadStream(path);
}

export type FileResponseOptions = {
	mime: string;
	filename: string;
	cacheControl?: string;
};

export function setFileResponseHeaders(
	reply: FastifyReply,
	options: FileResponseOptions,
): void {
	reply.header('Content-Type', getSafeContentType(options.mime));
	reply.header('Cache-Control', options.cacheControl ?? 'max-age=31536000, immutable');
	reply.header('Content-Disposition', contentDisposition('inline', options.filename));
}

export function needsCleanup<T extends { kind?: string; cleanup?: () => void }>(file: T): file is T & { cleanup: () => void } {
	return 'cleanup' in file && typeof file.cleanup === 'function';
}
