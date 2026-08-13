# 1.5.0-032

- Also chunked the batch **source-discovery** UDF pass, which the STEP 3 chunking
  had missed. `03_run_daily_lineage_pipeline.sql` runs the JavaScript UDF a
  second time over every changed definition in `source_discovery_only` mode to
  build `changed_definitions_with_discovery` — a separate single-query UDF pass
  across the whole changed set. At large target counts this pass hits the same
  "UDF out of memory" aggregate ceiling, so lowering `analysis_udf_chunk_size`
  alone did not help (it only chunks the analysis pass). Source discovery now
  runs in fixed-size chunks too: new DECLARE `discovery_udf_chunk_size` (default
  200); `changed_definitions_with_discovery` is created empty via the UDF SELECT
  with `WHERE FALSE`, then filled by one `INSERT ... WHERE discovery_chunk =
  @chunk_index` job per chunk (the chunk is `ROW_NUMBER()` over the changed set
  bucketed by the chunk size, so the UDF runs on at most chunk_size rows per
  job). SQL-only change; the engine bundle is unaffected. Not yet validated
  against BigQuery.

- Ran the STEP 3 lineage UDF in fixed-size chunks instead of one query over all
  analyzable objects, to stop "Resource exceeded during query execution: UDF out
  of memory" as the target set grows. Diagnosis on a failing run: 2667 objects,
  max SQL 64 KB, p50 192 B — no single large object, so the peak is aggregate
  (a single query calling the JavaScript UDF across thousands of rows accumulates
  V8 heap in the per-slot UDF context). The prior metadata slimming did not help
  because memory was not metadata-bound. `03_run_daily_lineage_pipeline.sql` now
  numbers analyzable rows into buckets of `analysis_udf_chunk_size` (new DECLARE,
  default 200) via a `udf_chunk` column on `batch_analysis_input`, creates
  `batch_udf_results` empty once (the UDF SELECT with `WHERE FALSE`, fixing the
  schema without invoking the UDF), then loops one `INSERT ... WHERE udf_chunk =
  @chunk_index` job per chunk so each job/context runs at most chunk_size
  invocations. Lower the chunk size if OOM persists; raise it to cut per-run job
  overhead. Trade-off: more sequential jobs than the single-query batch. SQL-only
  change; the engine bundle is unaffected. Not yet validated against BigQuery.

- Reduced the per-object physical-column metadata payload passed to the lineage
  UDF in `03_run_daily_lineage_pipeline.sql` STEP 3, to cut the JavaScript UDF's
  peak memory ("Resource exceeded during query execution / UDF out of memory")
  as the analyzed target set grows. The `physical_columns_json` built per object
  now ships only the fields the engine reads — table_name, column_name,
  field_path, ordinal_position — and drops `data_type` and `is_nullable`. The
  engine parses those two but never emits them in the exported output, so results
  are unchanged; a nested/complex `data_type` signature (e.g.
  `ARRAY<STRUCT<...>>` on GA-style event tables) can dominate a column's bytes,
  so removing it materially shrinks the payload for objects over wide/nested
  tables. The METADATA_TOO_LARGE byte guard now measures the same reduced
  payload. SQL-only change; the engine bundle is unaffected. Test:
  test_v1_5_0_061.js locks the contract that engine output is independent of
  data_type/is_nullable.

- Fixed `CREATE ... AS (SELECT ...)` — a CTAS / CREATE VIEW whose body is a
  parenthesized query, e.g. `CREATE OR REPLACE TEMP TABLE t AS (SELECT ...)`.
  QueryParser raised `トップレベルのSELECT Clauseが見つかりません。` The unparenthesized
  form `CREATE ... AS SELECT ...` worked because ClauseParser finds the SELECT at
  paren depth 0; with the parentheses the SELECT sits at depth 1, and the existing
  `#stripWrappingParentheses` only unwraps a query that *starts* with `(`, not one
  wrapped after a `CREATE ... AS` prefix. QueryParser now also recognizes a
  statement body of the form `... AS (query)` via `#stripStatementBodyParentheses`
  (a depth-0 `AS` immediately followed by a depth-0 `(` whose matching `)` is the
  last meaningful token, inner starting with SELECT/WITH) and re-parses the inner
  query. The target table name comes from the analysis metadata, so the
  `CREATE ... AS` prefix carries no lineage. `WITH t AS (...) SELECT ...`, column
  aliases `x AS y`, and scalar subqueries `(SELECT ...) AS y` are unaffected.
  Test: test_v1_5_0_060.js. Engine change: bundle rebuilt (sha256 0a31b8c9...,
  441569 bytes), release_manifest.json updated; redeploy the UDF bundle to GCS.

- Fixed `INTERVAL <expr> <part>` when the value is an arithmetic expression, e.g.
  `DATE_ADD(d, INTERVAL n * 2 DAY)` / `INTERVAL n + 1 DAY`. As a function argument
  it raised `ExpressionParser: expected ")", but found "day"`; as a bare SELECT
  item it mis-resolved `INTERVAL` as a column (`PHYSICAL_COLUMN_NOT_FOUND`). A
  literal value like `INTERVAL 2 DAY` and a bare column `INTERVAL n DAY` worked.
  Cause: `#parseIntervalExpression` parsed the value at unary precedence
  (`#parseUnaryExpression`), so it stopped before `*` / `/` / `+` / `-` and left
  the trailing date part unconsumed. The value is now parsed at additive
  precedence (`#parseAdditiveExpression`); the date part is a bare keyword (not an
  operator) so arithmetic parsing always stops just before it and never
  over-consumes. Columns inside the interval value (e.g. `n`) are now kept in the
  lineage. Test: test_v1_5_0_059.js. Engine change: bundle rebuilt (sha256
  81667d37..., 437648 bytes), release_manifest.json updated; redeploy the UDF
  bundle to GCS.

- Fixed `UNNEST(array) WITH OFFSET AS offset` when the offset alias is the
  reserved word `offset`. `SELECT offset FROM t, UNNEST(arr) AS e WITH OFFSET AS
  offset` raised a `OUTPUT_COLUMN_NAME_UNRESOLVED` (WARNING) — the output column
  had no resolvable name — while a non-keyword alias like `pos` worked. The
  offset value itself was fine; only the SELECT output name failed. Cause:
  `offset` is lexed as the `OFFSET` keyword, and SelectParser's implicit
  output-name derivation (`#deriveColumnAlias`) accepted only IDENTIFIER /
  BACKTICK tokens, so it could not name a keyword column — even though
  ExpressionParser already resolves non-reserved keywords as identifier (column)
  references. SelectParser now derives the output name for a single bare column
  token via a new `#isColumnNameToken`, which mirrors ExpressionParser's
  reserved-word set (so `OFFSET` and other non-reserved keywords name the
  column, while `NULL`/`TRUE`/`FALSE` and logical/clause keywords stay unnamed).
  Test: test_v1_5_0_058.js. Engine change: bundle rebuilt (sha256 c25189ec...,
  437077 bytes), release_manifest.json updated; redeploy the UDF bundle to GCS.

- Followed up the v1.5.0-056 `JOIN ... USING(col)` fix for the case where the
  USING key is not present in the FROM/left source. v1.5.0-056 resolved an
  unqualified USING column to the first (FROM/left) candidate, but a USING key
  need only exist in one of the joined sources — a physical FROM table may not
  contain it (e.g. `SELECT cola FROM tablea INNER JOIN aaa USING(id) INNER JOIN
  bbb USING(cola)` where `cola` lives in the CTEs `aaa`/`bbb`, not in `tablea`).
  Resolving to `tablea` then raised `PHYSICAL_COLUMN_NOT_FOUND`. ColumnResolver
  now prefers the first candidate that is known to expose the column (a CTE /
  derived source whose output includes it, i.e. `#getColumnStatus` == RESOLVED),
  falling back to the first candidate only when none is definitively known to
  expose it (all sources physical / schema-not-yet-linked). The join key traces
  to that source (here `cola` → the CTE → its physical source). Test:
  test_v1_5_0_057.js. Engine change: bundle rebuilt (sha256 397fb7e4...,
  435847 bytes), release_manifest.json updated; redeploy the UDF bundle to GCS.

- Fixed a false `PHYSICAL_COLUMN_AMBIGUOUS` (ERROR) on the join key of a
  `JOIN ... USING(col)` when the column is referenced unqualified and exists in
  two or more join sources (reported case: two `INNER JOIN`s, all sources CTEs,
  joined with `USING`, no column qualification). The parser recorded the USING
  columns in `join.using_columns`, but the resolver ignored them: SourceResolver
  did not carry USING info onto the scope, and ColumnResolver flagged any
  unqualified column found in 2+ sources as AMBIGUOUS. `USING(col)` merges the
  join key into a single logical column, so such a reference is not ambiguous.
  SourceResolver now records the normalized USING column names on
  `scope.join_using_columns`, and ColumnResolver resolves an unqualified USING
  column deterministically to the first (FROM/left) candidate source instead of
  AMBIGUOUS. Lineage for the join key is attributed to the left source (full
  dual-source union attribution would be a larger change). Genuine ambiguity via
  an `ON` join (same column name in both sources, no USING) still errors. Test:
  test_v1_5_0_056.js. Engine change: bundle rebuilt (sha256 2480400b...,
  435251 bytes), release_manifest.json updated; redeploy the UDF bundle to GCS.

