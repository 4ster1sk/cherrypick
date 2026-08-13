# yojo-art 独自機能一覧 (yojo-art-features)

upstream (misskey-dev/misskey) マージ時に**回帰させてはいけない** yojo-art 独自機能の完全一覧。

`git diff <upstream-tag> HEAD` で調査した結果に基づく。upstream との差分で新規追加 or 大幅変更されたファイル群が対象。

## 連合機能 (ActivityPub 拡張)

### チャンネル連合
- `core/activitypub/models/ApPersonService.ts` — `Group` タイプ（チャンネル）アクターの解決、`channelId` / `actorId` 保存
- `core/activitypub/ApRendererService.ts` — `getChannelUri()` でチャンネルアクター URI をノートに付与
- `models/Channel.ts` — `host` / `actorId` / `actor` を追加
- `core/entities/ChannelEntityService.ts` — チャンネルをアクター経由でフォロー判定
- `core/ChannelFollowingService.ts` — **followingsRepository + followee.channelId 方式**（`ChannelFollowing` モデルは yojo-art では削除済み。upstream の `channelFollowingsRepository` は使えない）
- `core/ChannelMutingService.ts` — **期限付きミュート**（`expiresAt` / `Or(IsNull(), MoreThan(...))`）
- `packages/backend/migration/1779795272287-Channel-Federation.js`
- ロール条件式の `isChannel`

### リバーシ連合
- `core/activitypub/models/ApGameService.ts` — AP `Game` タイプ（リバーシ）の解決・更新
- `core/ReversiService.ts` — **`federationId` を使ったリモート対局**（`matchSpecificUser` 等で `renderReversiInvite/Join/Update/Leave/Like` を配送）
- `core/activitypub/type.ts` — `IApGame` / `IApReversi`（`game_type_uuid` 判別）/ `isGame` / `isReversi`
- `models/ReversiGame.ts` — `federationId` カラム
- Nodeinfo に `reversiVersion`（`1.1.0-yojo`）を公開
- `packages/backend/migration/1722327455736-AddReversifederationId.js` / `1724921022768-AddNodeinfoReversi.js`

### チャット連合
- `core/ChatService.ts` — リモートユーザー/ルームへ `renderChatMessage` を Deliver、ルーム招待を `Invite` で送信
- `models/ChatMessage.ts` — `emojis` 追加
- `models/User.ts` — `canChat`（チャット受信可否）
- `packages/backend/migration/1742927188000-migrate-messaging-to-chat.js` ほか

### 絵文字連合
- `core/activitypub/misc/normalize-ap-emoji-tag.ts` — リモート絵文字のライセンス・コピー許可等を正規化
- `core/CustomEmojiService.ts` — `importFrom` 記録、`importEmoji()`（絵文字の窃取）
- `models/Emoji.ts` — `license` / `copyPermission` / `usageInfo` / `description` / `author` / `isBasedOn` / `importFrom`
- `admin/emoji/steal.ts` エンドポイント
- `packages/backend/migration/1735299834220-EmojiInfoFederation.js` / `1738203843000-EmojiInfoFederation2.js`

### クリップ / Flash 連合
- `core/activitypub/models/ApClipService.ts` — リモート Clip の解決・ローカル作成
- `models/ClipFavoriteRemote.ts` / `models/FlashLikeRemote.ts` — リモートのお気に入り/いいねをローカル複製
- `core/ClipService.ts` / `core/FlashService.ts` — `showRemote()` / `myLikesRemote()`
- `packages/backend/migration/1726276463152-ClipFavoriteRemote.js` / `1726452644817-FlashLikeRemote.js` ほか

### 検索可否 (searchableBy)
- `core/activitypub/misc/searchableBy.ts` — AP タグから `searchableBy`（public/followersAndReacted/reactedOnly/private）をパース（kmyblue 互換）
- `models/User.ts` / `models/Note.ts` — `searchableBy` / `isIndexable`
- `packages/backend/migration/1726205819617-AddIsIndexable.js` / `1729457336777-AddSearchable.js`

