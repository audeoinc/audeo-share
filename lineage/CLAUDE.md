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
npm run test:release            # リリース回帰（41 本、test_v1_5_0_061 … 014）
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
  `test:release` チェーンの先頭に追加する（番号は連番、現行最新は 061）。
- `CHANGELOG.md` の現行バージョン見出し直下に、症状・原因・修正・対象テストを追記。
- 詳細な変更手順・単位は `docs/DEVELOPMENT_GUIDE.md` に従う。

## 5. リポジトリ運用

本リポジトリ直下が成果物ツリー（deliverable）そのものであり、`main` で一元管理する。
以前は作業ツリー `lineage_v1.5.0-031`（source of truth）と成果物ツリー
`lineage_v1.5.0-032`（deliverable）を二本並行で同一内容に保つ運用だったが、単一
リポジトリへ統合済みのため二本ツリー同期は不要。変更は作業ブランチへ直接コミットし、
`main` へ取り込む。

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
- **03 パイプラインの構造**：`render_dynamic_sql`（8 プレースホルダ / 9 パラメータ）で
  テンプレート置換 → `EXECUTE IMMEDIATE`。この関数は **01 setup が UDF Dataset（`analyze_lineage_json`
  と同じ場所 = `udf_project_id.udf_dataset`）に作る永続関数**（旧: スクリプト内 TEMP FUNCTION。
  BigQuery が全子ジョブの SQL 冒頭に TEMP FUNCTION DDL を前置し「All results」が全部同表示に
  なるため永続化）。静的呼び出しは関数名に変数を使えないため、03 は `udf_project_id` /
  `udf_dataset` / `udf_render_function_name` から**呼び出し文 `render_call_sql` を1回組み立てて
  動的に呼ぶ**（`repo_tables` 直後で構築、各所は `EXECUTE IMMEDIATE render_call_sql INTO
  rendered_sql USING sql_template`）。これで設置場所が DECLARE 可変になる。本体変更時は
  `sql/bigquery/create_render_dynamic_sql_udf.sql` で再配備。STEP1=VIEW 収集、
  STEP2=JOBS 収集、STEP3/4=解析。region は単一の `job_region`（`@@location`）。
  project も単一ソース：各スクリプトは `default_project_id`（01/04 は
  `bootstrap_default_project_id`）を1つ宣言し、role 別の `*_project_id` は
  それを `DEFAULT` する（`@@location` と同じ単一ソース方式）。03 の
  `source_project_filters`（物理ソースは複数 project 可）と 08 の
  `audit_project_id`（監査 sink は別 project 可）は上書き前提で残す。
  さらに DECLARE 群は `[A] 必須設定（デプロイ/リージョンごと）`→
  `[B] 動作オプション`→`[C] 派生/内部（編集不可）`の3段に整理（03/01/04/06/07/08
  すべて）。新リージョン立ち上げ時に触るのは冒頭の `SET @@location` と `[A]` だけ。
  並べ替えとコメントのみで挙動不変（各変数は1回ずつ宣言・master は role より前・
  全 DECLARE は最初の文より前）。
  JOBS の重複除去はフィンガープリント方式（一時/ローテーション/期限付き宛先は
  代表 1 件に集約、永続宛先は宛先ごとに保持）。ephemeral 判定＝宛先が実在し、かつ
  テーブル expiration が無いもの以外。

## 7. 現在地

- バンドル: `sha256 = 9ce1fd5d0bfa28a750ed718d435be696517f64a8913d88bac8f2b05e1171d71a`、`447991` bytes
- `test:release` 41 本 PASS / ゴールデン 48 ケース PASS
- 直近の修正: 03 STEP 3 を**データセット単位のループ**へ変更し、UDF チャンク分割を撤去。
  リージョン全体を1パスで解析すると V8 ヒープ蓄積で "UDF out of memory" になり、行数チャンクでも
  大オブジェクトが偏ると OOM が続いた。実運用で「1データセットずつなら通る」ことを確認済みのため、
  STEP 3 の 変更検知→探索→解析→direct-dependency publish を
  `FOR ds_row IN (SELECT ds FROM UNNEST(target_datasets) ...) DO ... END FOR` で囲い、
  各反復で `analysis_include_dataset_patterns=['^ds$']` に絞る。探索・解析とも単一クエリに復帰
  （`*_udf_chunk_*`・`udf_chunk`・2つの `WHILE` を削除）。ループ外に残すもの＝target_datasets 解決／
  グローバルメタデータ（STEP 1 で全 target dataset 分ロード、跨ぎ参照を保持）／orphan cleanup／
  STEP 4 Impact 再構築（データセット跨ぎのため最後に1回）。カウンタは反復加算、run summary はループ後1回。
  さらに**変更なし時の高速化**：列メタデータ（COLUMNS/COLUMN_FIELD_PATHS 全収集＝最重）を STEP 1 から
  STEP 3 の has-changes gate 内へ移動。`changed_datasets`（変更ある有効 object を持つ Dataset）を軽い
  レジストリ probe で先に求め、空なら列メタ収集も解析ループも丸ごとスキップ、非空ならその Dataset だけ
  ループ。STEP 4 は `has_analysis_work OR orphan_direct_dep_deleted>0`（direct-dep orphan 削除の
  `@@row_count`）でのみ再構築。STEP 1/2 と orphan cleanup は毎回実行（変更検知・無効化処理）。
  加えて**列メタの参照データセット絞り込み（案D）**：has-changes gate 内に discovery 先行パスを新設。
  `changed_datasets` を回して UDF を `source_discovery_only` で1データセットずつ実行し、全 discovery 行を
  `all_changed_with_discovery` に蓄積、参照ソースの dataset 名を `referenced_source_datasets` に収集。
  列メタ union は「参照された & アクセス可能な」ソース dataset のみに限定（未参照時は型付き空表で fallback）。
  安全な過剰包含＝参照分を減らさないので解決結果は不変、未参照 dataset のみスキップ。解析ループは UDF 探索を
  再実行せず `all_changed_with_discovery` から当該 dataset 分を読むだけ（isolation 不変・object 単位検証は従来通り）。
  SQLのみ・バンドル不変・**BigQuery 未検証**。詳細は `CHANGELOG.md` 冒頭。
