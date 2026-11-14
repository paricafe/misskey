import path from 'path';
import pluginVue from '@vitejs/plugin-vue';
import { defineConfig, type UserConfig } from 'vite';
import { load as loadYaml } from 'js-yaml';
import { promises as fsp } from 'fs';

import locales from 'i18n';
import meta from '../../package.json';
import packageInfo from './package.json' with { type: 'json' };
import pluginJson5 from './lib/vite-plugin-json5.js';
import { pluginRemoveUnrefI18n } from '../frontend-builder/rollup-plugin-remove-unref-i18n';
import { Features } from 'lightningcss';

const url = process.env.NODE_ENV === 'development' ? (loadYaml(await fsp.readFile('../../.config/default.yml', 'utf-8')) as any).url : null;
const host = url ? (new URL(url)).hostname : undefined;

const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', '.json5', '.svg', '.sass', '.scss', '.css', '.vue'];

const externalPackages = [
	{
		name: 'shiki',
		match: /^shiki\/(?<subPkg>(langs|themes))$/,
		path(id: string, pattern: RegExp): string {
			const match = pattern.exec(id)?.groups;
			return match
				? `https://esm.sh/shiki@${packageInfo.dependencies.shiki}/${match['subPkg']}`
				: id;
		},
	},
	{
		name: 'tinyld',
		match: /^tinyld$/,
		path(): string {
			return `https://cdn.jsdelivr.net/npm/tinyld@${packageInfo.dependencies.tinyld}/dist/tinyld.heavy.node.mjs`
		},
	},
];

const hash = (str: string, seed = 0): number => {
	let h1 = 0xdeadbeef ^ seed,
		h2 = 0x41c6ce57 ^ seed;
	for (let i = 0, ch; i < str.length; i++) {
		ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}

	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

const BASE62_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function toBase62(n: number): string {
	if (n === 0) {
		return '0';
	}
	let result = '';
	while (n > 0) {
		result = BASE62_DIGITS[n % BASE62_DIGITS.length] + result;
		n = Math.floor(n / BASE62_DIGITS.length);
	}

	return result;
}

export function getConfig(): UserConfig {
	const localesHash = toBase62(hash(JSON.stringify(locales)));

	return {
		base: '/embed_vite/',

		clearScreen: false,

		server: {
			host: '0.0.0.0',
			allowedHosts: host ? [host] : undefined,
			port: 5174,
			strictPort: true,
			hmr: {
				clientPort: 5174,
			},
		},

		plugins: [
			pluginVue(),
			pluginRemoveUnrefI18n(),
			pluginJson5(),
		],

		resolve: {
			extensions,
			alias: {
				'@/': __dirname + '/src/',
				'@@/': __dirname + '/../frontend-shared/',
				'/client-assets/': __dirname + '/assets/',
				'/static-assets/': __dirname + '/../backend/assets/',
				'/fluent-emoji/': '@misskey-dev/emoji-assets/fluent-emoji/',
			},
		},

		css: {
			lightningcss: {
				exclude: Features.LightDark,
			},
			modules: {
				generateScopedName(name, filename, _css): string {
					const id = (path.relative(__dirname, filename.split('?')[0]) + '-' + name).replace(/[\\\/\.\?&=]/g, '-').replace(/(src-|vue-)/g, '');
					if (process.env.NODE_ENV === 'production') {
						return 'x' + toBase62(hash(id)).substring(0, 4);
					} else {
						return id;
					}
				},
			},
		},

		define: {
			_VERSION_: JSON.stringify(meta.version),
			_LANGS_: JSON.stringify(Object.entries(locales).map(([k, v]) => [k, v._lang_])),
			_ENV_: JSON.stringify(process.env.NODE_ENV),
			_DEV_: process.env.NODE_ENV !== 'production',
			_PERF_PREFIX_: JSON.stringify('Misskey:'),
			__VUE_OPTIONS_API__: false,
			__VUE_PROD_DEVTOOLS__: false,
		},

		build: {
			target: [
				'chrome130',
				'firefox132',
				'safari18.2',
			],
			manifest: 'manifest.json',
			rolldownOptions: {
				experimental: {
					nativeMagicString: true,
				},
				input: {
					i18n: './src/i18n.ts',
					entry: './src/boot.ts',
				},
				external: externalPackages.map(p => p.match),
				preserveEntrySignatures: 'allow-extension',
				output: {
					codeSplitting: {
						groups: [{
							name: 'vue',
							test: /node_modules[\\/]vue/,
						}, {
							name: 'i18n',
							includeDependenciesRecursively: false,
							test: /i18n\.ts|locale\.ts/,
						}],
					},
					entryFileNames: `scripts/${localesHash}-[hash:8].js`,
					chunkFileNames: `scripts/${localesHash}-[hash:8].js`,
					assetFileNames: `assets/${localesHash}-[hash:8][extname]`,
					paths(id) {
						for (const p of externalPackages) {
							if (p.match.test(id)) {
								return p.path(id, p.match);
							}
						}

						return id;
					},
				},
			},
			cssCodeSplit: true,
			outDir: __dirname + '/../../built/_frontend_embed_vite_',
			assetsDir: '.',
			emptyOutDir: false,
			sourcemap: process.env.NODE_ENV === 'development',
			reportCompressedSize: false,

			commonjsOptions: {
				include: [/misskey-js/, /node_modules/],
			},
		},

		worker: {
			format: 'es',
		},
	};
}

const config = defineConfig(({ command, mode }) => getConfig());

export default config;
