# リポジトリ構成 (merge-repo-map)

yojo-art/cherrypick のリモート・ブランチ構成と、マージに関わる運用メモ。

## リモート

| リモート | URL | 用途 |
|---|---|---|
| `origin` | https://github.com/yojo-art/cherrypick.git | メイン (yojo-art) |
| `upstream` | https://github.com/misskey-dev/misskey.git | 上流 (Misskey)。マージ元 |
| `kozakura` | https://github.com/kozakura913/yojo-art.git | 関連フォーク |
| `4sterisk` | https://github.com/4ster1sk/misskey.git | 関連フォーク |

## ブランチ構成

- `develop` — メイン開発ブランチ
- `master` — リリースブランチ
- `merge_YYYY_M_P_by_ai` — **upstream マージ用 WIP ブランチ**（例: `merge_2026_6_0_by_ai`）。`_wip` ではなく `_by_ai`
- 過去の例: `merge_2026_5_4_by_ai` / `merge_2026_5_4_wip` / `kozakura/merge_2026_3_2_wip` / `kozakura/merge_2025_12_2_wip`

## マージ履歴

| マージ対象 | コミット | 備考 |
|---|---|---|
| 2026.6.0 | `Merge 2026.6.0 into develop` | 168 ファイル変更。49 コンフリクト解決 |
| 2026.5.4 | `Merge 2026.5.4 into develop` | |
| 2026.3.2 | `Merge 2026.3.2 (#1259)` | |

## バージョン管理

- ルート `package.json`: `name: yojo-art` / `version: 1.9.0` / `basedCherrypickVersion: 4.17.0` / `basedMisskeyVersion: <マージ対象>` / `codename: tonjiru`
- `basedMisskeyVersion` はマージごとに更新する（例: `2026.5.4` → `2026.6.0`）
- `packageManager`: devDeps の `pnpm` と揃える（sha512 付きの長い形式は使わない）
- SDK: `packages/misskey-js/package.json`（`name: misskey-js`、version はルートと揃える）

## マージの出口

- マージ完了後は [../tasks/security-recheck.md](../tasks/security-recheck.md) を必ず実行
- 最終チェックは [shipping-misskey-change](../../../shipping-misskey-change/SKILL.md)
- コミットはユーザーの指示があるまで行わない（ただしマージ指示があればマージコミットを作成）
- gpg 署名鍵がない環境では `git commit --no-gpg-sign` を使う
