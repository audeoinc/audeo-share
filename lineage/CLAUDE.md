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
  - **修飾テーブル参照は必ずバッククォート（チームルール・必須）**：`project.dataset.table` /
    `` `%s.%s.INFORMATION_SCHEMA.X` `` / リージョン修飾 `` `%s.region-%s`.INFORMATION_SCHEMA.X `` /
    `CREATE ... TABLE \`%s.%s\`` はすべて backtick で囲む（ハイフン入り project や予約語 dataset/table でも
    安全）。現状の全 SQL は準拠済み。新規・変更時も修飾テーブル/ビュー/INFORMATION_SCHEMA 参照は
    裸で書かないこと（セッション一時テーブルの単一名と列参照は対象外）。
  - **オブジェクト命名規則（システム識別子 `lnge_`）**：このシステムが作成・利用する
    テーブル/ビュー/UDF は必ず `lnge_` prefix を付ける。組み立ては
    `<可変prefix> + 'lnge_' + marker + base + <可変suffix>`。marker はテーブル
    `m_`（master）/`t_`（transaction）、ビュー `vw_` + `t_`/`m_`。base に "lineage" は
    入れない（prefix に集約済み）。例：`lnge_m_definition_registry` /
    `lnge_t_impact` / `lnge_t_column_usage` / `lnge_vw_t_column_usage_impact`。
    UDF は `lnge_analyze_json` / `lnge_fingerprint_sql` / `lnge_render_dynamic_sql`。
    データセット名（`lineage_repository` 等）・GCS バンドル・ファイル名・JS API 名は
    対象外。新規オブジェクトも同規則に従う。
    **prefix/suffix**：テーブル/ビューは `*_table_name_prefix`/`_suffix`、UDF は
    **専用の** `*_udf_name_prefix`/`_suffix`（01/03/04/06/07）で組み立て
    （`prefix + 'lnge_' + base + suffix`）。UDF/ルーチン名はハイフン不可なので専用に
    分離（ハイフン混入は `^[A-Za-z0-9_]+$` ASSERT で検出）。01 が作る UDF 名と
    03/04/06/07 が呼ぶ UDF 名は同じ prefix/suffix で揃えること。
  - **project_id の自動取得**：各スクリプト（01/03/04/06/07/08/09）は
    `default_project_id`（01/04 は `bootstrap_default_project_id`）を
    `EXECUTE IMMEDIATE FORMAT("... \`region-%s\`.INFORMATION_SCHEMA.SCHEMATA ...", @@location) INTO`
    で自動取得（catalog_name＝ジョブ実行プロジェクト）。role 別 `*_project_id` は
    `DEFAULT NULL` 宣言＋実行時 `COALESCE(role, default)`（リテラルを入れれば pin）。
    別プロジェクト運用時は該当 SET をリテラルに置換。DECLARE-DEFAULT の評価順の都合で
    自動取得は「全 DECLARE の後の最初の実行文」に置く（04 は
    `repository_dataset_full_name` も同ブロックで SET）。debug スクリプトは対象外。
  - **project token 置換（`{project_token}`）**：自動取得した project id から設定可能な
    正規表現 `project_token_pattern`（`REGEXP_EXTRACT`・group1）で token を抽出し、
    データセット名・テーブル/ビュー/UDF の prefix/suffix・**GCS バンドル URI
    （`udf_library_uri`、01/04）**中の文字列 `{project_token}` を実行時に REPLACE
    （自動取得直後・名前組み立て/ASSERT より前）。
    例：project id `mycompany-prod-123` + `r'-([^-]+)-'` → `prod`、
    `table_name_prefix='{project_token}_'` → `prod_`。既定パターンは先頭ハイフン区切り
    セグメント。空振り＝token 空。全7スクリプトの name 入力に適用（01 の token/pattern
    と揃える）。**早期 ASSERT**：REPLACE 直後に、dataset 名（repository/udf/target/audit）
    が `^[A-Za-z0-9_]+$` か（＝残留 `{project_token}` や不正文字を検出）、URI に
    `{project_token}` が残っていないかを検証し、DDL/クエリ時ではなく実行前に misconfig を
    surface する（prefix/suffix は組み立て後のテーブル/UDF 名 ASSERT が担保）。
