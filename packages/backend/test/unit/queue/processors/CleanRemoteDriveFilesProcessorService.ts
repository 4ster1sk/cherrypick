/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import {
	type MiDriveFile,
	type MiGalleryPost,
	type MiNote,
	type MiUser,
	type DriveFilesRepository,
	type GalleryPostsRepository,
	type MetasRepository,
	type NotesRepository,
	type UsersRepository,
	type UserProfilesRepository,
} from '@/models/_.js';
import { CleanRemoteDriveFilesProcessorService } from '@/queue/processors/CleanRemoteDriveFilesProcessorService.js';
import { DriveService } from '@/core/DriveService.js';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { GlobalModule } from '@/GlobalModule.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';

describe('CleanRemoteDriveFilesProcessorService', () => {
	let app: TestingModule;
	let service: CleanRemoteDriveFilesProcessorService;
	let idService: IdService;
	let driveFilesRepository: DriveFilesRepository;
	let metasRepository: MetasRepository;
	let notesRepository: NotesRepository;
	let galleryPostsRepository: GalleryPostsRepository;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;
	let driveServiceMock: { deleteFileSync: ReturnType<typeof vi.fn> };

	// Local user
	let alice: MiUser;
	// Remote user
	let bob: MiUser;

	const DAY = 1000 * 60 * 60 * 24;

	// Mock job object
	const createMockJob = () => ({
		log: vi.fn(),
		updateProgress: vi.fn(),
	});

	async function createUser(data: Partial<MiUser> = {}) {
		const id = idService.gen();
		const un = data.username || secureRndstr(16);
		const user = await usersRepository
			.insert({
				id,
				username: un,
				usernameLower: un.toLowerCase(),
				...data,
			})
			.then(x => usersRepository.findOneByOrFail(x.identifiers[0]));

		await userProfilesRepository.save({
			userId: id,
		});

		return user;
	}

	async function createDriveFile(data: Partial<MiDriveFile>, time?: number): Promise<MiDriveFile> {
		const id = idService.gen(time);
		const file = await driveFilesRepository
			.insert({
				id,
				md5: secureRndstr(16),
				name: `file_${id}.png`,
				type: 'image/png',
				size: 1024,
				storedInternal: true,
				url: `https://example.com/files/${id}`,
				isLink: false,
				...data,
			})
			.then(x => driveFilesRepository.findOneByOrFail(x.identifiers[0]));
		return file;
	}

	async function createNoteWithFiles(user: MiUser, fileIds: MiDriveFile['id'][], time?: number): Promise<MiNote> {
		const id = idService.gen(time);
		const note = await notesRepository
			.insert({
				id,
				text: `note_${id}`,
				userId: user.id,
				userHost: user.host,
				visibility: 'public',
				fileIds,
			})
			.then(x => notesRepository.findOneByOrFail(x.identifiers[0]));
		return note;
	}

	async function enableCleaning(patch: Record<string, unknown> = {}) {
		await metasRepository.upsert({
			id: 'x',
			enableRemoteDriveFilesCleaning: true,
			remoteDriveFilesCleaningMaxProcessingDurationInMinutes: 60,
			remoteDriveFilesCleaningExpiryDaysForEachFiles: 30,
			remoteDriveFilesCleaningLastCursorId: null,
			...patch,
		}, ['id']);
	}

	beforeAll(async () => {
		driveServiceMock = {
			deleteFileSync: vi.fn(),
		};

		app = await Test
			.createTestingModule({
				imports: [
					GlobalModule,
				],
				providers: [
					CleanRemoteDriveFilesProcessorService,
					IdService,
					{
						provide: DriveService,
						useValue: driveServiceMock,
					},
					{
						provide: QueueLoggerService,
						useFactory: () => ({
							logger: {
								createSubLogger: () => ({
									info: vi.fn(),
									warn: vi.fn(),
									succ: vi.fn(),
								}),
							},
						}),
					},
				],
			})
			.compile();

		service = app.get(CleanRemoteDriveFilesProcessorService);
		idService = app.get(IdService);
		driveFilesRepository = app.get(DI.driveFilesRepository);
		metasRepository = app.get(DI.metasRepository);
		notesRepository = app.get(DI.notesRepository);
		galleryPostsRepository = app.get(DI.galleryPostsRepository);
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);

		alice = await createUser({ username: 'alice', host: null });
		bob = await createUser({ username: 'bob', host: 'remote1.example.com' });

		app.enableShutdownHooks();
	});

	beforeEach(async () => {
		vi.clearAllMocks();
		await enableCleaning();
	}, 60 * 1000);

	afterEach(async () => {
		await Promise.all([
			driveFilesRepository.createQueryBuilder().delete().execute(),
			notesRepository.createQueryBuilder().delete().execute(),
			galleryPostsRepository.createQueryBuilder().delete().execute(),
		]);
	}, 60 * 1000);

	afterAll(async () => {
		// 他スイートへの影響を避けるため無効化に戻す
		await metasRepository.upsert({ id: 'x', enableRemoteDriveFilesCleaning: false }, ['id']);
		await app.close();
	});

	describe('basic', () => {
		test('should skip cleaning when enableRemoteDriveFilesCleaning is false', async () => {
			await metasRepository.upsert({ id: 'x', enableRemoteDriveFilesCleaning: false }, ['id']);
			const job = createMockJob();

			const result = await service.process(job as any);

			expect(result.skipped).toBe(true);
			expect(result.deletedCount).toBe(0);
			expect(driveServiceMock.deleteFileSync).not.toHaveBeenCalled();
		});

		test('should delete an old orphan remote file', async () => {
			const file = await createDriveFile({ userId: bob.id, userHost: bob.host }, Date.now() - (100 * DAY));
			const job = createMockJob();

			const result = await service.process(job as any);

			expect(result.skipped).toBe(false);
			expect(result.completed).toBe(true);
			expect(result.deletedCount).toBe(1);
			expect(driveServiceMock.deleteFileSync).toHaveBeenCalledTimes(1);
			expect(driveServiceMock.deleteFileSync.mock.calls[0][0].id).toBe(file.id);
			expect(job.log).toHaveBeenCalledWith(expect.stringContaining('Deleted 1 orphan files'));
		});

		test('should keep a file attached to a note', async () => {
			const file = await createDriveFile({ userId: bob.id, userHost: bob.host }, Date.now() - (100 * DAY));
			await createNoteWithFiles(bob, [file.id], Date.now() - (100 * DAY));
			const job = createMockJob();

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(driveServiceMock.deleteFileSync).not.toHaveBeenCalled();
		});

		test('should keep a file used as avatar', async () => {
			const file = await createDriveFile({ userId: bob.id, userHost: bob.host }, Date.now() - (100 * DAY));
			await usersRepository.update(bob.id, { avatarId: file.id });
			const job = createMockJob();

			try {
				const result = await service.process(job as any);

				expect(result.deletedCount).toBe(0);
				expect(driveServiceMock.deleteFileSync).not.toHaveBeenCalled();
			} finally {
				await usersRepository.update(bob.id, { avatarId: null });
			}
		});

		test('should keep a file attached to a gallery post', async () => {
			const file = await createDriveFile({ userId: bob.id, userHost: bob.host }, Date.now() - (100 * DAY));
			const postId = idService.gen(Date.now() - (100 * DAY));
			await galleryPostsRepository.insert({
				id: postId,
				updatedAt: new Date(),
				title: 'gallery',
				userId: bob.id,
				fileIds: [file.id],
			} satisfies Partial<MiGalleryPost>);
			const job = createMockJob();

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(driveServiceMock.deleteFileSync).not.toHaveBeenCalled();
		});

		test('should keep a young file even if it is orphan', async () => {
			await createDriveFile({ userId: bob.id, userHost: bob.host }, Date.now() - (1 * DAY));
			const job = createMockJob();

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.completed).toBe(true);
			expect(driveServiceMock.deleteFileSync).not.toHaveBeenCalled();
		});

		test('should ignore local files and link files', async () => {
			await createDriveFile({ userId: alice.id, userHost: null }, Date.now() - (100 * DAY));
			await createDriveFile({ userId: bob.id, userHost: bob.host, isLink: true }, Date.now() - (100 * DAY));
			const job = createMockJob();

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.checkedCount).toBe(0);
			expect(driveServiceMock.deleteFileSync).not.toHaveBeenCalled();
		});

		test('should resume from the saved cursor', async () => {
			const older = await createDriveFile({ userId: bob.id, userHost: bob.host }, Date.now() - (101 * DAY));
			const newer = await createDriveFile({ userId: bob.id, userHost: bob.host }, Date.now() - (100 * DAY));
			expect(older.id < newer.id).toBe(true);
			await metasRepository.update({ id: 'x' }, { remoteDriveFilesCleaningLastCursorId: older.id });
			const job = createMockJob();

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(1);
			expect(driveServiceMock.deleteFileSync).toHaveBeenCalledTimes(1);
			expect(driveServiceMock.deleteFileSync.mock.calls[0][0].id).toBe(newer.id);
		});
	});
});
