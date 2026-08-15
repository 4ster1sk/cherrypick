# ビルド・テスト検証 (verifying-build)

マージ後の検証手順。コンフリクト解決が正しいことを lint / build / typecheck / migration / テストで確認する。

## 前提: Node / pnpm 環境

このリポジトリは `packageManager: pnpm@11.x` を使う。nvm 環境では:

```bash
export NVM_DIR="$HOME/.nvm" && \. "$NVM_DIR/nvm.sh"
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
```

`packageManager` とインストール済み pnpm が一致しないとエラーになる（例: packageManager `pnpm@11.5.3` なのに `pnpm@11.5.2` が動く）。`packageManager` を devDeps の `pnpm` バージョンに揃えること。

## 1. 依存インストール

```bash
pnpm install
```

## 2. lint (typecheck + eslint)

```bash
# パッケージ単位
pnpm --filter backend lint
pnpm --filter frontend lint
pnpm --filter frontend-shared lint
pnpm --filter sw lint
pnpm --filter misskey-js lint
```

- frontend はメモリ不足 (OOM) になりがち → `NODE_OPTIONS="--max-old-space-size=8192"` を付ける
- **frontend-embed の typecheck は CI でも対象外**（tsgo の lib.dom / lib.webworker 衝突が環境依存で発生）。eslint のみ CI で実行されるため、typecheck 失敗は環境固有と判断してよい

## 3. ビルド

```bash
pnpm build
# または個別に
pnpm --filter backend build
NODE_OPTIONS="--max-old-space-size=8192" pnpm --filter frontend build
```

## 4. 型定義 (d.ts) の再生成が必要なパッケージ

`NODE_ENV=production` だと d.ts が生成されない。開発モードでビルドする必要がある:

```bash
# i18n (locale.ts を ja-JP.yml から再生成してから)
cd packages/i18n && pnpm generate
cd packages/i18n && NODE_ENV=development pnpm build

# misskey-js (backend API 変更時は autogen 再生成も)
cd packages/misskey-js && PATH="$PWD/node_modules/.bin:$PWD/../../node_modules/.bin:$PATH" NODE_ENV=development node build.js

# misskey-reversi / misskey-bubble-game
cd packages/misskey-reversi && PATH="$PWD/node_modules/.bin:$PWD/../../node_modules/.bin:$PATH" NODE_ENV=development node build.js
```

- `tsgo` が PATH に無いと d.ts 生成が `spawn tsgo ENOENT` で失敗するため、`node_modules/.bin` を PATH に含める
- backend API の `meta` / `paramDef` / `res` を変更した場合は `pnpm build-misskey-js-with-types` を実行し、`packages/misskey-js/src/autogen/` の差分をコミットに含める

## 5. migration 検査

```bash
pnpm --filter backend check-migrations
# 期待: "All migrations are clean."
```

- テスト用 DB (PostgreSQL) が必要。停止していれば起動:
  ```bash
  docker compose -f packages/backend/test/compose.yml up -d
  ```
- 新規 migration は `up()` と `down()` の両方を実装する
- マージ済み migration は編集しない（新規ファイルで対応）

## 6. backend ユニットテスト

`.config/test.yml` が必要（`ncp .github/misskey/test.yml .config/test.yml`）。DB / Redis / Meilisearch コンテナを起動してから:

```bash
docker compose -f packages/backend/test/compose.yml up -d
pnpm --filter backend test
```

- **OpenSearch テストはスキップ**: `.config/test.yml` の `fulltextSearch.provider` を `sqlLike` にするか、`--testNamePattern` で除外する（テストファイル自体は変更しない）
- **meilisearch テストもスキップ**: `--testNamePattern` で除外
- テスト実行時の NODE_ENV 問題（並列実行で `NODE_ENV is not a test`）は環境依存で、単独実行で通ることを確認すれば良い
- ffprobe / ffmpeg が無い環境では FileInfoService の一部テスト（M4A / WEBM の mime 判定）が失敗するが、環境依存

## 7. 最終確認

```bash
git status --short
# conflict マーカーが残っていないこと
grep -rln "<<<<<<< HEAD" packages/ locales/ 2>/dev/null | head
```