- Added a `labels ARRAY<STRUCT<key STRING, value STRING>>` column to
  `lineage_definition_registry` so a FAILED object can be traced to its source
  DAG (dag_id, task_id, ...) without joining to the job registry. Populated in
  `03_run_daily_lineage_pipeline.sql` STEP 2 from the source job's labels
  (carried through `latest_generated_table_definitions` into the generated-table
  definition-registry MERGE, both the matched UPDATE and the not-matched INSERT).
  Views are unaffected — STEP 1 leaves `labels` unset, so it defaults to NULL.
  The job registry already stored `labels`; this copies them onto the analyzable
  object row. SQL-only change; the engine bundle is unaffected. MIGRATION: 01
  uses CREATE OR REPLACE TABLE (which would drop data), so on an existing
  deployment do NOT re-run 01 — instead `ALTER TABLE <definition_registry> ADD
  COLUMN IF NOT EXISTS labels ARRAY<STRUCT<key STRING, value STRING>>;` and the
  next daily run backfills labels for generated TABLEs.

- Fixed named parameters whose name collides with a clause keyword — @limit,
  @order, @where, @group, @from, @offset, @select — which failed even though
  v1.5.0-052 added @name handling. The lexer emitted '@' and the name as two
  tokens, so the ClauseParser saw the bare keyword token and mistook that
  position for the start of a clause (e.g. "LimitParser: body_start_seq must be
  an integer" for `a = @limit`). The lexer now reads @name / @@name as a single
  PARAMETER token (normalized with the '@', e.g. '@LIMIT'), so it never collides
  with a clause keyword; the expression parser consumes the PARAMETER token as a
  no-lineage literal. Test: test_v1_5_0_055.js. Engine change: bundle rebuilt
  (sha256 7d567a23..., 433565 bytes), release_manifest.json updated; redeploy the
  UDF bundle to GCS.

- Fixed three parser gaps seen in JOBS-collected SQL. (1) Typed STRUCT / ARRAY
  constructors — `STRUCT<f1 T1, f2 T2>(v1, v2)`, `ARRAY<STRUCT<...>>[...]`. The
  angle-bracket type list was read as comparisons, which broke array literals
  ("expected \"]\", but found \"STRING\".") and, for a top-level SELECT item,
  split the item on the comma inside `<...>` so the type field names were
  harvested as columns. Now `STRUCT<...>(...)` / `ARRAY<...>[...]` parse with the
  type skipped (no lineage) and the value/element lineage kept, and the SELECT
  item splitter tracks STRUCT/ARRAY angle depth so `<...>` commas no longer split
  items (plain comparisons `a < b, c > d` are unaffected). (2) A whole query
  wrapped in parentheses — `(SELECT ...)` — reported "トップレベルのSELECT Clauseが
  見つかりません。"; QueryParser now strips a matched outer paren pair (re-normalizing
  paren depth) and re-parses, while `(SELECT ...) UNION ALL (SELECT ...)` is still
  split rather than unwrapped. (3) A parenthesized tuple / row value — `(a, b) IN
  (SELECT ...)` or `(a, b) IN ((1,2),(3,4))` — reported "expected \")\", but found
  \",\"."; the parenthesized-expression parser now returns an EXPRESSION_LIST that
  keeps every element's lineage. Test: `test_v1_5_0_054.js`. Engine change: bundle
  rebuilt (sha256 a4a43b2c…, 433278 bytes), `release_manifest.json` updated;
  redeploy the UDF bundle to GCS.

- Parsed EXTRACT and the WEEK(<WEEKDAY>) date part correctly. `EXTRACT(part FROM
  expr [AT TIME ZONE tz])` was not handled as a special form: in a SELECT item it
  survived via the RAW_EXPRESSION fallback, but in a WHERE / nested context it
  threw "ExpressionParser: expected \")\", but found \"FROM\"." (PARTIAL_FAILURE),
  and identifier-typed tokens inside were mis-harvested as columns — the weekday
  in `EXTRACT(WEEK(MONDAY) FROM dt)` and the `AT` of `AT TIME ZONE` both raised a
  spurious PHYSICAL_COLUMN_NOT_FOUND. Separately, `WEEK(<WEEKDAY>)` as a
  DATE_TRUNC granularity (`DATE_TRUNC(dt, WEEK(MONDAY))`) mis-harvested the
  weekday too. EXTRACT is now parsed as `EXTRACT(datepart FROM source [AT TIME
  ZONE tz])`: the datepart (including `WEEK(<WEEKDAY>)`) carries no lineage, while
  the source expression and any time-zone expression carry lineage (so
  `AT TIME ZONE tz_column` captures tz). `WEEK(<WEEKDAY>)` parses as a no-lineage
  date part wherever it appears. Bare dateparts as ordinary function arguments
  (`DATE_TRUNC(dt, WEEK)`, `DATE_DIFF(a, b, DAY)`) are unaffected. Test:
  `test_v1_5_0_053.js`. Engine change: bundle rebuilt (sha256 ea17ae4c…, 426507
  bytes), `release_manifest.json` updated; redeploy the UDF bundle to GCS.

- Handled BigQuery named query parameters `@name` (and `@@system_variable`) in
  the expression parser, e.g. dbt-style `@key` placeholders that appear in
  JOBS-collected SQL. The lexer emits `@` as its own token and the parser had no
  primary for it, so `WHERE c = @key` threw "ExpressionParser: token \"@\" cannot
  start an expression" (PARTIAL_FAILURE), and `SELECT @key` degraded to
  RAW_EXPRESSION and mis-harvested the parameter name as a bare column (spurious
  PHYSICAL_COLUMN_NOT_FOUND). `@name` / `@@name` now parse as a LITERAL_EXPRESSION
  of kind "PARAMETER": a parameter is an external scalar value, not a table
  column, so it carries no lineage. The name after `@` is consumed even when it
  is a reserved keyword (`@end`, `@order` are valid parameter names). Real column
  lineage in the same statement is preserved. Test: `test_v1_5_0_052.js`. Engine
  change: bundle rebuilt (sha256 ff86d618…, 424573 bytes), `release_manifest.json`
  updated; redeploy the UDF bundle to GCS.

- Fixed "FromParser: JOIN was expected, but found \"-\"." for an unquoted dashed
  table path in FROM — most commonly a dashed project id, e.g.
  `FROM my-project.dataset.table` or `my-project-123.dataset.table`. The lexer
  splits `my-project` into `my` `-` `project`, and FromParser#parseTableSource
  only walked '.'-separated parts, so it stopped at the first '-' and reported a
  spurious JOIN-expected error (PARTIAL_FAILURE). Two changes: (1)
  FromParser#parseTableSource now merges hyphen-joined tokens (and numeric
  segments) into one path part (`my - project` -> MY-PROJECT); (2) the lexer no
  longer swallows a '.' into a number when the '.' is immediately followed by an
  identifier-start character, so `my-project-123.dataset` tokenizes as `123` `.`
  `dataset` (path separator) rather than `123.` `dataset`. Real float literals
  (1.5, 1., 1.5e3, 3.14) are unaffected, and backtick-quoted paths
  (`` `my-project.d.t` ``) already worked. Known limitation: a segment that mixes
  digits and letters with no separator (e.g. `my-2nd`) is still mis-lexed;
  backtick-quote such paths. Test: `test_v1_5_0_051.js`. Engine change: bundle
  rebuilt (sha256 526f9433…, 422958 bytes), `release_manifest.json` updated;
  redeploy the UDF bundle to GCS.

- Fixed "SelectParser: SELECT item 1 has no expression" for a string literal
  whose contents spell a SELECT set-quantifier, e.g. `SELECT 'ALL' AS col1`.
  SelectParser#removeSelectModifiers strips a leading SELECT ALL / SELECT DISTINCT
  quantifier (and the AS STRUCT / AS VALUE modifier) before the first item's
  expression is parsed, but it matched on normalized_token alone. A string literal
  `'ALL'` / `'DISTINCT'` (token_type STRING, normalized_token "ALL"/"DISTINCT")
  was mistaken for the quantifier and stripped, leaving the first item with no
  expression (PARTIAL_FAILURE). The modifier checks now also require
  token_type === "KEYWORD", so a quoted string is never treated as a modifier;
  genuine SELECT ALL / DISTINCT / AS STRUCT|VALUE are unaffected. Test:
  `test_v1_5_0_050.js`. Engine change: bundle rebuilt (sha256 2d485eb…, 420900
  bytes), `release_manifest.json` updated; redeploy the UDF bundle to GCS.

