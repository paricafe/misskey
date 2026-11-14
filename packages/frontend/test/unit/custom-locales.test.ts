/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { customLocales } from '../../../i18n/src/custom-locales.js';
import type { ILocale } from '../../../i18n/src/types.js';

const metaUrl = import.meta.url;
const languages = ['en-US', 'zh-CN', 'zh-TW'] as const;

function readLocale(language: string): ILocale {
	return loadYaml(readFileSync(new URL(`../../../../locales/${language}.yml`, metaUrl), 'utf8')) as ILocale;
}

function leafEntries(locale: ILocale, prefix = ''): [string, string][] {
	return Object.entries(locale).flatMap<[string, string]>(([key, value]) => {
		const path = `${prefix}${key}`;
		return typeof value === 'string' ? [[path, value]] : leafEntries(value, `${path}.`);
	});
}

function placeholders(value: string): string[] {
	return [...new Set(value.match(/\{\w+\}/g) ?? [])].sort();
}

function expectCompatibleLocale(locale: ILocale, source: ILocale, prefix: string): void {
	for (const [key, value] of Object.entries(locale)) {
		const path = `${prefix}.${key}`;
		expect(Object.hasOwn(source, key), path).toBe(true);
		const sourceValue = source[key];
		expect(typeof value, path).toBe(typeof sourceValue);
		if (typeof value === 'string') {
			expect(value.trim(), path).not.toBe('');
			expect(placeholders(value), path).toEqual(placeholders(sourceValue as string));
		} else {
			expectCompatibleLocale(value, sourceValue as ILocale, path);
		}
	}
}

const japanese = readLocale('ja-JP');
const japaneseLeaves = new Map(leafEntries(japanese));

const customPaths = [
	'allowClickingNotifications',
	'_role._options.canEditNote',
	'_role._options.canImportNotes',
	'_signup.approvalPending',
	'_signup.reasonInfo',
	'_permissions.write:admin:approve-user',
	'_permissions.write:admin:decline-user',
	'_moderationLogTypes.approve',
	'_moderationLogTypes.decline',
	'approvals',
	'registerApproveConfirm',
	'registerApproveConfirmDescription',
	'approvalRequiredForSignup',
	'signupPendingApprovals',
	'pendingUserApprovals',
	'approveAccount',
	'denyAccount',
	'approved',
	'notApproved',
	'approvalStatus',
	'approvalRequiredToRegister',
	'registerReason',
	'registerHasNotBeenApprovedYet',
	'registerApprovalEmailRecommended',
	'pariMisskeyAbout',
	'timeTravel',
	'timeTravelDescription',
	'undoPostForm',
	'clearPostForm',
	'pariPlusInfo',
	'pariPlusSystemSettings',
	'pariPlusNoteSettings',
	'pariPlusAppearanceSettings',
	'pariPlusFontPicker',
	'enableRenderingOptimization',
	'enableTranslateButton',
	'showDetailTimeWhenHover',
	'noteClickToOpen',
	'enableFallbackReactButton',
	'enableMFMCheatsheet',
	'enableUndoClearPostForm',
	'collapseNotesRepliedTo',
	'alwaysCollapseRenotes',
	'collapseEverything',
	'collapseEverythingDescription',
	'disableReactionsViewer',
	'collapsedUnexpectedLangs',
	'emojiAutoSpacing',
	'autoSpacing',
	'autoSpacingDescription',
	'clickToShowInstanceTickerWindow',
	'defaultLike',
	'_dataRequest.lable',
	'_dataRequest.title',
	'_dataRequest.warn',
	'_dataRequest.text',
	'_dataRequest.button',
	...leafEntries(japanese._mfm as ILocale, '_mfm.').map(([path]) => path),
];

describe('Pari custom locales', () => {
	test('retains the 123 custom source fields, including unused and historical keys', () => {
		expect(customPaths).toHaveLength(123);
		expect(new Set(customPaths).size).toBe(customPaths.length);
		for (const path of customPaths) {
			expect(japaneseLeaves.get(path)?.trim(), path).toBeTruthy();
		}
	});

	test.each(languages)('%s explicitly translates every custom field without Japanese fallback', language => {
		const translations = new Map(leafEntries(customLocales[language]));
		const missingPaths = customPaths.filter(path => !translations.get(path)?.trim());
		expect(missingPaths).toEqual([]);
	});

	test.each(languages)('%s overrides only source keys with matching types and placeholders', language => {
		expectCompatibleLocale(customLocales[language], japanese, language);
	});

	test.each([
		{ language: 'zh-CN', mute: '隐藏', unmute: '取消隐藏', block: '屏蔽', unblock: '取消屏蔽' },
		{ language: 'zh-TW', mute: '靜音', unmute: '解除靜音', block: '封鎖', unblock: '解除封鎖' },
	])('$language keeps mute and block actions distinct after applying overrides', ({ language, ...labels }) => {
		const locale = { ...readLocale(language), ...customLocales[language] };
		for (const [key, value] of Object.entries(labels)) {
			expect(locale[key], `${language}.${key}`).toBe(value);
		}
		expect(locale.mute).not.toBe(locale.block);
		expect(locale.unmute).not.toBe(locale.unblock);
	});
});
