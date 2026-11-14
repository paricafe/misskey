/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// @ts-check

import { execFileSync } from 'node:child_process';
import { TextDecoder } from 'node:util';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export const DEFAULT_INTEGRATION_REFS = ['origin/develop', 'develop', 'origin/master', 'master'];

class GitOperationError extends Error {}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeGitFailure(error) {
	if (error === null || typeof error !== 'object') return '';
	const failure = /** @type {{ status?: number | null, stderr?: Buffer | null }} */ (error);
	const details = [];
	if (typeof failure.status === 'number') details.push(`exit ${failure.status}`);
	if (Buffer.isBuffer(failure.stderr)) {
		const stderr = failure.stderr.toString('utf8').replace(/\s+/g, ' ').trim();
		if (stderr !== '') details.push(stderr);
	}
	return details.join(': ');
}

/**
 * @param {string[]} args
 * @param {{ quiet?: boolean }} [options]
 * @returns {Buffer}
 */
function gitBuffer(args, options = {}) {
	try {
		return execFileSync('git', args, {
			maxBuffer: 64 * 1024 * 1024,
			stdio: ['ignore', 'pipe', options.quiet === true ? 'pipe' : 'inherit'],
		});
	} catch (error) {
		const detail = describeGitFailure(error);
		throw new GitOperationError(`git ${args[0]} を実行できない${detail === '' ? '' : ` — ${detail}`}`);
	}
}

/**
 * @param {Buffer} buffer
 * @param {string} context
 * @returns {string}
 */
function decodeGitOutput(buffer, context) {
	try {
		return UTF8_DECODER.decode(buffer);
	} catch {
		throw new GitOperationError(`${context}: Git 出力に UTF-8 でないファイル名が含まれる`);
	}
}

/**
 * @param {string[]} args
 * @param {{ quiet?: boolean }} [options]
 * @returns {string[]}
 */
export function gitLines(args, options = {}) {
	return decodeGitOutput(gitBuffer(args, options), `git ${args[0]}`)
		.split('\n')
		.filter((line) => line !== '');
}

/**
 * @param {string[]} args
 * @param {{ quiet?: boolean }} [options]
 * @returns {string[]}
 */
export function gitPaths(args, options = {}) {
	return decodeGitOutput(gitBuffer(args, options), `git ${args[0]}`)
		.split('\0')
		.filter((path) => path !== '');
}

/**
 * @param {string} ref
 * @returns {string}
 */
export function gitMergeBase(ref) {
	try {
		const base = gitLines(['merge-base', ref, 'HEAD'], { quiet: true })[0];
		if (base === undefined) throw new Error('empty merge-base');
		return base;
	} catch (error) {
		const detail = error instanceof Error ? ` — ${error.message}` : '';
		throw new GitOperationError(`merge-base を解決できない: ${ref}${detail}`);
	}
}

/**
 * @param {string[]} refs
 * @returns {string}
 */
export function findClosestMergeBase(refs) {
	/** @type {{ base: string, distance: number }[]} */
	const candidates = [];
	/** @type {string[]} */
	const failures = [];
	for (const ref of refs) {
		try {
			const base = gitMergeBase(ref);
			const distanceText = gitLines(['rev-list', '--count', `${base}..HEAD`], { quiet: true })[0];
			const distance = Number(distanceText);
			if (!Number.isInteger(distance)) throw new GitOperationError(`HEAD までの距離を解釈できない: ${ref}`);
			candidates.push({ base, distance });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			failures.push(detail.includes(ref) ? detail : `${ref}: ${detail}`);
		}
	}

	candidates.sort((a, b) => a.distance - b.distance);
	if (candidates[0] !== undefined) return candidates[0].base;
	throw new GitOperationError(`利用可能な統合先 ref がない (${failures.join('; ')})`);
}
