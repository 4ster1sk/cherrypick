## test-federation
Test federation between two Misskey servers: `a.test` and `b.test`.

Before testing, you need to build the entire project, and change working directory to here:
```sh
pnpm build
cd packages/backend/test-federation
```

First, you need to start servers by executing following commands:
```sh
bash ./setup.sh
NODE_VERSION=22 docker compose up --scale tester=0
```

Then you can run all tests by a following command:
```sh
NODE_VERSION=22 docker compose run --no-deps --rm tester
```

For testing a specific file, run a following command:
```sh
NODE_VERSION=22 docker compose run --no-deps --rm tester -- pnpm -F backend test:fed packages/backend/test-federation/test/user.test.ts
```

### AP emoji normalization tests (`#1049`)

Tests under `describe('AP絵文字タグの正規化')` in `test/emoji.test.ts` use the dedicated stub host `z.test`:

- **nginx** (`z.test`): static ActivityPub fixtures (`stub/` — Actor / Note / Emoji 画像)
- **stub-deliver** (`z.test.deliver`): 起動時に生成した `zack` の鍵で `Create` に HTTP Signature を付与し、対象インスタンスの `/inbox` へ配送

テストは `POST https://z.test/deliver` を呼ぶだけで、署名は z.test 側が行う（Misskey / tester 側では署名しない）。

`stub/` には `outbox` / `inbox` / `.well-known/nodeinfo` / `manifest.json` など、b.test がリモートインスタンスとして参照する最小エンドポイントも置いている。Note フィクスチャは `stub/notes/<suite>/` にテストスイートごとに分ける（`#1049` は `stub/notes/ap-emoji-1049/`）。絵文字画像は `stub/emoji/hello_world.png` の 1 枚を共通利用する。

`bash ./setup.sh` で `z.test` の TLS 証明書・`.config/z.test.conf`・`zack` の鍵ペア（`stub/users/zack` / `stub/users/zack-key.json`）を生成する。`z.test.deliver` 起動時にも鍵は再生成される。

### LD署名用の依存調達 (`stub-vendor/`)

`z.test.deliver` は隔離ネットワーク (`internal`) 上にあるため、起動時に npm registry へ到達できない。このため LD 署名に使う `jsonld` (backend 依存と同バージョン) は `setup.sh` がホスト側 (ネットワークあり) で `./stub-vendor/` に前もって install し、`compose.z.yml` で `/app/vendor` にマウントして使う。`stub-vendor/` は生成物のため git 管理外 (`.gitignore` 済み)。

`setup.sh` をネットワークなしで実行した場合、`stub-vendor/` が無い状態になる。この場合 `z.test.deliver` 自体は起動するが、`ld=valid/...` を指定した配送は「`setup.sh` をネットワークありで実行せよ」という明示的エラーで失敗する (`ld=none` の従来配送には影響しない)。
