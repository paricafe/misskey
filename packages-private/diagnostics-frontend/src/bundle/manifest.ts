/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileExists, fileSize, normalizePath, traverseDirectory } from './fs-utils';

export type BundleManifestChunk = {
	file: string;
	src?: string;
	name?: string;
	isEntry?: boolean;
	imports?: string[];
};

export type BundleManifest = Record<string, BundleManifestChunk>;

const locale = 'ja-JP';

const stableNamedChunks = new Set(['vue', 'i18n']);

export type FileEntry = {
	comparisonKey: string | null;
	displayName: string;
	file: string;
	manifestKeys: string[];
	size: number;
};

export type CollectedBundleReport = {
	manifest: BundleManifest;
	chunks: FileEntry[];
	comparableChunks: Record<string, FileEntry>;
	chunksByManifestKey: Record<string, FileEntry>;
	startupFiles: string[];
};

export function findEntryKey(manifest: BundleManifest) {
	const entries = Object.entries(manifest);
	return entries.find(([key, chunk]) => key === 'src/_boot_.ts' || chunk.src === 'src/_boot_.ts')?.[0]
		?? entries.find(([, chunk]) => chunk.name === 'entry' && chunk.isEntry)?.[0]
		?? entries.find(([, chunk]) => chunk.isEntry)?.[0]
		?? null;
}

export function stableChunkKey(chunk: BundleManifestChunk) {
	if (chunk.src != null) return `src:${normalizePath(chunk.src)}`;
	if (chunk.name != null && stableNamedChunks.has(chunk.name)) return `named:${chunk.name}`;
	return null;
}

export function collectStartupManifestKeys(manifest: BundleManifest) {
	const entryKey = findEntryKey(manifest);
	const keys = new Set<string>();
	if (entryKey == null) throw new Error('Unable to find frontend startup entry in Vite manifest.');

	function visit(key: string, importedBy?: string) {
		if (keys.has(key)) return;
		const chunk = manifest[key];
		const importContext = importedBy == null ? '' : ` imported by "${importedBy}"`;
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		if (chunk == null) throw new Error(`Startup manifest key "${key}"${importContext} is missing.`);
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		if (chunk.file == null || chunk.file.length === 0) throw new Error(`Startup manifest key "${key}"${importContext} has no output file.`);
		if (!chunk.file.endsWith('.js')) throw new Error(`Startup manifest key "${key}"${importContext} resolves to non-JavaScript output "${chunk.file}".`);
		keys.add(key);
		for (const importKey of chunk.imports ?? []) visit(importKey, key);
	}

	visit(entryKey);
	return keys;
}

export async function resolveBuiltFile(outDir: string, file: string) {
	if (file.startsWith('scripts/')) {
		const localizedFile = file.slice('scripts/'.length);
		const localizedPath = path.join(outDir, locale, localizedFile);
		if (await fileExists(localizedPath)) {
			return {
				absolutePath: localizedPath,
				relativePath: `${locale}/${localizedFile}`,
			};
		}

		throw new Error(`Expected ${locale} localized chunk for ${file}, but ${localizedPath} was not found.`);
	}
	return {
		absolutePath: path.join(outDir, file),
		relativePath: file,
	};
}

export async function collectBundleReport(repoDir: string): Promise<CollectedBundleReport> {
	const outDir = path.join(repoDir, 'built/_frontend_vite_');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as BundleManifest;
	const chunksByFile = new Map<string, FileEntry>();
	const comparableChunks = new Map<string, FileEntry>();
	const chunksByManifestKey = new Map<string, FileEntry>();

	for (const [manifestKey, chunk] of Object.entries(manifest)) {
		if (!chunk.file.endsWith('.js')) continue;
		const builtFile = await resolveBuiltFile(outDir, chunk.file);
		const comparisonKey = stableChunkKey(chunk);
		let entry = chunksByFile.get(builtFile.relativePath);
		if (entry == null) {
			entry = {
				comparisonKey,
				displayName: chunk.src ?? chunk.name ?? manifestKey,
				file: builtFile.relativePath,
				manifestKeys: [manifestKey],
				size: await fileSize(builtFile.absolutePath),
			};
			chunksByFile.set(entry.file, entry);
		} else if (entry.comparisonKey !== comparisonKey) {
			throw new Error(`Conflicting identities for ${entry.file}`);
		} else {
			entry.manifestKeys.push(manifestKey);
		}
		chunksByManifestKey.set(manifestKey, entry);
		if (comparisonKey != null) {
			const existing = comparableChunks.get(comparisonKey);
			if (existing != null && existing.file !== entry.file) {
				throw new Error(`Duplicate stable chunk key "${comparisonKey}": ${existing.file}, ${entry.file}`);
			}
			comparableChunks.set(comparisonKey, entry);
		}
	}

	const localeDir = path.join(outDir, locale);
	if (await fileExists(localeDir)) {
		for await (const fullPath of traverseDirectory(localeDir)) {
			if (!fullPath.endsWith('.js')) continue;
			const relativePath = normalizePath(path.relative(outDir, fullPath));
			if (chunksByFile.has(relativePath)) continue;
			chunksByFile.set(relativePath, {
				comparisonKey: null,
				displayName: relativePath,
				file: relativePath,
				manifestKeys: [],
				size: await fileSize(fullPath),
			});
		}
	}

	const startupFiles = new Set<string>();
	for (const manifestKey of collectStartupManifestKeys(manifest)) {
		const entry = chunksByManifestKey.get(manifestKey);
		if (entry != null) startupFiles.add(entry.file);
	}

	return {
		manifest,
		chunks: [...chunksByFile.values()],
		comparableChunks: Object.fromEntries(comparableChunks),
		chunksByManifestKey: Object.fromEntries(chunksByManifestKey),
		startupFiles: [...startupFiles],
	};
}
