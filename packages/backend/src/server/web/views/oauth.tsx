/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { CommonProps } from '@/server/web/views/_.js';
import { Layout } from '@/server/web/views/base.js';

export function OAuthPage(props: CommonProps<{
	transactionId: string;
	clientName: string;
	clientLogo?: string;
	scope: string[];
	mastodonScopes?: string[];
	forceLogin?: boolean;
	language?: string;
}>) {
	//- Should be removed by the page when it loads, so that it won't needlessly
	//- stay when user navigates away via the navigation bar
	//- XXX: Remove navigation bar in auth page?
	function metaBlock() {
		return (
			<>
				<meta name="misskey:oauth:transaction-id" content={props.transactionId} />
				<meta name="misskey:oauth:client-name" content={props.clientName} />
				{props.clientLogo ? <meta name="misskey:oauth:client-logo" content={props.clientLogo} /> : null}
				<meta name="misskey:oauth:scope" content={props.scope.join(' ')} />
				{props.mastodonScopes != null ? <meta name="misskey:oauth:mastodon-scopes" content={props.mastodonScopes.join(' ')} /> : null}
				{props.forceLogin ? <meta name="misskey:oauth:force-login" content="true" /> : null}
				{props.language != null ? <meta name="misskey:oauth:lang" content={props.language} /> : null}
			</>
		);
	}

	return (
		<Layout
			{...props}
			metaSlot={metaBlock()}
		>
		</Layout>
	);
}

export async function OAuthOobPage(props: { code?: string; language?: string }) {
	const { locales } = await import('i18n');
	const language = props.language ?? 'en-US';
	const locale = locales[language] ?? locales['en-US'];
	return (
		<>
			{'<!DOCTYPE html>'}
			<html lang={language}>
				<head>
					<meta charset="UTF-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<meta name="referrer" content="no-referrer" />
					<meta name="robots" content="noindex, nofollow" />
					<title safe>{locale.authentication}</title>
				</head>
				<body>
					<main>
						<h1 safe>{props.code != null ? locale._auth.accepted : locale._auth.denied}</h1>
						{props.code != null ? <>
							<p safe>{locale._auth.copyAuthorizationCode}</p>
							<label for="authorization-code" safe>{locale._auth.authorizationCode}</label>
							<input id="authorization-code" value={props.code} readonly autocomplete="off" spellcheck="false" size="64" />
						</> : null}
					</main>
				</body>
			</html>
		</>
	);
}
