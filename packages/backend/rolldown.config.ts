import { defineConfig } from 'rolldown';
import { version as summalyVersion } from '@misskey-dev/summaly';
import type { ExternalOption } from 'rolldown';
import { backendDevServerPlugin } from './lib/backend-dev-server.ts';
import { bullmqEsmPlugin } from './lib/bullmq-esm.ts';
import { esmShimPlugin } from './lib/esm-shim.ts';

export default defineConfig((args) => {
	const isWatchMode = args.watch != null && args.watch !== 'false';
	const isE2E = args.e2e != null && args.e2e !== 'false';

	const allExternalModulesRegex = /^(?!@\/|\0)[^.\/](?!:[\/\\])/;

	const externalModules: ExternalOption = [
		/^slacc-.*/,
		'class-transformer',
		'class-validator',
		/^@sentry\/.*/,
		/^@sentry-internal\/.*/,
		/^@nestjs\/(?:microservices|websockets)(?:\/.*)?$/,
		'mock-aws-s3',
		'aws-sdk',
		'nock',
		'sharp',
		'jsdom',
		're2',
		'ipaddr.js',
		'file-type',
		'pg',
	];

	const define: Record<string, string> = {
		'_SUMMALY_VERSION_': JSON.stringify(summalyVersion),
	};

	if (isE2E) {
		return {
			input: './test-server/entry.ts',
			platform: 'node',
			tsconfig: './test-server/tsconfig.json',
			plugins: [
				esmShimPlugin(),
			],
			transform: {
				define,
			},
			output: {
				keepNames: true,
				sourcemap: true,
				charset: 'ascii',
				dir: './built-test',
				cleanDir: true,
				format: 'esm',
			},
			experimental: {
				nativeMagicString: true,
			},
			external: allExternalModulesRegex,
		};
	} else {
		return {
			input: [
				'./src/boot/entry.ts',
				'./src/boot/cli.ts',
				'./src/config.ts',
				'./src/postgres.ts',
				'./src/server/api/openapi/gen-spec.ts',
			],
			platform: 'node',
			tsconfig: true,
			plugins: [
				esmShimPlugin(),
				(isWatchMode ? backendDevServerPlugin() : undefined),
				(isWatchMode ? undefined : bullmqEsmPlugin()),
			],
			transform: {
				define,
			},
			output: {
				keepNames: true,
				minify: !isWatchMode,
				sourcemap: isWatchMode,
				charset: isWatchMode ? 'utf8' : 'ascii',
				dir: './built',
				cleanDir: !isWatchMode,
				format: 'esm',
			},
			watch: {
				include: ['src/**/*.{ts,js,mjs,cjs,tsx,json}'],
				clearScreen: false,
			},
			experimental: {
				nativeMagicString: true,
			},
			external: isWatchMode ? allExternalModulesRegex : externalModules,
		};
	}
});
