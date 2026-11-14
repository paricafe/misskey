/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { constants as fsConstants, promises as fsp } from 'node:fs';
import { Reader, Writer, ZipReader, ZipWriter } from '@zip.js/zip.js';
import type { FileEntry } from '@zip.js/zip.js';

class FileHandleReader extends Reader<fsp.FileHandle> {
	constructor(
		private readonly handle: fsp.FileHandle,
		size: number,
	) {
		super(handle);
		this.size = size;
	}

	public override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
		const buffer = new Uint8Array(length);
		let read = 0;
		while (read < length) {
			const { bytesRead } = await this.handle.read(buffer, read, length - read, index + read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
		return read === length ? buffer : buffer.subarray(0, read);
	}
}

class FileHandleWriter extends Writer<fsp.FileHandle> {
	constructor(private readonly handle: fsp.FileHandle) {
		super();
	}

	public override async writeUint8Array(array: Uint8Array): Promise<void> {
		await writeAll(this.handle, array);
	}
}

async function writeAll(handle: fsp.FileHandle, chunk: Uint8Array): Promise<void> {
	let offset = 0;
	while (offset < chunk.byteLength) {
		const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
		offset += bytesWritten;
	}
}

export class ZipExtractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ZipExtractError';
	}
}

export type ZipExtractOptions = {
	maxBytes: number;
};

export class ZipFile {
	private constructor(
		private readonly handle: fsp.FileHandle,
		private readonly reader: ZipReader<unknown>,
	) {}

	public static async open(path: string): Promise<ZipFile> {
		const handle = await fsp.open(path, 'r');
		try {
			const { size } = await handle.stat();
			const reader = new ZipReader(new FileHandleReader(handle, size), {
				useWebWorkers: false,
				checkCrc32: true,
				filenameValidation: 'balanced',
			});
			return new ZipFile(handle, reader);
		} catch (e) {
			await handle.close();
			throw e;
		}
	}

	public async *entries(): AsyncGenerator<FileEntry, void, undefined> {
		const seen = new Set<string>();
		for await (const entry of this.reader.getEntriesGenerator()) {
			if (entry.directory) continue;
			if (seen.has(entry.filename)) {
				throw new ZipExtractError(`duplicate entry: ${entry.filename}`);
			}
			seen.add(entry.filename);
			yield entry;
		}
	}

	public async extractToFile(entry: FileEntry, destPath: string, options: ZipExtractOptions): Promise<void> {
		const { maxBytes } = options;

		if (entry.symlink) {
			throw new ZipExtractError(`symbolic link entry is not allowed: ${entry.filename}`);
		}
		if (entry.encrypted) {
			throw new ZipExtractError(`encrypted entry is not allowed: ${entry.filename}`);
		}
		if (entry.uncompressedSize > maxBytes) {
			throw new ZipExtractError(`entry is too large: ${entry.filename} (${entry.uncompressedSize} > ${maxBytes} bytes)`);
		}

		const handle = await fsp.open(destPath, 'wx');
		let succeeded = false;
		try {
			let written = 0;
			await entry.getData(new WritableStream<Uint8Array>({
				async write(chunk) {
					written += chunk.byteLength;
					if (written > maxBytes) {
						throw new ZipExtractError(`entry is too large: ${entry.filename} (> ${maxBytes} bytes)`);
					}
					await writeAll(handle, chunk);
				},
			}));
			succeeded = true;
		} finally {
			await handle.close();
			if (!succeeded) {
				await fsp.rm(destPath, { force: true });
			}
		}
	}

	public async close(): Promise<void> {
		await this.reader.close();
		await this.handle.close();
	}
}

export class ZipArchiveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ZipArchiveError';
	}
}

function assertSafeEntryName(name: string): void {
	// eslint-disable-next-line no-control-regex
	if (name === '' || /[\u0000-\u001f\u007f]/.test(name)) {
		throw new ZipArchiveError(`invalid entry name: ${JSON.stringify(name)}`);
	}
	if (name.includes('\\')) {
		throw new ZipArchiveError(`entry name must not contain a backslash: ${name}`);
	}
	if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
		throw new ZipArchiveError(`entry name must be relative: ${name}`);
	}
	const parts = name.split('/');
	if (parts.includes('..') || parts.includes('.') || parts.includes('')) {
		throw new ZipArchiveError(`entry name must not contain a '.', '..' or empty path segment: ${name}`);
	}
}

export class ZipArchive {
	private constructor(
		private readonly handle: fsp.FileHandle,
		private readonly writer: ZipWriter<unknown>,
	) {}

	public static async create(path: string): Promise<ZipArchive> {
		const handle = await fsp.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
		try {
			const writer = new ZipWriter(new FileHandleWriter(handle), {
				useWebWorkers: false,
				level: 0,
				bufferedWrite: false,
			});
			return new ZipArchive(handle, writer);
		} catch (e) {
			await handle.close();
			throw e;
		}
	}

	public async addFile(name: string, srcPath: string): Promise<void> {
		assertSafeEntryName(name);

		const handle = await fsp.open(srcPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			const stats = await handle.stat();
			if (!stats.isFile()) {
				throw new ZipArchiveError(`not a regular file: ${srcPath}`);
			}
			await this.writer.add(name, new FileHandleReader(handle, stats.size));
		} finally {
			await handle.close();
		}
	}

	public async close(): Promise<void> {
		try {
			await this.writer.close();
		} finally {
			await this.handle.close();
		}
	}

	public async abort(): Promise<void> {
		await this.handle.close();
	}
}