- Fixed a spurious PHYSICAL_COLUMN_NOT_FOUND for field access on a function-call
  result, e.g. the GA4 pattern `fn('key', event_params).string_value`. The
  postfix parser handled `OVER` and array subscripts `[ ... ]` but not a `.field`
  access following a completed value expression (a function call, a parenthesized
  expression, or a subscript). Such an item degraded to RAW_EXPRESSION, which
  harvested the trailing field name as a bare unqualified column reference, so
  `.string_value` was resolved against the physical tables, not found, and raised
  an ERROR (COMPLETED_WITH_ERRORS -> non-publishable / FAILED) even though
  `string_value` is a nested struct field, not a top-level column. The parser now
  parses `base.field` on a call/parenthesized/subscript result. Mirroring the
  array-subscript design (position keywords carry no lineage), the accessed field
  selects from an opaque/derived value (the function's return STRUCT) and carries
  NO physical-column lineage; only the base expression's lineage is kept — so the
  output still depends on the function argument (`event_params`, broadly all of
  its collected field paths) and the trailing `.string_value` no longer resolves
  as a column. Identifier chains like `event_params.value.string_value` (a struct
  field path on a real column) are unaffected — they are consumed before the
  postfix stage. Test: `test_v1_5_0_049.js`. Engine change: bundle rebuilt
  (sha256 b14244de…, 420340 bytes), `release_manifest.json` updated; redeploy the
  UDF bundle to GCS.

- Stopped treating a generated/DAG table as FAILED when the only problem is that
  a source it references no longer exists. Such sources (temporary or short-lived
  tables) have no collected columns, so the engine reports PHYSICAL_METADATA_NOT_
  FOUND / SOURCE_METADATA_NOT_COLLECTED (WARNING), which alone pushed the object
  to COMPLETED_WITH_WARNINGS -> non-publishable -> registry FAILED, a
  UDF_RESULT_NOT_PUBLISHABLE diagnostic, and is_changed = TRUE (retried every
  run). STEP 3 now distinguishes the two causes using INFORMATION_SCHEMA.TABLES
  (new `batch_object_source_flags`): a discovered source absent from
  INFORMATION_SCHEMA.TABLES is genuinely gone (expected), while a source present
  in TABLES but with no collected columns is a real coverage gap. An analyzed
  object is now publishable when its status is exactly COMPLETED, OR
  COMPLETED_WITH_WARNINGS with no present-but-uncollected source (i.e. its
  warnings are explained entirely by absent sources). Publishable objects finish
  normally: resolved dependencies are published, the absent-source warnings are
  NOT written to lineage_diagnostic, registry -> COMPLETED with is_changed =
  FALSE (no more retries). Objects with a real ERROR (e.g. a column missing from
  a source that DOES exist -> PHYSICAL_COLUMN_NOT_FOUND), a PARTIAL_FAILURE, or a
  present-but-uncollected source are unchanged (still surfaced and FAILED). Note:
  an object that mixes an absent-source warning with an independent real error
  stays FAILED and keeps all of its diagnostics. SQL-only change (STEP 3 publish
  classification); the engine bundle is unaffected. As with the other STEP 3
  work, validate on BigQuery before production.

- Added dataset-level counterparts to the registry and analysis name filters in
  `03_run_daily_lineage_pipeline.sql`, so filtering can now target whole datasets
  in addition to object names. New parameters (all default `[]` = no effect):
  `registry_exclude_dataset_patterns`, `analysis_include_dataset_patterns`,
  `analysis_exclude_dataset_patterns`. Semantics: REGISTRY-stage exclusion drops
  an object when its name matches any `registry_exclude_object_patterns` entry OR
  its dataset matches any `registry_exclude_dataset_patterns` entry (STEP 1 Views
  on object_dataset, STEP 2 generated TABLEs on destination_dataset). ANALYSIS-
  stage selection now gates name and dataset independently: an object is analyzed
  when (name-include empty OR name matches) AND (dataset-include empty OR dataset
  matches) AND it matches no name-exclude AND no dataset-exclude. All matching is
  the existing case-insensitive `REGEXP_CONTAINS(LOWER(value), LOWER(pattern))`.
  The existing `*_object_patterns` behavior is unchanged, and because every new
  array defaults to empty, runtimes that do not set them are unaffected. SQL-only
  change; the engine bundle is unaffected.

- Rewrote STEP 3 of `03_run_daily_lineage_pipeline.sql` from a per-object
  `FOR ... DO` loop into a fully set-based batch pipeline. The loop previously
  ran ~15-20 EXECUTE IMMEDIATE statements per changed object (two UDF calls plus
  metadata scoping, staging, and per-object DELETE/INSERT/UPDATE), i.e. ~15-20N
  serial BigQuery jobs for N changed objects. The batch form runs a fixed,
  N-independent set of statements: (1) scope physical-column metadata for all
  objects in one query; (2) invoke the persistent lineage UDF once across every
  analyzable object (`batch_udf_results`), paying the JavaScript UDF
  initialization cost once for the whole run; (3) stage dependencies and
  diagnostics for all objects with set queries; (4) publish with a handful of
  set-based DELETE/INSERT/UPDATE statements keyed by object-key temp tables
  (`batch_completed_objects` / `batch_udf_failed_objects` /
  `batch_preanalysis_failures`). On a run with N changed objects this collapses
  the STEP 3 job count from ~15-20N to a small constant.
  SEMANTICS PRESERVED: COMPLETED objects replace their direct dependencies and
  diagnostics; non-COMPLETED UDF results keep their last known-good dependencies
  (ADR-0004) while diagnostics are replaced and a UDF_RESULT_NOT_PUBLISHABLE row
  is recorded; pre-analysis failures (source discovery not COMPLETE, or scoped
  metadata over the single-call limit) leave dependencies untouched, append an
  ANALYSIS_EXECUTION_FAILED diagnostic, and mark the registry FAILED. The
  non_completed_udf_results result set is populated as before.
  BEHAVIOR CHANGE: publication is now batch-atomic instead of per-object. All
  staging is computed before any write; the destructive DML runs in a block that
  restores the affected direct_dependency / lineage_diagnostic rows from
  pre-publish backups and re-raises on any error, so a failed run leaves the
  repository unchanged rather than partially updated. A single object can no
  longer be committed while a sibling is skipped mid-run. Because the UDF returns
  analysis_status instead of throwing, per-object analysis failures remain
  isolated as data. SQL-only change; the engine bundle is unaffected.
  VALIDATION: this rewrite has not yet been executed against BigQuery from this
  environment. Before production use, run a dry-run parse and a staging run, and
  diff its direct_dependency / lineage_diagnostic / definition_registry output
  against the previous per-object pipeline on the same changed set.

- Sped up STEP 3 by hoisting source discovery out of the per-object loop in
  `03_run_daily_lineage_pipeline.sql`. The persistent UDF is a per-row scalar
  function, so source_discovery_only mode is now run ONCE across every changed
  definition (new `changed_definitions_with_discovery` temp table:
  `SELECT ..., UDF(definition_text, '[]', {source_discovery_only:TRUE}, NULL)
  FROM changed_definitions_to_analyze`) instead of a separate per-object UDF
  query inside the loop. The loop now reads `target.source_discovery_json`
  directly, so the object's UDF invocations drop from two (discovery + full
  analysis) to one, and the JavaScript UDF initialization cost for discovery is
  paid a single time per run rather than once per changed object. On a run with
  N changed objects this removes N-1 discovery jobs (2N → N+1 UDF jobs total)
  plus N-1 UDF cold starts. BEHAVIOR NOTE: no functional change. Per-object
  isolation is preserved because source_discovery_only never throws — it returns
  analysis_status = 'PARTIAL_FAILURE' with an error payload for a failing object,
  so the loop's existing status check + RAISE still routes that object to its own
  EXCEPTION handler (previous dependency rows preserved per ADR-0004). SQL-only
  change; the engine bundle is unaffected.

- Renamed the three name-based object filters in
  `03_run_daily_lineage_pipeline.sql` so the parameter name states which stage it
  acts on — and therefore whether a matched object is merely skipped for analysis
  or kept out of the registry entirely — and made both filter families
  consistently object-scoped. Mapping:
  `include_object_patterns` → `analysis_include_object_patterns`,
  `exclude_object_patterns` → `analysis_exclude_object_patterns`,
  `exclude_view_name_patterns` → `registry_exclude_object_patterns`. The
  `analysis_*` pair gates only lineage analysis (matched objects stay registered
  and keep change tracking; applies to VIEWs and, when
  process_generated_tables = TRUE, generated TABLEs). `registry_exclude_object_patterns`
  keeps matched objects out of the registry entirely: Views are dropped in STEP 1
  before entering the definition registry (an already-registered View is
  deactivated), and — newly — generated TABLEs are dropped in STEP 2 (matched on
  the destination table name) before entering the job / definition registry, so
  the filter is now genuinely object-scoped rather than VIEW-only. The
  `registry_*` DECLARE is now ordered before the `analysis_*` DECLAREs to match
  execution order (collection/STEP 1 precedes analysis/STEP 3-4). The dynamic-SQL
  bind names (`@include_patterns` / `@exclude_patterns`) are unchanged. BEHAVIOR
  NOTE: the only behavior change is that `registry_exclude_object_patterns` now
  also filters generated tables in STEP 2; because all three default to `[]`
  (exclude nothing / analyze all), a runtime that leaves them empty is unaffected.
  MIGRATION: if you set any of these in your runtime copy, rename them to the new
  identifiers (values and semantics for the `analysis_*` pair are unchanged; the
  former view-name exclusion now also applies to generated-table names). SQL-only
  change; the engine bundle is unaffected.

