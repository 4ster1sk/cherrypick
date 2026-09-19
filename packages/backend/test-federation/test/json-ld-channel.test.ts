import assert, { strictEqual } from 'node:assert';
import { describe, test, beforeAll } from 'vitest';
import type * as Misskey from 'misskey-js';
import {
	assertFederationTestNoteNotIngested,
	createAccount,
	deliverFederationTestNote,
	randomUsername,
	resolveRemoteUser,
	sleep,
	waitFor,
	waitForFederationTestNoteUri,
	type FederationTestHttpMode,
	type FederationTestLdMode,
	type LoginUser,
} from './utils.js';

const ORIGINAL_PATH = 'json-ld-signature/10-ch-original';
const ORIGINAL_URI = 'https://z.test/notes/json-ld-signature/10-ch-original';
const ANNOUNCE_PATH = 'json-ld-signature/11-ch-announce';

describe('JsonLD署名検証 (チャンネル投稿)', () => {
	let alice: LoginUser;
	let aliceCh: Misskey.entities.Channel;
	let channelActorUri: string;

	beforeAll(async () => {
		alice = await createAccount('a.test');
		aliceCh = await alice.client.request('channels/create', { username: randomUsername() });
		assert(aliceCh.actorId);
		channelActorUri = `https://a.test/users/${aliceCh.actorId}`;
		await sleep();
	});

	async function deliverChannelNote(options: { ld: FederationTestLdMode; http: FederationTestHttpMode }): Promise<string> {
		const nonce = crypto.randomUUID().replaceAll('-', '');
		const noteUri = `https://z.test/notes/json-ld-signature/${nonce}`;
		await deliverFederationTestNote('a.test', 'json-ld-signature/01-mention-self', {
			placeholders: { nonce, recipient: channelActorUri },
			ld: options.ld,
			http: options.http,
		});
		return noteUri;
	}

	async function deliverChannelAnnounce(options: { ld: FederationTestLdMode; http: FederationTestHttpMode }): Promise<string> {
		// Announce 対象のオリジナルを先に取り込ませる (再配送は重複スキップされ安全)
		await deliverFederationTestNote('a.test', ORIGINAL_PATH);
		await waitForFederationTestNoteUri(alice, ORIGINAL_URI);

		const delivered = await deliverFederationTestNote('a.test', ANNOUNCE_PATH, {
			placeholders: { channelActor: channelActorUri },
			ld: options.ld,
			http: options.http,
		});
		return delivered.activityId;
	}

	describe('チャンネル宛Create', () => {
		test('HTTP署名のみ (LDなし) はチャンネル投稿として取り込まれる', async () => {
			const noteUri = await deliverChannelNote({ ld: 'none', http: 'valid' });
			const note = await waitForFederationTestNoteUri(alice, noteUri);
			strictEqual(note.channelId, aliceCh.id);
		});

		test('HTTP有効+LD有効 はチャンネル投稿として取り込まれる', async () => {
			const noteUri = await deliverChannelNote({ ld: 'valid', http: 'valid' });
			const note = await waitForFederationTestNoteUri(alice, noteUri);
			strictEqual(note.channelId, aliceCh.id);
		});

		test('HTTP破壊+LD有効 はLDフォールバックでチャンネル投稿として取り込まれる', async () => {
			const noteUri = await deliverChannelNote({ ld: 'valid', http: 'broken' });
			const note = await waitForFederationTestNoteUri(alice, noteUri);
			strictEqual(note.channelId, aliceCh.id);
		});

		test('HTTP有効+LD改ざん はLDを剥がしてチャンネル投稿として取り込まれる', async () => {
			// NOTE: 現ブランチはHTTP有効時にLD不検証のまま継続し、Create経路には転送がないため取り込まれる (現行仕様の固定)
			const noteUri = await deliverChannelNote({ ld: 'tampered-body', http: 'valid' });
			const note = await waitForFederationTestNoteUri(alice, noteUri);
			strictEqual(note.channelId, aliceCh.id);
		});

		test('HTTP破壊+LDなし は拒否される', async () => {
			const noteUri = await deliverChannelNote({ ld: 'none', http: 'broken' });
			await assertFederationTestNoteNotIngested(alice, noteUri);
		});

		test('HTTP破壊+LD本文改ざん は拒否される', async () => {
			const noteUri = await deliverChannelNote({ ld: 'tampered-body', http: 'broken' });
			await assertFederationTestNoteNotIngested(alice, noteUri);
		});

		test('HTTP破壊+LD署名値改ざん は拒否される', async () => {
			const noteUri = await deliverChannelNote({ ld: 'tampered-value', http: 'broken' });
			await assertFederationTestNoteNotIngested(alice, noteUri);
		});

		test('HTTP破壊+LD型不正 は拒否される', async () => {
			const noteUri = await deliverChannelNote({ ld: 'wrong-type', http: 'broken' });
			await assertFederationTestNoteNotIngested(alice, noteUri);
		});

		test('HTTP破壊+LD creator不一致 (mallory署名) は拒否される', async () => {
			const noteUri = await deliverChannelNote({ ld: 'creator-mismatch', http: 'broken' });
			await assertFederationTestNoteNotIngested(alice, noteUri);
		});
	});

	describe('チャンネル宛Announce', () => {
		test('HTTP有効+LD有効 はチャンネルリノートとして取り込まれる', async () => {
			const activityId = await deliverChannelAnnounce({ ld: 'valid', http: 'valid' });
			const renote = await waitForFederationTestNoteUri(alice, activityId);
			strictEqual(renote.channelId, aliceCh.id);
			assert(renote.renoteId != null);

			const tl = await alice.client.request('channels/timeline', { channelId: aliceCh.id, limit: 20 });
			assert(tl.some(note => note.id === renote.id), 'チャンネルTLにリノートが流れる');
		});

		test('HTTP破壊+LD有効 はLDフォールバックでチャンネルリノートとして取り込まれる', async () => {
			const activityId = await deliverChannelAnnounce({ ld: 'valid', http: 'broken' });
			const renote = await waitForFederationTestNoteUri(alice, activityId);
			strictEqual(renote.channelId, aliceCh.id);
			assert(renote.renoteId != null);
		});

		test('HTTP破壊+LDなし は拒否される', async () => {
			const activityId = await deliverChannelAnnounce({ ld: 'none', http: 'broken' });
			await assertFederationTestNoteNotIngested(alice, activityId);
		});

		test('HTTP破壊+LD本文改ざん は拒否される', async () => {
			const activityId = await deliverChannelAnnounce({ ld: 'tampered-body', http: 'broken' });
			await assertFederationTestNoteNotIngested(alice, activityId);
		});

		test('HTTP破壊+LD型不正 は拒否される', async () => {
			const activityId = await deliverChannelAnnounce({ ld: 'wrong-type', http: 'broken' });
			await assertFederationTestNoteNotIngested(alice, activityId);
		});
	});

	describe('チャンネルフォロワーへの中継 (fan-out)', () => {
		// 未検証LDが他サーバーへ流れ出さない (AMPにならない) ことの観測。
		// R-P1 が中継経路自体の健全性を証明し、R-N1/R-N2 の「現れない」が抑止の結果であることを保証する。
		let bob: LoginUser;

		async function waitForTimelineUri(viewer: LoginUser, uri: string, timeout = 60_000): Promise<Misskey.entities.Note> {
			let found: Misskey.entities.Note | undefined;
			await waitFor(async () => {
				try {
					const tl = await viewer.client.request('notes/timeline', { limit: 100 });
					found = tl.find(note => note.uri === uri);
					return found != null;
				} catch {
					return false;
				}
			}, { timeout, interval: 2_000 });
			if (found == null) throw new Error(`relayed note not observed in timeline: ${uri}`);
			return found;
		}

		async function assertTimelineNotContains(viewer: LoginUser, uri: string, timeout = 20_000): Promise<void> {
			const start = Date.now();
			for (;;) {
				const tl = await viewer.client.request('notes/timeline', { limit: 100 });
				if (tl.some(note => note.uri === uri)) {
					throw new Error(`note should not have been relayed but was: ${uri}`);
				}
				if (Date.now() - start >= timeout) return;
				await sleep(2_000);
			}
		}

		beforeAll(async () => {
			bob = await createAccount('b.test');
			const zackInB = await resolveRemoteUser('z.test', 'zack', bob);
			await bob.client.request('following/create', { userId: zackInB.id });
			const chActorInB = await resolveRemoteUser('a.test', aliceCh.actorId, bob);
			assert(chActorInB.channelId);
			const aliceChInB = await bob.client.request('channels/show', { channelId: chActorInB.channelId });
			await bob.client.request('channels/follow', { channelId: aliceChInB.id });
			await waitFor(async () => {
				const channelActor = await bob.client.request('users/show', { userId: chActorInB.id });
				return channelActor.isFollowing ?? false;
			}, { timeout: 30_000, interval: 1_000 });
		});

		test('HTTP有効+LD有効 のAnnounceはフォロワーのサーバーへ中継される', async () => {
			const activityId = await deliverChannelAnnounce({ ld: 'valid', http: 'valid' });
			const renote = await waitForFederationTestNoteUri(alice, activityId);
			strictEqual(renote.channelId, aliceCh.id);

			const relayed = await waitForTimelineUri(bob, activityId);
			strictEqual(relayed.uri, activityId);
		});

		test('HTTP有効+LD改ざん のAnnounceは取り込まれるが中継されない (AMPにならない)', async () => {
			// H3 (vuln_scan/ap/REPORT.md): 現ブランチはHTTP有効時にLDを検証・剥離しないため、
			// 偽造LDが activity.signature として残り中継される。修正 (080f24a647相当) 適用まではREDが正しい。
			const activityId = await deliverChannelAnnounce({ ld: 'tampered-body', http: 'valid' });
			const renote = await waitForFederationTestNoteUri(alice, activityId);
			strictEqual(renote.channelId, aliceCh.id);

			await assertTimelineNotContains(bob, activityId);
		});

		test('HTTP有効+LD署名値改ざん のAnnounceは取り込まれるが中継されない (AMPにならない)', async () => {
			// H3: R-N1と同経路。修正 (080f24a647相当) 適用まではREDが正しい。
			const activityId = await deliverChannelAnnounce({ ld: 'tampered-value', http: 'valid' });
			const renote = await waitForFederationTestNoteUri(alice, activityId);
			strictEqual(renote.channelId, aliceCh.id);

			await assertTimelineNotContains(bob, activityId);
		});

		test('HTTP有効+LD型不正 のAnnounceは取り込まれるが中継されない (AMPにならない)', async () => {
			// H3: truthyなsignatureなら型不問で中継されるのが現状の穴。修正 (080f24a647相当) 適用まではREDが正しい。
			const activityId = await deliverChannelAnnounce({ ld: 'wrong-type', http: 'valid' });
			const renote = await waitForFederationTestNoteUri(alice, activityId);
			strictEqual(renote.channelId, aliceCh.id);

			await assertTimelineNotContains(bob, activityId);
		});

		test('HTTP有効+LD creator不一致 のAnnounceは取り込まれるが中継されない (AMPにならない)', async () => {
			// H3: 修正のcreator=actor束縛を直接検証する。修正 (080f24a647相当) 適用まではREDが正しい。
			const activityId = await deliverChannelAnnounce({ ld: 'creator-mismatch', http: 'valid' });
			const renote = await waitForFederationTestNoteUri(alice, activityId);
			strictEqual(renote.channelId, aliceCh.id);

			await assertTimelineNotContains(bob, activityId);
		});

		test('HTTP有効+LDなし のAnnounceは取り込まれるが中継されない (AMPにならない)', async () => {
			const activityId = await deliverChannelAnnounce({ ld: 'none', http: 'valid' });
			const renote = await waitForFederationTestNoteUri(alice, activityId);
			strictEqual(renote.channelId, aliceCh.id);

			await assertTimelineNotContains(bob, activityId);
		});
	});
});
