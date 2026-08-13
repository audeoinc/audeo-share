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
- VIEW 収集段に `exclude_view_name_patterns`（末尾数字・`test` を含む等を除外）。
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
- **`JOIN ... USING(col)` の結合キー誤検知（直近）**：修飾なしの `col` が複数ソースに
  存在するため `PHYSICAL_COLUMN_AMBIGUOUS`（ERROR）を誤検知（報告例＝全ソース CTE を
  2 回 INNER JOIN + USING）。原因＝パーサは `join.using_columns` を記録するがリゾルバが
  未使用。修正＝SourceResolver が `scope.join_using_columns` に USING 列名を記録し、
  ColumnResolver は該当列を先頭（FROM/左側）ソースへ確定解決（USING は結合キーを 1 論理列へ
  統合＝曖昧でない）。`ON` 結合での同名列は従来どおり曖昧扱い。テスト `test_v1_5_0_056.js`。
- **USING 列が FROM/左側ソースに無いケース（056 の追随修正）**：`SELECT cola FROM tablea
  INNER JOIN aaa USING(id) INNER JOIN bbb USING(cola)` で `cola` が CTE `aaa`/`bbb` にあり
  物理表 `tablea` に無い場合、056 の「先頭ソースへ確定解決」が `tablea` を選び
  `PHYSICAL_COLUMN_NOT_FOUND`。修正＝候補のうち列を公開すると分かっているもの（CTE/派生、
  `#getColumnStatus`==RESOLVED）を優先し、全て物理で確定不能な場合のみ先頭へフォールバック。
  テスト `test_v1_5_0_057.js`。
- **`UNNEST(array) WITH OFFSET AS offset` の別名が予約語 `offset`（直近）**：`SELECT offset
  FROM t, UNNEST(arr) AS e WITH OFFSET AS offset` で、SELECT の `offset` が KEYWORD 字句となり
  SelectParser の暗黙出力名導出（`#deriveColumnAlias`）が IDENTIFIER/BACKTICK のみ受理のため
  出力列が無名→`OUTPUT_COLUMN_NAME_UNRESOLVED`（WARNING）。ExpressionParser は非予約 KEYWORD を
  識別子解決するのに SelectParser だけ弾いていた不整合。修正＝`#isColumnNameToken` を追加し、
  ExpressionParser と同じ予約語基準で非予約 KEYWORD を列名として導出（NULL/TRUE/FALSE 等は無名
  のまま）。テスト `test_v1_5_0_058.js`。
- **`INTERVAL <expr> <part>` の値が算術式（直近）**：`DATE_ADD(d, INTERVAL n * 2 DAY)` /
  `INTERVAL n + 1 DAY` で、値を単項精度（`#parseUnaryExpression`）でしか解析せず `*`/`/`/`+`/`-`
  の後ろの日付単位を取りこぼし、関数引数内で `expected ) but found day`、素の式で INTERVAL 列
  誤解決（`PHYSICAL_COLUMN_NOT_FOUND`）。リテラル値・列値は問題なかった。修正＝値部を加減算精度
  （`#parseAdditiveExpression`）で解析（日付単位は裸のキーワードで必ず手前で停止＝過剰消費なし）。
  値内の列（n 等）も lineage に保持。テスト `test_v1_5_0_059.js`。
- **`CREATE ... AS (SELECT ...)` の括弧付き本体（直近）**：`CREATE OR REPLACE TEMP TABLE t AS
  (SELECT ...)` で「トップレベルの SELECT が見つからない」。括弧なし `AS SELECT ...` は ClauseParser
  が深さ0の SELECT を拾えるが、括弧付きだと SELECT が深さ1に入る。既存 `#stripWrappingParentheses`
  は「先頭が '('」の全体括弧しか剥がさなかった。修正＝深さ0の `AS` 直後の深さ0 `(` で対応 `)` が末尾
  （末尾 ';' 無視）、内側が SELECT/WITH の場合に括弧内クエリを取り出す `#stripStatementBodyParentheses`
  を追加。対象テーブル名はメタデータ側で与えるため前置きは lineage 非寄与。CTE/列別名 AS/スカラー
  サブクエリ AS は非対象。テスト `test_v1_5_0_060.js`。
- **UDF out of memory 対策：メタデータ縮小（SQLのみ）**：対象増加で 03 STEP 3 の JS UDF が
  "Resource exceeded / UDF out of memory"。UDF へ渡す per-object の `physical_columns_json` から
  `data_type` / `is_nullable` を除去（エンジンは内部で伝播するのみでエクスポート出力に含めない＝結果不変）。
  ネスト/複合型の `data_type`（`ARRAY<STRUCT<...>>` 等）は1列のバイト数を支配し得るため、広い/深い
  テーブル参照時のペイロードが大きく縮む。テスト `test_v1_5_0_061.js`。**※これだけでは解消せず**。
- **UDF out of memory 対策：STEP 3 UDF のチャンク分割（SQLのみ）**：診断で対象 2667 件・最大SQL
  64KB・中央値192B と判明＝単一巨大SQLは無く**集約ピーク**が原因。STEP 3 の UDF 実行を全件1クエリ→
  固定件数ループ（`analysis_udf_chunk_size` 既定200、`batch_analysis_input.udf_chunk` で分割、
  `batch_udf_results` を `WHERE FALSE` で空作成後 `INSERT ... WHERE udf_chunk=@i` を chunk_count 回）
  へ変更。**※これだけでは解消せず**（探索パスが未分割で残っていた）。§4.19。
- **UDF out of memory 対策：ソース探索パスのチャンク分割（直近・SQLのみ）**：03 には UDF 全件パスが
  **2つ**あり（①ソース探索 `source_discovery_only` → `changed_definitions_with_discovery`、②STEP 3 解析）、
  ①が未分割で残っていたため STEP 3 の chunk_size を下げても効かなかった。①も同方式でチャンク分割
  （`discovery_udf_chunk_size` 既定200、`WHERE FALSE` で空作成後 `INSERT ... WHERE discovery_chunk=@i`、
  chunk は changed 集合の ROW_NUMBER を chunk_size で DIV）。エンジン不変・BigQuery 未検証。§4.20。

## 5. 現在地（引き継ぎ時点）

- バンドル: `sha256 = 0a31b8c9a86faae55f8108e94b7a237906add0e96da6cd6b823f026371a8e3c5`、`441569` bytes
- `test:release` 41 本 PASS / ゴールデン 48 ケース PASS
- 二本ツリー（-031 / -032）同期済み

## 6. Claude Code で続きを進める手順

1. このリポジトリ一式をローカルの作業ディレクトリ（Git 管理下）に展開する。
2. Claude Code をそのディレクトリで起動する（`CLAUDE.md` が自動で読み込まれる）。
3. 最初に `CHANGELOG.md` 冒頭と本 `docs/SESSION_HANDOFF.md` を読ませて経緯を把握させる。
4. 変更は §4（CLAUDE.md）の必須手順に従う：実装 → 番号付き回帰テスト追加 →
   `test:release` / ゴールデン緑 → エンジン変更なら再ビルド + `release_manifest.json` 更新。