- Fixed column resolution for mixed qualified/unqualified references across a
  `SELECT *` CTE that is joined to another source. A CTE whose body is
  `SELECT * FROM <physical_table>` exposes an *unknown* set of columns at the
  name-resolution stage (the `*` pulls in physical columns that are only known
  once metadata is applied), but the ColumnResolver treated it as exposing *zero*
  columns. When such a CTE was the FROM side of a `LEFT JOIN` against a physical
  table (both aliased), an unqualified column belonging to the CTE was bound to
  the JOIN side and reported `PHYSICAL_COLUMN_NOT_FOUND` (no rescue fired, because
  a wrong single candidate had already been selected), and even a *qualified*
  reference into the CTE (`x.col`) was reported `UNRESOLVED_COLUMN`. Root cause:
  `#getWildcardExposedColumns` skipped physical/UNNEST sources, so a wildcard over
  them collapsed to an empty column set instead of "unknown". Fix: a wildcard that
  pulls from a source whose columns are unknown (physical table, UNNEST, or an
  unknown child scope) now propagates "unknown" (`null`) rather than an empty set,
  so the CTE stays a candidate source and the physical resolver disambiguates the
  reference using real metadata. Covered by `test/test_v1_5_0_048.js`. Engine
  change → the bundle was rebuilt; re-upload `lineage_udf_bundle.js` to GCS (no
  SQL change).
- Added array element access (subscript) parsing to the expression engine.
  Previously the parser handled only the `OVER` postfix, so
  `array_expr[OFFSET(n)]`, `[SAFE_OFFSET(n)]`, `[ORDINAL(n)]`, `[SAFE_ORDINAL(n)]`
  (and a generic `[expr]`) raised a parse error. Postfix `[...]` is now parsed:
  the position keyword itself carries no lineage, and the element value traces to
  the array expression's source column(s); a column referenced inside the index is
  also captured. Works in SELECT, WHERE, etc., and chains. Covered by
  `test/test_v1_5_0_047.js`. Engine change → the bundle was rebuilt; re-upload
  `lineage_udf_bundle.js` to GCS (no SQL change).
- Made all dataset/object name regex filters in
  `03_run_daily_lineage_pipeline.sql` case-insensitive. Previously the name side
  was lowercased but the pattern was not, so an uppercase pattern never matched a
  (lowercased) name and the dataset/object was silently dropped. Now both sides
  are lowercased (`REGEXP_CONTAINS(LOWER(name), LOWER(pattern))`), so a pattern
  matches regardless of the case it is written in. Applies to
  `source_project_filters` (dataset_include/exclude_patterns),
  `target_dataset_include/exclude_patterns`, `exclude_view_name_patterns`, and
  `include_object_patterns` / `exclude_object_patterns`.
- Tidied dead configuration in `03_run_daily_lineage_pipeline.sql` (no behavior
  change). Removed the two unused `render_dynamic_sql` placeholders `__REPOSITORY__`
  and `__TARGET__` (no template referenced them), and removed the now-vestigial
  `target_dataset` scalar that existed only to build `__TARGET__` — its DECLARE,
  its SET, the `render_dynamic_sql` parameter, and the argument at all 37 call
  sites. The renderer is now 8 placeholders / 9 parameters. `target_datasets`
  (plural, the resolved scan scope) and the direct-dependency `target_dataset`
  column are unchanged.
- Unified dataset filtering on regex and tidied the environment block in
  `03_run_daily_lineage_pipeline.sql`. `source_project_filters` now uses
  `dataset_include_patterns` / `dataset_exclude_patterns` (`ARRAY<STRING>` regex,
  matched via `REGEXP_CONTAINS` on the lowercased name, multiple patterns per
  list) instead of the previous single LIKE `dataset_filter` / `dataset_exclude`,
  so it matches the `target_dataset_*_patterns` convention added above — the whole
  pipeline now selects datasets by regex. Empty include list = every dataset in
  the region; empty exclude = exclude none. MIGRATION: rewrite existing source
  patterns from LIKE to regex (e.g. `dataset_filter = '%sales%'` →
  `dataset_include_patterns = [r'sales']`; `'%'` / all → `[]`). Also moved
  `job_region` to the top of the runtime environment settings (it is the
  single region for repository, target Views, source metadata, and JOBS, and must
  equal `SET @@location`).
- `target_datasets` (the View analysis scope in
  `03_run_daily_lineage_pipeline.sql`) is now resolved by region + regex instead
  of an explicit list. Two new parameters, `target_dataset_include_patterns` and
  `target_dataset_exclude_patterns` (`ARRAY<STRING>` of regex, default empty),
  drive a scan of the target project's datasets in `job_region`
  (`INFORMATION_SCHEMA.SCHEMATA`): a dataset is kept when it matches ANY include
  pattern (or include is empty = all) AND matches NO exclude pattern
  (`REGEXP_CONTAINS`, lowercased). The resolved list feeds the existing STEP 1
  View collection and the View not-found deactivation exactly as before. (JOBS
  collection is unchanged — it is region-scoped and never used `target_datasets`.)
  Note: this affects `03` only; `01`/`04`/`05` keep their own `bootstrap_*`
  values, which are used for the setup smoke test and validation, not the scan.
- Added a collection-stage VIEW name exclusion in
  `03_run_daily_lineage_pipeline.sql`: `exclude_view_name_patterns`
  (`ARRAY<STRING>` of regex, default empty). In STEP 1, any View whose name
  matches ANY pattern (partial match via `REGEXP_CONTAINS` on the lowercased name)
  is dropped from `current_view_definitions` before the registry MERGE, so it
  never enters the definition registry; a previously-registered View that now
  matches is deactivated by the existing STEP 1 not-found rule. This is stronger
  than `exclude_object_patterns` (which keeps the row and only skips analysis).
  Example — exclude names ending in a digit and names containing "test":
  `[r'[0-9]$', r'test']`.
- Analyze each structurally-identical JOBS SQL once, keyed by a literal-normalized
  fingerprint, splitting on whether the destination table persists. Engine: added
  `fingerprintSqlForBigQuery(sql)` — it lexes the SQL, replaces STRING/NUMBER
  literals with `?`, drops comments, and normalizes identifier/keyword case,
  returning a canonical string; SQL that differs only in literals yields the same
  fingerprint, structural differences a different one (covered by
  `test/test_v1_5_0_046.js`). Setup (01): registers a companion persistent scalar
  UDF `fingerprint_lineage_sql(sql)` from the same GCS bundle, and adds
  `sql_fingerprint` and `is_ephemeral` columns to the definition registry plus
  `sql_fingerprint` to the job registry. Pipeline (03): computes `sql_fingerprint`
  for every collected job, then builds the representative set with a split:
    - PERSISTENT — the destination table exists AND has no table expiration set:
      kept per destination with its real identity, so a downstream object
      referencing it still chains through it (e.g.
      `CREATE TABLE dst AS SELECT * FROM view`). `definition_hash` stays the
      SHA256 of the definition text. `is_ephemeral = FALSE`. Deactivated when no
      matching non-expiring table remains (dropped, or an expiration was added).
    - EPHEMERAL — the destination does not exist, OR it exists but has an
      `expiration_timestamp` (temp / rotating-name jobs such as
      `CREATE TEMP TABLE AS SELECT`, an expiring dated table, or a scheduled
      `SELECT` whose result lands in a rotating anonymous table): collapsed by
      fingerprint to one stable
      synthetic object `<target_project>.<ephemeral_object_dataset_label>.fp_<hash>`
      (default label `ephemeral_generated_sql`), analyzed once. `definition_hash`
      is set to the fingerprint (a later literal-only change does not re-trigger
      analysis), `is_ephemeral = TRUE`. Because the identity is fingerprint-stable,
      a recurring job refreshes the same row (no churn); it is aged out
      (`is_active = FALSE`, `INACTIVE_FINGERPRINT_NOT_SEEN`) when its fingerprint
      stops appearing in JOBS within the lookback window.
  Table expiration is read by joining `INFORMATION_SCHEMA.TABLE_OPTIONS`
  (`option_name = 'expiration_timestamp'`) into `current_target_tables`. This lets
  temp/rotating DAG jobs — including ones that write to real but expiring dated
  tables — be analyzed exactly once, while preserving per-destination traceability
  for real, non-expiring generated tables. Views are unchanged and
  always analyzed individually. Edge case: two *distinct persistent* tables with a
  byte-identical fingerprint are still kept separate (each exists); only
  non-persistent destinations are collapsed. NOTE: because 01 recreates the
  repository tables (`CREATE OR REPLACE TABLE`) to add the new columns, re-run 01
  after upgrading; an existing `lineage_job_registry` reached only through 03's
  `CREATE TABLE IF NOT EXISTS` will not gain the column on its own.

- Retired the typed `lineage_config` table. It was not a functional dependency of
  the daily pipeline — `03_run_daily_lineage_pipeline.sql` already declared all
  runtime settings itself and never read the table — so it only duplicated values
  already set elsewhere. `01_setup_lineage_environment.sql` no longer creates,
  seeds, or reads it (section 2 is now bootstrap validation; the setup steps use
  the `bootstrap_*` values directly for the UDF, smoke test, and summary).
  `04_validate_lineage_environment.sql` no longer loads the config row (the
  "lineage_config table exists" check was removed); its checks now compare the
  live repository against the script's own `bootstrap_*` expected values.
  `03_run_daily_lineage_pipeline.sql` dropped the unused `__T_CONFIG__`
  placeholder / `table_config` / `repo_tables.config`, and
  `05_repository_integration_test.sql` reads the impact-rank cap from a bootstrap
  parameter instead of the table. Note: shared scalars (repository/UDF
  project·dataset·location) still appear in both 01 and 03 because they are
  separate scripts; the table did not unify them (03 ignored it), so removing it
  drops an unused third copy rather than adding duplication.

