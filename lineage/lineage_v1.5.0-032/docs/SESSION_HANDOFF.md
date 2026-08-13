# SESSION_HANDOFF — 1.5.0-032 の意思決定と経緯

このドキュメントは、対話セッションで行った設計判断とその「理由」を、後続の
Claude Code セッション（会話の記憶を持たない）へ引き継ぐためのものです。各項目の
「何を・なぜ」を残しています。実装の要約は `CHANGELOG.md`、規約は `CLAUDE.md` /
`docs/DEVELOPMENT_GUIDE.md` を参照してください。

## 1. このバージョンで確定した方針

- **環境識別子の除去**：全ファイルの実名（旧 `audeodb` / `sample_ds` 等）を
  `project_id` / `dataset` に統一。自社環境を特定させないため。以後もこの匿名化を維持する。
- **設定テーブルの廃止**：
  - `lineage_config` テーブルを完全廃止。設定は 03 のパラメータに集約（01 は「初回の
    ブートストラップ準備」に限定され、意味合いが異なるので二重管理を許容）。
  - `lineage_execution_account_config` テーブルを廃止。サービスアカウントは 03 内で
    `scheduled_query_service_accounts` / `dag_service_accounts` として DECLARE 管理。
  - JOBS 抽出条件（lookback、statement types、scheduled query ラベル要否）も 03 の
    パラメータへ。意味のあるノブだけを露出する方針。
- **01 の初期化**：`CREATE TABLE IF NOT EXISTS` → `CREATE OR REPLACE TABLE`。
  スキーマ作成（テーブル用・fn 用の両データセット）は `CREATE SCHEMA` をコメントアウト。

## 2. JOBS 由来 SQL の重複除去（フィンガープリント方式）

背景として 2 パターンあった：(1) DAG が `CREATE TABLE AS SELECT * FROM view` を実行
→ view まで遡りたい（トレーサビリティ維持）。(2) 純粋な `SELECT` が毎回異なる一時
宛先テーブルに書き出される → 解析は 1 回で良い。

- 判断：宛先テーブル基準ではなく **全 SQL をフィンガープリントで一意化し、各 1 回だけ
  解析**する。VIEW は全件解析、JOBS 由来のみこの集約を適用。
- ただし **「出し分け」** を採用（一律集約しない）：永続宛先は宛先ごとに実名のまま保持し
  点(1) の遡りを残す。一時/期限付き宛先はフィンガープリント代表 1 件に集約する。
- **ephemeral 判定**：当初は「宛先が実在するか」で分けたが、SELECT が実在するが
  expiration 付きの一時テーブルに書くケースが persistent 誤判定され重複した。修正後の
  判定は「**宛先が実在し、かつ table expiration が無い**もののみ永続」。それ以外
  （非実在 or expiration 付き）は ephemeral として合成ラベル
  `<target_project>.<ephemeral_object_dataset_label>.fp_<hash>` に集約。
- 実装：`fingerprint_lineage_sql` UDF（01）と `fingerprintSqlForBigQuery`（エンジン）。
  文字列/数値リテラルを `?` に置換し構造だけを比較（リテラル差のみの SQL は同一指紋）。

## 3. フィルタ/リージョンまわりの整理

- ソース/ターゲットのデータセット選択を **すべて正規表現に統一**（LIKE を廃止）。
  `source_project_filters` は `dataset_include_patterns` / `dataset_exclude_patterns`、
  ターゲットは `target_dataset_include_patterns` / `target_dataset_exclude_patterns`。
  空 include=リージョン内全件、空 exclude=除外なし。
- `target_datasets` は明示列挙をやめ、**リージョン + 正規表現**で SCHEMATA を走査して解決。
- `job_region` を環境設定の先頭へ（リポジトリ・ターゲット VIEW・ソースメタデータ・
  JOBS すべてで使う単一リージョン、`@@location` と一致）。
- 名前フィルタは **大文字小文字を無視**（`REGEXP_CONTAINS(LOWER(name), LOWER(pattern))`）。
  以前は name だけ小文字化し pattern はそのままで、大文字パターンが常に外れていた。
