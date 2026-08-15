# コンフリクト解決 (resolving-conflicts)

upstream マージ時のコンフリクト解決の判断ルール。**基本方針は「yojo-art の機能を優先し、upstream の新機能は取り込む」**。

## 基本方針

1. **yojo-art 固有機能は優先維持**（回帰させない）
   - どのファイルが yojo-art 固有かは [../knowledge/yojo-art-features.md](../knowledge/yojo-art-features.md) を参照
   - upstream が yojo-art の機能を置き換える形の変更をしていても、**yojo-art 実装を維持**する
2. **upstream の新機能・新ファイルは取り込む**
   - 新規エンドポイント、新規モデル、新規 UI、CI 改善等は追加する
3. **両者の変更が共存できる場合は両方取る**
   - 例: yojo-art の独自チェック + upstream の新チェックを両方維持
4. **typeorm 形式変換**（upstream が typeorm をメジャーアップグレードした場合）
   - `find({ select: [...] })` / `relations: [...]` の配列形式 → object 形式に変換
   - 例: `select: ['followerId']` → `select: { followerId: true }`
   - 注意: **query builder 内の `.select([...])` は変換不要**（typeorm 1.x でも有効）

## ファイル種別ごとの解決方針

### backend ソース (`packages/backend/src/`)

- **yojo-art 固有サービス / 連合機能** → yojo-art 実装を維持
  - 例: `ChannelFollowingService`（followingsRepository 方式）、`ChannelMutingService`（期限付きミュート）、`ReversiService`（federationId）、`NoteCreateService`（channel.actorId ベース配送）
  - upstream が「削除済みのモデルを使う実装」に書き換えていても、**yojo-art のモデル構成に合わせる**（例: `ChannelFollowing` モデルは yojo-art では削除済みなので `channelFollowingsRepository` は使わない）
- **upstream の新規エンドポイント / モデル** → そのまま取り込む
- **OAuth2 のような upstream の大規模リライト** → upstream 実装を採用しつつ、yojo-art 固有の変更（環境変数名等）は維持
  - 例: OAuth2ProviderService は oauth2orize 廃止リライトを採用、`CHERRYPICK_TEST_CHECK_IP_RANGE` の環境変数名だけ維持

### locale (`locales/*.yml`)

- **本プロジェクトは Crowdin 未導入**。ja-JP.yml 以外の locale も通常のマージ対象として扱う（Crowdin 自動配信の制約はない）
- yojo-art のブランド表記（`CherryPick` / `cherrypick.example.com`）は維持しつつ、upstream の新規キーは追加する
- 例: `serverHostPlaceholder: "例: cherrypick.example.com"` を維持しつつ、upstream の新キー `postFrom` / `postTo` を追加
- 同一キーで翻訳が競合する場合は yojo-art 表記を優先

### ドキュメント・ハーネス (`.claude/`, `.agents/`, `AGENTS.md`, `.gitignore`)

- yojo-art 独自のファイル（`.claude/commands/changelog-add.md` 等、upstream に存在しないもの）は維持
- upstream が追加した新規ドキュメントは取り込む
- upstream が削除した yojo-art 独自ファイルは復元（`git checkout develop -- <path>`）

### package.json / lock 系

- [dependency-version.md](dependency-version.md) を参照

## よくある判断パターン（実績）

| 状況 | 判断 |
|---|---|
| upstream が `ChannelFollowingService` を `channelFollowingsRepository` 使用に変更 | yojo-art の followingsRepository 方式を維持（モデルが存在しないため） |
| upstream が `ReversiService` の `relations` を形式変換 | 変換を適用、`federationId`（yojo-art 機能）は維持 |
| upstream が OAuth2 を oauth2orize 廃止でリライト | upstream 実装を採用、環境変数名のみ yojo-art 仕様 |
| upstream が `admin/reset-password` に認可チェック追加 | upstream の認可チェック + yojo-art の root 保護・argon2 を両方維持 |
| upstream が RSS ウィジェットに javascript: URL 除外追加 | そのまま取り込む（セキュリティ修正） |

## 注意

- **テストファイルはユーザーが明示しない限り変更しない**（テストコードの改変は避ける）
- コンフリクト解決後、全ファイルから conflict マーカー（`<<<<<<<` / `=======` / `>>>>>>>`）が残っていないことを確認:
  ```bash
  grep -rln "<<<<<<< HEAD\|>>>>>>> 2026.6.0" packages/ locales/ | head
  ```
