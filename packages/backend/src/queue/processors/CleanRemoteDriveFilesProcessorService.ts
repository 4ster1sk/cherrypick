/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import { IsNull, MoreThan, Not } from 'typeorm';
import type { DataSource } from 'typeorm';
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

		@Inject(DI.db)
		private db: DataSource,

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
	private async findUnreferencedIds(fileIds: MiDriveFile['id'][], timeoutMs: number): Promise<Set<MiDriveFile['id']>> {
		if (fileIds.length === 0) return new Set();
		// 大規模環境では NOT EXISTS 群が重くなり、デフォルトの statement_timeout (10s) で57014になりうる。
		// 実行予定時間 (remoteDriveFilesCleaningMaxProcessingDurationInMinutes) に連動させ、
		// このクエリだけ SET LOCAL で延長する。SET LOCAL はトランザクション内必須のため QueryRunner を使用する。
		const clampedTimeoutMs = Math.min(Math.max(Math.floor(timeoutMs), 1000), 2147483647);
		const queryRunner = this.db.createQueryRunner('master');
		try {
			await queryRunner.connect();
			await queryRunner.startTransaction();
			await queryRunner.query(`SET LOCAL statement_timeout = ${clampedTimeoutMs}`);
			const rows = await queryRunner.query(
				// page は eyeCatchingImage・本文ブロックいずれも参照元になりえない
				// (eyeCatchingImage は本人所有ファイルのみ許可され、本人所有ファイルの userHost は必ず null。
				// 本文ブロックは UI 上は自ドライブからの選択のみ) ため判定対象外とする。
				// page 全文集約は10分規模の重クエリの主因だったため、これにより CTE を除去する。
				`SELECT f."id" AS "id" FROM drive_file f WHERE f."id" = ANY($1)
					-- 配列側を左辺にした @> で GIN (IDX_NOTE_FILE_IDS) を効かせる (= ANY(配列列) では使えない)
					AND NOT EXISTS (SELECT 1 FROM note WHERE note."fileIds" @> ARRAY[f."id"])
					AND NOT EXISTS (SELECT 1 FROM "user" WHERE "avatarId" = f."id" OR "bannerId" = f."id")
					AND NOT EXISTS (SELECT 1 FROM gallery_post WHERE gallery_post."fileIds" @> ARRAY[f."id"])
					AND NOT EXISTS (SELECT 1 FROM chat_message WHERE "fileId" = f."id")
					AND NOT EXISTS (SELECT 1 FROM channel WHERE "bannerId" = f."id")`,
				[fileIds],
			) as { id: MiDriveFile['id'] }[];
			await queryRunner.commitTransaction();
			return new Set(rows.map(r => r.id));
		} catch (e) {
			try {
				await queryRunner.rollbackTransaction();
			} catch {
				// ロールバック失敗は元のエラーを優先する
			}
			throw e;
		} finally {
			await queryRunner.release();
		}
	}

	@bindThis
	private async isUnreferenced(fileId: MiDriveFile['id']): Promise<boolean> {
		// 削除直前の単一行再判定 (TOCTOU 対策)。1行の EXISTS のみで page は対象外のため軽量であり、
		// 明示トランザクションや statement_timeout 延長なしで実行する。
		// gallery_post / chat_message / channel に有効なインデックスはないが、
		// いずれも件数が小規模なテーブルであるため逐次実行でも問題ない。
		const rows = await this.db.query(
			`SELECT EXISTS (
				SELECT 1 FROM note WHERE note."fileIds" @> ARRAY[$1::varchar]
				UNION ALL
				SELECT 1 FROM "user" WHERE "avatarId" = $1 OR "bannerId" = $1
				UNION ALL
				SELECT 1 FROM gallery_post WHERE gallery_post."fileIds" @> ARRAY[$1::varchar]
				UNION ALL
				SELECT 1 FROM chat_message WHERE "fileId" = $1
				UNION ALL
				SELECT 1 FROM channel WHERE "bannerId" = $1
			) AS "referenced"`,
			[fileId],
		) as { referenced: boolean }[];
		// 判定不能な場合は安全側(温存)に倒す
		return !(rows[0]?.referenced ?? true);
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
				// バッチ内の参照チェックを1クエリに集約する (N+1 回避)。
				// 100件ずつ取得し、タイムアウトは実行予定時間の残りに連動させる (実環境で10分規模のため)。
				const remainingMs = maxDuration - (Date.now() - startAt);
				if (remainingMs < 1000) {
					job.log(`Not enough remaining time (${remainingMs}ms) to check references of ${targets.length} files, stopping... (last cursor: ${cursor})`);
					break;
				}
				unreferencedIds = await this.findUnreferencedIds(targets.map(file => file.id), remainingMs);
			} catch (e) {
				// 判定クエリの失敗は即時リトライしても回復見込みが薄いため、ログを残して今回の実行を打ち切る。
				// カーソルは進めないので次回実行時に同範囲から再開される。待機を挟んだ再試行はしない。
				transientErrors++;
				const msg = `Error checking references of ${targets.length} files: ${e} (stopping this run; will resume from cursor ${cursor} next time)`;
				this.logger.warn(msg);
				job.log(msg);
				break;
			}

			let batchHadDeleteError = false;
			for (const file of targets) {
				if (!unreferencedIds.has(file.id)) {
					cursor = file.id;
					checkedCount++;
					consecutiveErrors = 0;
					continue;
				}

				let stillUnreferenced: boolean;
				try {
					// バッチ先頭の一括判定から時間が経っており、その間に連合経由で
					// 参照が増えている可能性があるため、削除直前に単一行で再判定する
					stillUnreferenced = await this.isUnreferenced(file.id);
				} catch (e) {
					transientErrors++;
					consecutiveErrors++;
					job.log(`Error re-checking references of file ${file.id}: ${e} (transient error?)`);
					batchHadDeleteError = true;
					break;
				}

				if (!stillUnreferenced) {
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
			job.log(`Checked ${targets.length} files (total checked: ${checkedCount}, deleted: ${deletedCount}); ${batchDuration}ms`);

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