- 名前規則による除外フィルタは 2 系統に統一（いずれも object 名の正規表現）：
  `registry_exclude_object_patterns`（登録段で存在ごと除外。VIEW は STEP 1、生成
  TABLE は STEP 2 の destination 名で弾き、レジストリに載せない）と、
  `analysis_include_object_patterns` / `analysis_exclude_object_patterns`（解析段で
  解析だけを制御。レジストリには残す）。宣言順は実行順に合わせ registry を先に置く。
  旧名: `exclude_view_name_patterns` → `registry_exclude_object_patterns`、
  `include/exclude_object_patterns` → `analysis_include/exclude_object_patterns`。
- **データセット版フィルタを追加**（object 名版と並列・非破壊、既定 `[]`）：
  `registry_exclude_dataset_patterns`（登録段。VIEW=object_dataset、生成 TABLE=
  destination_dataset で除外。名前版と OR）と `analysis_include_dataset_patterns` /
  `analysis_exclude_dataset_patterns`（解析段。名前版とは独立の AND ゲート：
  name-include かつ dataset-include を満たし、name-exclude・dataset-exclude の
  いずれにも当たらない object を解析）。マッチは既存同様
  `REGEXP_CONTAINS(LOWER(値), LOWER(pattern))`（大文字小文字無視）。
- 冗長変数の整理：`render_dynamic_sql` の未使用プレースホルダ `__REPOSITORY__` /
  `__TARGET__` と、それだけのために存在した `target_dataset` スカラーを撤去
  （現在は 8 プレースホルダ / 9 パラメータ）。

## 4. パーサ/リゾルバの機能追加・修正

- **配列要素アクセス**：`arr[SAFE_OFFSET(n)]` / `OFFSET` / `ORDINAL` / `SAFE_ORDINAL` /
  汎用 `[expr]` の後置サブスクリプトをパース対応（位置キーワード自体はリネージを持たず、
  要素値は配列式のソース列へ、添字内の列も捕捉）。テスト `test_v1_5_0_047.js`。
- **修飾あり/なし混在 × `SELECT *` CTE の JOIN（直近・重要）**：
  症状＝`FROM` が `SELECT *` の CTE、`LEFT JOIN` が実テーブル（ともに別名）で、
  本来 `FROM`(CTE) 側の非修飾列が JOIN 側で探され `PHYSICAL_COLUMN_NOT_FOUND`、
  さらに CTE への修飾参照 `x.col` まで `UNRESOLVED_COLUMN` になっていた。
  原因＝`SELECT * FROM 物理表` の CTE は名前解決段階では公開列が「不明」なのに、
  `ColumnResolver#getWildcardExposedColumns` が物理/UNNEST ソースを読み飛ばし、
  公開列「ゼロ（空集合）」と誤認 → CTE が候補ソースから外れ、非修飾列が誤って単独で
  JOIN 側にバインド（候補 1 件確定のため救済処理も不発）。
  修正＝ワイルドカードが列不明のソース（物理/UNNEST/列不明の子スコープ）を取り込む
  場合は空集合ではなく **「不明（null）」を伝播**。CTE が候補として残り、
  `PhysicalColumnResolver` が実メタデータで曖昧性を解消する。テスト `test_v1_5_0_048.js`。

## 4.5 STEP 3 高速化（03 パイプライン）

- **律速の所在**：03 の STEP 3 は「変更オブジェクト 1 件ずつの逐次 `FOR` ループ」で、
  1 件あたり約 20 の `EXECUTE IMMEDIATE`（UDF 2 回＝ソース探索＋本解析、温度テーブル
  作成、DELETE/INSERT/UPDATE/MERGE 多数）を直列実行する。変更 N 件で ~15〜20N ジョブが
  直列に走り、ジョブ起動・スロット取得オーバーヘッド × N が支配的コスト。STEP1/2 は
  増分 lookback で妥当、STEP4 は `WITH RECURSIVE` の 1 発でセットベース済み。
- **② 部分改修（実施済み）**：ソース探索 UDF をループ外へ集約。UDF は行ごとのスカラー
  関数なので、`source_discovery_only` を全変更定義に対して 1 ジョブで実行する温度テーブル
  `changed_definitions_with_discovery` を作り、ループは `target.source_discovery_json` を
  直接読む。UDF 呼び出しがオブジェクト当たり 2 回→1 回、探索の JS UDF 初期化コストは
  実行あたり 1 回に。隔離は維持（`source_discovery_only` は throw せず PARTIAL_FAILURE を
  返すため、ループ内の status チェック＋RAISE でオブジェクト単位に例外送出、ADR-0004 の
  旧 dependency 保護もそのまま）。SQL のみ／エンジン不変。
