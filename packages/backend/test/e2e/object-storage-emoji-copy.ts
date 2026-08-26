/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, yojo-art team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import {
	CreateBucketCommand,
	ListObjectsV2Command,
	PutBucketPolicyCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import { api, failedApiCall, role, signup, startJobQueue, uploadFile } from '../utils.js';
import { describeObjectStorageE2E } from '../helpers/describe-object-storage-e2e.js';
import type { INestApplicationContext } from '@nestjs/common';
import type * as misskey from 'misskey-js';

// ローカルで起動した rustfs (packages/backend/test/compose.yml 参照) に接続する
const OBJECT_STORAGE_ENDPOINT = process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://127.0.0.1:59312';
const OBJECT_STORAGE_BUCKET = process.env.OBJECT_STORAGE_BUCKET ?? 'misskey-test';
const OBJECT_STORAGE_ACCESS_KEY = process.env.OBJECT_STORAGE_ACCESS_KEY ?? 'rustfsadmin';
const OBJECT_STORAGE_SECRET_KEY = process.env.OBJECT_STORAGE_SECRET_KEY ?? 'rustfsadmin';

// PR #1316: ローカルユーザーがアップロードしたファイルからの絵文字登録が、
// ダウンロード再取得ではなくサーバーサイドコピー (S3 CopyObject) で行われることを検証する
describeObjectStorageE2E('絵文字コピー', () => {
	let queue: INestApplicationContext;
	let root: misskey.entities.SignupResponse;
	let s3Client: S3Client;

	beforeAll(async () => {
		queue = await startJobQueue();
		root = await signup({ username: 'root' });

		s3Client = new S3Client({
			endpoint: OBJECT_STORAGE_ENDPOINT,
			region: 'us-east-1',
			credentials: {
				accessKeyId: OBJECT_STORAGE_ACCESS_KEY,
				secretAccessKey: OBJECT_STORAGE_SECRET_KEY,
			},
			forcePathStyle: true,
		});

		try {
			await s3Client.send(new CreateBucketCommand({
				Bucket: OBJECT_STORAGE_BUCKET,
			}));
		} catch (err: any) {
			// 既にバケットが存在する場合は問題ない
			if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(err?.name)) {
				throw err;
			}
		}

		// Misskeyは生成したURLへ匿名アクセスするため、バケットを公開読み取り可能にしておく
		await s3Client.send(new PutBucketPolicyCommand({
			Bucket: OBJECT_STORAGE_BUCKET,
			Policy: JSON.stringify({
				Version: '2012-10-17',
				Statement: [{
					Sid: 'PublicReadGetObject',
					Effect: 'Allow',
					Principal: { AWS: ['*'] },
					Action: ['s3:GetObject'],
					Resource: [`arn:aws:s3:::${OBJECT_STORAGE_BUCKET}/*`],
				}],
			}),
		}));

		// S3Serviceはエンドポイント文字列をそのまま使うため <host>:<port> 形式にする
		// (objectStoragePort は公開URL構築用のレガシー項目でS3クライアントには反映されない)
		const storageUrl = new URL(OBJECT_STORAGE_ENDPOINT);

		await api('admin/update-meta', {
			useObjectStorage: true,
			objectStorageBaseUrl: null,
			objectStorageEndpoint: storageUrl.host,
			objectStoragePort: null,
			objectStorageUseSSL: storageUrl.protocol === 'https:',
			objectStorageBucket: OBJECT_STORAGE_BUCKET,
			objectStoragePrefix: 'test',
			objectStorageAccessKey: OBJECT_STORAGE_ACCESS_KEY,
			objectStorageSecretKey: OBJECT_STORAGE_SECRET_KEY,
			objectStorageRegion: 'us-east-1',
			objectStorageS3ForcePathStyle: true,
			objectStorageSetPublicRead: false, // rustfsはACL非対応
			objectStorageUseProxy: false,
		}, root);
	}, 1000 * 60 * 2);

	afterAll(async () => {
		await queue?.close();
	});

	test('ローカルユーザーのファイルから絵文字を登録するとオブジェクトストレージ上でコピーされる', async () => {
		const upRes = await uploadFile(root, { path: '192.jpg' });
		assert.strictEqual(upRes.status, 200);
		const originalFile = upRes.body!;
		const emojiName = 'obj_copy_' + originalFile.id.slice(0, 6);

		const addRes = await api('admin/emoji/add', {
			name: emojiName,
			fileId: originalFile.id,
		}, root);
		assert.strictEqual(addRes.status, 200);
		const emoji = addRes.body!;

		const expectedPrefix = `${OBJECT_STORAGE_ENDPOINT}/${OBJECT_STORAGE_BUCKET}/test/`;

		// 絵文字のURLはコピー先の新キー (webpublicが優先されるので元URLとも別バリアント)
		assert.ok(emoji.url.startsWith(expectedPrefix), `actual url: ${emoji.url}`);
		assert.notStrictEqual(emoji.url, originalFile.url);

		// コピーされたオブジェクトが取得できる (webpublicはwebpに変換済み)
		const fetched = await fetch(emoji.url);
		assert.strictEqual(fetched.status, 200);
		assert.strictEqual(fetched.headers.get('content-type'), 'image/webp');

		// コピーされたオリジナル (.jpg) がバケット上に存在する
		const listed = await s3Client.send(new ListObjectsV2Command({
			Bucket: OBJECT_STORAGE_BUCKET,
		}));
		const copiedOriginal = (listed.Contents ?? []).find(o =>
			o.Key?.startsWith('test/')
			&& o.Key.endsWith('.jpg')
			&& o.Key !== new URL(originalFile.url).pathname.replace(`/${OBJECT_STORAGE_BUCKET}/`, ''),
		);
		assert.ok(copiedOriginal != null, 'copied original object not found');

		// 元ファイルは参照カウント0のため削除される
		// NOTE(yojo-art #1316): 「ユーザー所有ファイルの自動削除」はレビュー指摘1で
		// 挙動が変わる可能性がある。修正が入った場合はこのアサートを見直すこと
		await failedApiCall({
			endpoint: 'drive/files/show',
			parameters: { fileId: originalFile.id },
			user: root,
		}, {
			status: 400,
			code: 'NO_SUCH_FILE',
			id: '067bc436-2718-4795-b0fb-ecbe43949e31',
		});
	});

	test('元ファイルのオブジェクトストレージ実体も削除され、絵文字は残る', async () => {
		const upRes = await uploadFile(root, { path: '192.png' });
		assert.strictEqual(upRes.status, 200);
		const originalFile = upRes.body!;
		const emojiName = 'obj_cleanup_' + originalFile.id.slice(0, 6);

		const addRes = await api('admin/emoji/add', {
			name: emojiName,
			fileId: originalFile.id,
		}, root);
		assert.strictEqual(addRes.status, 200);
		const emoji = addRes.body!;

		// 元ファイルのオリジナル・サムネイル実体はジョブキュー経由で削除される
		await vi.waitFor(async () => {
			const [original, thumbnail] = await Promise.all([
				fetch(originalFile.url),
				fetch(originalFile.thumbnailUrl!),
			]);
			assert.notStrictEqual(original.status, 200, 'original object still exists');
			assert.notStrictEqual(thumbnail.status, 200, 'thumbnail object still exists');
		}, { timeout: 30_000, interval: 500 });

		// 絵文字自体は引き続き取得できる
		const listRes = await api('admin/emoji/list', { query: emojiName }, root);
		assert.ok(listRes.body!.some(e => e.name === emojiName));
		const fetched = await fetch(emoji.url);
		assert.strictEqual(fetched.status, 200);
	});

	test('絵文字を登録したユーザーがアカウント削除されても絵文字とオブジェクトは残る', async () => {
		const uploader = await signup({ username: 'obj_uploader' });
		const emojiRole = await role(root, { name: 'ObjStorageEmojiRole' }, {
			canManageCustomEmojis: { priority: 0, useDefault: false, value: true },
		});
		await api('admin/roles/assign', { userId: uploader.id, roleId: emojiRole.id }, root);

		const upRes = await uploadFile(uploader, { path: '192.png' });
		assert.strictEqual(upRes.status, 200);
		const originalFile = upRes.body!;
		const emojiName = 'obj_survive_' + originalFile.id.slice(0, 6);

		const addRes = await api('admin/emoji/add', {
			name: emojiName,
			fileId: originalFile.id,
		}, uploader);
		assert.strictEqual(addRes.status, 200);
		const emoji = addRes.body!;

		// アップローダーの削除ジョブ完了を確認するための参照ファイル
		const refUpRes = await uploadFile(uploader, { path: '192.jpg' });
		assert.strictEqual(refUpRes.status, 200);
		const refFile = refUpRes.body!;

		const delRes = await api('i/delete-account', { password: 'test' }, uploader);
		assert.strictEqual(delRes.status, 204);

		// アップローダー自身のファイルが全て削除し切るまで待つ
		await vi.waitFor(async () => {
			const res = await fetch(refFile.url);
			assert.notStrictEqual(res.status, 200, 'uploader reference file still exists');
		}, { timeout: 60_000, interval: 500 });

		// 絵文字 (システム所有・userId:null のコピー) はアカウント削除の影響を受けない
		const listRes = await api('admin/emoji/list', { query: emojiName }, root);
		assert.ok(listRes.body!.some(e => e.name === emojiName));
		const fetched = await fetch(emoji.url);
		assert.strictEqual(fetched.status, 200);
	});
});
