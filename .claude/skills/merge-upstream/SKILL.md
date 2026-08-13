---
name: merge-upstream
description: Use whenever merging upstream Misskey releases (e.g. `2026.6.0`, `2026.7.0`) into the yojo-art/cherrypick fork. Covers WIP branch naming, conflict resolution policy (yojo-art features first, upstream additions included), dependency version selection (higher version wins, but ask the user before keeping a vulnerable yojo-art package), locale resolution (no Crowdin constraint), build/test verification, and the mandatory post-merge security re-check of upstream "Merge commit from fork" commits. Must be consulted before starting any upstream merge to avoid regressing yojo-art federation features and security fixes.
---

# merge-upstream

yojo-art/cherrypick に upstream (misskey-dev/misskey) のリリースをマージするときに最初に参照するスキル。

upstream の新機能は取り込みつつ、**yojo-art 独自機能（チャンネル連合・リバーシ連合・検索・モデレーション等）を回帰させない**ための判断ルールと手順をまとめている。

SKILL.md 本体は references への索引だけ。具体的な手順は該当ファイルを Read すること (progressive disclosure)。

## 前提: リポジトリ構成

- `upstream` = misskey-dev/misskey、`origin` = yojo-art/cherrypick（詳細は [references/knowledge/merge-repo-map.md](references/knowledge/merge-repo-map.md)）
- マージ対象は upstream のリリースタグ（例: `2026.6.0`）
- マージブランチ命名: `merge_YYYY_M_P_by_ai`（例: `merge_2026_6_0_by_ai`。`_wip` ではない）

## 全体フロー

1. **事前準備** → [references/tasks/preparing-merge.md](references/tasks/preparing-merge.md)
   - `git fetch upstream --tags`、対象タグの特定、WIP ブランチ作成、`git merge --no-commit --no-ff <tag>` 開始
2. **コンフリクト解決** → [references/tasks/resolving-conflicts.md](references/tasks/resolving-conflicts.md)
   - yojo-art 固有機能は優先維持 / upstream の新機能は取り込み / typeorm 形式変換 / locale 解決
3. **依存バージョン選択** → [references/tasks/dependency-version.md](references/tasks/dependency-version.md)
   - バージョンが上がっているものは高い方を採用 / yojo-art 固有パッケージは基本維持（脆弱性はユーザー確認）/ pnpm override
4. **ビルド・テスト検証** → [references/tasks/verifying-build.md](references/tasks/verifying-build.md)
   - lint / build / typecheck / misskey-js 再生成 / check-migrations / テスト（OpenSearch・meilisearch はスキップ）
5. **★ セキュリティ再チェック** → [references/tasks/security-recheck.md](references/tasks/security-recheck.md)
   - upstream はセキュリティ修正を **「Merge commit from fork」** で行うため、マージ完了後に必ず再チェック
   - 対象タグと前タグ間の「Merge commit from fork」を列挙し、各修正がマージ後も維持されているか検証
6. **最終確認・コミット**
   - [shipping-misskey-change](../shipping-misskey-change/SKILL.md) で最終チェック
   - コミット前に security-recheck を再実行（漏れがないか）
   - マージコミット作成（gpg 鍵なし環境では `--no-gpg-sign`）

## 作業別ワークフロー (tasks)

- 事前準備（タグ取得・ブランチ作成・マージ開始） → [references/tasks/preparing-merge.md](references/tasks/preparing-merge.md)
- コンフリクト解決（yojo-art 機能優先の判断ルール） → [references/tasks/resolving-conflicts.md](references/tasks/resolving-conflicts.md)
- 依存バージョン選択 → [references/tasks/dependency-version.md](references/tasks/dependency-version.md)
- ビルド・テスト・lint 検証 → [references/tasks/verifying-build.md](references/tasks/verifying-build.md)
- セキュリティ再チェック（Merge commit from fork） → [references/tasks/security-recheck.md](references/tasks/security-recheck.md)

## 共通知識 (knowledge)

- yojo-art 独自機能の完全一覧（マージで回帰させてはいけないもの） → [references/knowledge/yojo-art-features.md](references/knowledge/yojo-art-features.md)
- リモート / ブランチ構成 → [references/knowledge/merge-repo-map.md](references/knowledge/merge-repo-map.md)
