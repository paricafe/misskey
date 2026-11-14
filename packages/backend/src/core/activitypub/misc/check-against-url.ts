/*
 * SPDX-FileCopyrightText: dakkar and sharkey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { IObject } from '../type.js';

export enum FetchAllowSoftFailMask {
	Strict = 0,
	NonCanonicalId = 1 << 0,
	MisalignedOrigin = 1 << 1,
	CrossOrigin = 1 << 2 | MisalignedOrigin,
	Any = ~0,
}

function hostFuzzyMatch(requestHost: string, candidateHost: string): FetchAllowSoftFailMask {
	const requestFqdn = requestHost.endsWith('.') ? requestHost : `${requestHost}.`;
	const candidateFqdn = candidateHost.endsWith('.') ? candidateHost : `${candidateHost}.`;

	if (requestFqdn === candidateFqdn) {
		return FetchAllowSoftFailMask.Strict;
	}

	const requestDnsDepth = requestFqdn.split('.').length;
	const candidateDnsDepth = candidateFqdn.split('.').length;

	if ((candidateDnsDepth - requestDnsDepth) !== 1) {
		return FetchAllowSoftFailMask.CrossOrigin;
	}

	if (`.${candidateHost}`.endsWith(`.${requestHost}`)) {
		return FetchAllowSoftFailMask.MisalignedOrigin;
	}

	return FetchAllowSoftFailMask.CrossOrigin;
}

function normalizeSynonymousSubdomain(url: URL | string): URL {
	const urlParsed = url instanceof URL ? url : new URL(url);
	const host = urlParsed.host;
	const normalizedHost = host.replace(/^www\./, '');
	return new URL(urlParsed.toString().replace(host, normalizedHost));
}

export function assertActivityMatchesUrl(requestUrl: string | URL, activity: IObject, finalUrl: string | URL, allowSoftfail: FetchAllowSoftFailMask): FetchAllowSoftFailMask {
	if (!activity.id) {
		throw new Error('bad Activity: missing id field');
	}

	let softfail = 0;

	const requireSoftfail = (needed: FetchAllowSoftFailMask, message: string) => {
		if ((allowSoftfail & needed) !== needed) {
			throw new Error(message);
		}

		softfail |= needed;
	};

	const requestUrlParsed = normalizeSynonymousSubdomain(requestUrl);
	const idParsed = normalizeSynonymousSubdomain(activity.id);

	const finalUrlParsed = normalizeSynonymousSubdomain(finalUrl);

	requestUrlParsed.hash = '';
	finalUrlParsed.hash = '';

	const requestUrlSecure = requestUrlParsed.protocol === 'https:';
	const finalUrlSecure = finalUrlParsed.protocol === 'https:';
	if (requestUrlSecure && !finalUrlSecure) {
		throw new Error(`bad Activity: id(${activity.id}) is not allowed to have http:// in the url`);
	}

	if (finalUrlParsed.href !== idParsed.href) {
		requireSoftfail(FetchAllowSoftFailMask.NonCanonicalId, `bad Activity: id(${activity.id}) does not match response url(${finalUrlParsed.toString()})`);

		if (idParsed.host !== finalUrlParsed.host) {
			throw new Error(`bad Activity: id(${activity.id}) does not match response host(${finalUrlParsed.host})`);
		}
	}

	if (requestUrlParsed.href !== idParsed.href) {
		requireSoftfail(FetchAllowSoftFailMask.NonCanonicalId, `bad Activity: id(${activity.id}) does not match request url(${requestUrlParsed.toString()})`);

		const hostResult = hostFuzzyMatch(requestUrlParsed.host, idParsed.host);

		requireSoftfail(hostResult, `bad Activity: id(${activity.id}) is valid but is not the same origin as request url(${requestUrlParsed.toString()})`);
	}

	return softfail;
}
