/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { DataSource } from 'typeorm';
import {
	api,
	failedApiCall,
	signup,
	successfulApiCall,
	testPaginationConsistency,
	initTestDb,
} from '../utils.js';
import type * as misskey from 'cherrypick-js';
import { genAidx } from '@/misc/id/aidx.js';
import { MiAvatarDecoration } from '@/models/AvatarDecoration.js';

describe('アバターデコレーション', () => {
	type User = misskey.entities.SignupResponse;

	let root: User;
	let alice: User;
	let db: DataSource;

	const defaultDecoParam = {
		name: 'test-decoration',
		description: 'test description',
		url: 'https://example.com/decoration.png',
	};

	const createLocalDecoration = async (params: Partial<typeof defaultDecoParam> = {}) => {
		return successfulApiCall({
			endpoint: 'admin/avatar-decorations/create',
			parameters: { ...defaultDecoParam, ...params },
			user: root,
		});
	};

	const createRemoteDecoration = async (host: string, params: Partial<{ name: string, description: string, url: string }> = {}) => {
		const repo = db.getRepository(MiAvatarDecoration);
		const decoration = repo.create({
			id: genAidx(Date.now()),
			host,
			name: params.name ?? 'remote-decoration',
			description: params.description ?? 'remote description',
			url: params.url ?? 'https://remote.example.com/decoration.png',
			roleIdsThatCanBeUsedThisDecoration: [],
		});
		return repo.save(decoration);
	};

	beforeAll(async () => {
		root = await signup({ username: 'root' });
		alice = await signup({ username: 'alice' });
		db = await initTestDb(true);
	}, 1000 * 60 * 2);

	afterAll(async () => {
		await db.destroy();
	});

	beforeEach(async () => {
		await db.getRepository(MiAvatarDecoration).delete({});
	});

	//#region admin/avatar-decorations/list

	describe('admin/avatar-decorations/list', () => {
		test('認証なしは401になる', async () => {
			await failedApiCall({
				endpoint: 'admin/avatar-decorations/list',
				parameters: {},
				user: undefined,
			}, {
				status: 401,
				code: 'CREDENTIAL_REQUIRED',
				id: '1384574d-a912-4b81-8601-c7b1c4085df1',
			});
		});

		test('canManageAvatarDecorations権限なしは403になる', async () => {
			await failedApiCall({
				endpoint: 'admin/avatar-decorations/list',
				parameters: {},
				user: alice,
			}, {
				status: 403,
				code: 'ROLE_PERMISSION_DENIED',
				id: 'c3d38592-54c0-429d-be96-5636b0431a61',
			});
		});

		test('デコレーションがない場合は空配列が返る', async () => {
			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list',
				parameters: {},
				user: root,
			});
			assert.deepStrictEqual(res, []);
		});

		test('ローカルデコレーションが全フィールド付きで返る', async () => {
			const created = await createLocalDecoration();
			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list',
				parameters: {},
				user: root,
			});
			assert.strictEqual(res.length, 1);
			assert.strictEqual(res[0].id, created.id);
			assert.ok(res[0].createdAt);
			assert.strictEqual(res[0].updatedAt, null);
			assert.strictEqual(res[0].name, defaultDecoParam.name);
			assert.strictEqual(res[0].description, defaultDecoParam.description);
			assert.strictEqual(res[0].url, defaultDecoParam.url);
			assert.deepStrictEqual(res[0].roleIdsThatCanBeUsedThisDecoration, []);
		});

		test('リモートデコレーション(host!=null)は含まれない', async () => {
			await createLocalDecoration();
			await createRemoteDecoration('example.com');
			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list',
				parameters: {},
				user: root,
			});
			assert.strictEqual(res.length, 1);
			assert.strictEqual(res[0].name, defaultDecoParam.name);
		});

		test('limitが機能する', async () => {
			await createLocalDecoration({ name: 'deco1' });
			await createLocalDecoration({ name: 'deco2' });
			await createLocalDecoration({ name: 'deco3' });
			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list',
				parameters: { limit: 2 },
				user: root,
			});
			assert.strictEqual(res.length, 2);
		});

		test('limit=0はバリデーションエラーになる', async () => {
			const res = await api('admin/avatar-decorations/list', { limit: 0 } as any, root);
			assert.strictEqual(res.status, 400);
		});

		test('limit=101はバリデーションエラーになる', async () => {
			const res = await api('admin/avatar-decorations/list', { limit: 101 } as any, root);
			assert.strictEqual(res.status, 400);
		});

		test('sinceIdによるページネーションが機能する', async () => {
			const deco1 = await createLocalDecoration({ name: 'deco1' });
			const deco2 = await createLocalDecoration({ name: 'deco2' });
			const deco3 = await createLocalDecoration({ name: 'deco3' });

			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list',
				parameters: { sinceId: deco1.id },
				user: root,
			});
			const ids = res.map(d => d.id);
			assert.ok(ids.includes(deco2.id));
			assert.ok(ids.includes(deco3.id));
			assert.ok(!ids.includes(deco1.id));
		});

		test('untilIdによるページネーションが機能する', async () => {
			const deco1 = await createLocalDecoration({ name: 'deco1' });
			const deco2 = await createLocalDecoration({ name: 'deco2' });
			const deco3 = await createLocalDecoration({ name: 'deco3' });

			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list',
				parameters: { untilId: deco3.id },
				user: root,
			});
			const ids = res.map(d => d.id);
			assert.ok(ids.includes(deco1.id));
			assert.ok(ids.includes(deco2.id));
			assert.ok(!ids.includes(deco3.id));
		});

		test('sinceDateによるページネーションが機能する', async () => {
			const before = Date.now() - 5000;
			const deco = await createLocalDecoration({ name: 'afterDeco' });
			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list',
				parameters: { sinceDate: before },
				user: root,
			});
			const ids = res.map(d => d.id);
			assert.ok(ids.includes(deco.id));
		});

		test('untilDateによるページネーションが機能する', async () => {
			const deco = await createLocalDecoration({ name: 'beforeDeco' });
			const after = Date.now() + 5000;
			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list',
				parameters: { untilDate: after },
				user: root,
			});
			const ids = res.map(d => d.id);
			assert.ok(ids.includes(deco.id));
		});

		test('ページネーションの一貫性', async () => {
			const deco1 = await createLocalDecoration({ name: 'page1' });
			const deco2 = await createLocalDecoration({ name: 'page2' });
			const deco3 = await createLocalDecoration({ name: 'page3' });
			const deco4 = await createLocalDecoration({ name: 'page4' });
			const deco5 = await createLocalDecoration({ name: 'page5' });

			// 降順(新しい順)
			const expected = [deco5, deco4, deco3, deco2, deco1];

			await testPaginationConsistency(expected, async (paginationParam) => {
				return successfulApiCall({
					endpoint: 'admin/avatar-decorations/list',
					parameters: paginationParam,
					user: root,
				});
			});
		});
	});

	//#endregion

	//#region admin/avatar-decorations/list-remote

	describe('admin/avatar-decorations/list-remote', () => {
		test('認証なしは401になる', async () => {
			await failedApiCall({
				endpoint: 'admin/avatar-decorations/list-remote',
				parameters: {},
				user: undefined,
			}, {
				status: 401,
				code: 'CREDENTIAL_REQUIRED',
				id: '1384574d-a912-4b81-8601-c7b1c4085df1',
			});
		});

		test('canManageAvatarDecorations権限なしは403になる', async () => {
			await failedApiCall({
				endpoint: 'admin/avatar-decorations/list-remote',
				parameters: {},
				user: alice,
			}, {
				status: 403,
				code: 'ROLE_PERMISSION_DENIED',
				id: 'c3d38592-54c0-429d-be96-5636b0431a61',
			});
		});

		test('リモートデコレーションがない場合は空配列が返る', async () => {
			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list-remote',
				parameters: {},
				user: root,
			});
			assert.deepStrictEqual(res, []);
		});

		test('hostなし指定でリモートデコレーションのみ返る', async () => {
			await createLocalDecoration();
			await createRemoteDecoration('example.com');
			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list-remote',
				parameters: {},
				user: root,
			});
			assert.strictEqual(res.length, 1);
			assert.strictEqual((res[0] as any).host, 'example.com');
		});

		test('host指定でそのホストのデコレーションのみ返る', async () => {
			await createRemoteDecoration('example.com', { name: 'remote-a' });
			await createRemoteDecoration('other.example.com', { name: 'remote-b' });
			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list-remote',
				parameters: { host: 'example.com' },
				user: root,
			});
			assert.strictEqual(res.length, 1);
			assert.strictEqual((res[0] as any).host, 'example.com');
		});

		test('存在しないhost指定では空配列が返る', async () => {
			await createRemoteDecoration('example.com');
			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list-remote',
				parameters: { host: 'notexist.example.com' },
				user: root,
			});
			assert.deepStrictEqual(res, []);
		});

		test('host="."でローカルデコレーションが返る', async () => {
			await createLocalDecoration({ name: 'local-deco' });
			await createRemoteDecoration('example.com');
			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list-remote',
				parameters: { host: '.' },
				user: root,
			});
			assert.strictEqual(res.length, 1);
			assert.strictEqual((res[0] as any).host, null);
		});

		test('レスポンスにhostフィールドが含まれる', async () => {
			await createRemoteDecoration('example.com');
			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list-remote',
				parameters: {},
				user: root,
			});
			assert.strictEqual(res.length, 1);
			assert.ok(Object.prototype.hasOwnProperty.call(res[0], 'host'));
		});

		test('limitが機能する', async () => {
			await createRemoteDecoration('example.com', { name: 'r1' });
			await createRemoteDecoration('example.com', { name: 'r2' });
			await createRemoteDecoration('example.com', { name: 'r3' });
			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list-remote',
				parameters: { limit: 2 },
				user: root,
			});
			assert.strictEqual(res.length, 2);
		});

		test('untilIdによるページネーションが機能する', async () => {
			const r1 = await createRemoteDecoration('example.com', { name: 'r1' });
			const r2 = await createRemoteDecoration('example.com', { name: 'r2' });
			const r3 = await createRemoteDecoration('example.com', { name: 'r3' });

			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list-remote',
				parameters: { untilId: r3.id },
				user: root,
			});
			const ids = res.map(d => d.id);
			assert.ok(ids.includes(r1.id));
			assert.ok(ids.includes(r2.id));
			assert.ok(!ids.includes(r3.id));
		});

		test('sinceIdによるページネーションが機能する', async () => {
			const r1 = await createRemoteDecoration('example.com', { name: 'r1' });
			const r2 = await createRemoteDecoration('example.com', { name: 'r2' });
			const r3 = await createRemoteDecoration('example.com', { name: 'r3' });

			const res = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list-remote',
				parameters: { sinceId: r1.id },
				user: root,
			});
			const ids = res.map(d => d.id);
			assert.ok(ids.includes(r2.id));
			assert.ok(ids.includes(r3.id));
			assert.ok(!ids.includes(r1.id));
		});

		test('ページネーションの一貫性', async () => {
			await createRemoteDecoration('example.com', { name: 'rp1' });
			await createRemoteDecoration('example.com', { name: 'rp2' });
			await createRemoteDecoration('example.com', { name: 'rp3' });
			await createRemoteDecoration('example.com', { name: 'rp4' });
			await createRemoteDecoration('example.com', { name: 'rp5' });

			// APIで全件取得してexpectedとする(createdAtを含む)
			const expected = await successfulApiCall({
				endpoint: 'admin/avatar-decorations/list-remote',
				parameters: { host: 'example.com', limit: 100 },
				user: root,
			});

			await testPaginationConsistency(expected, async (paginationParam) => {
				return successfulApiCall({
					endpoint: 'admin/avatar-decorations/list-remote',
					parameters: { host: 'example.com', ...paginationParam },
					user: root,
				});
			});
		});
	});

	//#endregion
});
