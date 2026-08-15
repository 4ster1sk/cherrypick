# 事前準備 (preparing-merge)

upstream マージを開始する前の準備手順。マージ対象のタグを正確に特定し、WIP ブランチを作成してから `git merge` を開始する。

## 1. upstream の最新タグを取得

```bash
git fetch upstream --tags
```

## 2. マージ対象タグの特定

最新の安定タグ（alpha / beta / rc を除外）を選ぶ:

```bash
git tag -l "2026.*" --sort=-version:refname | grep -vE "alpha|beta|rc" | head -1
```

例: `2026.7.0`。ユーザーが明示的にタグを指定した場合はそれに従う（例: `2026.6.0`）。

## 3. マージ範囲の把握

対象タグと直前タグの間で何が変わったかを事前確認する:

```bash
# 直前の安定タグ
PREV=$(git tag -l "2026.*" --sort=-version:refname | grep -vE "alpha|beta|rc" | sed -n '2p')
# 変更ファイル数
git diff --name-only "$PREV" <tag> | wc -l
# セキュリティ修正 (Merge commit from fork) の有無
git log --oneline "$PREV"..<tag> | grep -iE "Merge commit from fork"
```

- 変更が大きい場合（数百ファイル）は、コンフリクト解決に時間がかかる想定をする
- 「Merge commit from fork」がある場合、**マージ完了後の security-recheck が必須**（[security-recheck.md](security-recheck.md)）

## 4. WIP ブランチ作成

命名規則: `merge_YYYY_M_P_by_ai`（例: `2026.6.0` → `merge_2026_6_0_by_ai`）。

**`_wip` ではなく `_by_ai` を使用する**（実績ブランチ名に合わせる）。

```bash
git checkout -b merge_2026_6_0_by_ai
```

ベースにするブランチは通常 `develop`（または直前のマージブランチの続き）。

## 5. マージ開始

コンフリクトを確認しながら解決するため、コミットせずにマージを開始する:

```bash
git merge --no-commit --no-ff 2026.6.0
```

- `--no-ff`: マージコミットを常に作成（履歴を明示的に残す）
- `--no-commit`: コンフリクト解決後に手動でコミットするため、いきなりコミットさせない

## 6. コンフリクト一覧の把握

```bash
git diff --name-only --diff-filter=U
```

コンフリクトの分類（種類ごとに解決方針が異なる）:
- `packages/backend/src/**`: コード（[resolving-conflicts.md](resolving-conflicts.md) の判断ルールを適用）
- `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`: 依存（[dependency-version.md](dependency-version.md)）
- `locales/*.yml`: 翻訳（[resolving-conflicts.md](resolving-conflicts.md) の locale 節）
- `.claude/` / `.agents/` / `AGENTS.md` / `.gitignore`: ドキュメント・ハーネス（yojo-art 独自分は維持）

## 参考: 実績

- 2026.6.0 マージ: 49 ファイルのコンフリクトを解決、168 ファイルを変更してコミット (`Merge 2026.6.0 into develop`)
- ブランチ: `merge_2026_6_0_by_ai`
