# UDF Bundle Build Process

> **Implementation baseline:** lineage v1.5.0-029  
> **Target artifact:** `javascript/dist/lineage_udf_bundle.js`

---

## 1. 目的

このドキュメントでは、BigQuery Persistent JavaScript UDFが参照する`lineage_udf_bundle.js`について、次を説明する。

- どのソースファイルから生成されるか
- `build_udf.js`と`build_everything.js`の役割分担
- bundleの検証と回帰試験
- リリースZIPへの格納と、任意のGCS・BigQueryデプロイ
- ソース変更時の標準手順と注意点

## 2. 結論

`lineage_udf_bundle.js`を直接生成するスクリプトは、`javascript/scripts/build_udf.js`である。

`javascript/scripts/build_everything.js`は、`build_udf.js`を最初に呼び出し、bundle検証、回帰試験、リリース成果物の作成、ZIP作成、任意のデプロイを統括する。

```text
javascript/src/*.js
        |
        |  scripts/build_udf.js
        v
javascript/dist/lineage_udf_bundle.js
        |
        |  scripts/verify_bundle.js
        v
bundle verification
        |
        |  scripts/build_everything.js
        v
release/lineage_v<version>/
release/lineage_v<version>.zip
```

したがって、bundleだけを作る場合は`build_udf.js`、通常のリリースを作る場合は`build_everything.js`を利用する。

## 3. Source of Truthとファイル構成

手作業で編集する対象は`javascript/src/`配下のソースだけである。

```text
javascript/
├── src/                         # 手作業で編集するSource of Truth
│   ├── ast/
│   ├── diagnostics/
│   ├── engine/
│   ├── exporter/
│   ├── lexer/
│   ├── parser/
│   ├── resolver/
│   └── token/
├── dist/
│   └── lineage_udf_bundle.js    # build_udf.jsが生成する成果物
├── scripts/
│   ├── build_udf.js             # bundleを直接生成する
│   ├── verify_bundle.js         # 生成bundleを検証する
│   ├── run_regression.js        # Golden regressionを実行する
│   └── build_everything.js      # リリース全体を統括する
├── test/                        # Golden、release、性能回帰試験
├── VERSION                      # リリースバージョンのSource of Truth
└── package.json
```

`dist/lineage_udf_bundle.js`は生成物である。直接編集してはいけない。次回のbuildで`javascript/src/`から再生成され、直接の変更は失われる。

## 4. bundleを直接生成する`build_udf.js`

### 4.1 処理内容

`build_udf.js`は、`buildOrder`に定義された順序でJavaScriptソースを読み込み、1つのbundleへ連結する。

現在の実装では、Lexer、Token Reader、Parser、AstFactory、Resolver、Diagnostic Engine、Exporter、Lineage Engineを含む24個のソースファイルを連結する。

```text
src/ast/ast_factory.js
src/exporter/bigquery_exporter.js
src/token/token_reader.js
...
src/engine/lineage_engine.js
        ↓
dist/lineage_udf_bundle.js
```

出力ファイルには、自動生成物であることを示すヘッダーと、各ソースの境界を示す`SOURCE:`コメントが付加される。

```javascript
/**
 * AUTO-GENERATED FILE.
 * scripts/build_udf.jsから生成されるため、直接編集しない。
 */

// SOURCE: src/ast_factory.js
```

### 4.2 明示的な連結順序を使う理由

このプロジェクトのbundle生成は、esbuildやwebpackによる変換・minifyではない。`buildOrder`で指定した順にソースを連結する方式である。

BigQuery JavaScript UDFでは、bundleを外部ライブラリとして読み込む。そのため、クラス、定数、関数が参照される前に定義されるよう、依存関係を考慮して順序を固定している。

`buildOrder`を変更する場合は、参照先が先に評価されることを確認し、bundle検証とrelease regressionを必ず実行する。

### 4.3 実行方法

`javascript/`ディレクトリで実行する。

```bash
npm run build
```

このコマンドは、次と同じである。

```bash
node scripts/build_udf.js
```

成功すると、次のファイルが更新される。

```text
javascript/dist/lineage_udf_bundle.js
```

## 5. 生成bundleを検証する`verify_bundle.js`

`verify_bundle.js`は、生成されたbundleが存在し、必要なAPIを公開し、最小限の解析を完了できることを検証する。

検証内容は次のとおりである。

| 確認項目 | 内容 |
|---|---|
| bundle存在確認 | `dist/lineage_udf_bundle.js`が生成されていること |
| 公開API | `LineageEngine`と`analyzeLineageForBigQuery`が関数として公開されていること |
| Smoke Analysis | 簡単なSELECT式と物理カラムMetadataを入力し、解析結果を取得できること |
| Export結果 | `analysis_status`が`COMPLETED`となること |

実行コマンドは次のとおりである。

```bash
npm run verify:bundle
```

bundleを生成した後、少なくともこの検証を実行する。

## 6. リリースを統括する`build_everything.js`

### 6.1 標準フロー

`build_everything.js`は、`VERSION`を読み込み、次の順序でリリース成果物を作成する。