- Moved execution service-account configuration into the pipeline and retired the
  `lineage_execution_account_config` table. `03_run_daily_lineage_pipeline.sql`
  now declares `scheduled_query_service_accounts` and `dag_service_accounts` in a
  new top-level STEP 2 parameter block instead of reading them from the
  repository table (the table load + `__T_EXEC_ACCOUNT__` placeholder were
  removed). `01_setup_lineage_environment.sql` no longer creates/seeds that table
  (section 3 removed) and `04_validate_lineage_environment.sql` no longer
  validates it (result ids 22-24 removed); stale references in
  `06_analyze_changed_objects.sql` and the integration test plan were updated. The
  whole pipeline is now configured in a single file.
- Parameterized the meaningful JOBS-extraction knobs in
  `03_run_daily_lineage_pipeline.sql` (top-level DECLAREs): `initial_lookback_days`
  / `incremental_lookback_days` (hoisted from STEP 2), `collected_statement_types`
  (was a hardcoded `statement_type IN ('SELECT','CREATE_TABLE_AS_SELECT')`, now an
  `IN UNNEST(@statement_types)` array parameter), and `require_scheduled_query_label`
  (when FALSE, Scheduled Query jobs are classified by service account alone).
  Correctness invariants (`job_type = 'QUERY'`, `state = 'DONE'`,
  `error_result IS NULL`, non-null `query` / `destination_table`) remain hardcoded
  in the WHERE clause by design.

- Sanitized environment-identifying strings across the entire tree. The concrete
  project id was replaced with the placeholder `project_id` (uppercase
  `PROJECT_ID`), the concrete dataset with `dataset` (uppercase `DATASET`), the
  concrete GCS bundle bucket/path with `gs://YOUR_BUCKET/YOUR_PATH/...`, and an
  illustrative include/exclude regex example with `r'^stg_'`. Service-account
  defaults became `project_id@appspot.gserviceaccount.com`. Applied to SQL, docs,
  and test fixtures/golden expected outputs alike; the JS engine `src/` never
  contained these strings, so the bundle is byte-for-byte unchanged. All release +
  golden tests pass with the placeholders.
- Setup (`sql/setup/01_setup_lineage_environment.sql`): repository tables are now
  created with `CREATE OR REPLACE TABLE` instead of `CREATE TABLE IF NOT EXISTS`
  (config, execution-account config, definition registry, direct dependency,
  impact, diagnostic, and job registry), so a re-run rebuilds the table schemas
  in place. Note: `CREATE OR REPLACE TABLE` drops and recreates each table, so
  any existing rows are removed on re-run — the `MERGE` seeds re-populate the
  configuration tables, but the transactional lineage tables start empty.
- Setup (`sql/setup/01_setup_lineage_environment.sql`): dataset (`CREATE SCHEMA`)
  creation is now disabled (commented out) for both the repository (table)
  dataset and the UDF/function dataset. Both datasets are expected to already
  exist; the script now only creates/replaces the tables and the UDF within
  them. The blocks are left in place (commented) so they can be re-enabled if
  needed.

- Stopped reporting `WITH RECURSIVE` self-references as a false cycle. A recursive
  CTE's recursive term legitimately references the CTE itself
  (`... UNION ALL SELECT a.itm_cd FROM cte_rec a JOIN cte_c b ...`); the lineage
  resolver's cycle guard flagged the re-entry as `CYCLE_DETECTED`, producing a
  false `PARTIALLY_RESOLVED` ("Unresolved: a.itm_cd @scope N [cycle detected]").
  Recursive CTE body scopes are now tracked (from the `recursive` flag the source
  resolver already records), and re-entry into a recursive CTE's own output
  terminates benignly (`NO_COLUMN_DEPENDENCY`) — the base term supplies the
  lineage and the recursive term adds no new physical source. Non-recursive
  re-entry still yields `CYCLE_DETECTED`. Covered by `test/test_v1_5_0_045.js`.

- Hardened derived-scope resolution against a false `CYCLE_DETECTED` on
  self-joined CTEs. A qualified reference into a self-joined CTE
  (`table_a AS x LEFT JOIN table_a AS y`, `y.col`) could have its derived scope
  resolved to the referencing scope itself; the existing self-reference
  correction only fired when the scope had exactly one local derived source, so a
  self-join (two derived sources sharing one child scope) fell through and
  produced a self-cycle (`col_a → col_b @scope N [CYCLE_DETECTED]`,
  PARTIALLY_RESOLVED). The resolver now discards a derived scope equal to the
  referencing scope (impossible in a non-recursive query) and selects the derived
  source by the reference qualifier, falling back to the sole / single-child-scope
  derived source (preserving the PIVOT-in-outer-subquery case). Covered by
  `test/test_v1_5_0_044.js`.

- Parsed aggregate / navigation function argument suffixes. `IGNORE NULLS` /
  `RESPECT NULLS` (and an aggregate `ORDER BY` / `LIMIT` / `HAVING MAX|MIN`)
  inside a function call were not handled, so strict parsing failed and the raw
  fallback treated `IGNORE` / `RESPECT` as a column
  (`PHYSICAL_COLUMN_NOT_FOUND` / "Unresolved: IGNORE"). `#parseFunctionCall` now
  consumes these suffixes: NULL treatment and `LIMIT` carry no lineage, while
  `ORDER BY` / `HAVING MAX|MIN` expressions are captured as dependencies. Covers
  `ARRAY_AGG(x IGNORE NULLS ORDER BY ts LIMIT 5)`,
  `FIRST_VALUE(x IGNORE NULLS) OVER (...)`, `STRING_AGG(x, sep ORDER BY y)`, and
  `ARRAY_AGG(DISTINCT x IGNORE NULLS)`. Covered by `test/test_v1_5_0_043.js`.

- Allowed conditionless `[LEFT|INNER] JOIN UNNEST(...)` and added array-literal
  parsing. BigQuery permits a correlated UNNEST join without ON/USING, but the
  FromParser only allowed it when the array expression textually referenced a
  visible source name, so a bare/unqualified array column
  (`LEFT JOIN UNNEST(items)`), a no-left-alias form, or a CTE-column array raised
  `FromParser: LEFT JOIN requires ON or USING condition.`. Any non-CROSS join
  whose right source is `UNNEST` may now omit the condition; ordinary joins still
  require ON/USING. Array literals `[ ... ]` (e.g. `UNNEST([1,2,3])`,
  `SELECT [STRUCT(...)]` in a strict-parse context) now parse as expressions.
  Covered by `test/test_v1_5_0_042.js`.

- Resolved field access over `UNNEST(<column>)` and stopped reporting
  constant/no-physical dependencies as PARTIALLY_RESOLVED. Field access on an
  UNNEST of a bare column previously stopped at `UNNEST_DEFERRED` and surfaced as
  a false `PARTIALLY_RESOLVED` (which propagated downstream, e.g. into
  `ROW_NUMBER() ... PARTITION BY`). Now `#resolveCorrelatedUnnestReference`
  resolves the element field against the array's owning source: a physical
  repeated STRUCT (GA4 `UNNEST(event_params)` with `ep.key`,
  `ep.value.string_value`, or the no-alias bare `key`/`value`) resolves to the
  nested `field_path` (`event_params.key`, …); an UNNEST over a STRUCT-literal or
  other derived array (e.g. `WITH cte AS (SELECT [STRUCT('v' AS aaa, ...)] AS str)
  ... FROM cte, UNNEST(str)`) has no upstream physical column, so its element
  fields resolve as constants. An unqualified field with no matching physical or
  derived sibling but exactly one UNNEST source in scope is routed to that UNNEST.
  In the lineage resolver, the "resolved but no physical dependency" statuses
  (`UNNEST_CONSTANT`, `UNNEST_OFFSET`, `PSEUDO_COLUMN_RESOLVED`) now become a
  RESOLVED constant dependency (no physical edge, no warning) instead of an
  unresolved dependency. Covered by `test/test_v1_5_0_041.js`.

- Resolved nested STRUCT field references (e.g. GA4 `geo.region`,
  `device.web_info.browser`). The ColumnResolver reads `a.b` as qualifier `a` /
  column `b` and, finding no source aliased `a`, marked it UNRESOLVED_SOURCE, so
  nested fields never resolved even though `COLUMN_FIELD_PATHS` metadata was
  collected and present. The PhysicalColumnResolver now resolves a qualified,
  otherwise-unresolved reference as a STRUCT field path by matching the full
  `reference_name` against a scope source's `field_path` metadata (works for
  arbitrary depth). For an alias-qualified reference (`t.geo.region`) that already
  resolved to a source, the leading alias is stripped and the remaining path is
  matched exactly against `field_path`, so it resolves to just `geo.region`
  instead of also attaching the top-level `geo` struct column. Covered by
  `test/test_v1_5_0_040.js`. (COLUMN_FIELD_PATHS was already collected by
  `03_run_daily_lineage_pipeline.sql`; this was an engine resolution gap.)

