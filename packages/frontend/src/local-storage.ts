/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type Keys = (
	'v' |
	'lastVersion' |
	'instance' |
	'instanceCachedAt' |
	'account' |
	'latestDonationInfoShownAt' |
	'neverShowDonationInfo' |
	'neverShowLocalOnlyInfo' |
	'modifiedVersionMustProminentlyOfferInAgplV3Section13Read' |
	'lastUsed' |
	'lang' |
	'drafts' |
	'hashtags' |
	'colorScheme' |
	'useSystemFont' |
	'defaultFontFace' |
	'fontSize' |
	'ui' |
	'ui_temp' |
	'bootloaderLocales' |
	'theme' |
	'themeId' |
	'themeCachedVersion' |
	'customCss' |
	'chatMessageDrafts' |
	'scratchpad' |
	'debug' |
	'preferences' |
	'latestPreferencesUpdate' |
	'hidePreferencesRestoreSuggestion' |
	'isSafeMode' |
	`miux:${string}` |
	`ui:folder:${string}` |
	`themes:${string}` |
	`aiscript:${string}` |
	'lastEmojisFetchedAt' |
	'emojis' |
	`channelLastReadedAt:${string}` |
	`idbfallback::${string}`
);

export const miLocalStorage = {
	getItem: (key: Keys): string | null => {
		return window.localStorage.getItem(key);
	},
	setItem: (key: Keys, value: string): void => {
		window.localStorage.setItem(key, value);
	},
	removeItem: (key: Keys): void => {
		window.localStorage.removeItem(key);
	},
	getItemAsJson: (key: Keys): any | undefined => {
		const item = miLocalStorage.getItem(key);
		if (item === null) {
			return undefined;
		}
		return JSON.parse(item);
	},
	setItemAsJson: (key: Keys, value: any): void => {
		miLocalStorage.setItem(key, JSON.stringify(value));
	},
};