- **残タスク（未実施）**：
  - **① フルのバッチ化（実施済み）**：STEP 3 の `FOR ... DO` ループを撤廃し、
    完全な集合ベースに置換。(1) メタデータ scoping を全obj 1 クエリ（`batch_object_metadata`）、
    (2) 本解析 UDF を解析可能 obj 全件で 1 ジョブ（`batch_udf_results`）、(3) dependency /
    diagnostic を集合で staging、(4) オブジェクトキーの temp（`batch_completed_objects` /
    `batch_udf_failed_objects` / `batch_preanalysis_failures`）を使い数本の集合 DML で公開。
    STEP 3 のジョブ数が ~15〜20N → 定数に。意味論は維持（COMPLETED=公開、非COMPLETED=旧
    dependency 温存＋UDF_RESULT_NOT_PUBLISHABLE、事前失敗=ANALYSIS_EXECUTION_FAILED 追記＋
    FAILED、ADR-0004 準拠）。
    **挙動変更**：公開はオブジェクト単位ではなく **バッチ原子的**。staging を全部先に計算し、
    破壊的 DML はバックアップ（`batch_previous_*`）を取ってから実行、失敗時は復元して RAISE。
    失敗runはリポジトリを変更しない（部分更新なし）。UDF は throw せず status を返すので
    解析失敗はデータとして隔離される。SQL のみ／エンジン不変。
    **未検証**：本環境から BigQuery 実行はしていない。本番前に dry-run パースと staging 実行、
    旧ループとの出力 diff（direct_dependency / lineage_diagnostic / definition_registry）で検証すること。
  - **③ ループ内 DML の集約**：①に包含済み（公開 DML は集合化された）。

## 4.6 消えたソースの not-found を FAILED 扱いしない（03 STEP 3）

- **症状**：DAG/生成テーブルが参照する temp/一時テーブルが今は存在せず、メタデータが
  無いため not-found。エンジンは「メタデータ皆無＝WARNING（PHYSICAL_METADATA_NOT_FOUND /
  SOURCE_METADATA_NOT_COLLECTED）」「列だけ無い＝ERROR（PHYSICAL_COLUMN_NOT_FOUND）」を
  区別するが、WARNING 1 つでも `analysis_status` が COMPLETED_WITH_WARNINGS になり、
  パイプラインは `COMPLETED` 以外を非公開＝FAILED＋UDF_RESULT_NOT_PUBLISHABLE＋
  is_changed=TRUE（毎回リトライ）にしていた。
- **対応**：STEP 3 で `INFORMATION_SCHEMA.TABLES`（`current_target_tables`）を使い原因を
  切り分け（`batch_object_source_flags`）。ソースが TABLES に**無い**＝本当に消えている
  （想定内）、TABLES に**在るが列未収集**＝本物のカバレッジ不足。判定 `is_publishable`＝
  「status が厳密 COMPLETED、または COMPLETED_WITH_WARNINGS かつ present-but-uncollected
  ソースが無い（＝WARNING は全て消えたソース起因）」。publishable は正常終了：解決できた
  依存を公開、消えたソースの WARNING は診断に**出さない**、registry=COMPLETED／
  is_changed=FALSE（リトライ停止）。ERROR あり・PARTIAL_FAILURE・present-uncollected あり
  は従来通り FAILED で表面化。※消えたソース WARNING と別の実 ERROR が混在する object は
  FAILED のまま全診断を保持（安全側）。SQL のみ／エンジン不変。**BigQuery 未検証**。

## 4.7 関数結果への後置フィールドアクセス（`fn(...).string_value`）の誤 not-found 修正

- **症状**：GA4 の `fn('key', event_params).string_value` のような「**関数呼び出し結果への
  ドットアクセス**」で、末尾 `.string_value` が裸の列 `string_value` として誤解決され
  `PHYSICAL_COLUMN_NOT_FOUND`（ERROR）→ COMPLETED_WITH_ERRORS → 非公開/FAILED。
- **原因**：パーサの後置処理（`#parsePostfixExpression`）が `OVER` と 添字 `[...]` のみ対応で、
  `)`/`]` の直後の `.field` を扱えず、select 項目が RAW_EXPRESSION に退避 → 中の識別子
  `string_value` を裸の列参照として収集していた。