| 段階 | 処理 | 主な成果物・確認 |
|---:|---|---|
| 1 | bundle生成とbundle検証 | `javascript/dist/lineage_udf_bundle.js` |
| 2 | release regression | Golden、bundle、性能などの回帰試験 |
| 3 | リリースディレクトリをstage | `release/lineage_v<version>/` |
| 4 | `release_manifest.json`を生成 | bundleのSHA-256、サイズ、試験結果 |
| 5 | リリースZIPを生成 | `release/lineage_v<version>.zip` |
| 6 | 任意のGCSアップロード | `--deploy`指定時だけ実行 |
| 7 | 任意のPersistent UDF更新 | `--deploy`指定時だけ実行 |

デフォルトでは、GCSアップロードとBigQuery UDF更新は行わない。

```bash
npm run build:everything
```

このコマンドは、次と同じである。

```bash
node scripts/build_everything.js
```

### 6.2 リリース成果物

バージョンが`1.5.0-029`の場合、生成先は次のとおりである。

```text
release/
├── lineage_v1.5.0-029/
│   ├── javascript/dist/lineage_udf_bundle.js
│   ├── docs/UDF_BUNDLE_BUILD_PROCESS.md
│   └── release_manifest.json
└── lineage_v1.5.0-029.zip
```

`release_manifest.json`には、bundleの相対パス、SHA-256、サイズ、実行した試験数、リリース名、ZIP名を記録する。bundleとZIPの対応関係を確認するための機械可読な記録として利用する。

### 6.3 `--skip-tests`

`--skip-tests`を指定すると、release regressionを省略できる。

```bash
node scripts/build_everything.js --skip-tests
```

これはローカルでの生成確認など、限定した用途にだけ用いる。配布するリリースZIPを作る場合は、`--skip-tests`を使わずに回帰試験を実行する。

## 7. 任意のデプロイ

GCSへのbundle・ZIPのアップロードとPersistent UDFの更新を行う場合だけ、`--deploy`を指定する。

```bash
node scripts/build_everything.js --deploy
```

`--deploy`には`javascript/release_config.json`が必要である。設定ファイルには、BigQueryのProject ID、Dataset、Function名、GCS上のbundle URI、GCS上のZIP URIを設定する。

`build_everything.js`は、設定されたbundle URIを参照するPersistent UDFの`CREATE OR REPLACE FUNCTION` SQLをリリースディレクトリへ生成する。その後、bundleとZIPをGCSへ配置し、`bq query`でPersistent UDFを更新する。

通常のローカルbuildやrelease ZIP作成では`--deploy`を付けない。これにより、検証・配布用の生成と本番環境への反映を明確に分離する。

## 8. ソース変更からリリースまでの標準手順

1. `javascript/src/`配下の対象モジュールを編集する
2. 必要に応じてGolden fixture・expected JSON・release testを追加または更新する
3. `npm run build`でbundleを再生成する
4. `npm run verify:bundle`で公開APIとSmoke Analysisを確認する
5. `npm run test:release`で回帰試験を実行する
6. `javascript/VERSION`と`package.json`のバージョンを更新する
7. `CHANGELOG.md`と必要な設計・運用ドキュメントを更新する
8. `npm run build:everything`でstage済みreleaseとZIPを生成する
9. `release_manifest.json`のbundle SHA-256、サイズ、試験結果を確認する
10. デプロイが必要な場合だけ、設定を確認して`--deploy`を実行する

バージョンはrelease生成の前に更新する。`build_everything.js`は`javascript/VERSION`を読み、リリースディレクトリ名、ZIP名、manifestのversionを決定するためである。

## 9. 注意点とよくある誤り

| 事象 | 原因 | 対応 |
|---|---|---|
| bundleへの直接修正が消えた | `dist/`は生成物であり、buildで上書きされる | `src/`を修正して再buildする |
| bundle生成後に参照エラーが出る | `buildOrder`とモジュール間の依存順序が不整合 | 順序を見直し、bundle検証とrelease regressionを実行する |
| `--deploy`が失敗する | `release_config.json`がない、または環境値が不正 | 設定ファイルとGCS・BigQuery権限を確認する |
| ZIPとbundleの対応が不明 | 手作業で成果物を混在させた | `release_manifest.json`のversion、SHA-256、sizeを確認する |
| 試験なしで配布した | `--skip-tests`を配布用releaseで使用した | 試験を有効にしてreleaseを再生成する |

## 10. 設計方針との対応

このbuildプロセスは、次の設計方針を実現する。

| 設計方針 | buildプロセスでの実現方法 |
|---|---|
| Single Source of Truth | 手作業で編集するのは`javascript/src/`であり、bundleはそこから生成する |
| Build Everything | bundle生成、検証、回帰試験、stage、manifest、ZIPを1コマンドで実行する |
| Policy Centralization | Diagnostic Engineをbundleへ一貫して含め、同じ実装を試験・配布する |
| Small, Focused Modules | Lexer、Parser、Resolverなどの責務別モジュールを、明示的な順序でbundleへ統合する |

---

## 関連ファイル

- `javascript/scripts/build_udf.js`
- `javascript/scripts/verify_bundle.js`
- `javascript/scripts/build_everything.js`
- `javascript/package.json`
- `javascript/VERSION`
- `javascript/release_config.example.json`
- `release/lineage_v<version>/release_manifest.json`
