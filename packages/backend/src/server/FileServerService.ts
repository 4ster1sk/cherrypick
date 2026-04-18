/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import rename from 'rename';
import type { Config } from '@/config.js';
import type { DriveFilesRepository, MiDriveFile } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { createTemp } from '@/misc/create-temp.js';
import { FILE_TYPE_BROWSERSAFE } from '@/const.js';
import { StatusError } from '@/misc/status-error.js';
import type Logger from '@/logger.js';
import { DownloadService } from '@/core/DownloadService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { contentDisposition } from '@/misc/content-disposition.js';
import { FileInfoService } from '@/core/FileInfoService.js';
import { IImageStreamable, ImageProcessingService } from '@/core/ImageProcessingService.js';
import { VideoProcessingService } from '@/core/VideoProcessingService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { bindThis } from '@/decorators.js';
import { isMimeImage } from '@/misc/is-mime-image.js';
import { correctFilename } from '@/misc/correct-filename.js';
import { handleRequestRedirectToOmitSearch } from '@/misc/fastify-hook-handlers.js';
import { FileServerDriveHandler } from './file/FileServerDriveHandler.js';
import { FileServerFileResolver } from './file/FileServerFileResolver.js';
import { FileServerProxyHandler } from './file/FileServerProxyHandler.js';
import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const assets = `${_dirname}/../../server/file/assets/`;

@Injectable()
export class FileServerService {
	private logger: Logger;
	private driveHandler: FileServerDriveHandler;
	private proxyHandler: FileServerProxyHandler;
	private fileResolver: FileServerFileResolver;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private fileInfoService: FileInfoService,
		private downloadService: DownloadService,
		private imageProcessingService: ImageProcessingService,
		private videoProcessingService: VideoProcessingService,
		private internalStorageService: InternalStorageService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('server', 'gray');
		this.fileResolver = new FileServerFileResolver(
			this.driveFilesRepository,
			this.fileInfoService,
			this.downloadService,
			this.internalStorageService,
		);
		this.driveHandler = new FileServerDriveHandler(
			this.config,
			this.fileResolver,
			assets,
			this.videoProcessingService,
		);
		this.proxyHandler = new FileServerProxyHandler(
			this.config,
			this.fileResolver,
			assets,
			this.imageProcessingService,
		);