- **修正**：後置 `base.field`（関数呼び出し/括弧式/添字の結果）をパース対応（`#parseFieldAccess`）。
  配列添字と同じ設計で、**末尾フィールドは lineage を持たない**（不透明な戻り STRUCT の
  フィールド選択）、**base（関数なら引数）の lineage のみ保持**。よって出力は `event_params`
  （その全 field_path に広く帰属）に依存し、`.string_value` は非計上。列への識別子チェーン
  `event_params.value.string_value` は後置段の前に消費されるため無影響。テスト
  `test_v1_5_0_049`。エンジン変更（要 GCS 再デプロイ）。

## 4.8 文字列リテラル `'ALL'`/`'DISTINCT'` を SELECT 修飾子と誤認する不具合

- **症状**：先頭 SELECT 項目が `'ALL' AS col1` のような**文字列リテラル**のとき
  "SelectParser: SELECT item 1 has no expression"（PARTIAL_FAILURE）。
- **原因**：`SelectParser#removeSelectModifiers` が `SELECT [ALL|DISTINCT]` 集合修飾子と
  `AS STRUCT|VALUE` を先頭から除去する際、`normalized_token` だけで判定していた。文字列
  `'ALL'`（token_type=STRING、normalized_token="ALL"）を修飾子と誤認し除去 → 式が消えた。
- **修正**：修飾子判定に **`token_type === "KEYWORD"` を追加**（ALL/DISTINCT/AS はキーワード、
  文字列は STRING）。本来の `SELECT ALL/DISTINCT` や `SELECT AS STRUCT|VALUE` は無影響。
  テスト `test_v1_5_0_050`。エンジン変更（要 GCS 再デプロイ）。

## 4.9 未クォートのダッシュ付きテーブルパス（`my-project.d.t`）の FROM 解析

- **症状**：FROM に未クォートのダッシュ付きテーブルパス（ダッシュ付きプロジェクトID
  `my-project.dataset.table` 等）があると "FromParser: JOIN was expected, but found -"
  （PARTIAL_FAILURE）。バッククォート版 `` `my-project.d.t` `` は従来通り可。
- **原因**：レキサが `my-project` を `my`/`-`/`project` に分割。`FromParser#parseTableSource`
  は `.` 区切りしか辿らず最初の `-` で停止。加えて数字終わりのID（`my-project-123.d`）は
  レキサが `123.` を区切りドットごと1数値トークンとして食う別問題もあった。
- **修正**：(1) `FromParser#parseTableSource` がハイフン連結（`my - project`→`MY-PROJECT`、
  数値セグメントも）を1パートに統合。(2) レキサは、数値直後の `.` が**英字識別子の前**なら
  数値に取り込まず区切りとして扱う（`123.dataset`→`123`/`.`/`dataset`）。小数
  `1.5`/`1.`/`1.5e3`/`3.14` は無影響。テスト `test_v1_5_0_051`。
- **既知の限界**：区切り無しで数字と英字が混在するセグメント（例 `my-2nd`）は依然
  誤トークン化 → その場合はバッククォート推奨。エンジン変更（要 GCS 再デプロイ）。

## 4.10 名前付きクエリパラメータ `@key` / `@@system_var` の対応

- **症状**：JOBS 収集 SQL に dbt 由来の `@key` 等の名前付きパラメータがあると、式パーサが
  `token "@" cannot start an expression`（式コンテキスト→PARTIAL_FAILURE）／SELECT 位置では
  RAW_EXPRESSION に退避して名前を裸の列として誤解決（PHYSICAL_COLUMN_NOT_FOUND）。
- **原因**：Lexer は `@` を単独 UNKNOWN トークンとして返すが、式パーサに `@` を始端とする
  一次式が無かった。
- **修正**：`@name` / `@@name` を **LITERAL_EXPRESSION（kind "PARAMETER"）** としてパース。
  パラメータは外部スカラー値でテーブル列ではないため **lineage を持たない**。`@` 直後の名前は
  予約語でも消費（`@end` / `@order` も有効なパラメータ名）。同一文の実列 lineage は保持。
  テスト `test_v1_5_0_052`。エンジン変更（要 GCS 再デプロイ）。

## 4.11 EXTRACT / WEEK(<WEEKDAY>) デートパートの解析

