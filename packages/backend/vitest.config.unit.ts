import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from './vitest.config.js';

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globalSetup: './test/setup.unit.ts',
			environment: './test/environment.unit.ts',
			include: ['test/unit/**/*.ts', 'src/**/*.test.ts'],
			// yojo-art 独自のテストは jest ベースのため、vitest の実行対象から除外する (必要に応じて `pnpm jest` で実行)
			exclude: [
				'test/unit/core/activitypub/misc/normalize-ap-emoji-tag.ts',
				'test/unit/server/api/endpoints/fetch-rss.ts',
				'test/unit/server/api/translate/notes_translate.ts',
				'test/unit/server/api/translate/polls_translate.ts',
				'test/unit/server/api/translate/users_translate.ts',
			],
		},
	}),
);
