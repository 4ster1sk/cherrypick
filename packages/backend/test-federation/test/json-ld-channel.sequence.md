# JsonLD署名検証 (チャンネル投稿) テスト — テストごとの挙動とシーケンス図

対象: `test/json-ld-channel.test.ts` (全14ケース)
登場人物: Tester (vitest) / Stub (`z.test` 配信代行) / Inbox (`a.test` の inbox・202で即時応答) / Queue (BullMQ) / Proc (`InboxProcessorService`) / AP (`ApInboxService`) / DB

前提: `beforeAll` で alice (`a.test`) がチャンネルを作成し、チャンネルアクターURI (`https://a.test/users/<actorId>`) を fixture の `{{recipient}}` / `{{channelActor}}` に注入する。cc に自ホスト (`a.test`) が含まれるため、HTTP有効経路でもLD検証が試行される。
Announce系は `10-ch-original` を先に取り込ませてから `11-ch-announce` (配送毎にstubが一意id採番) を配送する。

## C-P1. チャンネル宛Create・HTTP署名のみ (LDなし) は取り込まれる (none/valid)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=none, http=valid)
    Stub->>Inbox: POST /inbox (HTTP署名付き, LDなし)
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 OK かつ actor一致
    Proc->>Proc: audienceに自ホストあり → verifyJsonLD試行 → LDなし → signatureなし扱いで継続
    Proc->>AP: performActivity(Create)
    AP->>AP: cc言及からチャンネル検出
    AP->>DB: Note作成 (channelId付き)
    Tester->>Inbox: users/notes (zack) をポーリング
    Inbox-->>Tester: note.channelId == aliceCh.id を確認
```
判定: `strictEqual(note.channelId, aliceCh.id)`。

## C-P2. チャンネル宛Create・HTTP有効+LD有効 は取り込まれる (valid/valid)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=valid, http=valid)
    Stub->>Stub: ActivityにRsaSignature2017を付与
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 OK かつ actor一致
    Proc->>Proc: audienceに自ホストあり → verifyJsonLDを試行 → 成功 (署名保持)
    Proc->>AP: performActivity(Create)
    AP->>AP: cc言及からチャンネル検出
    AP->>DB: Note作成 (channelId付き)
    Tester->>Inbox: users/notes (zack) をポーリング
    Inbox-->>Tester: note.channelId == aliceCh.id を確認
```
判定: `strictEqual(note.channelId, aliceCh.id)`。

## C-P3. チャンネル宛Create・HTTP破壊+LD有効 はフォールバックで取り込まれる (valid/broken)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=valid, http=broken)
    Stub->>Stub: ActivityにRsaSignature2017を付与
    Stub->>Stub: Signatureヘッダ中央1文字を反転
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 NG → verifyJsonLDが必須 → 成功
    Proc->>AP: performActivity(Create)
    AP->>AP: cc言及からチャンネル検出
    AP->>DB: Note作成 (channelId付き)
    Tester->>Inbox: users/notes (zack) をポーリング
    Inbox-->>Tester: note.channelId == aliceCh.id を確認
```
判定: `strictEqual(note.channelId, aliceCh.id)`。

## C-P4. チャンネル宛Create・HTTP有効+LD改ざん は剥がして取り込まれる (tampered-body/valid)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=tampered-body, http=valid)
    Stub->>Stub: 署名後にobject.contentへ追記
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 OK かつ actor一致
    Proc->>Proc: audienceに自ホストあり → verifyJsonLDを試行 → 失敗 → signature削除
    Proc->>AP: performActivity(Create)
    AP->>AP: cc言及からチャンネル検出
    AP->>DB: Note作成 (channelId付き、現行の寛容仕様を固定)
    Tester->>Inbox: users/notes (zack) をポーリング
    Inbox-->>Tester: note.channelId == aliceCh.id を確認
```
判定: `strictEqual(note.channelId, aliceCh.id)`。

## C-N1. チャンネル宛Create・HTTP破壊+LDなし は拒否される (none/broken)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=none, http=broken)
    Stub->>Inbox: POST /inbox (HTTP署名破壊, LDなし)
    Inbox-->>Stub: 202 (非同期のため受付のみ)
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 NG、LD署名なし → UnrecoverableError
    Note over Proc,DB: Noteは作成されない
    Tester->>Inbox: users/notes (zack) を10秒ポーリング
    Inbox-->>Tester: noteUri は一度も現れない
```
判定: `assertFederationTestNoteNotIngested`。

## C-N2. チャンネル宛Create・HTTP破壊+LD本文改ざん は拒否される (tampered-body/broken)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=tampered-body, http=broken)
    Stub->>Stub: 署名後にobject.contentへ追記
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 NG → verifyJsonLDが必須
    Proc->>Proc: verifyRsaSignature2017 失敗 → UnrecoverableError
    Note over Proc,DB: Noteは作成されない
    Tester->>Inbox: users/notes (zack) を10秒ポーリング
    Inbox-->>Tester: noteUri は一度も現れない
```
判定: `assertFederationTestNoteNotIngested`。