- **03 パイプラインの構造**：`lnge_render_dynamic_sql`（8 プレースホルダ / 9 パラメータ）で
  テンプレート置換 → `EXECUTE IMMEDIATE`。この関数は **01 setup が UDF Dataset（`lnge_analyze_json`
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
  **対象フィルタは2系統に統合（レジストリ＝解析対象）**：以前の
  `target_dataset_*`（走査範囲）／`registry_exclude_*`（収集除外）／
  `analysis_*`（解析ゲート）を、`analysis_include/exclude_dataset_patterns`
  （dataset スコープ＝View 走査範囲＋生成テーブルの dataset ゲート）と
  `analysis_include/exclude_object_patterns`（object 名フィルタ、収集時に適用）の
  2系統だけに整理。両フィルタは **収集段（STEP1 View／STEP2 生成テーブル）で適用**し、
  通ったものだけがレジストリに載る＝そのまま解析対象。除外された object は登録も
  変更追跡もされず、設定変更で新たに除外された既存 object は orphan cleanup が
  deactivate。よって解析段（changed_datasets probe・per-dataset materialization）
  ではフィルタ再適用は無く、`process_generated_tables`（生成テーブルを解析するかの
  トグル）と per-dataset スコープのみ。source 側の `source_project_filters` は別軸
  （参照される物理テーブルの schema 取得範囲）で不変。09 の dataset スコープも
  `analysis_*_dataset` に改名して 03 と統一。
  さらに DECLARE 群は `[A] 必須設定（デプロイ/リージョンごと）`→
  `[B] 動作オプション`→`[C] 派生/内部（編集不可）`の3段に整理（03/01/04/06/07/08
  すべて）。新リージョン立ち上げ時に触るのは冒頭の `SET @@location` と `[A]` だけ。
  並べ替えとコメントのみで挙動不変（各変数は1回ずつ宣言・master は role より前・
  全 DECLARE は最初の文より前）。**`[A]` 内はさらに「DECLARE を1ブロックに固め、
  用途グループごとに1行の見出しコメント（例 `-- Datasets (repository / UDF)`）で
  区切る＋その下に `Variable notes:` として変数名ごとの詳細説明」の形に統一**
  （01/03/04/06/07/08/09 すべて）。設定すべき変数が一覧で見渡せるようにするためで、
  インラインコメントは付けず詳細は下のノートを参照する。挙動はコメント再配置のみで不変。
  グループ順も全ファイルで統一：project-token → datasets → table naming → UDF naming
  → ファイル固有（source scope / analysis filter / service accounts 等）。
  `project_token_pattern` と `udf_name_prefix`/`_suffix` は「デプロイごとに設定する
  命名ノブ」なので `[A]` に置く（04/06/07 は旧 `[B]` から移動。08/09 は UDF 命名なし）。
  なお `default_project_id`（01/04 は `bootstrap_default_project_id`）は実行時
  自動取得（[C]）でユーザーが通常設定しないため、DECLARE は `[A]` ではなく `[B]` に
  置き、`[A]` にはそれを指すポインタコメントのみ残す（宣言は1回・最初の文より前は不変）。
  JOBS の重複除去はフィンガープリント方式（一時/ローテーション/期限付き宛先は
  代表 1 件に集約、永続宛先は宛先ごとに保持）。ephemeral 判定＝宛先が実在し、かつ
  テーブル expiration が無いもの以外。
  **スクリプト変数対応**：BigQuery script の子 SELECT/CTAS は DECLARE 文脈を持たず
  変数 `aaa` が列と区別できない。STEP 2 が同一 JOBS スキャンで親 SCRIPT も読み、
  `parent_job_id` 経由で `DECLARE` 名を抽出→レジストリの `script_variables ARRAY<STRING>`
  列に保存（既存デプロイは `ALTER ADD COLUMN` で移行）。STEP 3 が discovery accumulator
  経由で解析 UDF の options に `script_variables` を渡し、エンジンは「非修飾かつ列解決
  不可」な識別子が変数集合にあれば opaque 値扱い（列優先維持・修飾は対象外）。位置
  パラメータ `?` と名前付き `@param` はレキサが PARAMETER トークンとして処理。
  **FROM のテーブル値関数**：`FROM EXTERNAL_QUERY(...) AS a` など FROM 位置で名前
  直後に `(` が来る呼び出しは `TABLE_FUNCTION` ソース（不透明）として解析（括弧内は
  解析せず読み飛ばし・別名任意）。外部/フェデレーテッド出力は物理列を持たないため、
  列参照は `EXTERNAL_SOURCE_RESOLVED`（定数同様の終端・系統も診断もなし）で解決。
  実テーブルとの JOIN では実列優先・誤 AMBIGUOUS なし。
  **未解析オブジェクトのスナップショット（STEP 5）**：03 末尾で毎回
  `CREATE OR REPLACE TABLE <prefix>lnge_t_unanalyzed_definition<suffix>` を実行。
  レジストリ（STEP 1-2 で同期済み）から「実在（is_active・非 ephemeral）だが
  解析カバー外＝COMPLETED かつ last_analyzed_hash=definition_hash ではない」行を
  `coverage_reason` 付きで定義単位 DISTINCT に書き出す（INFORMATION_SCHEMA 再スキャン
  なし・毎回全更新で積み上がらない）。名前は render の固定 `__T_*__` 枠外なので直接
  組み立て（バッククォート）。STEP 5 の CREATE OR REPLACE 自体が作成するので 01 不要。
  収集フィルタ（analysis dataset scope＋object filter）で未収集の object は含まれない
  （オンデマンドの 09 が `NOT_REGISTERED` として拾う）。
  **カラム利用箇所インデックス（lnge_t_column_usage）**：カラム要件変更の影響
  確認用（Looker で table/view＋カラムを選ぶと「どの object のどの行でどう使われて
  いるか」を表示）。impact は値フロー（SELECT）系統だが、こちらは全句
  （SELECT/WHERE/JOIN_ON/JOIN_UNNEST/FROM_UNNEST/GROUP_BY/HAVING/QUALIFY/ORDER_BY）の
  物理カラム参照を「1参照=1行」で持つ。エンジンは exporter で `column_usages` を新規
  出力（`physical_column_references` を平坦化し、解決済み物理列ごとに usage_type=clause・
  reference_name・source 物理列・line_number・column_number・line_text＝参照トークンの
  ある1行 を付与。派生/未解決参照は除外）。03 STEP 3 が direct_dependency と同じ
  delete-by-object＋insert で publish（rollback/orphan cleanup も対応）。テーブル名は
  render の固定枠外なので直接組み立て（`column_usage_fqn`）、既存デプロイ向けに 03 が
  `CREATE TABLE IF NOT EXISTS` で自己修復（正本スキーマは 01）。下流列の「大元と経由」は
  既存 impact（`origin/impacted`＋`dependency_path`）で辿れるため新規実装なし。
  **利用箇所×深さ（lnge_vw_t_column_usage_impact）**：利用箇所の「深さ(rank)」は
  原点カラム基準の相対値（同じ利用箇所でも原点次第で深さが変わる）ため、usage 表に
  単一 rank を持たせず、ビュー `lnge_vw_t_column_usage_impact` でクエリ時結合。直接参照＝深さ1、
  impact 経由＝`impact_rank+1`、`dependency_path` で経由も表示。各行に
  `usage_definition_hash`（参照を含む object の `definition_hash`）を露出し、メタ＋行番号
  で足りない時に実SQL（`lnge_m_definition_registry` 等）を引く join key に使える。
  impact は STEP 4 で
  毎回全置換のため常に最新スナップショット（フィルタ不要）。**ビューは 01 setup が
  テーブル作成直後に併せて作成**（`lnge_t_column_usage`／`lnge_t_impact` の後）。
  既存デプロイでビューだけ追加/更新したい場合は 01 の該当 `CREATE OR REPLACE VIEW`
  ブロックを単独実行すればよい（データを持たないので無害）。
  **診断の generation_type**：`lnge_t_diagnostic` に `generation_type`（nullable）を
  追加。View 定義か Job SQL かを registry と join せず判別可（'VIEW_DEFINITION'＝View、
  'SCHEDULED_QUERY'/'DAG' 等＝生成テーブル Job）。値は元々診断ステージングを流れており
  永続化しただけ。書込みは 03 STEP 3 の3系統（UDF診断・非publishableマーカー・
  pre-analysis失敗）と 06 単体経路。
  **absent 判定の鮮度（STEP 3）**：publish 可否分類 `batch_object_source_flags` の存在
  判定は、STEP 1 スナップショット `current_target_tables` ではなく、STEP 3 で列メタと
  同時・同一参照データセット範囲で採る `current_referenced_tables`（フレッシュな TABLES
  スキャン）を使う。STEP1→STEP3 の間に drop されたソーステーブルが「在るが列無し＝
  coverage gap→FAILED」と誤判定される窓を塞ぐ（drop 済みは absent＝publish 可で警告抑制）。
  実在するが列が空の真の coverage gap は従来どおり検出。

## 7. 現在地

- バンドル: `sha256 = ad18b4bc5a015e9d831900d5ca6edfde4043b3c5ccb9fc71a6940e0e24ad00cf`、`461888` bytes
- `test:release` 52 本 PASS / ゴールデン 48 ケース PASS
- 直近の修正: 03 STEP 3 を**データセット単位のループ**へ変更し、UDF チャンク分割を撤去。
  リージョン全体を1パスで解析すると V8 ヒープ蓄積で "UDF out of memory" になり、行数チャンクでも
  大オブジェクトが偏ると OOM が続いた。実運用で「1データセットずつなら通る」ことを確認済みのため、
  STEP 3 の 変更検知→探索→解析→direct-dependency publish を
  `FOR ds_row IN (SELECT ds FROM UNNEST(target_datasets) ...) DO ... END FOR` で囲い、
  各反復で `LOWER(object_dataset)=LOWER(@current_dataset)` に絞る。探索・解析とも単一クエリに復帰
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
