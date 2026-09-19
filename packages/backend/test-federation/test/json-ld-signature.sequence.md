# JsonLD署名検証テスト — テストごとの挙動とシーケンス図

対象: `test/json-ld-signature.test.ts` (全11ケース)
登場人物: Tester (vitest) / Stub (`z.test` 配信代行) / Inbox (`b.test` の inbox・202で即時応答) / Queue (BullMQ) / Proc (`InboxProcessorService`) / AP (`ApInboxService`) / DB

フラグ意味: `http=valid/broken` (HTTP Signatureの正否)、`ld=none/valid/改ざん系` (LD署名の状態)。
`01-mention-self` は cc に自ホスト (`b.test`) 言及あり、`02-public-only` は言及なし。

## P1. HTTP署名のみ (LDなし) は取り込まれる (`02-public-only`, none/valid)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=none, http=valid)
    Stub->>Inbox: POST /inbox (HTTP署名付き, LDなし)
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 OK かつ actor一致
    Proc->>Proc: LDなしのまま継続 (現ブランチはHTTP有効時にLD検証・剥離しない)
    Proc->>AP: performActivity(Create)
    AP->>DB: Note作成
    Tester->>Inbox: users/notes (zack) をポーリング
    Inbox-->>Tester: note.uri == noteUri を確認
```
判定: `strictEqual(note.uri, noteUri)`。

## P2. HTTP有効+LD有効 (self言及あり) は取り込まれる (`01-mention-self`, valid/valid)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=valid, http=valid)
    Stub->>Stub: ActivityにRsaSignature2017を付与
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 OK かつ actor一致
    Proc->>Proc: 現ブランチはHTTP有効時にLD不検証のまま継続 (署名保持)
    Proc->>AP: performActivity(Create)
    AP->>DB: Note作成
    Tester->>Inbox: users/notes (zack) をポーリング
    Inbox-->>Tester: note.uri == noteUri を確認
```
判定: `strictEqual(note.uri, noteUri)`。

## P3. HTTP有効+LD有効 (self言及なし) はLDを剥がして取り込まれる (`02-public-only`, valid/valid)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=valid, http=valid)
    Stub->>Stub: ActivityにRsaSignature2017を付与
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 OK かつ actor一致
    Proc->>Proc: 現ブランチはLD不検証のまま継続 (署名保持)。Create経路に転送はない
    Proc->>AP: performActivity(Create)
    AP->>DB: Note作成
    Tester->>Inbox: users/notes (zack) をポーリング
    Inbox-->>Tester: note.uri == noteUri を確認
```
判定: `strictEqual(note.uri, noteUri)`。

## P4. HTTP破壊+LD有効 はLDフォールバックで取り込まれる (`01-mention-self`, valid/broken)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=valid, http=broken)
    Stub->>Stub: ActivityにRsaSignature2017を付与
    Stub->>Stub: Signatureヘッダ中央1文字を反転
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 NG → verifyJsonLDが必須
    Proc->>Proc: type=RsaSignature2017, creator解決, 検証成功, actor一致
    Proc->>AP: performActivity(Create)
    AP->>DB: Note作成
    Tester->>Inbox: users/notes (zack) をポーリング
    Inbox-->>Tester: note.uri == noteUri を確認
```
判定: `strictEqual(note.uri, noteUri)`。

## P5. HTTP有効+LD改ざん はLDを剥がして取り込まれる (`01-mention-self`, tampered-body/valid)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=tampered-body, http=valid)
    Stub->>Stub: 署名後にobject.contentへ追記 (署名破壊)
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名検証 OK かつ actor一致
    Proc->>Proc: 現ブランチはLD不検証のまま継続 (偽造署名が残存)。Create経路に転送はないため取り込まれる
    Proc->>AP: performActivity(Create)
    AP->>DB: Note作成 (現行の寛容仕様を固定)
    Tester->>Inbox: users/notes (zack) をポーリング
    Inbox-->>Tester: note.uri == noteUri を確認
```
判定: `strictEqual(note.uri, noteUri)`。

## N1. HTTP破壊+LDなし は拒否される (`01-mention-self`, none/broken)

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
判定: `assertFederationTestNoteNotIngested` (出現したら失敗)。

## N2. HTTP破壊+LD本文改ざん は拒否される (`01-mention-self`, tampered-body/broken)

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

## N3. HTTP破壊+LD署名値改ざん は拒否される (`01-mention-self`, tampered-value/broken)

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

## N4. HTTP破壊+LD型不正 は拒否される (`01-mention-self`, wrong-type/broken)

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

## N5. HTTP破壊+LD creator不一致 (mallory署名) は拒否される (`01-mention-self`, creator-mismatch/broken)

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

## N6. activity.idホスト不一致 は拒否される (`01-mention-self`, valid/valid + activityId上書き)

```mermaid
sequenceDiagram
    Tester->>Stub: POST /deliver (ld=valid, http=valid, activityId=evil.test)
    Stub->>Stub: Create.id を https://evil.test/... に上書きして署名
    Stub->>Inbox: POST /inbox
    Inbox-->>Stub: 202
    Inbox->>Queue: inboxジョブを投入
    Queue->>Proc: process(activity, signature)
    Proc->>Proc: HTTP署名 OK (現ブランチはLD不検証)
    Proc->>Proc: activity.idホスト(evil.test) != 署名者(z.test) → UnrecoverableError
    Note over Proc,DB: Noteは作成されない
    Tester->>Inbox: users/notes (zack) を10秒ポーリング
    Inbox-->>Tester: noteUri は一度も現れない
```
判定: `assertFederationTestNoteNotIngested`。