## C-N3. チャンネル宛Create・HTTP破壊+LD署名値改ざん は拒否される (tampered-value/broken)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=tampered-value, http=broken)
    Stub->>Stub: signatureValue中央1文字を反転
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 NG → verifyJsonLDが必須
    Proc->>Proc: verifyRsaSignature2017 失敗 → UnrecoverableError
    Note over Proc,DB: Noteは作成されない
    Tester->>Inbox: users/notes (zack) を10秒ポーリング
    Inbox-->>Tester: noteUri は一度も現れない
```
判定: `assertFederationTestNoteNotIngested`。

## C-N4. チャンネル宛Create・HTTP破壊+LD型不正 は拒否される (wrong-type/broken)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=wrong-type, http=broken)
    Stub->>Stub: signature.type をDataIntegrityProofにすり替え
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 NG → verifyJsonLDが必須
    Proc->>Proc: type != RsaSignature2017 → UnrecoverableError
    Note over Proc,DB: Noteは作成されない
    Tester->>Inbox: users/notes (zack) を10秒ポーリング
    Inbox-->>Tester: noteUri は一度も現れない
```
判定: `assertFederationTestNoteNotIngested`。

## C-N5. チャンネル宛Create・HTTP破壊+LD creator不一致 は拒否される (creator-mismatch/broken)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=creator-mismatch, http=broken)
    Stub->>Stub: mallory鍵で署名 (creator=mallory, actor=zackのまま)
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 NG → verifyJsonLDが必須
    Proc->>Proc: LD検証自体は成功するが LDユーザー(mallory) != actor(zack) → UnrecoverableError
    Note over Proc,DB: Noteは作成されない
    Tester->>Inbox: users/notes (zack) を10秒ポーリング
    Inbox-->>Tester: noteUri は一度も現れない
```
判定: `assertFederationTestNoteNotIngested`。

## A-P1. チャンネル宛Announce・HTTP有効+LD有効 はリノートとして取り込まれる (valid/valid)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (10-ch-original, 署名なし)
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: HTTP署名 OK → performActivity(Create)
    Proc->>AP: performActivity(Create)
    AP->>DB: オリジナルNote作成
    Tester->>Stub: POST /deliver (11-ch-announce, ld=valid, http=valid)
    Stub->>Stub: AnnounceにRsaSignature2017を付与 (idは配送毎に採番)
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名 OK、ccに自チャンネル → verifyJsonLD成功 (署名保持)
    Proc->>AP: performActivity(Announce) → announceNote
    AP->>AP: cc言及からチャンネル検出 → renote作成 (channel付き)
    AP->>DB: Renote作成 (uri=activityId)
    Tester->>Inbox: users/notes (zack) をポーリング
    Inbox-->>Tester: renote.channelId == aliceCh.id、renoteId != null を確認
    Tester->>Inbox: channels/timeline を取得
    Inbox-->>Tester: チャンネルTLにリノートが含まれることを確認
```
判定: `channelId` 一致、`renoteId` 非null、チャンネルTL含有。

## A-P2. チャンネル宛Announce・HTTP破壊+LD有効 はフォールバックで取り込まれる (valid/broken)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (10-ch-original, 署名なし)
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Queue->>Proc: performActivity(Create)
    Proc->>AP: performActivity(Create)
    AP->>DB: オリジナルNote作成
    Tester->>Stub: POST /deliver (11-ch-announce, ld=valid, http=broken)
    Stub->>Stub: AnnounceにRsaSignature2017を付与
    Stub->>Stub: Signatureヘッダ中央1文字を反転
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 NG → verifyJsonLDが必須 → 成功
    Proc->>AP: performActivity(Announce) → announceNote
    AP->>AP: cc言及からチャンネル検出 → renote作成 (channel付き)
    AP->>DB: Renote作成 (uri=activityId)
    Tester->>Inbox: users/notes (zack) をポーリング
    Inbox-->>Tester: renote.channelId == aliceCh.id、renoteId != null を確認
```
判定: `channelId` 一致、`renoteId` 非null。

## A-N1. チャンネル宛Announce・HTTP破壊+LDなし は拒否される (none/broken)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (10-ch-original, 署名なし)
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Queue->>Proc: performActivity(Create)
    Proc->>AP: performActivity(Create)
    AP->>DB: オリジナルNote作成 (以後annyounce対象として解決可能)
    Tester->>Stub: POST /deliver (11-ch-announce, ld=none, http=broken)
    Stub->>Inbox: POST /inbox (HTTP署名破壊, LDなし)
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 NG、LD署名なし → UnrecoverableError
    Note over Proc,DB: Renoteは作成されない
    Tester->>Inbox: users/notes (zack) を10秒ポーリング
    Inbox-->>Tester: activityId は一度も現れない
```
判定: `assertFederationTestNoteNotIngested(alice, activityId)`。

