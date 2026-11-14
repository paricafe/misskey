import { findSourceMap } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setupCoverage, startCoverage } from './coverage.js';
import type { TestProject } from 'vitest/node';

const bundleUrlPrefix = new URL('./', import.meta.url).href;

startCoverage();

installPrepareStackTrace();

function installPrepareStackTrace() {
	process.setSourceMapsEnabled(true);

	const prepare = Error.prepareStackTrace;

	Error.prepareStackTrace = (error, callSites) => {
		let mappedCallSites = callSites;
		try {
			mappedCallSites = callSites.map(mapBundledCallSite);
			if (prepare != null) return prepare(error, mappedCallSites);
		} catch {
		}
		return `${String(error)}${mappedCallSites.map(callSite => `\n    at ${callSite}`).join('')}`;
	};
}

function mapBundledCallSite(callSite: NodeJS.CallSite): NodeJS.CallSite {
	const fileName = callSite.getFileName();
	const line = callSite.getLineNumber();
	const column = callSite.getColumnNumber();
	if (fileName == null || line == null || column == null || !fileName.startsWith(bundleUrlPrefix)) return callSite;

	const origin = findSourceMap(fileName)?.findOrigin(line, column);
	if (origin == null || !('fileName' in origin)) return callSite;

	const originFileName = origin.fileName.startsWith('file://') ? fileURLToPath(origin.fileName) : origin.fileName;
	const location = `${originFileName}:${origin.lineNumber}:${origin.columnNumber}`;
	const overrides: Partial<NodeJS.CallSite> & { toString(): string } = {
		getFileName: () => originFileName,
		getScriptNameOrSourceURL: () => originFileName,
		getLineNumber: () => origin.lineNumber,
		getColumnNumber: () => origin.columnNumber,
		toString: () => callSite.toString().replace(`${fileName}:${line}:${column}`, location),
	};

	return new Proxy(callSite, {
		get(target, property) {
			if (Object.hasOwn(overrides, property)) return overrides[property as keyof typeof overrides];
			const value = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

let serverModule: Promise<typeof import('./server.js')> | undefined;

function loadServer() {
	return serverModule ??= import('./server.js');
}

export async function setup(project: TestProject) {
	await setupCoverage(project);
	await (await loadServer()).setup();
}

export async function teardown() {
	await (await loadServer()).teardown();
}
