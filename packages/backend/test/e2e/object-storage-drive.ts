/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, yojo-art team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import {
	CreateBucketCommand,
	DeleteObjectCommand,
	ListObjectsV2Command,
	PutBucketPolicyCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import { api, signup, startJobQueue, uploadFile, uploadUrl } from '../utils.js';
import { describeObjectStorageE2E } from '../helpers/describe-object-storage-e2e.js';
import type { INestApplicationContext } from '@nestjs/common';
import type * as misskey from 'misskey-js';

// ローカルで起動した rustfs (packages/backend/test/compose.yml 参照) に接続する
const OBJECT_STORAGE_ENDPOINT = process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://127.0.0.1:59312';
// 実行ごとに新しいバケットを作り、前回実行の残留オブジェクトによる非決定性を防ぐ
const OBJECT_STORAGE_BUCKET = `misskey-test-${randomUUID()}`;
const OBJECT_STORAGE_ACCESS_KEY = process.env.OBJECT_STORAGE_ACCESS_KEY ?? 'rustfsadmin';
const OBJECT_STORAGE_SECRET_KEY = process.env.OBJECT_STORAGE_SECRET_KEY ?? 'rustfsadmin';

describeObjectStorageE2E('オブジェクトストレージ', () => {
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

		await s3Client.send(new CreateBucketCommand({
			Bucket: OBJECT_STORAGE_BUCKET,
		}));

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

	test('アップロードしたファイルがオブジェクトストレージへ保存され、URLから取得できる', async () => {
		const upRes = await uploadFile(root, { path: '192.jpg' });
		assert.strictEqual(upRes.status, 200);
		const file = upRes.body!;

		const expectedPrefix = `${OBJECT_STORAGE_ENDPOINT}/${OBJECT_STORAGE_BUCKET}/test/`;
		assert.ok(file.url.startsWith(expectedPrefix), `actual url: ${file.url}`);
		assert.ok(file.url.endsWith('.jpg'), `actual url: ${file.url}`);
		assert.ok(file.thumbnailUrl != null && file.thumbnailUrl.startsWith(expectedPrefix), `actual thumbnailUrl: ${file.thumbnailUrl}`);

		// オリジナルが取得でき、中身も一致する
		const original = await fetch(file.url);
		assert.strictEqual(original.status, 200);
		assert.strictEqual(original.headers.get('content-type'), 'image/jpeg');
		assert.ok(original.headers.get('content-disposition')?.includes('192.jpg'));
		assert.deepStrictEqual(
			new Uint8Array(await original.arrayBuffer()),
			new Uint8Array(await readFile(new URL('../resources/192.jpg', import.meta.url))),
		);

		// サムネイルが取得できる
		const thumbnail = await fetch(file.thumbnailUrl!);
		assert.strictEqual(thumbnail.status, 200);
		assert.strictEqual(thumbnail.headers.get('content-type'), 'image/webp');

		// 192.jpgはEXIF等を持たない小さい画像なのでwebpublicは生成されず、オリジナル・サムネイルが保存される
		const listed = await s3Client.send(new ListObjectsV2Command({
			Bucket: OBJECT_STORAGE_BUCKET,
		}));
		assert.ok((listed.KeyCount ?? 0) >= 2, `objects: ${JSON.stringify(listed.Contents?.map(o => o.Key))}`);
	});

	test('ファイルを削除するとオブジェクトストレージからも削除される', async () => {
		// 当該アップロード由来のキーを特定できるよう、事前のキー一覧を取得しておく
		const beforeKeys = new Set((await s3Client.send(new ListObjectsV2Command({
			Bucket: OBJECT_STORAGE_BUCKET,
		}))).Contents?.map(o => o.Key!) ?? []);

		// EXIFを持つrotate.jpgを使い、webpublic代替画像の生成・削除も検証対象にする
		// (EXIF等を持たない小さい画像はsatisfyWebpublicによりwebpublicが生成されない)
		const upRes = await uploadFile(root, { path: 'rotate.jpg' });
		assert.strictEqual(upRes.status, 200);
		const file = upRes.body!;

		const expectedPrefix = `${OBJECT_STORAGE_ENDPOINT}/${OBJECT_STORAGE_BUCKET}/test/`;
		assert.ok(file.url.startsWith(expectedPrefix));
		assert.ok(file.thumbnailUrl != null && file.thumbnailUrl.startsWith(expectedPrefix));

		// original・webpublic・サムネイルの3オブジェクトが作られていることを確認
		const listedAfterUpload = await s3Client.send(new ListObjectsV2Command({
			Bucket: OBJECT_STORAGE_BUCKET,
		}));
		const uploadedKeys = (listedAfterUpload.Contents?.map(o => o.Key!) ?? [])
			.filter(key => !beforeKeys.has(key));
		assert.ok(uploadedKeys.length >= 3, `uploaded keys: ${JSON.stringify(uploadedKeys)}`);

		const delRes = await api('drive/files/delete', { fileId: file.id }, root);
		assert.strictEqual(delRes.status, 204);

		// 削除はジョブキュー経由で行われるので完了まで待つ(S3上のキー消失で判定する)
		await vi.waitFor(async () => {
			const listedAfterDelete = await s3Client.send(new ListObjectsV2Command({
				Bucket: OBJECT_STORAGE_BUCKET,
			}));
			const remainingKeys = uploadedKeys.filter(key => listedAfterDelete.Contents?.some(o => o.Key === key));
			assert.deepStrictEqual(remainingKeys, [], `remaining keys: ${JSON.stringify(remainingKeys)}`);
		}, { timeout: 30_000, interval: 500 });

		// 匿名GETが404になることも確認する(403など「読めないがオブジェクトが残っている」状態と区別するため)
		assert.strictEqual((await fetch(file.url)).status, 404);
	});

	test('8MBを超えるファイルはマルチパートアップロードされ、単一オブジェクトとして取得できる', async () => {
		// lib-storage の partSize (8MB) を超えるサイズでマルチパート経路を発火させる
		// 既存リソースに大容量画像はないため、ランタイムでバイナリを生成する (octet-streamなのでsharp処理もスキップされる)
		const body = new Uint8Array(8 * 1024 * 1024 + 1);
		for (let i = 0; i < body.length; i += 4096) {
			body.fill((i / 4096) % 251, i, Math.min(i + 4096, body.length));
		}
		const expectedMd5 = createHash('md5').update(body).digest('hex');

		const upRes = await uploadFile(root, {
			blob: new Blob([body], { type: 'application/octet-stream' }),
			name: 'multipart-test.bin',
		});
		assert.strictEqual(upRes.status, 200);
		const file = upRes.body!;
		assert.strictEqual(file.size, body.length);
		assert.strictEqual(file.md5, expectedMd5);

		const expectedPrefix = `${OBJECT_STORAGE_ENDPOINT}/${OBJECT_STORAGE_BUCKET}/test/`;
		assert.ok(file.url.startsWith(expectedPrefix), `actual url: ${file.url}`);

		// マルチパートで組み立てられた単一オブジェクトとして取得できる
		const fetched = await fetch(file.url);
		assert.strictEqual(fetched.status, 200);
		const fetchedBody = new Uint8Array(await fetched.arrayBuffer());
		assert.strictEqual(fetchedBody.length, body.length);
		assert.strictEqual(createHash('md5').update(fetchedBody).digest('hex'), expectedMd5);

		// バケット上に単一オブジェクトとして存在する (パートが露出していない)
		const key = new URL(file.url).pathname.replace(`/${OBJECT_STORAGE_BUCKET}/`, '');
		const listed = await s3Client.send(new ListObjectsV2Command({
			Bucket: OBJECT_STORAGE_BUCKET,
			Prefix: 'test/',
		}));
		const sameKeyObjects = (listed.Contents ?? []).filter(o => o.Key === key);
		assert.strictEqual(sameKeyObjects.length, 1);
		assert.strictEqual(sameKeyObjects[0].Size, body.length);
	});

	test('URLアップロードでもオブジェクトストレージへ保存される', async () => {
		// drive.ts の通常E2Eと同じ、CIから到達可能な既存リソースのURLを使う
		const url = 'https://raw.githubusercontent.com/yojo-art/cherrypick/develop/packages/backend/test/resources/192.jpg';

		const file = await uploadUrl(root, url);

		const expectedPrefix = `${OBJECT_STORAGE_ENDPOINT}/${OBJECT_STORAGE_BUCKET}/test/`;
		assert.ok(file.url.startsWith(expectedPrefix), `actual url: ${file.url}`);
		assert.strictEqual(file.type, 'image/jpeg');
		assert.ok(file.thumbnailUrl != null && file.thumbnailUrl.startsWith(expectedPrefix));

		const original = await fetch(file.url);
		assert.strictEqual(original.status, 200);
		assert.strictEqual(original.headers.get('content-type'), 'image/jpeg');

		const thumbnail = await fetch(file.thumbnailUrl!);
		assert.strictEqual(thumbnail.status, 200);
		assert.strictEqual(thumbnail.headers.get('content-type'), 'image/webp');
	});

	test('削除対象のオブジェクトが既に存在しなくてもジョブは詰まらない', async () => {
		// 先に実体だけ手動で消したファイルを削除し (NoSuchKey)、
		// 続く別ファイルの削除ジョブが正常完遂することでワーカーが生きていることを確認する
		const upResA = await uploadFile(root, { path: '192.png' });
		assert.strictEqual(upResA.status, 200);
		const fileA = upResA.body!;
		const keyA = new URL(fileA.url).pathname.replace(`/${OBJECT_STORAGE_BUCKET}/`, '');

		await s3Client.send(new DeleteObjectCommand({
			Bucket: OBJECT_STORAGE_BUCKET,
			Key: keyA,
		}));

		const delResA = await api('drive/files/delete', { fileId: fileA.id }, root);
		assert.strictEqual(delResA.status, 204);

		const upResB = await uploadFile(root, { path: '192.jpg' });
		assert.strictEqual(upResB.status, 200);
		const fileB = upResB.body!;
		const delResB = await api('drive/files/delete', { fileId: fileB.id }, root);
		assert.strictEqual(delResB.status, 204);

		await vi.waitFor(async () => {
			const res = await fetch(fileB.url);
			assert.notStrictEqual(res.status, 200, 'fileB object still exists (queue may be stuck)');
		}, { timeout: 30_000, interval: 500 });
	});
});