- Fixed wildcard-table (GA4 `events_*`) metadata scoping in
  `03_run_daily_lineage_pipeline.sql`. Source discovery returns the wildcard name
  verbatim (e.g. `project.analytics_123.events_*`), but the per-view metadata
  scoping (`discovered_metadata_tables`) matched discovered sources to metadata by
  exact name equality, so `events_*` never matched a shard (`events_20240101`) and
  the UDF received no columns → `PHYSICAL_METADATA_NOT_FOUND`. The scoping step now
  matches wildcard sources against shard tables by pattern (REGEXP_CONTAINS, with
  `.`→`\.` and `*`→`.*`; BigQuery LIKE has no ESCAPE clause), keeps a
  single representative shard per source (GA shards share one schema, so every
  daily shard is not pulled into the metadata), and relabels the columns back to
  the wildcard identity (`events_*`) so lineage is stable across days instead of
  pointing at a dated shard. Non-wildcard sources keep exact-match behavior.
  (Requires the sharded dataset to be within the configured metadata-collection
  scope, i.e. covered by `source_project_filters` and not excluded, so the shard
  columns are present in `current_target_columns`.) The JS engine already resolves
  a wildcard source against relabeled metadata; no bundle change.

- Handled `GROUP BY ALL`. The `ALL` keyword was parsed as a grouping expression
  and mis-resolved to a column (`PHYSICAL_COLUMN_NOT_FOUND` for "ALL"). The
  GroupByParser now recognises the `GROUP BY ALL` form and emits no grouping
  column reference (grouping-key lineage is carried by the SELECT items).

- Supported wildcard tables and pseudo-columns. `FROM \`project.dataset.events_*\``
  now resolves its columns from the collected shard-table schemas (matching the
  `events_*` pattern against the metadata), so downstream columns resolve instead
  of reporting `PHYSICAL_METADATA_NOT_FOUND`. The pseudo-columns `_TABLE_SUFFIX`,
  `_TABLE_DATE`, `_PARTITIONTIME`, `_PARTITIONDATE`, and `_FILE_NAME` are now
  recognised and resolved with no dependency instead of raising
  `PHYSICAL_COLUMN_NOT_FOUND`.

- Resolved `UNNEST` value lineage. A reference to the whole UNNEST element
  (`UNNEST(item_id) AS item_id`, or `UNNEST(t.items) AS x`) now traces back to the
  underlying array column/field instead of stopping at `UNNEST_DEFERRED`; the
  `WITH OFFSET` position column is treated as a no-lineage integer. This completes
  the earlier UNNEST-value change that only removed the hard error.

- Broadened common BigQuery syntax coverage after a parser sweep. Each of these
  previously aborted parsing (PARTIAL_FAILURE), mis-read a keyword as a column
  (spurious PHYSICAL_COLUMN_NOT_FOUND), or raised a hard ERROR:
  - Typed literals `DATE '...'`, `TIMESTAMP '...'`, `DATETIME '...'`,
    `TIME '...'`, `NUMERIC '...'`, `BIGNUMERIC '...'`, `BYTES '...'`,
    `JSON '...'` (a type keyword followed by a string literal; `DATE(...)` etc.
    still parse as function calls).
  - `INTERVAL n UNIT` / `INTERVAL expr UNIT [TO UNIT]` (a column-valued interval
    keeps its dependency).
  - Raw and bytes string prefixes in the lexer: `r'...'`, `b'...'`, and the
    `rb`/`br` combinations, for both quote styles.
  - Scientific-notation numeric literals (`1.5e3`, `2E-4`) in the lexer.
  - `x [NOT] IN UNNEST(array_expr)`.
  - `INTERSECT` / `EXCEPT` set operators with `DISTINCT`/`ALL`, disambiguated
    from the `SELECT * EXCEPT(col)` column-exclusion syntax.
  - `UNNEST(...) [AS v] WITH OFFSET [AS off]` in the FROM clause.
  - The named `WINDOW` clause (`... WINDOW w AS (...)`).
  - `TABLESAMPLE SYSTEM (n PERCENT)`.
  - A reference to an `UNNEST` value/offset alias (e.g. `SELECT v FROM t,
    UNNEST(arr) AS v`) now resolves to that source instead of raising a hard
    `PHYSICAL_COLUMN_NOT_FOUND`; element-to-array lineage for a bare `UNNEST`
    value remains deferred (reported as a LINEAGE warning, not an error).
  Covered by `test/test_v1_5_0_038.js`. Known remaining niche gaps (left as-is):
  `EXTRACT(WEEK(<WEEKDAY>) FROM ...)` and query parameters `@param` (the latter
  cannot appear in a view definition).

- Added `LIKE` / `NOT LIKE` operator support to the ExpressionParser. The parser
  had no rule for `LIKE`, so any predicate using it (e.g. `col_b LIKE '110%'`)
  raised `ExpressionParser: unexpected token "LIKE"`, which aborted source
  discovery (`Source discovery did not complete ...` / PARTIAL_FAILURE) in
  WHERE/JOIN clauses, and in a SELECT item mis-read `LIKE` as a column name
  (`PHYSICAL_COLUMN_NOT_FOUND` for "LIKE"). `LIKE` and `NOT LIKE` now parse as
  comparison expressions (keeping the operand column dependencies), the
  quantified `LIKE ANY|SOME|ALL (...)` form parses as an IN-style pattern list,
  and `LIKE` is reserved so it is never treated as an identifier. Covered by
  `test/test_v1_5_0_037.js`.

- Fixed unqualified column resolution across a JOIN of derived sources. In a
  scope with more than one source (e.g. `FROM cte c LEFT JOIN (subquery) f`), an
  unqualified column that exists only in a derived source (CTE/subquery) was left
  UNRESOLVED_COLUMN with zero candidates by the ColumnResolver — which has no
  physical schema and cannot see columns a derived source exposes through a `*`
  cascade — so it never reached disambiguation. Downstream, a `SELECT * ... UNION
  ALL ...` propagated this as a `PARTIALLY_RESOLVED` column at the
  `SET_OPERATION_QUERY` scope (the reported symptom). `PhysicalColumnResolver`
  now performs a late disambiguation using the derived column lists it can
  compute: `#resolveAmbiguousReference` and a new scope-source recovery both go
  through `#disambiguateAcrossSources`, which checks physical and derived
  (CTE/subquery) sources alike. If exactly one source in the reference's scope
  exposes the column it resolves there; if more than one it stays ambiguous
  (never silently guessed); if none it is left unresolved (correlated/outer
  references are not disturbed). Covered by `test/test_v1_5_0_036.js`.

- Added the `SOURCE_METADATA_NOT_COLLECTED` diagnostic (WARNING). A `SELECT *`
  over a physical table whose column metadata was not in the collected set
  expanded to zero columns silently (`WILDCARD_NOT_EXPANDED`); in a UNION this
  surfaced far downstream as an unexplained `UNRESOLVED` column at the
  `SET_OPERATION_QUERY` scope, with no indication of which table was missing.
  `PhysicalColumnResolver` now records any physical-table wildcard source that
  has no collected columns (top-level and through recursive derived expansion)
  and emits one WARNING per such table, naming it and pointing at widening the
  metadata collection filters. Explicit column references already warned via
  `PHYSICAL_METADATA_NOT_FOUND`; this covers the previously-silent `*` case.
  Covered by `test/test_v1_5_0_035.js`.

- Fixed `SELECT * EXCEPT(...)` being lost through multi-level wildcard cascades.
  A single `SELECT *` over an `EXCEPT` CTE dropped the column correctly, but when
  `*` cascaded two or more levels (e.g. `x_all AS (SELECT * EXCEPT(col_a) ...)`
  then `x_some AS (SELECT * FROM x_all)` then `SELECT * FROM x_some`), the
  recursive expansion in `PhysicalColumnResolver#expandDerivedScopeColumns`
  re-expanded the underlying table without re-applying the upstream `EXCEPT`, so
  the excluded column silently reappeared — producing wrong column sets (and, in
  a UNION/set-operation with mismatched branches, spurious resolution failures).
  Each scope's `wildcard_exclusions` are now applied during recursive derived
  expansion, so multi-level `EXCEPT`s compose correctly. Covered by
  `test/test_v1_5_0_034.js`.

- Added `#` single-line comment support to the lexer. BigQuery treats both `--`
  and `#` as single-line comments, but the lexer only recognized `--` and
  `/* ... */`, so a `#` comment (e.g. between CTEs) corrupted parsing and caused
  spurious `PHYSICAL_METADATA_NOT_FOUND` / partial-resolution results. `#` is now
  tokenized as a COMMENT to end-of-line, identically to `--`. Covered by
  `test/test_v1_5_0_034.js`.

- Enriched `LINEAGE_PARTIALLY_RESOLVED` / `LINEAGE_UNRESOLVED` diagnostics so
  they point at the SQL and name what failed, even for wildcard-expanded output
  columns. Wildcard-expanded outputs (`output_column_id = "WILDCARD_<n>"`) are
  synthetic and have no source token range, so previously these diagnostics had
  `line_number` / `column_number` / `sql_fragment` = null and no dependency
  breakdown — making a partial resolution over a `SELECT *` / set operation
  impossible to locate. `LineageResolver#addDiagnostics` now (1) resolves an SQL
  location by falling back to the offending branch/derived scope's token range
  (`via_derived_scope_id` etc.), and finally the output scope's range, recording
  which was used in `location_basis`
  (`OUTPUT_COLUMN` / `UNRESOLVED_BRANCH_SCOPE` / `OUTPUT_SCOPE` / `UNLOCATED`);
  and (2) attaches `unresolved_dependencies[]` (with `dependency_status`,
  `source_reference_name`, `branch_scope_id`, `branch_scope_type`,
  `via_derived_output_column_name`), `unresolved_dependency_count`, `scope_type`,
  and `expression_text`, and lists the unresolved columns in the message. These
  flow into the exported diagnostic's `line_number` / `sql_fragment` /
  `sql_context` columns and into `diagnostic_json`, so the persisted
  `lineage_diagnostic` table gains the detail with no repository DDL change.
  Covered by `test/test_v1_5_0_033.js`.

