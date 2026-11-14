import { defineConfig, mergeConfig } from 'vitest/config';
import { getConfig } from './vite.config.js';

export default mergeConfig(getConfig(), defineConfig({
	test: {
		include: ['./test/unit/**/*.test.ts'],
		environment: 'happy-dom',
		setupFiles: ['./test/setup.unit.ts'],
		deps: {
			optimizer: {
				web: {
					include: [
						'browser-image-resizer',
					],
				},
			},
		},
		includeSource: ['src/**/*.ts'],
	},
}));

