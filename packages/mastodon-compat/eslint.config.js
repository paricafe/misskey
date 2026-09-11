import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [{ ignores: ['dist/**', 'node_modules/**'] }, {
	files: ['src/**/*.ts', 'test/**/*.ts'],
	languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
	plugins: { '@typescript-eslint': tsPlugin },
	rules: {
		'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
		'no-constant-condition': ['error', { checkLoops: false }],
		'no-debugger': 'error',
		'eqeqeq': ['error', 'always', { null: 'ignore' }]
	}
}];