- **症状**：`EXTRACT(part FROM expr [AT TIME ZONE tz])` が特殊構文として未対応。SELECT 位置は
  RAW_EXPRESSION フォールバックで通っていたが、WHERE 等では `expected ")" but found "FROM"`
  （PARTIAL_FAILURE）。さらに `EXTRACT(WEEK(MONDAY) FROM dt)` の `MONDAY` や `AT TIME ZONE` の
  `AT` を列と誤認（PHYSICAL_COLUMN_NOT_FOUND）。`DATE_TRUNC(dt, WEEK(MONDAY))` の `MONDAY` も同様。
- **修正**：`EXTRACT` を特殊構文としてパース（`#consumeDatePart` で part を読み飛ばし、`FROM` の
  後の source 式と `AT TIME ZONE` の tz 式のみ lineage 保持）。`WEEK(<WEEKDAY>)` は
  デートパート（非スカラー関数）として no-lineage リテラル化。bare datepart 引数
  （`DATE_TRUNC(dt, WEEK)` / `DATE_DIFF(a,b,DAY)`）は無影響。テスト `test_v1_5_0_053`。
  エンジン変更（要 GCS 再デプロイ）。

## 4.12 definition_registry に labels 列を追加（エラー追跡用）

- **目的**：FAILED オブジェクトを DAG（dag_id / task_id 等）へ紐付けやすくする。labels は
  既に `lineage_job_registry` にあるが、解析/エラーの主テーブル `lineage_definition_registry`
  には無く join が必要だった。
- **実装（SQLのみ・エンジン不変）**：01 の definition_registry に
  `labels ARRAY<STRUCT<key STRING, value STRING>>` を追加。03 STEP 2 で
  `latest_generated_table_definitions` に labels を通し、生成テーブルの def_registry MERGE
  （MATCHED UPDATE / NOT MATCHED INSERT 両方）で `source.labels` を格納。View（STEP 1）は
  未指定＝NULL 既定。
- **移行注意**：01 は `CREATE OR REPLACE TABLE`（データ消去）。既存本番では 01 を再実行せず
  `ALTER TABLE <definition_registry> ADD COLUMN IF NOT EXISTS labels ARRAY<STRUCT<key STRING,
  value STRING>>;` を実行 → 次回日次で生成テーブル分が backfill される。

## 4.13 `JOIN ... USING(col)` 結合キーの AMBIGUOUS 誤検知を修正

- **症状**：全ソースが CTE、2 回 INNER JOIN、`USING` 結合、カラム修飾なしの SQL
  （`SELECT id FROM c1 INNER JOIN c2 USING(id) INNER JOIN c3 USING(id)`）で、`id` が
  「複数ソースに存在する曖昧な列」と判定され `PHYSICAL_COLUMN_AMBIGUOUS`（ERROR）。
- **原因**：パーサ（`from_parser.js`）は `JOIN ... USING(col)` の列を `join.using_columns`
  に記録していたが、リゾルバが未使用。`source_resolver.js #resolveQueryScope` は JOIN 登録時に
  USING 情報を scope に残さず、`column_resolver.js #resolveUnqualifiedReference` は候補ソースが
  2 件以上あれば無条件で `AMBIGUOUS` を返していた。`USING` は結合キーを 1 論理列へ統合する構文
  なので、この参照は本来曖昧でない。
- **修正（エンジン変更・要 GCS 再デプロイ）**：
  - `source_resolver.js` — scope に `join_using_columns: []` を追加し、JOIN ループで
    `join.using_columns` を正規化（大文字化）して記録。
  - `column_resolver.js` — 非修飾参照で候補が 2 件以上のとき、列名が `scope.join_using_columns`
    に含まれれば登録順で先頭（FROM/左側）の候補へ確定解決し、`#getColumnStatus` で状態を付与。
    含まれなければ従来どおり `AMBIGUOUS`。
- **リネージ属性**：結合キーは左ソース側に付く。両ソースへの完全なユニオン属性は
  lineage_resolver が単一 source_id で派生を辿る設計のため、より大きな変更になる（今回は誤 ERROR
  解消を優先）。
- **回帰**：`ON` 結合（USING でない）で両ソースに同名列があり修飾なし参照は、従来どおり
  `PHYSICAL_COLUMN_AMBIGUOUS` のまま。テスト `test_v1_5_0_056.js`。

## 4.14 USING 列が FROM/左側ソースに無いケースの解決（4.13 の追随）