### その他連合
- `core/activitypub/models/ApOutboxFetchService.ts` + `ap/fetch-outbox.ts` — リモート Outbox のページング取得
- `models/AvatarDecoration.ts` — `remoteId` / `host` / `rawUrl`（リモートアバターデコレーション）
- `admin/avatar-decorations/{copy,list-remote}.ts`
- `models/Instance.ts` — `quarantineLimited` / `reversiVersion`
- ノート `Update` 受信時のローカルノート更新（編集連合）

## 検索・インデックス

### AdvancedSearch (OpenSearch)
- `core/AdvancedSearchService.ts` — OpenSearch による高度な検索（ノート/リアクション/投票/クリップ/お気に入り横断、`FullIndexKind`、進捗の Redis 保存）
- `notes/advanced-search.ts` エンドポイント
- `admin/full-index.ts` / `admin/full-index-progress.ts` / `admin/abort-full-index.ts` / `admin/recreate-index.ts`
- `queue/processors/FullIndexProcessorService.ts`
- 設定: `config.opensearch`、`canAdvancedSearchNotes` ポリシー
- `packages/backend/migration/` の OpenSearch 関連（index / searchable 系）

### バブルタイムライン (BTL)
- `notes/bubble-timeline.ts` / `stream/channels/bubble-timeline.ts`
- `bubbleInstances` メタ設定、`btlAvailable` ポリシー
- `packages/backend/migration/1701647674000-BubbleInstances.js`

## ノート機能

- **ノート編集**: `core/NoteUpdateService.ts` / `notes/update.ts` / `core/NoteHistoryService.ts` / `models/NoteHistory.ts` / `entities/NoteHistoryEntityService.ts` / `canEditNote` ポリシー / `NoteHistory*` migration
- **ノート自動削除**: `queue/processors/AutoDeleteNotesProcessorService.ts` / `i/auto-delete-settings.ts` / `i/update-auto-delete-settings.ts` / `models/User` の `autoDeleteNotesAfterDays` / `autoDeleteKeepFavorites`
- **イベント埋め込み**: `models/Event.ts` / `notes/events/search.ts` / frontend の `MkEvent.vue` / `MkEventEditor.vue` / `search.event.vue`
- **ノート未読**: `models/NoteUnread.ts` / `i/read-all-unread-notes.ts` / `core/NoteReadService.ts`
- **検索可能性 (searchbility)**: `CPSearchbilityPicker.vue` / `rememberNoteSearchbility`
- **アンケート翻訳**: `notes/polls/translate.ts`

## アカウント・ユーザー

- **アカウント整理**: `core/TruncateAccountService.ts` / `i/truncate-account.ts` / `queue/processors/TruncateAccountProcessorService.ts`
- **ユーザーグループ**: `models/UserGroup*.ts` / `users/groups/*` エンドポイント群 / `i/user-group-invites.ts` / frontend `my-groups/*`
- **公式タグ**: `models/OfficialTag.ts` / `official-tags/*` エンドポイント / frontend `official-tags.vue` / `global/MkOfficialTag.vue`
- **相互リンク**: `mutualLinkSections` / `mutualLinkSectionLimit` / `mutualLinkLimit` ポリシー / `packages/backend/migration/1723311628855-mutuallinks.js`
- **ノート自動翻訳**: `canUseAutoTranslate` ポリシー / `useAutoTranslate` / frontend `translate.ts` / `detect-language.ts`（tinyld）
- **ユーザー統計**: `users/stats.ts` / frontend `account-stats.vue`
- **翻訳サービス複数対応**: `translatorType` / `ctav3*`（Cloud Translation v3）/ `libreTranslateEndPoint` / `LibreTranslate` migration
- **IP の DNS 名記録**: `UserIp.dnsNames` / `1746361416550-UserIpsAdddnsNames.js`

## モデレーション・運用

