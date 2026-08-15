/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, yojo-art team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import util from 'util';
import stripAnsi from 'strip-ansi';
import type { Log } from '@google-cloud/logging';
import type { LogBackend } from './LogBackend.js';
import type { LogRecord } from './types.js';

/**
 * 正規化済みのログをGoogle Cloud Loggingへ出力するための出力先です。
 * yojo-art 独自機能として、コンソール出力とは別にCloud Loggingへも送信します。
 */
export class CloudLoggingBackend implements LogBackend {
	private readonly log: Log;

	constructor(log: Log) {
		this.log = log;
	}

	public write(record: LogRecord): void {
		// `fatal`はCloud Loggingのseverityへ存在しないため、`error`として扱います。
		const severity = record.level === 'fatal' ? 'error' : record.level;

		const logMessage = stripAnsi(record.message);
		const metadata = {
			severity: severity.toUpperCase(),
			resource: {
				type: 'global',
				timestamp: new Date(record.timestamp),
			},
			labels: {
				name: record.loggerName,
			},
		};

		const dataString = record.compatibility?.data != null
			? '\n' + util.inspect(record.compatibility.data, { depth: null })
			: '';
		const entry = this.log.entry(metadata, logMessage + dataString);

		this.log.write(entry).catch(() => {});
	}
}
