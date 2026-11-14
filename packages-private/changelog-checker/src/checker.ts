/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Release } from './parser.js';

export class Result {
	public readonly success: boolean;
	public readonly message?: string;

	private constructor(success: boolean, message?: string) {
		this.success = success;
		this.message = message;
	}

	static ofSuccess(): Result {
		return new Result(true);
	}

	static ofFailed(message?: string): Result {
		return new Result(false, message);
	}
}

export function checkNewRelease(base: Release[], head: Release[]): Result {
	const releaseCountDiff = head.length - base.length;
	if (releaseCountDiff <= 0) {
		return Result.ofFailed('Invalid release count.');
	}

	const existingReleases = head.slice(releaseCountDiff);
	for (let relIdx = 0; relIdx < base.length; relIdx++) {
		if (base[relIdx].releaseName !== existingReleases[relIdx].releaseName) {
			return Result.ofFailed(`Contains unexpected releases. base:${base[relIdx].releaseName}, head:${existingReleases[relIdx].releaseName}`);
		}
	}

	return Result.ofSuccess();
}

function isSameItems(base: string[], head: string[]) {
	return base.length === head.length && base.every((item, idx) => item === head[idx]);
}

export function checkNewTopic(base: Release[], head: Release[]): Result {
	if (head.length !== base.length) {
		return Result.ofFailed('Invalid release count.');
	}

	const headLatest = head[0];
	for (let relIdx = 0; relIdx < base.length; relIdx++) {
		const baseItem = base[relIdx];
		const headItem = head[relIdx];
		if (baseItem.releaseName !== headItem.releaseName) {
			return Result.ofFailed(`Release is different. base:${baseItem.releaseName}, head:${headItem.releaseName}`);
		}

		if (baseItem.categories.length !== headItem.categories.length) {
			if (headLatest.releaseName !== headItem.releaseName) {
				return Result.ofFailed(`There is an error in the update history. expected additions:${headLatest.releaseName}, actual additions:${headItem.releaseName}`);
			}
		} else {
			for (let catIdx = 0; catIdx < baseItem.categories.length; catIdx++) {
				const baseCategory = baseItem.categories[catIdx];
				const headCategory = headItem.categories[catIdx];

				if (baseCategory.categoryName !== headCategory.categoryName) {
					return Result.ofFailed(`Category is different. base:${baseCategory.categoryName}, head:${headCategory.categoryName}`);
				}

				if (!isSameItems(baseCategory.items, headCategory.items)) {
					if (headLatest.releaseName !== headItem.releaseName) {
						return Result.ofFailed(`There is an error in the update history. expected additions:${headLatest.releaseName}, actual additions:${headItem.releaseName}`);
					}
				}
			}
		}
	}

	return Result.ofSuccess();
}