- **通報自動解決**: `models/AbuseReportResolver.ts` / `admin/abuse-report-resolver/*` / `queue/processors/ReportAbuseProcessorService.ts` / frontend `MkAbuseReportResolver.vue`
- **モデレーター活動監視**: `checkModeratorInactive*` migration / `moderatorInactivityLimitDays` / `disableRegistrationWhenInactive` / `disablePublicNoteWhenInactive`
- **外部遷移警告**: `MkUrlWarningDialog.vue` / `trustedLinkUrlPatterns` / `trustedDomains` / `externalNavigationWarning` / `warning-external-website.ts`
- **通報通知メール**: `emailToReceiveAbuseReport` / `doNotSendNotificationEmailsForAbuseReport` / `1691120548582-notification-emails-for-abuse-report.js`
- **相互リンク解除**: `admin/unset-user-mutual-link.ts`
- **招待コード失効**: `admin/invite/revoke.ts`

## 独自パッケージ（置換・追加）

| パッケージ | 用途 | upstream の扱い |
|---|---|---|
| `argon2` | パスワードハッシュ（bcrypt 置換） | yojo-art 固有。維持（脆弱性確認が必要ならユーザーに確認） |
| `mfc-js` | MFM パーサー（mfm-js 置換） | yojo-art 固有。維持 |
| `temml` | 数式レンダリング | yojo-art 固有。維持 |
| `vuedraggable` | ドラッグ&ドロップ | yojo-art 固有。維持 |
| `@opensearch-project/opensearch` | 高度な検索 | yojo-art 固有。維持 |
| `@google-cloud/logging` / `@google-cloud/translate` | Cloud 翻訳・ログ | yojo-art 固有。維持 |
| `@dice-roller/rpg-dice-roller` | ダイスロール | yojo-art 固有。維持 |
| `tinyld` | 言語自動検出 | yojo-art 固有。維持 |
| `js-yaml` (4.3.1) | YAML パース | **脆弱性あり**（upstream は 5.2.2 に更新）。ユーザー確認の上で判断（2026.6.0 時点では見送り） |

バージョン選択の詳細は [../tasks/dependency-version.md](../tasks/dependency-version.md) を参照。

## ブランド・運用

- ブランド表記: `CherryPick` / `yojo-art`（locale の `cherrypick.example.com`、`ClientServerService` の title、package.json の `name` / `codename`）
- `CHANGELOG_YOJO.md` / `CHANGELOG_CHERRYPICK.md` / `CHANGELOG_engawa.md`
- `doc/Advanced-Search.md` / `doc/README.md`
- `opensearch/` / `opensearch-dashboards/` の dockerfile
- 設定: `remoteProxy` / `directSummalyProxy` / `customSplashText` / `customRobotsTxt` / `fetchOutbox` / `checkR18` 等
- 実績（アチーブメント）: `iLoveCherryPick` / `setNameToYojo` / `ohayoujo*` 等

## メタ設定・ポリシー（マージで維持すべき独自キー）

- 翻訳: `translatorType` / `ctav3SaKey/ProjectId/Location/Model/Glossary` / `libreTranslateEndPoint/ApiKey`
- リモートオブジェクトストレージ: `useRemoteObjectStorage` / `remoteObjectStorage*`
- 外部リンク: `trustedLinkUrlPatterns` / `youBlockedImageUrl`
- 管理: `enableReceivePrerelease` / `skipVersion` / `skipCherryPickVersion` / `statusUrl` / `customSplashText` / `customRobotsTxt` / `bubbleInstances`
- ポリシー: `btlAvailable` / `canEditNote` / `canUseAutoTranslate` / `canAdvancedSearchNotes` / `canSetFederationAvatarShape` / `mutualLinkSectionLimit` / `mutualLinkLimit`
- 設定: `opensearch` / `redisForRemoteApis` / `cloudLogging` / `apFileBaseUrl` / `remoteProxy` / `hashtagTrendExcludeBotUsers`