- **症状**：`SELECT cola FROM tablea INNER JOIN aaa USING(id) INNER JOIN bbb USING(cola)` で、
  `cola` が CTE `aaa`/`bbb` にあり FROM の物理表 `tablea` には無い場合、4.13（v1.5.0-056）の
  「USING 列を先頭候補へ確定解決」が物理表 `tablea` を選び、`tablea` に `cola` が無く
  `PHYSICAL_COLUMN_NOT_FOUND`（ERROR）。
- **原因**：`#findUnqualifiedCandidates` は物理ソース（列不明＝`#getKnownOutputColumns`==null）を
  常に候補に含めるため、候補は `[tablea, aaa, bbb]`。056 は無条件に `candidateSources[0]`
  （=tablea）を選んでいた。USING 列は結合先のいずれかにあればよく、FROM 側が必ず持つとは限らない。
- **修正（エンジン変更・要 GCS 再デプロイ）**：`column_resolver.js #resolveUnqualifiedReference` の
  USING 分岐で、候補のうち列を公開すると分かっているもの（`#getColumnStatus`==`"RESOLVED"`＝
  CTE/派生で出力列に含む）を `find` で優先。見つからない（全て物理でスキーマ未連携）場合のみ
  `candidateSources[0]` へフォールバック。結合キーはその公開ソースへ属性（例では `cola` →
  CTE → 物理 `p.d.src.cola`）。
- **回帰**：FROM の物理表側に USING キーがある通常ケースも従来どおり解決。テスト `test_v1_5_0_057.js`。

## 4.15 `UNNEST(array) WITH OFFSET AS offset` の別名が予約語 `offset` のケース

- **症状**：`SELECT id, offset FROM t, UNNEST(arr) AS e WITH OFFSET AS offset` で、SELECT の
  `offset` の出力列名が解決できず `OUTPUT_COLUMN_NAME_UNRESOLVED`（WARNING、
  `COMPLETED_WITH_WARNINGS`）。別名が `pos` 等の通常識別子ならクリーンだった。offset 値自体の
  解決（リネージ無し）は問題なく、出力名の導出だけが失敗していた。
- **原因**：`offset` は Lexer が `OFFSET` キーワードとして字句化する。SelectParser の暗黙出力名
  導出 `#deriveColumnAlias` が `#isIdentifierToken`（IDENTIFIER/BACKTICK のみ）で判定していたため
  KEYWORD の列名を導出できなかった。一方 ExpressionParser の `#isIdentifierToken` は非予約 KEYWORD
  を識別子（列参照）として解決するため、式ASTは `offset` を列として扱えていた（不整合）。
- **修正（エンジン変更・要 GCS 再デプロイ）**：SelectParser に `#isColumnNameToken` を追加し、
  ExpressionParser と同じ予約語集合（`NULL`/`TRUE`/`FALSE`・論理/句キーワード等）を除いた KEYWORD を
  列名として受理。`#deriveColumnAlias` の単一トークン列・ドット修飾列の両方でこれを使う。`OFFSET`
  等の非予約語は列名になり、真の予約語リテラル（`NULL` 等）は従来どおり無名のまま。
- **回帰**：識別子別名 `pos`、`SELECT NULL`（無名維持）を併せて確認。テスト `test_v1_5_0_058.js`。

## 4.16 `INTERVAL <expr> <part>` の値が算術式のケース

- **症状**：`DATE_ADD(d, INTERVAL n * 2 DAY)` や `INTERVAL n + 1 DAY` のように INTERVAL の値部が
  算術式だと、関数引数内で `ExpressionParser: expected ")", but found "day"`、素の SELECT 項目では
  `INTERVAL` が列参照へ誤解決し `PHYSICAL_COLUMN_NOT_FOUND`。リテラル値 `INTERVAL 2 DAY` や
  単独列 `INTERVAL n DAY` は問題なかった（値の後ろに演算子が無いため）。
- **原因**：`#parseIntervalExpression` が値部を `#parseUnaryExpression`（単項精度）で解析していた。
  単項は `*`/`/`/`+`/`-` の手前で止まるため、`n * 2` の場合 `n` だけを値として返し、続く `* 2 DAY` が
  取り残される。関数引数では末尾の日付単位が閉じ `)` 検査に衝突し、素の式では式解析失敗の
  フォールバックで先頭語が列扱いになっていた。
- **修正（エンジン変更・要 GCS 再デプロイ）**：値部を `#parseAdditiveExpression`（加減算精度、
  乗除算も含む）で解析。日付単位（DAY 等）は裸のキーワードで演算子ではないため、加減算解析は必ず
  単位の手前で停止し過剰消費しない。値部に含まれる列（例: n）の依存も lineage に保持される。
