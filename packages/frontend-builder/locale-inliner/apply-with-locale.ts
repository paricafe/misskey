/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import MagicString from 'magic-string';
import { assertNever } from '../utils.js';
import type { ILocale, Locale } from 'i18n';
import type { TextModification } from '../locale-inliner.js';
import type { Logger } from '../logger.js';

export function applyWithLocale(
	sourceCode: MagicString,
	modifications: TextModification[],
	localeName: string,
	localeJson: Locale,
	fileLogger: Logger,
) {
	for (const modification of modifications) {
		switch (modification.type) {
			case 'delete':
				sourceCode.remove(modification.begin, modification.end);
				break;
			case 'insert':
				sourceCode.appendRight(modification.begin, modification.text);
				break;
			case 'replace':
				sourceCode.update(modification.begin, modification.end, modification.text);
				break;
			case 'localized': {
				const accessed = getPropertyByPath(localeJson, modification.localizationKey);
				if (accessed == null) {
					fileLogger.warn(`Cannot find localization key ${modification.localizationKey.join('.')}`);
				}
				sourceCode.update(modification.begin, modification.end, JSON.stringify(accessed));
				break;
			}
			case 'parameterized-function': {
				const accessed = getPropertyByPath(localeJson, modification.localizationKey);
				let replacement: string;
				if (typeof accessed === 'string') {
					replacement = formatFunction(accessed);
				} else if (typeof accessed === 'object' && accessed !== null) {
					replacement = `({${Object.entries(accessed).map(([key, value]) => `${JSON.stringify(key)}:${formatFunction(value)}`).join(',')}})`;
				} else {
					fileLogger.warn(`Cannot find localization key ${modification.localizationKey.join('.')}`);
					replacement = '(() => "")';
				}
				sourceCode.update(modification.begin, modification.end, replacement);
				break;

				function formatFunction(format: string): string {
					const params = new Set<string>();
					const components: string[] = [];
					let lastIndex = 0;
					for (const match of format.matchAll(/\{(.+?)}/g)) {
						const [fullMatch, paramName] = match;
						if (lastIndex < match.index) {
							components.push(JSON.stringify(format.slice(lastIndex, match.index)));
						}
						params.add(paramName);
						components.push(paramName);
						lastIndex = match.index + fullMatch.length;
					}
					components.push(JSON.stringify(format.slice(lastIndex)));

					const paramList = Array.from(params).join(',');
					let body = components.filter(x => x !== '""').join('+');
					if (body === '') body = '""';
					return `(({${paramList}})=>(${body}))`;
				}
			}
			case 'locale-name': {
				sourceCode.update(modification.begin, modification.end, modification.literal ? JSON.stringify(localeName) : localeName);
				break;
			}
			case 'locale-json': {
				sourceCode.update(modification.begin, modification.end, `JSON.parse(${JSON.stringify(JSON.stringify(localeJson))})`);
				break;
			}
			default: {
				assertNever(modification);
			}
		}
	}
}

function getPropertyByPath(localeJson: ILocale, localizationKey: string[]): string | object | null {
	if (localizationKey.length === 0) return localeJson;
	let current: ILocale | string = localeJson;
	for (const key of localizationKey) {
		if (typeof current !== 'object' || !(key in current)) {
			return null;
		}
		current = current[key];
	}
	return current;
}
