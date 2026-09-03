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
	private async isReferenced(fileId: MiDriveFile['id']): Promise<boolean> {
		const row = await this.driveFilesRepository.createQueryBuilder('file')
			.select('EXISTS(SELECT 1 FROM note WHERE :fileId = ANY(note."fileIds"))', 'referencedByNote')
			.addSelect('EXISTS(SELECT 1 FROM "user" WHERE "avatarId" = :fileId OR "bannerId" = :fileId)', 'referencedByUser')
			.addSelect('EXISTS(SELECT 1 FROM gallery_post WHERE :fileId = ANY(gallery_post."fileIds"))', 'referencedByGalleryPost')
			.addSelect('EXISTS(SELECT 1 FROM chat_message WHERE "fileId" = :fileId)', 'referencedByChatMessage')
			.addSelect('EXISTS(SELECT 1 FROM page WHERE "eyeCatchingImageId" = :fileId)', 'referencedByPage')
			.addSelect('EXISTS(SELECT 1 FROM channel WHERE "bannerId" = :fileId)', 'referencedByChannel')
			.where('file.id = :fileId', { fileId })
			.getRawOne<Record<string, boolean>>();

		if (row == null) return true; // 判定不能な場合は安全側(温存)に倒す

		return row.referencedByNote
			|| row.referencedByUser
			|| row.referencedByGalleryPost
			|| row.referencedByChatMessage
			|| row.referencedByPage
			|| row.referencedByChannel;
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

			for (const file of files) {
				cursor = file.id;
				checkedCount++;

				// ID は時系列順なので、保持期限内のファイルに到達したら以降は全て期限内。今回の走査は完了扱いにする
				if (file.id >= newestLimit) {
					await this.metasRepository.update(meta.id, { remoteDriveFilesCleaningLastCursorId: null });
					cursor = null;
					completed = true;
					break;
				}

				let referenced: boolean;
				try {
					referenced = await this.isReferenced(file.id);
				} catch (e) {
					// 判定クエリの失敗は一時的なものとして次バッチ以降に委ねる
					transientErrors++;
					job.log(`Error checking references of file ${file.id}: ${e} (transient error?)`);
					continue;
				}

				if (!referenced) {
					try {
						await this.driveService.deleteFileSync(file);
						deletedCount++;
					} catch (e) {
						// 判定と削除の間の競合による制約違反などは次回に委ねる
						transientErrors++;
						job.log(`Error deleting file ${file.id}: ${e} (transient race condition?)`);
					}
				}
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

		const summary = `cleaning of remote drive files completed. Deleted ${deletedCount} orphan files (checked ${checkedCount} files).`;
		this.logger.succ(summary);
		job.log(summary);

		return {
			deletedCount,
			checkedCount,
			skipped: false,
			completed,
			transientErrors,
		};
	}
}
