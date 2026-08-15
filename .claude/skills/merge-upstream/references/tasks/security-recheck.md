# ★ セキュリティ再チェック (security-recheck)

upstream マージの**必須**工程。upstream (misskey-dev/misskey) はセキュリティ修正を **「Merge commit from fork」** という形で取り込むことが多い。マージ時にこの修正がコンフリクト解決で失われる・古いコードに回帰することがあるため、**マージ完了後（コミット前）に必ず再チェックする**。

## なぜ必要か

- upstream のセキュリティ修正の一部はコミットメッセージが「Merge commit from fork」だけ（件名からセキュリティと分からない）
- `git log ... | grep -i security` では検出できない
- マージで yojo-art 実装を優先した際に、upstream のセキュリティ修正が誤って上書き・喪失されるリスクがある

## 手順

### 1. 対象タグと前タグの間の「Merge commit from fork」を列挙

```bash
TAG=<マージ対象タグ>           # 例: 2026.7.0
PREV=$(git tag -l "2026.*" --sort=-version:refname | grep -vE "alpha|beta|rc" | sed -n '2p')

git log --oneline "$PREV".."$TAG" | grep -iE "Merge commit from fork"
```

### 2. 各「Merge commit from fork」の変更ファイルを特定

```bash
git show --name-only --format="" <commit> | grep -E "\.(ts|vue|js)$"
```

### 3. マージ後状態で各修正が維持されているか検証

```bash
git diff HEAD "$TAG" -- <file>
```

- 差分が **0** → マージ後も最新のセキュリティ修正を維持（OK）
- 差分がある → 内容を精査:
  - **セキュリティロジックが維持されている**か確認（`MAX_URL_LENGTH` 制限、認可チェック、URL プロトコル検証等の実体が残っているか）
  - yojo-art 固有の差し替え（argon2 ハッシュ化、環境変数名等）による差分は許容
  - セキュリティ修正が失われている場合は復元する

### 4. 失われた修正の復元

- upstream のセキュリティ修正部分を手動で適用（`git checkout "$TAG" -- <file>` は yojo-art 固有機能を潰す可能性があるため、**手動マージ推奨**）
- 適用後、lint / typecheck で確認（[verifying-build.md](verifying-build.md)）

### 5. コミット前にもう一度再実行

最新の「Merge commit from fork」セキュリティ修正が漏れていないことを、マージコミット作成前に最終確認する。

## 確認済みの具体例 (2026.7.0 時点)

| コミット | 対象ファイル | セキュリティ修正内容 |
|---|---|---|
| `a12ee2e5d7` | `packages/backend/src/server/api/endpoints/fetch-rss.ts` | RSS 取得の URL 長制限 (8192) / レスポンス上限 (1MiB) / 並行リクエスト制限 (32) / レートリミット (300) / in-flight 管理 |
| `1a59ec20e3` | `packages/backend/src/server/api/endpoints/admin/reset-password.ts` | 管理者のパスワードを他人がリセットできない認可チェック (`isAdministrator && me.id !== user.id`) |
| `1a59ec20e3` | `packages/backend/src/server/api/endpoints/admin/unset-mfa.ts` | 管理者の MFA を他人が解除できない認可チェック（※2026.7.0 で新規追加のため、2026.6.0 マージ時点では範囲外） |
| `2509a28813` | `packages/frontend/src/ui/_common_/statusbar-rss.vue` ほか RSS ウィジェット3ファイル | `javascript:` URL インジェクション対策（http/https のみ許可） |

## 注意

- 「Merge commit from fork」が複数ある場合は**全て**チェックする
- deps のセキュリティ修正（Renovate の `[security]` コミット）は [dependency-version.md](dependency-version.md) のバージョン選択で対処し、本手順では「Merge commit from fork」由来のコード修正を重点的に確認する
- ユーザーが「最新バージョンのセキュリティ修正を確認して」と指示した場合も、この手順に従う