- **回帰**：リテラル値・単独列・負値・`DAY TO SECOND` 句を併せて確認。テスト `test_v1_5_0_059.js`。

## 4.17 `CREATE ... AS (SELECT ...)` の括弧付き本体

- **症状**：`CREATE OR REPLACE TEMP TABLE t AS (SELECT ...)` で QueryParser が
  「トップレベルの SELECT Clause が見つかりません」。括弧なし `CREATE ... AS SELECT ...` は
  通っていた。
- **原因**：ClauseParser は深さ0の SELECT を探すが、`AS (SELECT ...)` では SELECT が括弧内（深さ1）
  に入る。既存の `#stripWrappingParentheses` は「先頭の非コメント Token が '('」の全体括弧しか
  剥がさないため、`CREATE ... AS` の前置きの後ろに来る括弧付きクエリには対応していなかった。
- **修正（エンジン変更・要 GCS 再デプロイ）**：QueryParser に `#stripStatementBodyParentheses` を追加。
  深さ0の `AS` の直後（コメント除く）が深さ0の `(` で、その対応する `)` が末尾（末尾 ';' 無視）に
  一致し、内側が SELECT/WITH で始まる場合に、括弧内のクエリだけを取り出して `#normalizeTokenDepth`
  後に再解析する。対象テーブル名は解析メタデータ（view_project/dataset/name）で与えるため、
  `CREATE ... AS` の前置きは lineage に寄与しない。
- **非対象（回帰確認済み）**：`WITH t AS (...) SELECT ...`（括弧の後ろに続きがある）、列別名 `x AS y`、
  スカラーサブクエリ `(SELECT ...) AS y`、括弧なし CTAS、全体括弧 `(SELECT ...)`。テスト `test_v1_5_0_060.js`。

## 4.18 UDF out of memory 対策：物理列メタデータの縮小（SQLのみ）

- **症状**：解析対象を増やしたところ、03 STEP 3 の JS UDF で "Resource exceeded during query
  execution / UDF out of memory"。
- **切り分け**：エンジンにモジュールレベルの蓄積状態（行をまたぐキャッシュ）は無く、各 UDF 呼び出しは
  独立（呼び出しごとに `new LineageEngine` → 文字列を返すのみ）。よって BigQuery の JS UDF メモリ上限に
  対し、単一の巨大オブジェクト（大きな SQL＋大きなメタデータ）または多数行処理でのヒープ蓄積が原因。
- **対処（今回・SQLのみ）**：UDF へ渡す per-object の `physical_columns_json` から `data_type` /
  `is_nullable` を除去。エンジンはこれらを内部で伝播するだけで、エクスポート出力（lineage_paths /
  physical_column_references 等）には一切含めないため、解析結果は不変（`test_v1_5_0_061.js` で
  「出力が data_type/is_nullable の有無に依存しない」ことを固定）。ネスト/複合型の `data_type`
  （`ARRAY<STRUCT<...>>` 等、GA 系イベントテーブル）は1列のバイト数を支配し得るため、広い/深い
  テーブルを参照するオブジェクトのペイロードが大きく縮む。`03_...sql` の agg で ARRAY_AGG の STRUCT と
  METADATA_TOO_LARGE 用の BYTE_LENGTH の両方から2フィールドを削除。エンジンバンドルは不変。
- **未実施の追加レバー（必要なら）**：SQL本文サイズのガード追加、METADATA_TOO_LARGE 閾値の引き下げ、
  UDF バッチのチャンク分割（固定件数ループ）。ユーザー選択は「メタデータ縮小」のみ。

## 4.19 UDF out of memory 対策：STEP 3 UDF のチャンク分割（4.18 の続き・SQLのみ）

- **4.18 では解消せず**（メタデータ縮小では効かなかった）。実データ診断で原因を確定：
  対象 **2667 件**、最大 SQL **64KB**、中央値 192B、p95 9KB。**単一の巨大 SQL は無く**、
  全件を 1 クエリで UDF 実行する際の**スロット上の V8 ヒープ蓄積（集約ピーク）**が原因。