		//this.createServer = this.createServer.bind(this);
	}

	@bindThis
	public createServer(fastify: FastifyInstance, options: FastifyPluginOptions, done: (err?: Error) => void) {
		fastify.addHook('onRequest', (request, reply, done) => {
			reply.header('Content-Security-Policy', 'default-src \'none\'; img-src \'self\'; media-src \'self\'; style-src \'unsafe-inline\'');
			if (process.env.NODE_ENV === 'development') {
				reply.header('Access-Control-Allow-Origin', '*');
			}
			done();
		});

		fastify.register((fastify, options, done) => {
			fastify.addHook('onRequest', handleRequestRedirectToOmitSearch);
			fastify.get('/files/app-default.jpg', (request, reply) => {
				const file = fs.createReadStream(`${_dirname}/assets/dummy.png`);
				reply.header('Content-Type', 'image/jpeg');
				reply.header('Cache-Control', 'max-age=31536000, immutable');
				return reply.send(file);
			});

			fastify.get<{ Params: { key: string; } }>('/files/:key', async (request, reply) => {
				return await this.driveHandler.handle(request, reply)
					.catch(err => this.errorHandler(request, reply, err));
			});
			fastify.get<{ Params: { key: string; } }>('/files/:key/*', async (request, reply) => {
				return await reply.redirect(`${this.config.url}/files/${request.params.key}`, 301);
			});
			done();
		});

		fastify.get<{
			Params: { url: string; };
			Querystring: { url?: string; };
		}>('/proxy/:url*', async (request, reply) => {
			return await this.proxyHandler.handle(request, reply)
				.catch(err => this.errorHandler(request, reply, err));
		});

		done();
	}

	@bindThis
	private async errorHandler(request: FastifyRequest<{ Params?: { [x: string]: any }; Querystring?: { [x: string]: any }; }>, reply: FastifyReply, err?: any) {
		this.logger.error(`${err}`);

		reply.header('Cache-Control', 'max-age=300');

		if (request.query && 'fallback' in request.query) {
			return reply.sendFile('/dummy.png', assets);
		}

		if (err instanceof StatusError && (err.statusCode === 302 || err.isClientError)) {
			reply.code(err.statusCode);
			return;
		}

		reply.code(500);
		return;
	}

	@bindThis
	private async sendDriveFile(request: FastifyRequest<{ Params: { key: string; } }>, reply: FastifyReply) {
		const key = request.params.key;
		const file = await this.getFileFromKey(key).then();

		if (file === '404') {
			reply.code(404);
			reply.header('Cache-Control', 'max-age=86400');
			return reply.sendFile('/dummy.png', assets);
		}

		if (file === '204') {
			reply.code(204);
			reply.header('Cache-Control', 'max-age=86400');
			return;
		}

		try {
			if (file.state === 'remote') {
				let image: IImageStreamable | null = null;

				if (file.fileRole === 'thumbnail') {
					if (isMimeImage(file.mime, 'sharp-convertible-image-with-bmp')) {
						reply.header('Cache-Control', 'max-age=31536000, immutable');

						const url = new URL(`${this.config.mediaProxy}/static.webp`);
						url.searchParams.set('url', file.url);
						url.searchParams.set('static', '1');

						file.cleanup();
						return await reply.redirect(url.toString(), 301);
					} else if (file.mime.startsWith('video/')) {
						const externalThumbnail = this.videoProcessingService.getExternalVideoThumbnailUrl(file.url);
						if (externalThumbnail) {
							file.cleanup();
							return await reply.redirect(externalThumbnail, 301);
						}

						image = await this.videoProcessingService.generateVideoThumbnail(file.path);
					}
				}

				if (file.fileRole === 'webpublic') {
					if (['image/svg+xml'].includes(file.mime)) {
						reply.header('Cache-Control', 'max-age=31536000, immutable');

						const url = new URL(`${this.config.mediaProxy}/svg.webp`);
						url.searchParams.set('url', file.url);

						file.cleanup();
						return await reply.redirect(url.toString(), 301);
					}
				}

				if (!image) {
					if (request.headers.range && file.file.size > 0) {
						const range = request.headers.range as string;
						const parts = range.replace(/bytes=/, '').split('-');
						const start = parseInt(parts[0], 10);
						let end = parts[1] ? parseInt(parts[1], 10) : file.file.size - 1;
						if (end > file.file.size) {
							end = file.file.size - 1;
						}
						const chunksize = end - start + 1;

						image = {
							data: fs.createReadStream(file.path, {
								start,
								end,
							}),
							ext: file.ext,
							type: file.mime,
						};

						reply.header('Content-Range', `bytes ${start}-${end}/${file.file.size}`);
						reply.header('Accept-Ranges', 'bytes');
						reply.header('Content-Length', chunksize);
						reply.code(206);
					} else {
						image = {
							data: fs.createReadStream(file.path),
							ext: file.ext,
							type: file.mime,
						};
					}
				}

				if ('pipe' in image.data && typeof image.data.pipe === 'function') {
					// image.dataがstreamなら、stream終了後にcleanup
					image.data.on('end', file.cleanup);
					image.data.on('close', file.cleanup);
				} else {
					// image.dataがstreamでないなら直ちにcleanup
					file.cleanup();
				}

				reply.header('Content-Type', FILE_TYPE_BROWSERSAFE.includes(image.type) ? image.type : 'application/octet-stream');
				reply.header('Content-Length', file.file.size);
				reply.header('Cache-Control', 'max-age=31536000, immutable');
				reply.header('Content-Disposition',
					contentDisposition(
						'inline',
						correctFilename(file.filename, image.ext),
					),
				);
				return image.data;
			}

			if (file.fileRole !== 'original') {
				const filename = rename(file.filename, {
					suffix: file.fileRole === 'thumbnail' ? '-thumb' : '-web',
					extname: file.ext ? `.${file.ext}` : '.unknown',
				}).toString();

				reply.header('Content-Type', FILE_TYPE_BROWSERSAFE.includes(file.mime) ? file.mime : 'application/octet-stream');
				reply.header('Cache-Control', 'max-age=31536000, immutable');
				reply.header('Content-Disposition', contentDisposition('inline', filename));

				if (request.headers.range && file.file.size > 0) {
					const range = request.headers.range as string;
					const parts = range.replace(/bytes=/, '').split('-');
					const start = parseInt(parts[0], 10);
					let end = parts[1] ? parseInt(parts[1], 10) : file.file.size - 1;
					if (end > file.file.size) {
						end = file.file.size - 1;
					}
					const chunksize = end - start + 1;
					const fileStream = fs.createReadStream(file.path, {
						start,
						end,
					});
					reply.header('Content-Range', `bytes ${start}-${end}/${file.file.size}`);
					reply.header('Accept-Ranges', 'bytes');
					reply.header('Content-Length', chunksize);
					reply.code(206);
					return fileStream;
				}

				return fs.createReadStream(file.path);
			} else {
				reply.header('Content-Type', FILE_TYPE_BROWSERSAFE.includes(file.file.type) ? file.file.type : 'application/octet-stream');
				reply.header('Content-Length', file.file.size);
				reply.header('Cache-Control', 'max-age=31536000, immutable');
				reply.header('Content-Disposition', contentDisposition('inline', file.filename));

				if (request.headers.range && file.file.size > 0) {
					const range = request.headers.range as string;
					const parts = range.replace(/bytes=/, '').split('-');
					const start = parseInt(parts[0], 10);
					let end = parts[1] ? parseInt(parts[1], 10) : file.file.size - 1;
					if (end > file.file.size) {
						end = file.file.size - 1;
					}
					const chunksize = end - start + 1;
					const fileStream = fs.createReadStream(file.path, {
						start,
						end,
					});
					reply.header('Content-Range', `bytes ${start}-${end}/${file.file.size}`);
					reply.header('Accept-Ranges', 'bytes');
					reply.header('Content-Length', chunksize);
					reply.code(206);
					return fileStream;
				}

				return fs.createReadStream(file.path);
			}
		} catch (e) {
			if ('cleanup' in file) file.cleanup();
			throw e;
		}
	}

	@bindThis
	private async getStreamAndTypeFromUrl(url: string): Promise<
		{ state: 'remote'; fileRole?: 'thumbnail' | 'webpublic' | 'original'; file?: MiDriveFile; mime: string; ext: string | null; path: string; cleanup: () => void; filename: string; }
		| { state: 'stored_internal'; fileRole: 'thumbnail' | 'webpublic' | 'original'; file: MiDriveFile; filename: string; mime: string; ext: string | null; path: string; }
		| '404'
		| '204'
	> {
		if (url.startsWith(`${this.config.url}/files/`)) {
			const key = url.replace(`${this.config.url}/files/`, '').split('/').shift();
			if (!key) throw new StatusError('Invalid File Key', 400, 'Invalid File Key');

			return await this.getFileFromKey(key);
		}

		return await this.downloadAndDetectTypeFromUrl(url);
	}

	@bindThis
	private async downloadAndDetectTypeFromUrl(url: string): Promise<
		{ state: 'remote'; mime: string; ext: string | null; path: string; cleanup: () => void; filename: string; }
	> {
		const [path, cleanup] = await createTemp();
		try {
			const { filename } = await this.downloadService.downloadUrl(url, path);

			const { mime, ext } = await this.fileInfoService.detectType(path);

			return {
				state: 'remote',
				mime, ext,
				path, cleanup,
				filename,
			};
		} catch (e) {
			cleanup();
			throw e;
		}
	}

	@bindThis
	private async getFileFromKey(key: string): Promise<
		{ state: 'remote'; fileRole: 'thumbnail' | 'webpublic' | 'original'; file: MiDriveFile; filename: string; url: string; mime: string; ext: string | null; path: string; cleanup: () => void; }
		| { state: 'stored_internal'; fileRole: 'thumbnail' | 'webpublic' | 'original'; file: MiDriveFile; filename: string; mime: string; ext: string | null; path: string; }
		| '404'
		| '204'
	> {
		// Fetch drive file
		const file = await this.driveFilesRepository.createQueryBuilder('file')
			.where('file.accessKey = :accessKey', { accessKey: key })
			.orWhere('file.thumbnailAccessKey = :thumbnailAccessKey', { thumbnailAccessKey: key })
			.orWhere('file.webpublicAccessKey = :webpublicAccessKey', { webpublicAccessKey: key })
			.getOne();

		if (file == null) return '404';

		const isThumbnail = file.thumbnailAccessKey === key;
		const isWebpublic = file.webpublicAccessKey === key;

		if (!file.storedInternal) {
			if (!(file.isLink && file.uri)) return '204';
			const result = await this.downloadAndDetectTypeFromUrl(file.uri);
			file.size = (await fs.promises.stat(result.path)).size;	// DB file.sizeは正確とは限らないので
			return {
				...result,
				url: file.uri,
				fileRole: isThumbnail ? 'thumbnail' : isWebpublic ? 'webpublic' : 'original',
				file,
				filename: file.name,
			};
		}

		const path = this.internalStorageService.resolvePath(key);

		if (isThumbnail || isWebpublic) {
			const { mime, ext } = await this.fileInfoService.detectType(path);
			return {
				state: 'stored_internal',
				fileRole: isThumbnail ? 'thumbnail' : 'webpublic',
				file,
				filename: file.name,
				mime, ext,
				path,
			};
		}

		return {
			state: 'stored_internal',
			fileRole: 'original',
			file,
			filename: file.name,
			// 古いファイルは修正前のmimeを持っているのでできるだけ修正してあげる
			mime: this.fileInfoService.fixMime(file.type),
			ext: null,
			path,
		};
	}
}
