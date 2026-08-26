/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, yojo-art team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import {
	CreateBucketCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	PutBucketPolicyCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import { api, signup, startJobQueue, uploadFile } from '../utils.js';
import { describeObjectStorageE2E } from '../helpers/describe-object-storage-e2e.js';
import type { INestApplicationContext } from '@nestjs/common';
import type * as misskey from 'misskey-js';

// ローカルで起動した rustfs (packages/backend/test/compose.yml 参照) に接続する
const OBJECT_STORAGE_ENDPOINT = process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://127.0.0.1:59312';
const OBJECT_STORAGE_BUCKET = `misskey-test-${randomUUID()}`;
const OBJECT_STORAGE_ACCESS_KEY = process.env.OBJECT_STORAGE_ACCESS_KEY ?? 'rustfsadmin';
const OBJECT_STORAGE_SECRET_KEY = process.env.OBJECT_STORAGE_SECRET_KEY ?? 'rustfsadmin';

describeObjectStorageE2E('ストレージライフサイクル', () => {
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

	test('アカウントを削除するとユーザーの全オブジェクトがストレージからも削除される', async () => {
		const alice = await signup({ username: 'alice' });

		const upRes = await uploadFile(alice, { path: '192.png' });
		assert.strictEqual(upRes.status, 200);
		const file = upRes.body!;
		assert.ok(file.thumbnailUrl != null);

		const delRes = await api('i/delete-account', { password: 'test' }, alice);
		assert.strictEqual(delRes.status, 204);

		// オリジナル・サムネイルともにジョブ経由で削除される
		await vi.waitFor(async () => {
			const [original, thumbnail] = await Promise.all([
				fetch(file.url),
				fetch(file.thumbnailUrl!),
			]);
			assert.notStrictEqual(original.status, 200, 'original object still exists');
			assert.notStrictEqual(thumbnail.status, 200, 'thumbnail object still exists');
		}, { timeout: 60_000, interval: 500 });
	});

	// メタ設定を変更するテストなので、他テストへの影響を避けるため最後に実行する
	test('objectStorageBaseUrl を設定すると公開URLだけが別ベースになり、実体はendpoint側に保存される', async () => {
		// 実在しないパスを「CDN」のベースとして設定する (URL構築の差し替えを検証するのが目的)
		const cdnBaseUrl = `${OBJECT_STORAGE_ENDPOINT}/cdn`;

		const setRes = await api('admin/update-meta', {
			objectStorageBaseUrl: cdnBaseUrl,
		}, root);
		assert.strictEqual(setRes.status, 200);

		const upRes = await uploadFile(root, { path: '192.jpg' });
		assert.strictEqual(upRes.status, 200);
		const file = upRes.body!;

		// 公開URLはbaseUrlベースで生成される
		assert.ok(file.url.startsWith(`${cdnBaseUrl}/test/`), `actual url: ${file.url}`);
		assert.ok(file.thumbnailUrl != null && file.thumbnailUrl.startsWith(`${cdnBaseUrl}/test/`), `actual thumbnailUrl: ${file.thumbnailUrl}`);

		// 公開URL上のパスからオブジェクトキーを復元して、実体がendpointバケット側にあることを確認する
		const key = new URL(file.url).pathname.replace('/cdn/', '');
		const stored = await s3Client.send(new GetObjectCommand({
			Bucket: OBJECT_STORAGE_BUCKET,
			Key: key,
		}));
		assert.strictEqual(stored.ContentType, 'image/jpeg');

		const listed = await s3Client.send(new ListObjectsV2Command({
			Bucket: OBJECT_STORAGE_BUCKET,
		}));
		assert.ok((listed.Contents ?? []).some(o => o.Key === key));
	});
});