- **対処（今回・SQLのみ）**：STEP 3 の UDF 実行を全件1クエリ→**固定件数チャンクのループ**へ変更。
  - `analysis_udf_chunk_size`（新 DECLARE・既定 200）を追加。
  - `batch_analysis_input` に `udf_chunk` 列（analyzable 行を analyzability で PARTITION した
    ROW_NUMBER を chunk_size で DIV）を追加。
  - `batch_udf_results` は UDF SELECT の `WHERE FALSE` で**空テーブルとして先に作成**（UDF 未評価で
    スキーマ確定）。以後 `INSERT ... WHERE udf_chunk = @chunk_index` を chunk_count 回ループ。
  - `analysis_udf_chunk_count = DIV(COUNT(*) + size - 1, size)`（0 件なら 0 → ループ無し）。
  - INSERT テンプレートはループ外で1回 render、`@chunk_index` のみ差し替え。
  - 効果不足なら chunk_size を下げる／過剰なジョブ数なら上げる。トレードオフ：単一クエリより
    逐次ジョブ数が増える。エンジンバンドルは不変・**BigQuery 未検証**。
- **※4.19 だけでは解消せず**：03 には UDF 全件パスが2つあり、探索パス（下記 4.20）が未分割で残っていた。

## 4.20 UDF out of memory 対策：ソース探索パスのチャンク分割（4.19 の続き・SQLのみ）

- **症状の継続**：4.19（STEP 3 チャンク分割）を入れても、対象増加時にまだ "UDF out of memory"。
  `analysis_udf_chunk_size` を下げても効かない。
- **原因**：03 には JS UDF を changed 全件に回すパスが**2つ**ある。
  ① **ソース探索**（1652 付近）：`source_discovery_only` モードで UDF を全 changed 定義に回し
     `changed_definitions_with_discovery`（`source_discovery_json`）を作る単一クエリ。**未分割だった**。
  ② **STEP 3 解析**（2090 付近）：4.19 で分割済み。
  ①も同じ集約ピークで OOM するため、②だけ分割しても解消しない（②の chunk_size は①に無関係）。
- **対処（今回・SQLのみ）**：①も固定件数チャンクのループへ。
  - 新 DECLARE `discovery_udf_chunk_size`（既定 200、ブロック 1430 の変数群に追加）。
  - `changed_definitions_with_discovery` を UDF SELECT の `WHERE FALSE` で空作成（スキーマ確定）。
  - `discovery_udf_chunk_count = DIV(COUNT(*) + size - 1, size)`（changed_definitions_to_analyze 基準）。
  - `INSERT ... FROM (SELECT c.*, DIV(ROW_NUMBER() OVER(ORDER BY オブジェクトキー) - 1, @chunk_size) AS discovery_chunk
    FROM changed_definitions_to_analyze c) WHERE discovery_chunk=@chunk_index` を chunk_count 回ループ。
    UDF は選択チャンクの行だけに評価される。
  - `changed_definitions_to_analyze` 自体は不変（chunk は探索ステップ内で ROW_NUMBER 再計算）。
- **切り分けのヒント**：どちらのパスで落ちたかは失敗ジョブの SQL で分かる。
  `... changed_definitions_with_discovery ... source_discovery_json` なら①、
  `INSERT INTO batch_udf_results` なら②。エンジン不変・**BigQuery 未検証**。

## 5. 現在地（引き継ぎ時点）

- バンドル: `sha256 = 0a31b8c9a86faae55f8108e94b7a237906add0e96da6cd6b823f026371a8e3c5`、`441569` bytes
- `test:release` 41 本 PASS / ゴールデン 48 ケース PASS
- 二本ツリー（-031 / -032）同期済み
- 03 STEP 3：フルバッチ化済み（上記 §4.5 ①②③）。集合ベースに全面置換、ジョブ数は
  N 非依存。**BigQuery 未検証**（本番前に staging 実行＋旧ループとの出力 diff が必要）。

## 6. Claude Code で続きを進める手順

1. このリポジトリ一式をローカルの作業ディレクトリ（Git 管理下）に展開する。
2. Claude Code をそのディレクトリで起動する（`CLAUDE.md` が自動で読み込まれる）。
3. 最初に `CHANGELOG.md` 冒頭と本 `docs/SESSION_HANDOFF.md` を読ませて経緯を把握させる。
4. 変更は §4（CLAUDE.md）の必須手順に従う：実装 → 番号付き回帰テスト追加 →
   `test:release` / ゴールデン緑 → エンジン変更なら再ビルド + `release_manifest.json` 更新。
