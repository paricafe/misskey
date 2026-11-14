import globals from 'globals';
import pluginMisskey from '@misskey-dev/eslint-plugin';

export default [
	...pluginMisskey.configs['recommended'],
	{
		files: ['**/*.cjs'],
		languageOptions: {
			sourceType: 'commonjs',
			parserOptions: {
				sourceType: 'commonjs',
			},
		},
	},
	{
		files: ['**/*.js', '**/*.jsx'],
		languageOptions: {
			parserOptions: {
				sourceType: 'module',
			},
		},
	},
	{
		files: ['build.js'],
		languageOptions: {
			globals: globals.node,
		},
	},
	{
		files: ['**/*.js', '**/*.cjs'],
		rules: {
			'@typescript-eslint/no-var-requires': 'off',
		},
	},
	{
		rules: {
			'no-restricted-imports': ['error', {
				paths: [{ name: 'punycode' }],
			}],
			'@typescript-eslint/no-misused-promises': 'off',
			'no-async-promise-executor': 'error',
		},
	},
	{
		files: ['**/*.ts', '**/*.tsx'],
		rules: {
			'@typescript-eslint/no-unused-vars': ['warn', {
				'args': 'all',
				'argsIgnorePattern': '^_',
				'caughtErrors': 'all',
				'caughtErrorsIgnorePattern': '^_',
				'destructuredArrayIgnorePattern': '^_',
				'varsIgnorePattern': '^_',
				'ignoreRestSiblings': true,
			}],
		},
	},
];
