/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(scriptDir, '..');

function toPosixPath(filePath) {
	return filePath.split(path.sep).join('/');
}

function isInside(parentDir, filePath) {
	const relative = path.relative(parentDir, filePath);
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function isCheckableDeclarationFile(filePath, rootDir = defaultRootDir) {
	const absoluteRootDir = path.resolve(rootDir);
	const absoluteFilePath = path.resolve(filePath);
	if (!isInside(absoluteRootDir, absoluteFilePath)) return false;
	if (!absoluteFilePath.endsWith('.d.ts')) return false;

	const relativePath = toPosixPath(path.relative(absoluteRootDir, absoluteFilePath));
	const segments = relativePath.split('/');
	if (segments.includes('node_modules') || segments.includes('.pnpm')) return false;
	if (segments.includes('built') || segments.includes('js-built')) return false;

	return true;
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getWorkspacePackageDirs(rootDir) {
	const rootPackageJson = readJson(path.join(rootDir, 'package.json'));
	return rootPackageJson.workspaces
		.filter((workspace) => !workspace.includes('*'))
		.map((workspace) => path.resolve(rootDir, workspace))
		.filter((workspaceDir) => fs.existsSync(path.join(workspaceDir, 'package.json')));
}

function getTsconfigPaths(packageDir) {
	return ts.sys.readDirectory(
		packageDir,
		['.json'],
		['node_modules'],
		['**/tsconfig.json'],
		undefined,
	);
}

function discoverDeclarationFiles(packageDir, rootDir) {
	return ts.sys.readDirectory(
		packageDir,
		['.d.ts'],
		undefined,
		['**/*.d.ts'],
		undefined,
	).filter((filePath) => isCheckableDeclarationFile(filePath, rootDir));
}

function readTsconfig(tsconfigPath) {
	if (!fs.existsSync(tsconfigPath)) return undefined;

	const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (config.error != null) {
		throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
	}

	return ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(tsconfigPath), undefined, tsconfigPath);
}

function createFormatHost(rootDir) {
	return {
		getCanonicalFileName: (fileName) => fileName,
		getCurrentDirectory: () => rootDir,
		getNewLine: () => ts.sys.newLine,
	};
}

function isRootTsconfig(packageDir, tsconfigPath) {
	return path.resolve(packageDir, 'tsconfig.json') === path.resolve(tsconfigPath);
}

function getDeclarationFilesForTsconfig(packageDir, tsconfigPath, parsedConfig, rootDir) {
	const declarationFiles = parsedConfig.fileNames
		.filter((filePath) => isCheckableDeclarationFile(filePath, rootDir));

	if (!isRootTsconfig(packageDir, tsconfigPath)) {
		return declarationFiles;
	}

	const extraRootConfigDeclarationFiles = discoverDeclarationFiles(packageDir, rootDir)
		.filter((filePath) => {
			return path.dirname(filePath) === packageDir;
		});

	return [...new Set([...declarationFiles, ...extraRootConfigDeclarationFiles])];
}

function checkTsconfigDeclarations(packageDir, tsconfigPath, rootDir) {
	const parsedConfig = readTsconfig(tsconfigPath);
	if (parsedConfig == null) {
		return { declarationFiles: [], diagnostics: [] };
	}

	const declarationFiles = getDeclarationFilesForTsconfig(packageDir, tsconfigPath, parsedConfig, rootDir);
	if (declarationFiles.length === 0) {
		return { declarationFiles, diagnostics: [] };
	}

	const program = ts.createProgram({
		rootNames: declarationFiles,
		options: {
			...parsedConfig.options,
			noEmit: true,
			skipLibCheck: false,
		},
	});

	const diagnostics = ts.getPreEmitDiagnostics(program)
		.filter((diagnostic) => diagnostic.file != null && isCheckableDeclarationFile(diagnostic.file.fileName, rootDir));

	return { declarationFiles, diagnostics };
}

function deduplicateDiagnostics(diagnostics) {
	const seen = new Set();
	return diagnostics.filter((diagnostic) => {
		const key = [
			diagnostic.file?.fileName ?? '',
			diagnostic.start ?? '',
			diagnostic.code,
			ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
		].join('\0');
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function checkPackageDeclarations(packageDir, rootDir) {
	const results = getTsconfigPaths(packageDir)
		.map((tsconfigPath) => checkTsconfigDeclarations(packageDir, tsconfigPath, rootDir));

	return {
		declarationFiles: [...new Set(results.flatMap((result) => result.declarationFiles))],
		diagnostics: deduplicateDiagnostics(results.flatMap((result) => result.diagnostics)),
	};
}

export function checkDeclarations(rootDir = defaultRootDir) {
	const workspacePackageDirs = getWorkspacePackageDirs(rootDir);
	const results = workspacePackageDirs.map((packageDir) => ({
		packageDir,
		...checkPackageDeclarations(packageDir, rootDir),
	}));

	return {
		results,
		declarationFileCount: results.reduce((count, result) => count + result.declarationFiles.length, 0),
		diagnostics: results.flatMap((result) => result.diagnostics),
	};
}

function main() {
	const { declarationFileCount, diagnostics } = checkDeclarations(defaultRootDir);

	if (diagnostics.length === 0) {
		console.log(`Checked ${declarationFileCount} repository declaration files.`);
		return;
	}

	console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, createFormatHost(defaultRootDir)));
	process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
