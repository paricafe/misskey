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
}>) {
	function metaBlock() {
		return (
			<>
				<meta name="misskey:oauth:transaction-id" content={props.transactionId} />
				<meta name="misskey:oauth:client-name" content={props.clientName} />
				{props.clientLogo ? <meta name="misskey:oauth:client-logo" content={props.clientLogo} /> : null}
				<meta name="misskey:oauth:scope" content={props.scope.join(' ')} />
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
