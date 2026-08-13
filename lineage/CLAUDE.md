# CLAUDE.md — プロジェクト作業ガイド（Claude Code 自動読込用）

このファイルは Claude Code がセッション開始時に自動で読み込みます。ここに書かれた
方針・コマンド・規約に従って作業してください。会話の記憶は引き継がれないため、
「これまでの経緯」は本ファイル・`CHANGELOG.md`・`docs/SESSION_HANDOFF.md` から把握します。

## 1. プロジェクト概要

BigQuery のカラムレベル・リネージ（列単位の依存関係）解析システム。現行バージョン
**1.5.0-032**。SQL を解析して「出力列 ← 物理テーブル.物理列」の依存を導出する
JavaScript エンジンと、それを日次で回す BigQuery パイプライン SQL 一式で構成される。

- エンジン本体: `javascript/src`（Lexer → Parser → Resolver → Exporter/Diagnostics）
- デプロイ成果物: `javascript/dist/lineage_udf_bundle.js`（24 ソースを束ねた単一バンドル）
- パイプライン SQL: `sql/setup/01_*`, `sql/pipeline/03_*`, `sql/validation/04_*`, `tests/integration/05_*`
- 設計資料: `docs/`（ARCHITECTURE / SYSTEM_DESIGN / SQL_DESIGN / UDF_DESIGN / SUPPORTED_SQL、ADR は `docs/adr/`）

## 2. エンジン構成（javascript/src）

`lexer/` → `parser/`（query / from / select / clause / expression）→
`resolver/`（source / column / output_column / physical_column / lineage / impact）→
`exporter/` + `diagnostics/`。エントリは `engine/lineage_engine.js`：

- `analyzeLineageForBigQuery(sql, physicalColumnsJson, optionsJson, exportMetadataJson)` — 主解析
- `discoverPhysicalSourcesForBigQuery(...)` — 物理ソース探索
- `fingerprintSqlForBigQuery(sqlText)` — SQL 正規化フィンガープリント（JOBS 重複除去用）
- `module.exports`: 上記 + `LineageEngine`, `BigQueryExporter`

ポイント：`ColumnResolver` は物理スキーマを持たない段階での名前解決、`PhysicalColumnResolver`
が physicalColumnsJson の実メタデータで最終解決する二段構え。非修飾列は
`ColumnResolver` が候補ソースを絞り、`PhysicalColumnResolver` が実列で曖昧性を解消する。

## 3. ビルドとテスト（すべて `javascript/` 配下、オフラインで完結。実 BigQuery 不要）

```
cd javascript
node scripts/build_udf.js       # src → dist/lineage_udf_bundle.js を再生成
node scripts/verify_bundle.js   # バンドルの API とスモーク解析を検証
npm run test:release            # リリース回帰（28 本、test_v1_5_0_048 … 014）
node test/test_v1_5_0_003.js    # ゴールデン回帰（48 ケース）
npm test                        # build + verify:bundle + test:release を一括
```

**エンジン（`src/`）を変更したら必ず：** `build_udf.js` で再ビルド → 全テスト →
`release_manifest.json` の `sha256` / `size_bytes` を更新 → GCS の
`lineage_udf_bundle.js` を再アップロード（SQL 変更は不要）。バンドルはリポジトリ内の
`release_manifest.json` でハッシュ追跡している。

## 4. 変更時の必須手順（重要）

1 変更 = 「実装 + 番号付き回帰テスト + CHANGELOG 追記」をワンセットにする。

- 回帰テストは `javascript/test/test_v1_5_0_0XX.js` を新規作成し、`package.json` の
  `test:release` チェーンの先頭に追加する（番号は連番、現行最新は 048）。
- `CHANGELOG.md` の現行バージョン見出し直下に、症状・原因・修正・対象テストを追記。
- 詳細な変更手順・単位は `docs/DEVELOPMENT_GUIDE.md` に従う。

## 5. 二本ツリー運用

作業ツリー `lineage_v1.5.0-031`（source of truth）と成果物ツリー
`lineage_v1.5.0-032`（deliverable）を **常に同一内容** に保つ。片方に入れた変更は
必ずもう片方へ反映し、`diff -rq`（node_modules / *.zip / .git 除外）で一致を確認する。
※ 単一リポジトリで運用する場合は、このセクションは「main で一元管理」に読み替えてよい。

## 6. コーディング規約・環境固有の注意

- **識別子は匿名化を維持**：実プロジェクト/データセット名は使わず `project_id` /
  `dataset` を使う（自社環境を特定させないためのセキュリティ方針）。共有コードでは崩さない。
- **JS 規約**：`docs/DEVELOPMENT_GUIDE.md` 参照（1 `const` 1 行、AstFactory 経由で
  AST 生成、条件式は意味ある変数に分解、等）。
- **GoogleSQL の落とし穴（学習済み）**：
  - `''` はエスケープではなく「隣接する 2 つの文字列リテラル」→ パースエラー。単一
    引用符のエスケープは `\'`。
  - STRUCT リテラル内の空配列は要素型が推論できない → `CAST([] AS ARRAY<STRING>)`。
    `DECLARE x ARRAY<STRING> DEFAULT []` は可。
  - `OFFSET` / `ORDINAL` は予約キーワード、`SAFE_OFFSET` / `SAFE_ORDINAL` は識別子。
  - 名前フィルタの正規表現は大文字小文字を無視：`REGEXP_CONTAINS(LOWER(name), LOWER(pattern))`。
- **03 パイプラインの構造**：`render_dynamic_sql` TEMP FUNCTION（8 プレースホルダ /
  9 パラメータ）でテンプレート置換 → `EXECUTE IMMEDIATE`。STEP1=VIEW 収集、
  STEP2=JOBS 収集、STEP3/4=解析。region は単一の `job_region`（`@@location`）。
  JOBS の重複除去はフィンガープリント方式（一時/ローテーション/期限付き宛先は
  代表 1 件に集約、永続宛先は宛先ごとに保持）。ephemeral 判定＝宛先が実在し、かつ
  テーブル expiration が無いもの以外。

## 7. 現在地

- バンドル: `sha256 = 0a31b8c9a86faae55f8108e94b7a237906add0e96da6cd6b823f026371a8e3c5`、`441569` bytes
- `test:release` 41 本 PASS / ゴールデン 48 ケース PASS
- 直近の修正: 03 の**2つのUDFパス**（ソース探索 `discovery_udf_chunk_size` / STEP 3 解析
  `analysis_udf_chunk_size`、各既定200件ずつ INSERT ループ）をチャンク分割し、対象増加時の
  "UDF out of memory"（スロット上の V8 ヒープ蓄積）を回避。STEP 3 のみのチャンクでは探索パスが
  未分割で残りOOM継続 → 探索も分割。SQLのみ・バンドル不変・BigQuery 未検証。詳細は
  `docs/SESSION_HANDOFF.md` と `CHANGELOG.md` 冒頭。
