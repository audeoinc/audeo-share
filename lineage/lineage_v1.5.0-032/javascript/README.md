# JavaScript UDF Package

BigQuery Physical Lineage EngineのJavaScriptソース、生成bundle、回帰試験、BigQuery smoke testを格納します。

## 正式ディレクトリ構成

```text
javascript/
├── src/
│   ├── ast/
│   ├── engine/
│   ├── exporter/
│   ├── lexer/
│   ├── parser/
│   ├── resolver/
│   └── token/
├── build/
│   └── lineage_udf_bundle.js
├── legacy/
│   └── lineage_udf_bundle_v1_5_0_014.js
├── scripts/
│   ├── build_udf.js
│   ├── run_regression.js
│   └── verify_bundle.js
├── test/
│   ├── golden/fixtures/
│   ├── golden/expected/
│   ├── fixtures/
│   ├── expected/
│   └── lib/
├── bigquery/
├── package.json
└── VERSION
```

## ソース復元について

`v1.5.0-014`の確定bundleに含まれる`SOURCE: src/...`境界から、23個のソースを機械的に復元しました。実装内容を推測して書き換えてはいません。責務別ディレクトリへ移動し、`scripts/build_udf.js`が明示的な順序で再結合します。

## 実行

```bash
cd javascript
npm test
```

個別実行:

```bash
npm run build
npm run verify:bundle
npm run test:golden
npm run test:regression
npm run test:release
```

## テスト契約

- Golden fixtureのSQLは`test/golden/fixtures`に配置
- 期待する物理依存は同名の`test/golden/expected/*.json`に配置
- fixtureとexpectedは常に1対1
- 新構文対応では最低1ケースを追加
- 既知の未対応は期待値を曖昧にせず、診断またはknown gapとして明記
- 性能は`performance_contract_v1_5_0_014.json`に対して回帰判定

## Build Everything v1

```bash
cd javascript
npm run build:everything
```

通常実行ではbundle生成、検証、回帰試験、`release_manifest.json`生成、ZIP作成までを行います。
GCSアップロードとBigQuery UDF更新は、`release_config.example.json`を`release_config.json`へコピーして環境値を設定したうえで、明示的に`--deploy`を指定した場合のみ実行します。

```bash
node scripts/build_everything.js --deploy
```

生成物はパッケージの親ディレクトリにある`release/`へ出力されます。
