/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, yojo-art team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe } from 'vitest';
import { loadConfig } from '../../src/config.js';

/**
 * describeOpenSearchE2E で宣言される suite の名前に付ける共通プレフィックス。
 * OPENSEARCH_E2E=1 のとき `vitest --testNamePattern="^\[opensearch\] "` で
 * このプレフィックスを持つ suite のみ実行する。
 */
export const OPENSEARCH_SUITE_PREFIX = '[opensearch] ';

/**
 * OpenSearch E2E CI（OPENSEARCH_E2E=1）で実行する suite を宣言する。
 *
 * OPENSEARCH_E2E=1 のときは package.json の test:e2e:opensearch スクリプトで
 * `--testNamePattern` を使って本関数で宣言された suite のみ実行する。
 * requireOpenSearch が true のとき、config に opensearch が無ければ skip する。
 */
export function describeOpenSearchE2E(
	name: string,
	fnOrOpts: (() => void) | { requireOpenSearch?: boolean },
	fn?: () => void,
): void {
	let callback: () => void;
	let opts: { requireOpenSearch?: boolean } | undefined;

	if (typeof fnOrOpts === 'function') {
		callback = fnOrOpts;
		opts = undefined;
	} else {
		opts = fnOrOpts;
		if (fn == null) {
			throw new Error('describeOpenSearchE2E: callback is required');
		}
		callback = fn;
	}

	if (opts?.requireOpenSearch) {
		const config = loadConfig();
		if (!config.opensearch) {
			describe.skip(OPENSEARCH_SUITE_PREFIX + name, callback);
			return;
		}
	}

	describe(OPENSEARCH_SUITE_PREFIX + name, callback);
}