- Note (not yet fixed): in `03_run_daily_lineage_pipeline.sql`, the
  `staged_direct_dependency` edges only ever show `resolution_status = 'RESOLVED'`
  for wildcard-expanded columns. The table is built from `lineage_paths` (which
  contains resolved physical edges only, so a non-resolving UNION branch produces
  no row), and its `resolution_status` join casts `output_column_id` to `INT64`
  while wildcard IDs are the string `WILDCARD_<n>` (→ NULL → the join misses →
  `COALESCE(..., 'RESOLVED')`). Use `lineage_diagnostic.diagnostic_json`
  (`unresolved_dependencies`) for the unresolved detail; a follow-up can fix the
  join and add a non-physical-edge representation.

- Widened physical-source metadata collection in
  `03_run_daily_lineage_pipeline.sql` from a single target dataset to every
  same-region dataset across configured source projects, fixing
  `PHYSICAL_COLUMN_NOT_FOUND` for Views whose base tables live in other
  datasets or projects. Added `source_project_ids ARRAY<STRING>`; datasets are
  enumerated from each project's `region-<job_region>` SCHEMATA into a
  `source_datasets` temp table, and `current_target_columns`,
  `current_target_column_field_paths`, and `current_target_tables` are built by
  unioning `INFORMATION_SCHEMA.COLUMNS` / `COLUMN_FIELD_PATHS` / `TABLES` across
  those datasets. Project identifiers are validated and the union SQL is
  assembled with FORMAT. Requires metadata-read on every listed project and all
  source datasets in job_region; unqualified source references that exist in
  multiple scanned datasets can become `PHYSICAL_COLUMN_AMBIGUOUS`.
  (`06_analyze_changed_objects.sql` and `07_run_single_view_analysis.sql` use
  the same single-dataset collection and are the next to update.)

- Fixed `Script variable exported_json exceeded the size limit of 1048576 bytes`
  in the STEP 3 analysis loop. The full UDF result JSON is now materialized into
  a `udf_result` temp-table cell (which has no 1 MiB cap) instead of a STRING
  script variable, and the staged diagnostics/direct-dependency queries, the
  non-publishable branch, and the non-completed result rows read the arrays and
  scalars from that cell. Only small extracted scalars
  (`udf_analysis_status`, `udf_analysis_message`) are kept in variables, so
  Views whose lineage JSON exceeds 1 MiB no longer abort the pipeline.

- Implemented `CAST(expr AS type)` and `SAFE_CAST(expr AS type)` in the
  ExpressionParser. Previously the `expr AS type` form was not parsed, so these
  functions only survived inside a top-level SELECT item (via the
  raw-expression fallback) and failed elsewhere with
  `ExpressionParser: expected ")", but found "AS".` — breaking any View that
  used CAST/SAFE_CAST in WHERE, JOIN ON, GROUP BY, HAVING, or ORDER BY. The
  value expression now drives lineage and the target type (including
  parameterized precision like `NUMERIC(10, 2)`, angle-bracket parameters like
  `ARRAY<INT64>` / `STRUCT<a INT64, b STRING>`, and a trailing `FORMAT` clause)
  is consumed without producing spurious physical-column references.
- Fixed a related paren-counting defect in the window sub-expression parser
  (`#parseWindowSubExpression`): the `)` that closes an inner function call
  (e.g. `SAFE_CAST(...)`) was mistaken for the window-clause terminator, so any
  function call inside a window `PARTITION BY` / `ORDER BY` truncated the
  sub-expression. This surfaced as a QUALIFY failure
  (`unexpected token ")"`); it now parses correctly.
- Added `test/test_v1_5_0_032.js` covering CAST/SAFE_CAST across SELECT, WHERE,
  JOIN ON, GROUP BY, HAVING, ORDER BY, and QUALIFY windows, and wired it into
  `test:release`. The 48-case Golden regression and all existing tests still
  pass; the regenerated bundle SHA-256 is recorded in `release_manifest.json`.

- Made repository table names configurable from the declaration block using a
  prefix, a per-table infix, a canonical base name, and a suffix, so
  environments with different naming rules no longer require edits to the body
  of the scripts.
- Added `table_name_prefix`/`table_name_suffix` and seven derived table-name
  variables (with name-format ASSERTs) to `01_setup_lineage_environment.sql`
  and `03_run_daily_lineage_pipeline.sql`. Physical names are assembled as
  `prefix + marker + canonical + suffix` (for example prefix `ope_`, marker
  `m_`, suffix `_tky` gives `ope_m_lineage_config_tky`).
- Wrote the master/transaction marker directly as an inline `'m_'` / `'t_'`
  literal in each table's SET line, since the marker rarely changes, while the
  environment-specific prefix and suffix stay as variables (default empty).
  The marker split is `m_` for the configuration and ledger tables (`config`,
  `execution_account_config`, `definition_registry`, `job_registry`) and `t_`
  for the derived analysis outputs (`direct_dependency`, `impact`,
  `diagnostic`); edit a single SET line to reclassify a table.
- Extended `render_dynamic_sql()` with a `repo_tables STRUCT` argument and
  seven fully qualified `__T_*__` placeholders (`__T_CONFIG__`,
  `__T_EXEC_ACCOUNT__`, `__T_DEF_REGISTRY__`, `__T_DIRECT_DEP__`,
  `__T_IMPACT__`, `__T_DIAGNOSTIC__`, `__T_JOB_REGISTRY__`).
- Converted every remaining static repository-table reference in
  `03_run_daily_lineage_pipeline.sql` to the template -> render -> unresolved
  placeholder ASSERT -> `EXECUTE IMMEDIATE` pattern with named `USING`
  parameters, including the STEP 3 changed-object loop (materialized into a
  temporary table so the `FOR ... IN` query stays static), the COMPLETED and
  non-publishable branches, the EXCEPTION replace/restore handler (with
  captured `@@error.*` values), the recursive impact rebuild, and the run and
  pipeline summaries. Repository DDL in `01_setup_lineage_environment.sql` now
  injects the configured names into its `EXECUTE IMMEDIATE FORMAT` statements.
- Fixed a pre-existing error surfaced on first execution: `ASSERT ... AS
  FORMAT(...)` is invalid because the assertion message must be a string
  literal (BigQuery: "Expected string literal but got keyword Format"). The two
  formatted assertions in the STEP 3 analysis loop (source-discovery status and
  the 900,000-byte scoped-metadata guard) now use `IF ... THEN RAISE USING
  MESSAGE = FORMAT(...); END IF;`, which is caught by the same per-object
  EXCEPTION handler. The identical construct still exists in
  `06_analyze_changed_objects.sql` (lines 302, 395) and
  `07_run_single_view_analysis.sql` (line 292) and will be fixed with the
  Phase 2 changes.
- Scope note: `04_validate_lineage_environment.sql`,
  `05_repository_integration_test.sql`, and
  `06_analyze_changed_objects.sql` still use the canonical names and are the
  next phase of this change.

# v1.5.0-031

- Changed 03, 06, and 07 to discover each SQL definition's physical Source
  names first, then pass only the matching `COLUMNS` and
  `COLUMN_FIELD_PATHS` Metadata rows to the JavaScript UDF.
- Added the `source_discovery_only` UDF option and
  `discoverPhysicalSourcesForBigQuery` bundle API.
- Retained PhysicalColumnResolver-compatible matching for fully qualified,
  dataset-qualified, and unqualified source names.
- Added a 900,000-byte preflight guard for the scoped Metadata JSON so an
  exceptionally wide single Source produces an explicit diagnostic instead of
  the BigQuery Script 1 MiB expression-limit error.

# v1.5.0-030

- Added `docs/REPOSITORY_TABLE_REFERENCE.md`, a column-level reference for all
  Repository tables, including direct-source and impacted-column semantics in
  `lineage_impact`.
- Replaced the sample product brand value with `BrandXX`.

# v1.5.0-029

- Added `docs/UDF_BUNDLE_BUILD_PROCESS.md`, which documents the generation,
  verification, release, and optional deployment process for
  `lineage_udf_bundle.js`.
- Clarified that `scripts/build_udf.js` directly generates the bundle and
  `scripts/build_everything.js` orchestrates the release workflow.
- Synchronized package version metadata to `1.5.0-029`.

# v1.5.0-028

- Added physical-column lineage resolution for UNPIVOT-generated value and
  name columns.
- Added support for single-column and multiple-column UNPIVOT forms.
- Added parser support for `INCLUDE NULLS` and `EXCLUDE NULLS`.
- Excluded consumed UNPIVOT input columns from `SELECT *` expansion while
  preserving generated output columns.
