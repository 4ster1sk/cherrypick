# 依存バージョン選択 (dependency-version)

upstream マージ時の package.json / lockfile コンフリクト解決方針。

## 基本方針

1. **バージョンが上がっているものは高い方を採用する**
   - upstream と yojo-art でバージョンが競合したら、数値が大きい方を選ぶ
   - 例: mediabunny `1.44.1` vs `1.46.0` → `1.46.0`、nsfwjs `4.2.0` vs `4.3.0` → `4.3.0`
2. **yojo-art 固有の置換パッケージは基本維持する**（upstream に存在しないもの）
   - パッケージの置換は yojo-art の機能に直結するため、単純に upstream へ合わせない
   - 一覧: [../knowledge/yojo-art-features.md](../knowledge/yojo-art-features.md) の「独自パッケージ」節
3. **★ 脆弱性がある yojo-art 固有パッケージはユーザーに都度確認する**
   - 「基本維持」とはいえ、セキュリティ修正（CVE）が upstream で提供されている場合は、**ユーザーに確認してから**維持するかアップグレードするか決める
   - 実績:
     - typeorm: CVE 修正版 `1.1.0` を**適用**（パッチリリースで影響小 → ユーザー確認の上で適用）
     - js-yaml: upstream は `5.2.2`（セキュリティ修正）だが yojo-art は `4.3.1` を維持。メジャーアップグレード（4→5）でコード影響が大きいため**ユーザー確認の上で見送り**

## package.json の更新ポイント

- `basedMisskeyVersion`: マージ対象タグに更新（例: `2026.5.4` → `2026.6.0`）
- `packageManager`: ルート devDependencies の `pnpm` と揃える
  - 例: devDeps `pnpm: 11.5.3` なら `packageManager: pnpm@11.5.3`（sha512 付きの長い形式は使わない）
- パッケージメタデータ（`name` / `version` / `codename` / `repository`）は yojo-art のものを維持

## 型エラー回避のための pnpm override

依存が複数バージョンに分裂して型エラーになる場合は、`pnpm-workspace.yaml` の `overrides` で統一する。

- 実績: ioredis
  - backend が `5.11.1` を使い、bullmq が `5.10.1` を固定依存 → 型エラー（`Redis` 型不整合）
  - `overrides` に `ioredis: 5.11.1` を追加して統一
  - その後 `pnpm install` で lockfile 更新

```yaml
overrides:
  ioredis: 5.11.1
```

## セキュリティ修正 deps の適用

- upstream が `[security]` コミット（Renovate の CVE 修正）でパッケージを更新している場合、**バージョン差分を確認して適用する**
- メジャーアップグレード（4→5 等）でコード影響が大きいものはユーザーに確認
- パッチ / マイナーアップグレードで影響が小さいものは適用
- `pnpm-workspace.yaml` の `minimumReleaseAgeExclude` にセキュリティ修正パッケージを追加して、Renovate の遅延を回避する（実績: typeorm）

## 手順

1. コンフリクトを解決した package.json 群（ルート + 各パッケージ）を確認
2. `pnpm install --lockfile-only --fix-lockfile` で lockfile を再生成
3. `pnpm install` で node_modules 更新
4. typecheck / build で整合性検証（[verifying-build.md](verifying-build.md)）
