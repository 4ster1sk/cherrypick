/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import { IsNull, MoreThan, Not } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository, MetasRepository, MiDriveFile, MiMeta } from '@/models/_.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { DriveService } from '@/core/DriveService.js';
import { IdService } from '@/core/IdService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';

@Injectable()
export class CleanRemoteDriveFilesProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.metasRepository)
		private metasRepository: MetasRepository,

		private driveService: DriveService,
		private idService: IdService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('clean-remote-drive-files');
	}

	@bindThis
	private async fetchMeta(): Promise<MiMeta | null> {
		// 過去のバグでレコードが複数出来てしまっている可能性があるので新しいIDを優先する
		const metas = await this.metasRepository.find({
			order: {
				id: 'DESC',
			},
			take: 1,
		});
		return metas[0] ?? null;
	}

	@bindThis
	private async findUnreferencedIds(fileIds: MiDriveFile['id'][]): Promise<Set<MiDriveFile['id']>> {
		if (fileIds.length === 0) return new Set();
		const rows = await this.driveFilesRepository.query(
			`WITH page_text AS (
				-- page 全文走査はバッチあたり1回にまとめる (候補ごとの相関スキャンを避ける)
				SELECT string_agg(page."content"::text, chr(10)) AS t FROM page
			)
			SELECT f."id" AS "id" FROM drive_file f, page_text WHERE f."id" = ANY($1)
				-- 配列側を左辺にした @> で GIN (IDX_NOTE_FILE_IDS) を効かせる (= ANY(配列列) では使えない)
				AND NOT EXISTS (SELECT 1 FROM note WHERE note."fileIds" @> ARRAY[f."id"])
				AND NOT EXISTS (SELECT 1 FROM "user" WHERE "avatarId" = f."id" OR "bannerId" = f."id")
				AND NOT EXISTS (SELECT 1 FROM gallery_post WHERE gallery_post."fileIds" @> ARRAY[f."id"])
				AND NOT EXISTS (SELECT 1 FROM chat_message WHERE "fileId" = f."id")
				AND NOT EXISTS (SELECT 1 FROM page WHERE "eyeCatchingImageId" = f."id")
				-- ページ本文の画像ブロックも参照しうる (children にネストしうるためテキスト検索で判定)。
				-- 誤検出しても温存側に倒れるだけなので安全
				AND NOT EXISTS (SELECT 1 FROM page_text WHERE strpos(page_text.t, f."id") > 0)
				AND NOT EXISTS (SELECT 1 FROM channel WHERE "bannerId" = f."id")`,
			[fileIds],
		) as { id: MiDriveFile['id'] }[];
		return new Set(rows.map(r => r.id));
	}

	@bindThis
	public async process(job: Bull.Job<Record<string, unknown>>): Promise<{
		deletedCount: number;
		checkedCount: number;
		skipped: boolean;
		completed: boolean;
		transientErrors: number;
	}> {
		const initialMeta = await this.fetchMeta();
		if (initialMeta == null || !initialMeta.enableRemoteDriveFilesCleaning) {
			this.logger.info('Remote drive files cleaning is disabled, skipping...');
			return {
				deletedCount: 0,
				checkedCount: 0,
				skipped: true,
				completed: false,
				transientErrors: 0,
			};
		}

		this.logger.info('cleaning remote drive files...');

		const startAt = Date.now();
		const batchSize = 100;

		let cursor: MiDriveFile['id'] | null = initialMeta.remoteDriveFilesCleaningLastCursorId;
		let deletedCount = 0;
		let checkedCount = 0;
		let transientErrors = 0;
		let consecutiveErrors = 0;
		const maxConsecutiveErrors = 10;
		let completed = false;

		for (;;) {
			// 実行中に設定が変わりうるので毎バッチ読み直す
			const meta = await this.fetchMeta();
			if (meta == null || !meta.enableRemoteDriveFilesCleaning) {
				this.logger.info('Remote drive files cleaning is disabled, processing stopped...');
				break;
			}

			const maxDuration = meta.remoteDriveFilesCleaningMaxProcessingDurationInMinutes * 60 * 1000;
			const newestLimit = this.idService.gen(Date.now() - (1000 * 60 * 60 * 24 * meta.remoteDriveFilesCleaningExpiryDaysForEachFiles));

			const elapsed = Date.now() - startAt;
			if (elapsed >= maxDuration) {
				job.log(`Reached maximum duration of ${maxDuration}ms, stopping... (last cursor: ${cursor}, checked ${checkedCount} files, deleted ${deletedCount} files)`);
				break;
			}

			const batchBeginAt = Date.now();

			const files = await this.driveFilesRepository.find({
				where: {
					userHost: Not(IsNull()),
					isLink: false,
					...(cursor ? { id: MoreThan(cursor) } : {}),
				},
				take: batchSize,
				order: {
					id: 1,
				},
			});

			if (files.length === 0) {
				// 全件走査し終えたので次回は先頭からやり直す
				await this.metasRepository.update(meta.id, { remoteDriveFilesCleaningLastCursorId: null });
				cursor = null;
				completed = true;
				job.log('No more files to clean.');
				break;
			}

			// ID は時系列順なので、保持期限内のファイルに到達したら以降は全て期限内。今回の走査は完了扱いにする
			const cutoffIndex = files.findIndex(file => file.id >= newestLimit);
			const targets = cutoffIndex === -1 ? files : files.slice(0, cutoffIndex);
			const hitNewestLimit = cutoffIndex !== -1;

			let unreferencedIds: Set<MiDriveFile['id']>;
			try {
				// バッチ内の参照チェックを1クエリに集約する (N+1 回避)
				unreferencedIds = await this.findUnreferencedIds(targets.map(file => file.id));
			} catch (e) {
				// 判定不能な場合は安全側(温存)に倒し、カーソルを進めず次バッチで同じ範囲から再試行する
				transientErrors++;
				consecutiveErrors++;
				job.log(`Error checking references of ${targets.length} files: ${e} (transient error?)`);
				if (consecutiveErrors >= maxConsecutiveErrors) {
					job.log(`Too many consecutive errors (${consecutiveErrors}), stopping... (last cursor: ${cursor})`);
					break;
				}
				continue;
			}

			let batchHadDeleteError = false;
			for (const file of targets) {
				if (!unreferencedIds.has(file.id)) {
					cursor = file.id;
					checkedCount++;
					consecutiveErrors = 0;
					continue;
				}

				try {
					await this.driveService.deleteFileSync(file);
					deletedCount++;
				} catch (e) {
					// バッチを打ち切り、カーソルを最後の成功位置に留めることで次バッチでこのファイルから再開させる
					// (continue すると後続ファイルの成功でカーソルが失敗ファイルを飛び越えてしまう)
					transientErrors++;
					consecutiveErrors++;
					job.log(`Error deleting file ${file.id}: ${e} (transient race condition?)`);
					batchHadDeleteError = true;
					break;
				}

				cursor = file.id;
				checkedCount++;
				consecutiveErrors = 0;
			}

			if (consecutiveErrors >= maxConsecutiveErrors) {
				job.log(`Too many consecutive errors (${consecutiveErrors}), stopping... (last cursor: ${cursor})`);
				break;
			}

			if (hitNewestLimit && !batchHadDeleteError) {
				// 保持期限内のファイルに到達したので今回の走査は完了扱いにする
				await this.metasRepository.update(meta.id, { remoteDriveFilesCleaningLastCursorId: null });
				cursor = null;
				completed = true;
			}

			// 次回はここから再開できるようカーソルを永続化する
			if (cursor != null) {
				await this.metasRepository.update(meta.id, { remoteDriveFilesCleaningLastCursorId: cursor });
			}

			const batchDuration = Date.now() - batchBeginAt;
			job.log(`Checked ${files.length} files (total checked: ${checkedCount}, deleted: ${deletedCount}); ${batchDuration}ms`);

			if (completed) {
				break;
			}

			if (process.env.NODE_ENV !== 'test') {
				await setTimeout(Math.min(1000, batchDuration)); // Wait a moment to avoid overwhelming the db
			}
		}

		if (transientErrors > 0) {
			const msg = `${transientErrors} transient errors occurred while cleaning remote drive files. You may need a second pass to complete the cleaning.`;
			this.logger.warn(msg);
			job.log(msg);
		}

		if (completed) {
			const summary = `cleaning of remote drive files completed. Deleted ${deletedCount} orphan files (checked ${checkedCount} files).`;
			this.logger.succ(summary);
			job.log(summary);
		} else {
			const summary = `cleaning of remote drive files stopped before completion (last cursor: ${cursor}). Deleted ${deletedCount} orphan files (checked ${checkedCount} files).`;
			this.logger.warn(summary);
			job.log(summary);
		}

		return {
			deletedCount,
			checkedCount,
			skipped: false,
			completed,
			transientErrors,
		};
	}
}