- Added direct physical-source, CTE, wildcard, derived-expression, and Golden
  regression coverage for UNPIVOT.
- Changed the historical diagnostic-enrichment test to use a genuine missing
  physical column instead of relying on unsupported UNPIVOT semantics.
- Synchronized package version metadata to `1.5.0-028`.

# v1.5.0-027

- Added BigQuery-compatible PIVOT generated-column naming using
  `aggregate_prefix + "_" + pivot_column`.
- Added same-scope resolution for explicit references to PIVOT-generated
  columns.
- Added support for multiple prefixed aggregate expressions in one PIVOT.
- Added release and Golden regression coverage for aggregate prefixes,
  generated-column references, multiple aggregates, and compatibility with
  prefix-free PIVOT expressions.
- Added `sql/sample/02a_create_cost_measurement_view.sql` as an approximately
  500-line cost and performance measurement View.
- Changed `sql/maintenance/07_run_single_view_analysis.sql` to use the new cost
  measurement View by default.
- Synchronized package version metadata to `1.5.0-027`.

# v1.5.0-026

- Added `sql/maintenance/07_run_single_view_analysis.sql` for read-only,
  single-View UDF execution and script-level cost/performance measurement.
- Aligned the single-View physical-column metadata contract with the formal
  daily pipeline and standalone changed-object analysis.
- Removed eight obsolete `sql/bigquery` files tied to the retired staging,
  physical-column catalog, normalized publish, and duplicate test workflow.
- Updated the retained persistent-UDF redeployment and smoke-test helpers to
  use the current four-argument `analyze_lineage_json` contract and deployed
  environment defaults.
- Synchronized package version metadata to `1.5.0-026`.

# v1.5.0-025

- Changed `06_analyze_changed_objects.sql` to declare repository, target, region, and UDF identifiers at the top of the script.
- Added placeholder rendering and `EXECUTE IMMEDIATE` for target `INFORMATION_SCHEMA` references and persistent UDF invocation.
- Kept repository table access aligned with the declared repository project and dataset through `@@dataset_project_id` and `@@dataset_id`.
- Includes the v1.5.0-024 validation corrections: `routine_type = 'FUNCTION'` and C001 expected sales amount `129250`.

# v1.5.0-021

- Diagnosticへ`scope_type`を自動補完。
- `candidate_source_name(s)`と`resolved_source_name`を追加。
- `sql_context`を対象SELECT項目のAST Token範囲から生成。
- 診断補完の回帰テストを追加。

# v1.5.0-020

- Preserve `diagnostic_json` even when `compact_export = TRUE`.
- Suppress derived `LINEAGE_PARTIALLY_RESOLVED` warnings when the same unresolved dependency already has an ERROR diagnostic.
- Add scope and token location details to physical-column diagnostics.
- Verify `error_nodes_json` and compact diagnostics through regression tests.

## 1.5.0-019

- Added `DiagnosticEngine` as the central diagnostic policy and formatting component.
- Added common node, scope, token position, SQL fragment, SQL context, and original SQL fields.
- Added `error_nodes` to engine results and `error_nodes_json` to exported analysis rows.
- Added a dedicated `error_nodes_json` column to non-completed daily pipeline results.
- Added regression test `test_v1_5_0_019.js`.

## 1.5.0-018

- `EXPRESSION_SUBQUERY`内部の無名SELECT出力を`OUTPUT_COLUMN_NAME_UNRESOLVED`の対象外に変更。
- スカラ集約サブクエリと`EXISTS (SELECT 1 ...)`の回帰テストを追加。
- 外側の公開列名と物理カラムリネージは従来どおり保持。

## 1.5.0-017

- Added shared SELECT output-alias resolution for GROUP BY, HAVING, QUALIFY, and ORDER BY.
- Kept WHERE and JOIN ON from resolving SELECT output aliases.
- Promoted diagnostic output into the formal `03_run_daily_lineage_pipeline.sql`.
- Treats only `COMPLETED` as normal during stabilization and returns every other UDF result in the final SELECT.
- Moved generated JavaScript from `build` to `dist`.
- Moved BigQuery helper SQL from `javascript/bigquery` to `sql/bigquery`.
- Removed `javascript/legacy` and the separate debug pipeline.

# Changelog

## [1.5.0-016] - 2026-07-22

### Fixed

- Resolved fields referenced through a correlated `UNNEST` alias to the original physical STRUCT/ARRAY field path.
- Preserved support for conditionless correlated `LEFT JOIN UNNEST` and `ON TRUE`.
- Added the full UDF result JSON to the final debug result set when analysis is not publishable.

### Tests

- Added `test_v1_5_0_016.js` covering `CONTACTS.CONTACT_VALUE` resolution for both JOIN forms.
- Passed the 46-case Golden regression suite and bundle verification.

## 1.5.0-015 - 2026-07-22

- Allow conditionless `LEFT JOIN UNNEST(...)` only when the UNNEST expression is correlated to a previously visible FROM source.
- Preserve the ON/USING requirement for ordinary LEFT JOIN sources.
- Confirm explicit `ON TRUE` support for correlated LEFT JOIN UNNEST.
- Add parser regression test and sample View `v_customer_primary_contact_on_true`.


## [Unreleased]

### Fixed

- Moved per-object analysis variables into an outer `BEGIN` block.
- Wrapped the replace-and-restore operation in an inner `BEGIN ... EXCEPTION` block.
- Fixed `Unrecognized name: replacement_started` caused by BigQuery exception-handler variable scope.


### Changed

- Centralized every dynamic identifier substitution in the temporary SQL function `render_dynamic_sql()`.
- Removed intermediate identifier variables including `repository_identifier`, `target_identifier`, `target_project_identifier`, and `udf_identifier`.
- Standardized all dynamic SQL blocks to: template, render, unresolved-placeholder assertion, and execution.
- Continued to pass runtime values through `EXECUTE IMMEDIATE ... USING`.


### Fixed

- Fully qualified all three daily-pipeline `MERGE` targets with the `__REPOSITORY__` placeholder.
- Added `repository_identifier = repository_project_id || '.' || repository_dataset`.
- Added unresolved-placeholder assertions before repository `MERGE` execution.


### Changed

- Unified dynamic identifier construction in `03_run_daily_lineage_pipeline.sql` using named placeholders and `REPLACE()`.
- Added `__TARGET__`, `__TARGET_PROJECT__`, `__JOB_REGION__`, and `__UDF__` placeholders.
- Retained `USING` parameters for runtime values such as lookback days and UDF arguments.
- Added unresolved-placeholder assertions before every dynamic SQL execution.


### Changed

- `03_run_daily_lineage_pipeline.sql` now declares repository project, repository dataset, target project, target dataset, job region, UDF location, parser strict mode, and maximum impact rank at the beginning of the script.
- The daily pipeline no longer reads scalar environment settings from `lineage_config`.
- Repository tables use `@@dataset_project_id` and `@@dataset_id`; dynamic identifiers for metadata and UDF calls use `EXECUTE IMMEDIATE`.
- Scheduled Query and DAG service-account arrays remain managed in `lineage_execution_account_config`.


### Fixed

- Removed the unsupported `NOT NULL` constraint from the `ARRAY<STRING>` service account column. Non-empty arrays remain enforced by setup assertions and validation checks.

### Fixed

- Changed dynamic configuration reads from `SELECT AS STRUCT` to a single explicit `STRUCT(...)` column so `EXECUTE IMMEDIATE ... INTO config` receives exactly one column.

### Planned

- JavaScript source and regression fixtures
- Actual execution evidence
- Looker Studio operational dashboard
- Retention and cleanup policy
- CI workflow
- License selection

## [1.0.0-lts-udf.1] - 2026-07-21

### Added

- Recovered 23 JavaScript source files from canonical bundle source markers
- Formal source directories for AST, lexer, token reader, parsers, resolvers, exporter, and engine
- Reproducible UDF bundle build script
- Canonical legacy bundle behavior verification
- 46-case Golden parser and lineage regression suite
- Performance regression contract and runner
- BigQuery UDF smoke-test SQL assets
- Supported SQL coverage and regression test design documents

## [1.0.0-lts-docs.1] - 2026-07-21

### Added

- Environment setup SQL
- Sample environment SQL
- Integrated daily pipeline
- Validation SQL
- Repository integration test
- Changed-object analysis SQL
- Execution account configuration using `ARRAY<STRING>`
- Business requirements
- Architecture and system design
- SQL and UDF design
- Operation and troubleshooting guides
- Development guide
- ER diagram
- Initial ADR set

## 1.5.0-022

- Build Everything v1を追加。
- bundle生成、bundle検証、リリース回帰、成果物ステージング、ZIP生成を1コマンドに統合。
- `release_manifest.json`を追加し、version、SHA-256、テスト状態、成果物、デプロイ状態を記録。
- `--deploy`指定時のみGCSアップロードとBigQuery UDF更新を実行する安全な方式を採用。
- ZIPファイル名とトップレベルフォルダ名の一致を自動保証。

## 1.5.0-023

- Added `looker/sql/01_query_column_impact.sql`.
- Added `impact_type`, `dependency_usage_type`, and `dependency_path_display` to the downstream column impact report.
- Added `impacted_expression` to support manual impact review.
- Documented the current clause-level `usage_type` limitation.