## A-N2. チャンネル宛Announce・HTTP破壊+LD本文改ざん は拒否される (tampered-body/broken)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (10-ch-original, 署名なし)
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Queue->>Proc: performActivity(Create)
    Proc->>AP: performActivity(Create)
    AP->>DB: オリジナルNote作成
    Tester->>Stub: POST /deliver (11-ch-announce, ld=tampered-body, http=broken)
    Stub->>Stub: 署名後にtoへジャンクURI追加 (Announce用改変)
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 NG → verifyJsonLDが必須
    Proc->>Proc: verifyRsaSignature2017 失敗 → UnrecoverableError
    Note over Proc,DB: Renoteは作成されない
    Tester->>Inbox: users/notes (zack) を10秒ポーリング
    Inbox-->>Tester: activityId は一度も現れない
```
判定: `assertFederationTestNoteNotIngested(alice, activityId)`。

## A-N3. チャンネル宛Announce・HTTP破壊+LD型不正 は拒否される (wrong-type/broken)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (11-ch-announce, ld=wrong-type, http=broken)
    Note over Tester,Stub: オリジナル事前配送はA-N1/A-N2と同一のため省略
    Stub->>Stub: signature.type をDataIntegrityProofにすり替え
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 NG → verifyJsonLDが必須
    Proc->>Proc: type != RsaSignature2017 → UnrecoverableError
    Note over Proc,DB: Renoteは作成されない
    Tester->>Inbox: users/notes (zack) を10秒ポーリング
    Inbox-->>Tester: activityId は一度も現れない
```
判定: `assertFederationTestNoteNotIngested(alice, activityId)`。
備考: `creator-mismatch` / `tampered-value` は Create 側と同一 `verifyJsonLD` 経路で検証済みのため Announce では省略。

## R-P1. 正規LDのAnnounceはフォロワーのサーバーへ中継される (valid/valid)

前提: `bob` (`b.test`) がzackとチャンネルをフォロー済み (中継先の観測者)。

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (11-ch-announce, ld=valid, http=valid)
    Stub->>Stub: AnnounceにRsaSignature2017を付与
    Stub->>InboxA: POST /a.test/inbox
    InboxA-->>Stub: 202
    InboxA->>QueueA: inboxジョブを投入
    QueueA->>ProcA: HTTP署名 OK、LD検証成功 (署名保持)
    ProcA->>APA: performActivity(Announce) → announceNote
    APA->APA: チャンネル検出 → renote作成
    APA->>APA: activity.signatureあり → チャンネルフォロワーへ転送
    APA->>InboxB: POST /b.test/inbox (チャンネルアクター鍵のHTTP署名 + zackのLD署名)
    InboxB-->>APA: 202
    InboxB->>QueueB: inboxジョブを投入
    QueueB->>ProcB: HTTP署名者!=actor → LDフォールバック → zack署名を検証成功
    ProcB->>APB: performActivity(Announce) → renote作成
    Tester->>InboxB: notes/timeline (bob) を最大60秒ポーリング
    InboxB-->>Tester: uri == activityId の出現を確認
```
判定: a.testで `channelId` 一致のチャンネルリノート作成＋b.testのbob HTLに `uri == activityId` が出現。

## R-N1. 改竄LDのAnnounceは取り込まれるが中継されない (tampered-body/valid)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (11-ch-announce, ld=tampered-body, http=valid)
    Stub->>Stub: 署名後にtoへジャンクURI追加
    Stub->>InboxA: POST /a.test/inbox
    InboxA-->>Stub: 202
    InboxA->>QueueA: inboxジョブを投入
    QueueA->>ProcA: HTTP署名 OK → verifyJsonLD試行 → 失敗 → signature剥離
    ProcA->>APA: performActivity(Announce) → announceNote
    APA->>APA: チャンネル検出 → renote作成 (ローカル取り込みは継続)
    APA->>APA: activity.signatureなし → 転送しない
    Note over APA,InboxB: b.testへは何も配送されない (AMPにならない)
    Tester->>InboxA: チャンネルリノート作成を確認 (channelId一致)
    Tester->>InboxB: notes/timeline (bob) を約20秒ポーリング
    InboxB-->>Tester: activityId は一度も現れない
```
判定: a.testで取り込み確認＋b.test HTL不在確認。

## R-N2. LDなしのAnnounceは取り込まれるが中継されない (none/valid)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (11-ch-announce, ld=none, http=valid)
    Stub->>InboxA: POST /a.test/inbox (LD署名なし)
    InboxA-->>Stub: 202
    InboxA->>QueueA: inboxジョブを投入
    QueueA->>ProcA: HTTP署名 OK → verifyJsonLD試行 → LDなしで失敗 → 継続 (署名なし)
    ProcA->>APA: performActivity(Announce) → announceNote
    APA->>APA: チャンネル検出 → renote作成 (ローカル取り込みは継続)
    APA->>APA: activity.signatureなし → 転送しない
    Note over APA,InboxB: b.testへは何も配送されない (AMPにならない)
    Tester->>InboxA: チャンネルリノート作成を確認 (channelId一致)
    Tester->>InboxB: notes/timeline (bob) を約20秒ポーリング
    InboxB-->>Tester: activityId は一度も現れない
```
判定: a.testで取り込み確認＋b.test HTL不在確認。
