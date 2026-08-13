-- ============================================================================
-- 03_run_daily_lineage_pipeline.sql
-- BigQuery Physical Lineage Repository - Daily multi-statement pipeline
-- ============================================================================
-- IMPORTANT:
-- @@location must be set before statements that access BigQuery resources.
-- Keep this value equal to job_region below.
SET @@location = 'asia-northeast1';

-- ============================================================================
-- Common dynamic SQL renderer
-- ============================================================================
-- Only SQL identifiers are replaced here.
-- Runtime values must continue to be passed with EXECUTE IMMEDIATE ... USING.
CREATE TEMP FUNCTION render_dynamic_sql(
  sql_template STRING,
  repository_project_id STRING,
  repository_dataset STRING,
  target_project_id STRING,
  job_region STRING,
  udf_project_id STRING,
  udf_dataset STRING,
  udf_function_name STRING,
  repo_tables STRUCT<
    def_registry STRING,
    direct_dep STRING,
    impact STRING,
    diagnostic STRING,
    job_registry STRING
  >
)
RETURNS STRING
AS (
  -- Repository-table placeholders expand to the fully qualified
  -- repository_project.repository_dataset.<physical_table_name>, mirroring the
  -- __UDF__ placeholder. Physical table names are configured in the
  -- declaration block so that environment-specific naming rules can be applied
  -- without editing the body of the script.
  REPLACE(
  REPLACE(
  REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(
              sql_template,
              '__TARGET_PROJECT__',
              target_project_id
        ),
        '__JOB_REGION__',
        job_region
      ),
      '__UDF__',
      udf_project_id || '.' || udf_dataset || '.' || udf_function_name
    ),
    '__T_DEF_REGISTRY__',
    repository_project_id || '.' || repository_dataset || '.'
      || repo_tables.def_registry
  ),
    '__T_DIRECT_DEP__',
    repository_project_id || '.' || repository_dataset || '.'
      || repo_tables.direct_dep
  ),
    '__T_IMPACT__',
    repository_project_id || '.' || repository_dataset || '.'
      || repo_tables.impact
  ),
    '__T_DIAGNOSTIC__',
    repository_project_id || '.' || repository_dataset || '.'
      || repo_tables.diagnostic
  ),
    '__T_JOB_REGISTRY__',
    repository_project_id || '.' || repository_dataset || '.'
      || repo_tables.job_registry
  )
);

BEGIN
-- ============================================================================
-- Runtime environment settings
-- ============================================================================
-- These scalar values are intentionally defined in this script. There is no
-- lineage_config table; this pipeline is configured entirely here.
--
-- Region for the whole pipeline (repository, target Views, source metadata, and
-- JOBS are all single-region). Must equal the `SET @@location` at the top of
-- this file.
DECLARE job_region STRING DEFAULT 'asia-northeast1';
DECLARE repository_project_id STRING DEFAULT 'project_id';
DECLARE repository_dataset STRING DEFAULT 'lineage_repository';
DECLARE target_project_id STRING DEFAULT 'project_id';
-- Target datasets holding the Views to analyze (single target project). These
-- are NOT listed explicitly: they are resolved at runtime by scanning the target
-- project's datasets in job_region (INFORMATION_SCHEMA.SCHEMATA) and filtering by
-- the regex patterns below. Each resolved dataset is scanned via
-- `target_project.dataset.INFORMATION_SCHEMA.VIEWS`.
--   include: empty array = every dataset in the region; otherwise keep datasets
--            whose name matches ANY include pattern.
--   exclude: empty array = exclude none; drop datasets matching ANY pattern.
-- Matching is case-insensitive (both the dataset name and the pattern are
-- lowercased before REGEXP_CONTAINS), so patterns may be written in any case.
-- Example: only "mart"/"dwh" datasets, excluding temp/test:
--   include [r'^mart_', r'^dwh_'], exclude [r'_tmp$', r'test']
DECLARE target_dataset_include_patterns ARRAY<STRING> DEFAULT [];
DECLARE target_dataset_exclude_patterns ARRAY<STRING> DEFAULT [];
-- Resolved at runtime from the patterns above (see the resolution block below).
DECLARE target_datasets ARRAY<STRING>;
DECLARE target_datasets_lower ARRAY<STRING>;
DECLARE view_defs_union_sql STRING;

-- Projects that hold physical source tables, each with include/exclude
-- dataset-name regex patterns (same convention as target_dataset_*_patterns:
-- case-insensitive REGEXP_CONTAINS, multiple patterns per list),
-- because the dataset naming differs per project and some datasets must be
-- skipped (e.g. empty or inaccessible ones that would raise access-denied when
-- their COLUMNS are read). COLUMNS / COLUMN_FIELD_PATHS / TABLES are
-- dataset-scoped, so for each entry the matching same-region datasets are
-- enumerated from INFORMATION_SCHEMA.SCHEMATA and unioned. Include the target
-- project and every other project whose tables are sources; all must be in
-- job_region.
--   dataset_include_patterns : keep datasets matching ANY pattern
--                              (empty array = every dataset in the region).
--   dataset_exclude_patterns : drop datasets matching ANY pattern
--                              (empty array = exclude none).
-- Matching is case-insensitive (name and pattern are lowercased); write patterns
-- as raw strings in any case, e.g. r'^mart_'.
DECLARE source_project_filters
  ARRAY<STRUCT<
    project_id STRING,
    dataset_include_patterns ARRAY<STRING>,
    dataset_exclude_patterns ARRAY<STRING>
  >>
  DEFAULT [
    STRUCT(
      'project_id' AS project_id,
      [r'keyword'] AS dataset_include_patterns,
      CAST([] AS ARRAY<STRING>) AS dataset_exclude_patterns
    )
  ];
DECLARE udf_project_id STRING DEFAULT 'project_id';
DECLARE udf_dataset STRING DEFAULT 'dataset';
DECLARE udf_function_name STRING DEFAULT 'analyze_lineage_json';
-- Companion fingerprint UDF (registered by 01). Used to collapse
-- structurally-identical rotating-destination JOBS (temp / ephemeral) to one
-- representative.
DECLARE udf_fingerprint_function_name STRING DEFAULT 'fingerprint_lineage_sql';
DECLARE parser_strict_mode BOOL DEFAULT FALSE;
DECLARE configured_max_impact_rank INT64 DEFAULT 100;

-- Set FALSE to skip STEP 2 (Scheduled Query / DAG generated-table collection
-- from INFORMATION_SCHEMA.JOBS) and process only Views. STEP 1/3/4 still run.
DECLARE process_generated_tables BOOL DEFAULT TRUE;

-- REGISTRY-stage (collection) exclusion. An object is NOT registered at all if
-- its NAME matches any *_object_patterns entry OR its DATASET matches any
-- *_dataset_patterns entry (exclusion is OR across the two dimensions). Views
-- are dropped in STEP 1 before entering the definition registry (an
-- already-registered View is deactivated), and generated TABLEs are dropped in
-- STEP 2 before entering the job / definition registry (name matched on the
-- destination table, dataset on the destination dataset). This is stronger than
-- the analysis_* filters below (which keep the row and only skip analysis).
-- REGEXP_CONTAINS = partial match; matching is case-insensitive (value and
-- pattern are lowercased), so write patterns as raw strings in any case. Empty
-- array = exclude nothing on that dimension.
--   object e.g. names ending in a digit and names containing "test":
--          [r'[0-9]$', r'test']
--   dataset e.g. whole staging/scratch datasets: [r'^stg_', r'_scratch$']
DECLARE registry_exclude_object_patterns ARRAY<STRING> DEFAULT [];
DECLARE registry_exclude_dataset_patterns ARRAY<STRING> DEFAULT [];

-- ANALYSIS-stage filters. Applied when selecting which registered objects (VIEWs
-- and, when process_generated_tables = TRUE, generated TABLEs) to analyze.
-- Matched objects STAY in the definition registry and keep change tracking; only
-- lineage analysis is gated. The object NAME (object_name) and the DATASET
-- (object_dataset) are filtered independently: the *_object_patterns act on the
-- name and the *_dataset_patterns act on the dataset. REGEXP_CONTAINS = partial
-- match; matching is case-insensitive (value and pattern are lowercased), so
-- write patterns as raw strings in any case, e.g. r'^stg_'. An object is analyzed
-- when it passes BOTH dimensions' include gate AND is excluded by NEITHER
-- dimension: (name-include empty OR name matches) AND (dataset-include empty OR
-- dataset matches) AND (name matches no name-exclude) AND (dataset matches no
-- dataset-exclude). Non-matching objects stay in the registry but are not
-- analyzed.
--   include: empty array = no constraint on that dimension; otherwise analyze
--            only matches (handy for scoping a run, e.g. object [r'^v_sales'] or
--            dataset [r'^mart_']).
--   exclude: empty array = exclude nothing, e.g. object [r'^stg_', r'_tmp$'] or
--            dataset [r'_staging$'].
DECLARE analysis_include_object_patterns ARRAY<STRING> DEFAULT [];
DECLARE analysis_exclude_object_patterns ARRAY<STRING> DEFAULT [];
DECLARE analysis_include_dataset_patterns ARRAY<STRING> DEFAULT [];
DECLARE analysis_exclude_dataset_patterns ARRAY<STRING> DEFAULT [];

-- ----------------------------------------------------------------------------
-- STEP 2 parameters (Scheduled Query / DAG generated-table collection)
--
-- Consumed only when process_generated_tables = TRUE. Service accounts were
-- previously read from the lineage_execution_account_config table; they are now
-- declared here so the whole pipeline is configured in this single file.
--
--   scheduled_query_service_accounts : accounts that run BigQuery Scheduled
--     Queries (also gated by the scheduled_query label unless
--     require_scheduled_query_label = FALSE).
--   dag_service_accounts             : accounts that run DAG / Airflow jobs.
-- Both arrays must be non-empty (asserted in STEP 2).
-- ----------------------------------------------------------------------------
DECLARE scheduled_query_service_accounts ARRAY<STRING> DEFAULT [
  'project_id@appspot.gserviceaccount.com'
];
DECLARE dag_service_accounts ARRAY<STRING> DEFAULT [
  'project_id@appspot.gserviceaccount.com'
];

-- Lookback window over INFORMATION_SCHEMA.JOBS. The initial window is used on
-- the first run (empty job registry); the incremental window is used thereafter.
DECLARE initial_lookback_days INT64 DEFAULT 60;
DECLARE incremental_lookback_days INT64 DEFAULT 3;

-- statement_type values collected from JOBS; jobs of other types are ignored.
-- The remaining JOBS filters (job_type = 'QUERY', state = 'DONE',
-- error_result IS NULL, query IS NOT NULL, destination_table IS NOT NULL) are
-- fixed correctness conditions and stay hardcoded in the WHERE clause.
DECLARE collected_statement_types ARRAY<STRING> DEFAULT [
  'SELECT',
  'CREATE_TABLE_AS_SELECT'
];

-- When TRUE, a Scheduled Query job must carry the
-- data_source_id = 'scheduled_query' label AND be run by a
-- scheduled_query_service_account. Set FALSE to classify by service account
-- alone (e.g. when the label is not present in your environment).
DECLARE require_scheduled_query_label BOOL DEFAULT TRUE;

-- Synthetic dataset label used for the object identity of EPHEMERAL JOBS objects
-- (temp / rotating-destination jobs collapsed by structural fingerprint). Their
-- registry identity is `<target_project>.<this label>.fp_<fingerprint>`, which is
-- stable across runs and searchable; the real (rotating) destination is not part
-- of the identity. Persistent generated tables keep their real identity and do
-- not use this. This is a label only; no dataset by this name needs to exist.
DECLARE ephemeral_object_dataset_label STRING DEFAULT 'ephemeral_generated_sql';

-- ----------------------------------------------------------------------------
-- Repository table naming
--
-- Physical table names are assembled as
--   prefix + marker + canonical base name + suffix
-- in the SET lines below. The prefix and suffix change per environment, so
-- they are variables. The master/transaction marker ('m_' / 't_') rarely
-- changes, so it is written directly as a literal in each SET line; edit that
-- literal only when a table must be reclassified. Include any '_' separators
-- in the prefix, marker, and suffix. Example: prefix='ope_', marker 'm_',
-- suffix='_tky' yields ope_m_lineage_definition_registry_tky. Leave a segment
-- empty to omit it. The names are injected into every repository DML via __T_*__
-- placeholders handled by render_dynamic_sql().
-- ----------------------------------------------------------------------------
DECLARE table_name_prefix STRING DEFAULT '';
DECLARE table_name_suffix STRING DEFAULT '';

DECLARE table_definition_registry STRING;
DECLARE table_direct_dependency STRING;
DECLARE table_impact STRING;
DECLARE table_diagnostic STRING;
DECLARE table_job_registry STRING;

DECLARE repo_tables STRUCT<
  def_registry STRING,
  direct_dep STRING,
  impact STRING,
  diagnostic STRING,
  job_registry STRING
>;

-- Dynamic SQL work variables.
-- Identifier replacement is centralized in render_dynamic_sql().
DECLARE sql_template STRING;
DECLARE rendered_sql STRING;

-- Work variables for building the cross-dataset source-metadata union SQL.
DECLARE columns_union_sql STRING;
DECLARE field_paths_union_sql STRING;
DECLARE tables_union_sql STRING;
DECLARE source_dataset_count INT64;

-- Physical table names: prefix + marker + canonical base + suffix.
-- The 'm_' / 't_' marker literal is inline; edit it to reclassify a table.
SET table_definition_registry =
  table_name_prefix || 'm_' || 'lineage_definition_registry'
    || table_name_suffix;
SET table_job_registry =
  table_name_prefix || 'm_' || 'lineage_job_registry' || table_name_suffix;
SET table_direct_dependency =
  table_name_prefix || 't_' || 'lineage_direct_dependency'
    || table_name_suffix;
SET table_impact =
  table_name_prefix || 't_' || 'lineage_impact' || table_name_suffix;
SET table_diagnostic =
  table_name_prefix || 't_' || 'lineage_diagnostic' || table_name_suffix;

ASSERT REGEXP_CONTAINS(table_definition_registry, r'^[A-Za-z0-9_]+$')
AS 'Invalid table_definition_registry name.';
ASSERT REGEXP_CONTAINS(table_direct_dependency, r'^[A-Za-z0-9_]+$')
AS 'Invalid table_direct_dependency name.';
ASSERT REGEXP_CONTAINS(table_impact, r'^[A-Za-z0-9_]+$')
AS 'Invalid table_impact name.';
ASSERT REGEXP_CONTAINS(table_diagnostic, r'^[A-Za-z0-9_]+$')
AS 'Invalid table_diagnostic name.';
ASSERT REGEXP_CONTAINS(table_job_registry, r'^[A-Za-z0-9_]+$')
AS 'Invalid table_job_registry name.';

SET repo_tables = STRUCT(
  table_definition_registry AS def_registry,
  table_direct_dependency AS direct_dep,
  table_impact AS impact,
  table_diagnostic AS diagnostic,
  table_job_registry AS job_registry
);

-- Repository tables are always addressed through the __T_*__ placeholders and
-- EXECUTE IMMEDIATE so that configured physical names are honored. The session
-- defaults below keep any remaining unqualified repository reference pointing
-- at the repository project and dataset.
SET @@dataset_project_id = repository_project_id;
SET @@dataset_id = repository_dataset;

ASSERT @@location = job_region
AS '@@location and job_region must be identical.';
ASSERT REGEXP_CONTAINS(repository_project_id, r'^[A-Za-z0-9._:-]+$')
AS 'Invalid repository_project_id.';
ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
AS 'Invalid repository_dataset.';
ASSERT REGEXP_CONTAINS(target_project_id, r'^[A-Za-z0-9._:-]+$')
AS 'Invalid target_project_id.';
ASSERT REGEXP_CONTAINS(job_region, r'^[A-Za-z0-9-]+$')
AS 'Invalid job_region.';

-- Resolve target_datasets by scanning the target project's datasets in
-- job_region and applying the include/exclude regex patterns. Dataset ids keep
-- their real case (case-sensitive identifiers); matching is case-insensitive.
EXECUTE IMMEDIATE FORMAT(
  """
  SELECT ARRAY_AGG(schema_name)
  FROM `%s.region-%s`.INFORMATION_SCHEMA.SCHEMATA
  WHERE (
    ARRAY_LENGTH(@inc) = 0
    OR EXISTS (
      SELECT 1 FROM UNNEST(@inc) AS p
      WHERE REGEXP_CONTAINS(LOWER(schema_name), LOWER(p))
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM UNNEST(@exc) AS p
    WHERE REGEXP_CONTAINS(LOWER(schema_name), LOWER(p))
  )
  """,
  target_project_id, job_region
)
INTO target_datasets
USING
  target_dataset_include_patterns AS inc,
  target_dataset_exclude_patterns AS exc;

SET target_datasets = COALESCE(target_datasets, CAST([] AS ARRAY<STRING>));

ASSERT ARRAY_LENGTH(target_datasets) > 0
AS 'No target dataset matched target_dataset_include_patterns / exclude in the region.';
ASSERT (
  SELECT LOGICAL_AND(REGEXP_CONTAINS(d, r'^[A-Za-z0-9_]+$'))
  FROM UNNEST(target_datasets) AS d
)
AS 'Invalid target dataset name in target_datasets.';
SET target_datasets_lower = ARRAY(
  SELECT LOWER(d) FROM UNNEST(target_datasets) AS d
);
ASSERT REGEXP_CONTAINS(udf_project_id, r'^[A-Za-z0-9._:-]+$')
AS 'Invalid udf_project_id.';
ASSERT REGEXP_CONTAINS(udf_dataset, r'^[A-Za-z0-9_]+$')
AS 'Invalid udf_dataset.';
ASSERT REGEXP_CONTAINS(udf_function_name, r'^[A-Za-z0-9_]+$')
AS 'Invalid udf_function_name.';
ASSERT REGEXP_CONTAINS(udf_fingerprint_function_name, r'^[A-Za-z0-9_]+$')
AS 'Invalid udf_fingerprint_function_name.';
ASSERT configured_max_impact_rank BETWEEN 1 AND 1000
AS 'configured_max_impact_rank must be between 1 and 1000.';

-- Execution order:
--   1. Synchronize View definitions
--   2. Synchronize Scheduled Query / DAG generated-table definitions
--   3. Analyze changed definitions
--   4. Rebuild ranked impact paths
--
-- Scalar environment settings are maintained above.
-- Multi-valued execution accounts remain table-managed.
-- Dynamic SQL execution convention:
--   1. SET sql_template
--   2. SET rendered_sql = render_dynamic_sql(...)
--   3. ASSERT that no placeholder remains
--   4. EXECUTE IMMEDIATE rendered_sql [INTO ...] [USING ...]
-- Dynamic SQL placeholders:
--   __TARGET_PROJECT__ -> target project
--   __JOB_REGION__     -> BigQuery location without the region- prefix
--   __UDF__            -> UDF project.dataset.function
--   __T_DEF_REGISTRY__ -> repository definition-registry table (qualified)
--   __T_DIRECT_DEP__   -> repository direct-dependency table (qualified)
--   __T_IMPACT__       -> repository impact table (qualified)
--   __T_DIAGNOSTIC__   -> repository diagnostic table (qualified)
--   __T_JOB_REGISTRY__ -> repository job-registry table (qualified)

-- ============================================================================
-- STEP 1: Synchronize View definitions
-- ============================================================================
BEGIN
  DECLARE step_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();

  -- View definitions are collected across every target dataset (single target
  -- project) by unioning `target_project.dataset.INFORMATION_SCHEMA.VIEWS`.
  -- Dataset ids keep their real case for the identifier; stored object_* are
  -- lowercased for the registry.
  SET view_defs_union_sql = (
    SELECT STRING_AGG(
      FORMAT(
        'SELECT LOWER(table_catalog) AS object_project, '
        || 'LOWER(table_schema) AS object_dataset, '
        || 'LOWER(table_name) AS object_name, '
        || '"VIEW" AS object_type, '
        || '"VIEW_DEFINITION" AS generation_type, '
        || '"INFORMATION_SCHEMA.VIEWS" AS definition_source, '
        || 'view_definition AS definition_text, '
        || 'TO_HEX(SHA256(view_definition)) AS definition_hash '
        || 'FROM `%s.%s.INFORMATION_SCHEMA.VIEWS` '
        || 'WHERE view_definition IS NOT NULL AND TRIM(view_definition) != ""',
        target_project_id, d
      ),
      ' UNION ALL '
    )
    FROM UNNEST(target_datasets) AS d
  );
  EXECUTE IMMEDIATE FORMAT(
    'CREATE OR REPLACE TEMP TABLE current_view_definitions AS %s',
    view_defs_union_sql
  );

  -- Drop Views whose name matches any registry_exclude_object_patterns regex, or
  -- whose dataset matches any registry_exclude_dataset_patterns regex, so they
  -- never enter the definition registry. object_name / object_dataset are already
  -- lowercased. Any such View already registered is deactivated by the STEP 1
  -- "not found" rule below (it is no longer present in current_view_definitions).
  IF ARRAY_LENGTH(registry_exclude_object_patterns) > 0
     OR ARRAY_LENGTH(registry_exclude_dataset_patterns) > 0 THEN
    DELETE FROM current_view_definitions AS v
    WHERE EXISTS (
      SELECT 1
      FROM UNNEST(registry_exclude_object_patterns) AS pattern
      WHERE REGEXP_CONTAINS(LOWER(v.object_name), LOWER(pattern))
    )
    OR EXISTS (
      SELECT 1
      FROM UNNEST(registry_exclude_dataset_patterns) AS pattern
      WHERE REGEXP_CONTAINS(LOWER(v.object_dataset), LOWER(pattern))
    );
  END IF;

  -- --------------------------------------------------------------------------
  -- Physical-source metadata scope
  --
  -- COLUMNS / COLUMN_FIELD_PATHS are dataset-scoped, and target Views can
  -- reference base tables in other datasets and other projects. Every
  -- same-region dataset in the configured source projects is enumerated from
  -- INFORMATION_SCHEMA.SCHEMATA, and its COLUMNS / COLUMN_FIELD_PATHS are
  -- unioned so cross-dataset and cross-project physical columns are visible to
  -- the resolver. TABLES (region-scoped) are unioned across the same projects
  -- for source object-type classification.
  --
  -- These identifiers come from source_project_filters (validated below) and
  -- from SCHEMATA (BigQuery dataset names are restricted to [A-Za-z0-9_]), so the
  -- union SQL is assembled with FORMAT rather than render_dynamic_sql.
  -- Requirement: the executing account needs metadata read on every listed
  -- project, and all source datasets must be in job_region.
  -- --------------------------------------------------------------------------
  ASSERT ARRAY_LENGTH(source_project_filters) > 0
  AS 'source_project_filters must contain at least one entry.';

  FOR src IN (
    SELECT project_id
    FROM UNNEST(source_project_filters)
  )
  DO
    ASSERT REGEXP_CONTAINS(src.project_id, r'^[A-Za-z0-9._:-]+$')
    AS 'Invalid source project_id in source_project_filters.';
  END FOR;

  CREATE OR REPLACE TEMP TABLE source_datasets (
    project_id STRING,
    dataset_id STRING
  );

  FOR src IN (
    SELECT project_id, dataset_include_patterns, dataset_exclude_patterns
    FROM UNNEST(source_project_filters)
  )
  DO
    EXECUTE IMMEDIATE FORMAT(
      'INSERT INTO source_datasets (project_id, dataset_id) '
      -- Preserve the real dataset-id case: it is used to build the
      -- `project.dataset.INFORMATION_SCHEMA.*` identifier, and BigQuery dataset
      -- ids are case-sensitive. The regex filters match case-insensitively (name
      -- and pattern are both lowercased before REGEXP_CONTAINS).
      -- Empty @inc = every dataset; matching @exc datasets are skipped so their
      -- COLUMNS are never read (avoids access-denied on ignorable datasets).
      || 'SELECT DISTINCT catalog_name, schema_name '
      || 'FROM `%s.region-%s`.INFORMATION_SCHEMA.SCHEMATA '
      || 'WHERE (ARRAY_LENGTH(@inc) = 0 OR EXISTS ('
      || 'SELECT 1 FROM UNNEST(@inc) AS p '
      || 'WHERE REGEXP_CONTAINS(LOWER(schema_name), LOWER(p)))) '
      || 'AND NOT EXISTS ('
      || 'SELECT 1 FROM UNNEST(@exc) AS p '
      || 'WHERE REGEXP_CONTAINS(LOWER(schema_name), LOWER(p)))',
      src.project_id,
      job_region
    )
    USING
      COALESCE(src.dataset_include_patterns, CAST([] AS ARRAY<STRING>)) AS inc,
      COALESCE(src.dataset_exclude_patterns, CAST([] AS ARRAY<STRING>)) AS exc;
  END FOR;

  SET source_dataset_count = (SELECT COUNT(*) FROM source_datasets);
  ASSERT source_dataset_count > 0
  AS 'No source datasets were found in the configured projects and region.';

  -- TABLES per source dataset (dataset-scoped, so only dataset-level metadata
  -- access is needed; the region-qualified form requires broader permissions).
  -- TABLE_OPTIONS is joined to expose each table's expiration_timestamp: a table
  -- with an expiration set is a temporary output (collapsed by fingerprint like a
  -- non-existent destination), while a table with no expiration is a persistent
  -- generated table kept per destination. expiration_timestamp is NULL when no
  -- expiration is configured.
  SET tables_union_sql = (
    SELECT STRING_AGG(
      FORMAT(
        'SELECT LOWER(t.table_catalog) AS table_catalog, '
        || 'LOWER(t.table_schema) AS table_schema, '
        || 'LOWER(t.table_name) AS table_name, t.table_type, '
        || 'opt.option_value AS expiration_timestamp '
        || 'FROM `%s.%s.INFORMATION_SCHEMA.TABLES` AS t '
        || 'LEFT JOIN `%s.%s.INFORMATION_SCHEMA.TABLE_OPTIONS` AS opt '
        || 'ON opt.table_name = t.table_name '
        || 'AND opt.option_name = \'expiration_timestamp\'',
        project_id, dataset_id, project_id, dataset_id
      ),
      ' UNION ALL '
    )
    FROM (SELECT DISTINCT project_id, dataset_id FROM source_datasets)
  );
  EXECUTE IMMEDIATE FORMAT(
    'CREATE OR REPLACE TEMP TABLE current_target_tables AS %s',
    tables_union_sql
  );

  -- COLUMNS across every source dataset.
  SET columns_union_sql = (
    SELECT STRING_AGG(
      FORMAT(
        'SELECT * FROM `%s.%s.INFORMATION_SCHEMA.COLUMNS`',
        project_id, dataset_id
      ),
      ' UNION ALL '
    )
    FROM (SELECT DISTINCT project_id, dataset_id FROM source_datasets)
  );
  EXECUTE IMMEDIATE FORMAT(
    'CREATE OR REPLACE TEMP TABLE current_target_columns AS %s',
    columns_union_sql
  );

  -- COLUMN_FIELD_PATHS across every source dataset.
  SET field_paths_union_sql = (
    SELECT STRING_AGG(
      FORMAT(
        'SELECT * FROM `%s.%s.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS`',
        project_id, dataset_id
      ),
      ' UNION ALL '
    )
    FROM (SELECT DISTINCT project_id, dataset_id FROM source_datasets)
  );
  EXECUTE IMMEDIATE FORMAT(
    'CREATE OR REPLACE TEMP TABLE current_target_column_field_paths AS %s',
    field_paths_union_sql
  );

  SET sql_template = """
      MERGE
        `__T_DEF_REGISTRY__` AS target
      USING current_view_definitions AS source
      ON LOWER(target.object_project) = source.object_project
      AND LOWER(target.object_dataset) = source.object_dataset
      AND LOWER(target.object_name) = source.object_name
      AND target.object_type = source.object_type
      WHEN MATCHED THEN
        UPDATE SET
          target.generation_type = source.generation_type,
          target.definition_source = source.definition_source,
          target.definition_text = source.definition_text,
          target.previous_definition_hash = CASE
            WHEN target.definition_hash IS DISTINCT FROM source.definition_hash
              THEN target.definition_hash
            ELSE target.previous_definition_hash
          END,
          target.definition_hash = source.definition_hash,
          target.source_job_id = NULL,
          target.source_job_time = NULL,
          target.source_user_email = NULL,
          target.is_changed = (
            target.is_changed
            OR target.definition_hash IS DISTINCT FROM source.definition_hash
          ),
          target.is_active = TRUE,
          target.analysis_status = CASE
            WHEN target.definition_hash IS DISTINCT FROM source.definition_hash
              THEN NULL
            ELSE target.analysis_status
          END,
          target.last_seen_at = CURRENT_TIMESTAMP(),
          target.updated_at = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN
        INSERT (
          object_project,
          object_dataset,
          object_name,
          object_type,
          generation_type,
          definition_source,
          definition_text,
          definition_hash,
          previous_definition_hash,
          source_job_id,
          source_job_time,
          source_user_email,
          is_changed,
          is_active,
          analysis_status,
          last_analyzed_hash,
          first_seen_at,
          last_seen_at,
          last_analyzed_at,
          updated_at
        )
        VALUES (
          source.object_project,
          source.object_dataset,
          source.object_name,
          source.object_type,
          source.generation_type,
          source.definition_source,
          source.definition_text,
          source.definition_hash,
          NULL,
          NULL,
          NULL,
          NULL,
          TRUE,
          TRUE,
          NULL,
          NULL,
          CURRENT_TIMESTAMP(),
          CURRENT_TIMESTAMP(),
          NULL,
          CURRENT_TIMESTAMP()
        );
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in lineage_definition_registry MERGE SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  SET sql_template = """
    UPDATE
      `__T_DEF_REGISTRY__` AS registry
    SET
      is_active = FALSE,
      is_changed = FALSE,
      analysis_status = 'INACTIVE_OBJECT_NOT_FOUND',
      updated_at = CURRENT_TIMESTAMP()
    WHERE registry.object_type = 'VIEW'
      AND registry.generation_type = 'VIEW_DEFINITION'
      AND registry.is_active = TRUE
      AND LOWER(registry.object_project) = LOWER(@target_project_id)
      AND LOWER(registry.object_dataset) IN UNNEST(@target_datasets)
      AND NOT EXISTS (
        SELECT 1
        FROM current_view_definitions AS source
        WHERE source.object_project = LOWER(registry.object_project)
          AND source.object_dataset = LOWER(registry.object_dataset)
          AND source.object_name = LOWER(registry.object_name)
      );
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in inactive VIEW registry UPDATE SQL.';

  EXECUTE IMMEDIATE rendered_sql
  USING
    target_project_id AS target_project_id,
    target_datasets_lower AS target_datasets;

  SELECT
    'SYNC_VIEW_REGISTRY' AS step_name,
    step_started_at,
    CURRENT_TIMESTAMP() AS step_finished_at,
    (SELECT COUNT(*) FROM current_view_definitions)
      AS current_view_count;
END;

-- ============================================================================
-- STEP 2: Synchronize Scheduled Query / DAG generated-table definitions
-- Skipped entirely when process_generated_tables is FALSE (Views-only run).
-- ============================================================================
IF process_generated_tables THEN
BEGIN
  DECLARE step_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
  DECLARE lookback_days INT64;
  DECLARE job_registry_row_count INT64;

  -- Service accounts and lookback windows are declared in the top-level
  -- parameter block; STEP 2 only validates them here.
  ASSERT ARRAY_LENGTH(scheduled_query_service_accounts) > 0
  AS 'scheduled_query_service_accounts must not be empty (see the STEP 2 parameter block).';

  ASSERT ARRAY_LENGTH(dag_service_accounts) > 0
  AS 'dag_service_accounts must not be empty (see the STEP 2 parameter block).';

  SET sql_template = """
    CREATE TABLE IF NOT EXISTS
      `__T_JOB_REGISTRY__`
    (
      job_project STRING NOT NULL,
      job_id STRING NOT NULL,
      creation_time TIMESTAMP NOT NULL,
      start_time TIMESTAMP,
      end_time TIMESTAMP,
      execution_source STRING NOT NULL,
      source_detection_method STRING NOT NULL,
      user_email STRING,
      labels ARRAY<STRUCT<key STRING, value STRING>>,
      statement_type STRING,
      query_text STRING,
      definition_text STRING,
      definition_hash STRING NOT NULL,
      sql_fingerprint STRING,
      destination_project STRING NOT NULL,
      destination_dataset STRING NOT NULL,
      destination_table STRING NOT NULL,
      collected_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL
    )
    PARTITION BY DATE(creation_time)
    CLUSTER BY
      destination_project,
      destination_dataset,
      destination_table,
      execution_source
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in lineage_job_registry CREATE SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  SET sql_template = """
    SELECT COUNT(*)
    FROM `__T_JOB_REGISTRY__`
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in lineage_job_registry count SQL.';

  EXECUTE IMMEDIATE rendered_sql INTO job_registry_row_count;

  SET lookback_days = IF(
    job_registry_row_count = 0,
    initial_lookback_days,
    incremental_lookback_days
  );

  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE raw_generated_table_jobs AS
    SELECT
      project_id,
      job_id,
      creation_time,
      start_time,
      end_time,
      user_email,
      labels,
      statement_type,
      query,
      destination_table
    FROM `__TARGET_PROJECT__.region-__JOB_REGION__`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
    WHERE creation_time >= TIMESTAMP_SUB(
      CURRENT_TIMESTAMP(),
      INTERVAL @lookback_days DAY
    )
      AND creation_time < CURRENT_TIMESTAMP()
      -- Fixed correctness conditions (do not parameterize): only successful,
      -- completed QUERY jobs that produced a destination table.
      AND job_type = 'QUERY'
      AND state = 'DONE'
      AND error_result IS NULL
      AND query IS NOT NULL
      AND destination_table IS NOT NULL
      -- Parameterized: statement types to collect (collected_statement_types).
      AND statement_type IN UNNEST(@statement_types)
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in raw_generated_table_jobs SQL.';

  EXECUTE IMMEDIATE rendered_sql
  USING
    lookback_days AS lookback_days,
    collected_statement_types AS statement_types;

  CREATE OR REPLACE TEMP TABLE recent_generated_table_jobs AS
  WITH target_jobs AS (
    SELECT
      project_id AS job_project,
      job_id,
      creation_time,
      start_time,
      end_time,
      user_email,
      labels,
      statement_type,
      query,
      destination_table.project_id AS destination_project,
      destination_table.dataset_id AS destination_dataset,
      destination_table.table_id AS destination_table,
      (
        (
          NOT require_scheduled_query_label
          OR EXISTS (
            SELECT 1
            FROM UNNEST(labels) AS label
            WHERE label.key = 'data_source_id'
              AND label.value = 'scheduled_query'
          )
        )
        AND user_email IN UNNEST(
          scheduled_query_service_accounts
        )
      ) AS is_scheduled_query,
      user_email IN UNNEST(dag_service_accounts) AS is_dag
    FROM raw_generated_table_jobs
  ),
  classified_jobs AS (
    SELECT
      job_project,
      job_id,
      creation_time,
      start_time,
      end_time,
      CASE
        WHEN is_scheduled_query THEN 'SCHEDULED_QUERY'
        WHEN is_dag THEN 'DAG'
      END AS execution_source,
      CASE
        WHEN is_scheduled_query THEN 'LABEL_AND_ACCOUNT'
        WHEN is_dag THEN 'USER_EMAIL'
      END AS source_detection_method,
      user_email,
      labels,
      statement_type,
      query AS query_text,
      LOWER(destination_project) AS destination_project,
      LOWER(destination_dataset) AS destination_dataset,
      LOWER(destination_table) AS destination_table
    FROM target_jobs
    WHERE (is_scheduled_query OR is_dag)
      -- REGISTRY-stage exclusion for generated TABLEs: drop jobs whose
      -- destination table name matches any registry_exclude_object_patterns
      -- regex, or whose destination dataset matches any
      -- registry_exclude_dataset_patterns regex, so they never enter the job /
      -- definition registry (the STEP 1 counterpart drops Views the same way).
      -- Empty array = exclude nothing on that dimension.
      AND NOT EXISTS (
        SELECT 1
        FROM UNNEST(registry_exclude_object_patterns) AS pattern
        WHERE REGEXP_CONTAINS(LOWER(destination_table), LOWER(pattern))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM UNNEST(registry_exclude_dataset_patterns) AS pattern
        WHERE REGEXP_CONTAINS(LOWER(destination_dataset), LOWER(pattern))
      )
  ),
  normalized_definitions AS (
    SELECT
      *,
      CASE
        WHEN statement_type = 'CREATE_TABLE_AS_SELECT'
          THEN REGEXP_REPLACE(
            query_text,
            r'(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+'
            r'(?:IF\s+NOT\s+EXISTS\s+)?(?:`[^`]+`|[^\s]+)'
            r'(?:\s+OPTIONS\s*\([^;]*?\))?\s+AS\s+',
            ''
          )
        ELSE query_text
      END AS definition_text
    FROM classified_jobs
  )
  SELECT
    job_project,
    job_id,
    creation_time,
    start_time,
    end_time,
    execution_source,
    source_detection_method,
    user_email,
    labels,
    statement_type,
    query_text,
    definition_text,
    TO_HEX(SHA256(definition_text)) AS definition_hash,
    destination_project,
    destination_dataset,
    destination_table,
    CURRENT_TIMESTAMP() AS collected_at,
    CURRENT_TIMESTAMP() AS updated_at
  FROM normalized_definitions
  WHERE definition_text IS NOT NULL
    AND TRIM(definition_text) != '';

  SET sql_template = """
      MERGE
        `__T_JOB_REGISTRY__` AS target
      USING recent_generated_table_jobs AS source
      ON target.job_project = source.job_project
      AND target.job_id = source.job_id
      WHEN MATCHED THEN
        UPDATE SET
          target.creation_time = source.creation_time,
          target.start_time = source.start_time,
          target.end_time = source.end_time,
          target.execution_source = source.execution_source,
          target.source_detection_method = source.source_detection_method,
          target.user_email = source.user_email,
          target.labels = source.labels,
          target.statement_type = source.statement_type,
          target.query_text = source.query_text,
          target.definition_text = source.definition_text,
          target.definition_hash = source.definition_hash,
          target.destination_project = source.destination_project,
          target.destination_dataset = source.destination_dataset,
          target.destination_table = source.destination_table,
          target.collected_at = source.collected_at,
          target.updated_at = source.updated_at
      WHEN NOT MATCHED THEN
        INSERT (
          job_project,
          job_id,
          creation_time,
          start_time,
          end_time,
          execution_source,
          source_detection_method,
          user_email,
          labels,
          statement_type,
          query_text,
          definition_text,
          definition_hash,
          destination_project,
          destination_dataset,
          destination_table,
          collected_at,
          updated_at
        )
        VALUES (
          source.job_project,
          source.job_id,
          source.creation_time,
          source.start_time,
          source.end_time,
          source.execution_source,
          source.source_detection_method,
          source.user_email,
          source.labels,
          source.statement_type,
          source.query_text,
          source.definition_text,
          source.definition_hash,
          source.destination_project,
          source.destination_dataset,
          source.destination_table,
          source.collected_at,
          source.updated_at
        );
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in lineage_job_registry MERGE SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  -- Populate sql_fingerprint for every newly-collected job (SELECT and CTAS
  -- alike). The structural fingerprint (literals normalized) is what lets us
  -- collapse rotating-destination jobs whose SQL is identical. Computed once per
  -- job_id (guarded by sql_fingerprint IS NULL). Built inline rather than via
  -- render_dynamic_sql because it needs the fingerprint UDF's qualified name.
  SET rendered_sql = FORMAT(
    """
    UPDATE `%s`
    SET
      sql_fingerprint = TO_HEX(SHA256(`%s`(definition_text))),
      updated_at = CURRENT_TIMESTAMP()
    WHERE sql_fingerprint IS NULL
      AND definition_text IS NOT NULL
    """,
    repository_project_id || '.' || repository_dataset || '.'
      || repo_tables.job_registry,
    udf_project_id || '.' || udf_dataset || '.'
      || udf_fingerprint_function_name
  );

  EXECUTE IMMEDIATE rendered_sql;

  -- Representative definition per JOBS group, split by whether the destination is
  -- a PERSISTENT table or a temporary one:
  --   * PERSISTENT (destination table exists AND has no expiration set) -> kept
  --     per destination with its real identity, so a downstream object that
  --     references the table still chains through it (e.g.
  --     CREATE TABLE dst AS SELECT * FROM view). definition_hash stays the SHA256
  --     of the definition text. is_ephemeral = FALSE.
  --   * EPHEMERAL (destination does not exist, OR it exists but has an
  --     expiration_timestamp -> a temp / rotating-name output such as
  --     CREATE TEMP TABLE AS SELECT, an expiring dated table, or a scheduled
  --     SELECT whose result lands in a rotating anonymous table) -> collapsed by
  --     structural fingerprint to one stable synthetic object
  --     `<target_project>.<ephemeral_dataset>.fp_<hash>` so structurally-identical
  --     runs are analyzed once. definition_hash is set to the fingerprint (a later
  --     literal-only change does not re-trigger analysis). is_ephemeral = TRUE.
  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE latest_generated_table_definitions AS
    WITH classified AS (
      SELECT
        jobs.*,
        (
          target_table.table_name IS NOT NULL
          AND target_table.expiration_timestamp IS NULL
        ) AS destination_is_persistent
      FROM `__T_JOB_REGISTRY__` AS jobs
      LEFT JOIN current_target_tables AS target_table
        ON LOWER(target_table.table_catalog) = LOWER(jobs.destination_project)
        AND LOWER(target_table.table_schema) = LOWER(jobs.destination_dataset)
        AND LOWER(target_table.table_name) = LOWER(jobs.destination_table)
    )
    SELECT
      IF(destination_is_persistent, destination_project, @target_project)
        AS object_project,
      IF(destination_is_persistent, destination_dataset, @ephemeral_dataset)
        AS object_dataset,
      IF(
        destination_is_persistent,
        destination_table,
        CONCAT('fp_', sql_fingerprint)
      ) AS object_name,
      'TABLE' AS object_type,
      execution_source AS generation_type,
      'INFORMATION_SCHEMA.JOBS' AS definition_source,
      definition_text,
      IF(destination_is_persistent, definition_hash, sql_fingerprint)
        AS definition_hash,
      sql_fingerprint,
      NOT destination_is_persistent AS is_ephemeral,
      job_id AS source_job_id,
      creation_time AS source_job_time,
      user_email AS source_user_email,
      labels AS labels
    FROM classified
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY
        CASE
          WHEN destination_is_persistent THEN CONCAT(
            'DST:', destination_project, '.',
            destination_dataset, '.', destination_table
          )
          ELSE CONCAT('FP:', sql_fingerprint)
        END
      ORDER BY
        creation_time DESC,
        job_id DESC
    ) = 1
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in latest_generated_table_definitions SQL.';

  EXECUTE IMMEDIATE rendered_sql
  USING
    target_project_id AS target_project,
    ephemeral_object_dataset_label AS ephemeral_dataset;

  SET sql_template = """
      MERGE
        `__T_DEF_REGISTRY__` AS target
      USING latest_generated_table_definitions AS source
      ON LOWER(target.object_project) = source.object_project
      AND LOWER(target.object_dataset) = source.object_dataset
      AND LOWER(target.object_name) = source.object_name
      AND target.object_type = source.object_type
      WHEN MATCHED THEN
        UPDATE SET
          target.generation_type = source.generation_type,
          target.definition_source = source.definition_source,
          target.definition_text = source.definition_text,
          target.previous_definition_hash = CASE
            WHEN target.definition_hash IS DISTINCT FROM source.definition_hash
              THEN target.definition_hash
            ELSE target.previous_definition_hash
          END,
          target.definition_hash = source.definition_hash,
          target.sql_fingerprint = source.sql_fingerprint,
          target.is_ephemeral = source.is_ephemeral,
          target.source_job_id = source.source_job_id,
          target.source_job_time = source.source_job_time,
          target.source_user_email = source.source_user_email,
          target.labels = source.labels,
          target.is_changed = (
            target.is_changed
            OR target.definition_hash IS DISTINCT FROM source.definition_hash
          ),
          target.is_active = TRUE,
          target.analysis_status = CASE
            WHEN target.definition_hash IS DISTINCT FROM source.definition_hash
              THEN NULL
            ELSE target.analysis_status
          END,
          target.last_seen_at = CURRENT_TIMESTAMP(),
          target.updated_at = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN
        INSERT (
          object_project,
          object_dataset,
          object_name,
          object_type,
          generation_type,
          definition_source,
          definition_text,
          definition_hash,
          previous_definition_hash,
          sql_fingerprint,
          is_ephemeral,
          source_job_id,
          source_job_time,
          source_user_email,
          labels,
          is_changed,
          is_active,
          analysis_status,
          last_analyzed_hash,
          first_seen_at,
          last_seen_at,
          last_analyzed_at,
          updated_at
        )
        VALUES (
          source.object_project,
          source.object_dataset,
          source.object_name,
          source.object_type,
          source.generation_type,
          source.definition_source,
          source.definition_text,
          source.definition_hash,
          NULL,
          source.sql_fingerprint,
          source.is_ephemeral,
          source.source_job_id,
          source.source_job_time,
          source.source_user_email,
          source.labels,
          TRUE,
          TRUE,
          NULL,
          NULL,
          CURRENT_TIMESTAMP(),
          CURRENT_TIMESTAMP(),
          NULL,
          CURRENT_TIMESTAMP()
        );
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in lineage_definition_registry MERGE SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  SET sql_template = """
    UPDATE
      `__T_DEF_REGISTRY__` AS registry
    SET
      is_active = FALSE,
      is_changed = FALSE,
      analysis_status = 'INACTIVE_OBJECT_NOT_FOUND',
      updated_at = CURRENT_TIMESTAMP()
    WHERE registry.object_type = 'TABLE'
      AND registry.generation_type IN (
        'SCHEDULED_QUERY',
        'DAG'
      )
      AND registry.is_active = TRUE
      -- Persistent generated tables only. Ephemeral (fingerprint-identified)
      -- objects have no real destination to look up and are aged out separately
      -- by fingerprint recency below.
      AND registry.is_ephemeral = FALSE
      AND LOWER(registry.object_project) = LOWER(@target_project_id)
      -- Deactivate when there is no longer a matching PERSISTENT table: the
      -- destination is gone, or it now has an expiration set (in which case the
      -- ephemeral fingerprint object takes over). expiration_timestamp IS NULL
      -- means no expiration = still persistent.
      AND NOT EXISTS (
        SELECT 1
        FROM current_target_tables AS table_info
        WHERE LOWER(table_info.table_catalog) =
          LOWER(registry.object_project)
          AND LOWER(table_info.table_schema) =
            LOWER(registry.object_dataset)
          AND LOWER(table_info.table_name) =
            LOWER(registry.object_name)
          AND table_info.expiration_timestamp IS NULL
      );
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in inactive generated-table registry UPDATE SQL.';

  EXECUTE IMMEDIATE rendered_sql
  USING target_project_id AS target_project_id;

  -- Age out ephemeral (fingerprint-identified) objects whose fingerprint has not
  -- appeared in JOBS within the lookback window. The synthetic identity is stable
  -- per fingerprint, so a recurring job keeps refreshing the same row (no
  -- churn); this only deactivates fingerprints that have stopped running. The
  -- lookback matches the JOBS collection window used above.
  SET sql_template = """
    UPDATE
      `__T_DEF_REGISTRY__` AS registry
    SET
      is_active = FALSE,
      is_changed = FALSE,
      analysis_status = 'INACTIVE_FINGERPRINT_NOT_SEEN',
      updated_at = CURRENT_TIMESTAMP()
    WHERE registry.is_ephemeral = TRUE
      AND registry.is_active = TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM `__T_JOB_REGISTRY__` AS jobs
        WHERE jobs.sql_fingerprint = registry.sql_fingerprint
          AND jobs.creation_time >= TIMESTAMP_SUB(
            CURRENT_TIMESTAMP(),
            INTERVAL @lookback_days DAY
          )
      );
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in ephemeral fingerprint age-out UPDATE SQL.';

  EXECUTE IMMEDIATE rendered_sql
  USING lookback_days AS lookback_days;

  SELECT
    'SYNC_GENERATED_TABLE_REGISTRY' AS step_name,
    step_started_at,
    CURRENT_TIMESTAMP() AS step_finished_at,
    lookback_days,
    (SELECT COUNT(*) FROM recent_generated_table_jobs)
      AS recent_target_job_count;
END;
END IF;

-- ============================================================================
-- Non-completed UDF results retained for the final operational result set.
-- COMPLETED is the only normal status during the stabilization period.
-- ============================================================================
CREATE TEMP TABLE non_completed_udf_results (
  object_project STRING,
  object_dataset STRING,
  object_name STRING,
  object_type STRING,
  analysis_status STRING,
  diagnostic_count INT64,
  output_lineage_count INT64,
  lineage_path_count INT64,
  diagnostic_code STRING,
  engine_stage STRING,
  severity STRING,
  message STRING,
  diagnostic_json JSON,
  error_nodes_json JSON,
  analysis_result_json STRING
);

-- ============================================================================
-- STEP 3: Analyze changed definitions
-- ============================================================================
BEGIN
  -- ============================================================================
  -- 06_analyze_changed_objects.sql
  -- EXECUTION ORDER: Initial setup 08 / Daily operation 03
  -- ============================================================================
  -- ============================================================================
  -- Changed definitions -> persistent lineage UDF -> direct dependency repository
  --
  -- Design principles:
  --   - No explicit transaction.
  --   - Re-runnable and idempotent.
  --   - Existing dependencies are not touched until UDF parsing and staging finish.
  --   - Dependency replacement uses DELETE + INSERT.
  --   - If replacement DML fails inside the object block, the previous dependency
  --     rows are restored from temporary backup tables.
  --   - is_changed becomes FALSE only after dependency and diagnostic persistence
  --     both finish successfully.
  --
  -- Environment-dependent scalar values, service-account arrays, and JOBS
  -- collection parameters are all declared at the top of this file.
  -- ============================================================================

  DECLARE run_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
  DECLARE strict_mode BOOL DEFAULT parser_strict_mode;
  DECLARE analyzed_object_count INT64 DEFAULT 0;
  DECLARE failed_object_count INT64 DEFAULT 0;

  -- Source discovery runs the JavaScript UDF across every changed definition,
  -- like the STEP 3 analysis pass, and at large target counts it likewise
  -- accumulates V8 heap in the per-slot UDF context and hits "Resource exceeded
  -- during query execution: UDF out of memory". It is therefore run in
  -- fixed-size chunks (one EXECUTE IMMEDIATE job per chunk). Lower this if OOM
  -- persists; keep it roughly in step with analysis_udf_chunk_size below.
  DECLARE discovery_udf_chunk_size INT64 DEFAULT 200;
  DECLARE discovery_udf_chunk_count INT64 DEFAULT 0;
  DECLARE discovery_udf_chunk_index INT64 DEFAULT 0;

  -- --------------------------------------------------------------------------
  -- Remove repository rows whose target definition is no longer active.
  -- --------------------------------------------------------------------------
  SET sql_template = """
    DELETE FROM
      `__T_DIRECT_DEP__` AS dependency
    WHERE NOT EXISTS (
      SELECT 1
      FROM
        `__T_DEF_REGISTRY__` AS registry
      WHERE registry.is_active = TRUE
        AND LOWER(registry.object_project) = LOWER(dependency.target_project)
        AND LOWER(registry.object_dataset) = LOWER(dependency.target_dataset)
        AND LOWER(registry.object_name) = LOWER(dependency.target_object)
        AND registry.object_type = dependency.target_object_type
        AND registry.generation_type = dependency.generation_type
    );
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in orphan direct-dependency DELETE SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  SET sql_template = """
    DELETE FROM
      `__T_DIAGNOSTIC__` AS diagnostic
    WHERE NOT EXISTS (
      SELECT 1
      FROM
        `__T_DEF_REGISTRY__` AS registry
      WHERE registry.is_active = TRUE
        AND LOWER(registry.object_project) = LOWER(diagnostic.object_project)
        AND LOWER(registry.object_dataset) = LOWER(diagnostic.object_dataset)
        AND LOWER(registry.object_name) = LOWER(diagnostic.object_name)
        AND registry.object_type = diagnostic.object_type
    );
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in orphan diagnostic DELETE SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  -- --------------------------------------------------------------------------
  -- Analyze active definitions whose current definition has changed.
  --
  -- The changed-definition set is materialized into a temporary table through
  -- dynamic SQL so that the repository table name stays configurable while the
  -- FOR ... IN loop query itself remains static.
  -- --------------------------------------------------------------------------
  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE changed_definitions_to_analyze AS
    SELECT
      object_project,
      object_dataset,
      object_name,
      object_type,
      generation_type,
      definition_text,
      definition_hash
    FROM
      `__T_DEF_REGISTRY__`
    WHERE is_active = TRUE
      AND is_changed = TRUE
      AND definition_text IS NOT NULL
      AND object_type IN ('VIEW', 'TABLE')
      -- When generated-table collection is off, analyze Views only.
      AND (@include_tables OR object_type = 'VIEW')
      -- Include only objects whose NAME matches a configured regex (empty = all).
      AND (
        ARRAY_LENGTH(@include_patterns) = 0
        OR EXISTS (
          SELECT 1
          FROM UNNEST(@include_patterns) AS pattern
          WHERE REGEXP_CONTAINS(
            LOWER(object_name),
            LOWER(pattern)
          )
        )
      )
      -- Include only objects whose DATASET matches a configured regex (empty = all).
      AND (
        ARRAY_LENGTH(@include_dataset_patterns) = 0
        OR EXISTS (
          SELECT 1
          FROM UNNEST(@include_dataset_patterns) AS pattern
          WHERE REGEXP_CONTAINS(
            LOWER(object_dataset),
            LOWER(pattern)
          )
        )
      )
      -- Exclude objects whose name matches any configured regex.
      AND NOT EXISTS (
        SELECT 1
        FROM UNNEST(@exclude_patterns) AS pattern
        WHERE REGEXP_CONTAINS(
          LOWER(object_name),
          LOWER(pattern)
        )
      )
      -- Exclude objects whose dataset matches any configured regex.
      AND NOT EXISTS (
        SELECT 1
        FROM UNNEST(@exclude_dataset_patterns) AS pattern
        WHERE REGEXP_CONTAINS(
          LOWER(object_dataset),
          LOWER(pattern)
        )
      )
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in changed-definitions materialization SQL.';

  EXECUTE IMMEDIATE rendered_sql
  USING
    process_generated_tables AS include_tables,
    analysis_include_object_patterns AS include_patterns,
    analysis_exclude_object_patterns AS exclude_patterns,
    analysis_include_dataset_patterns AS include_dataset_patterns,
    analysis_exclude_dataset_patterns AS exclude_dataset_patterns;

  -- Snapshot the active VIEW registry once so the per-object staging query can
  -- classify source object types without referencing the (configurable-named)
  -- repository table directly inside a static statement.
  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE active_view_definitions AS
    SELECT
      object_project,
      object_dataset,
      object_name,
      object_type,
      is_active,
      updated_at
    FROM
      `__T_DEF_REGISTRY__`
    WHERE is_active = TRUE
      AND object_type = 'VIEW'
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in active_view_definitions snapshot SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  -- --------------------------------------------------------------------------
  -- Batch source discovery: run the persistent UDF in source_discovery_only
  -- mode ONCE across every changed definition, instead of once per object
  -- inside the loop below. The UDF is a per-row scalar function, so a single
  -- query computes each object's source list while paying the JavaScript UDF
  -- initialization cost a single time rather than once per object. This turns
  -- the N per-object discovery jobs into one batch job.
  --
  -- Isolation is preserved: source_discovery_only never throws (it returns
  -- analysis_status = 'PARTIAL_FAILURE' with an error payload for a failing
  -- object), so one object's discovery failure surfaces only as that object's
  -- source_discovery_json cell. The loop still validates the per-object status
  -- and RAISEs into this object's EXCEPTION handler exactly as before.
  -- --------------------------------------------------------------------------
  -- Create the discovery result table empty (WHERE FALSE: the UDF is not
  -- evaluated, only the schema is fixed), then fill it one chunk per job.
  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE changed_definitions_with_discovery AS
    SELECT
      object_project,
      object_dataset,
      object_name,
      object_type,
      generation_type,
      definition_text,
      definition_hash,
      `__UDF__`(
        definition_text,
        '[]',
        @options_json,
        NULL
      ) AS source_discovery_json
    FROM
      changed_definitions_to_analyze
    WHERE FALSE
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in batch source-discovery result-table SQL.';

  EXECUTE IMMEDIATE rendered_sql
  USING
    TO_JSON_STRING(STRUCT(TRUE AS source_discovery_only)) AS options_json;

  SET discovery_udf_chunk_count = (
    SELECT DIV(COUNT(*) + discovery_udf_chunk_size - 1, discovery_udf_chunk_size)
    FROM changed_definitions_to_analyze
  );

  -- Per-chunk INSERT. A row's chunk is its ROW_NUMBER (over the full changed set)
  -- bucketed by @chunk_size; the UDF is evaluated only for the selected chunk, so
  -- each job runs at most @chunk_size invocations.
  SET sql_template = """
    INSERT INTO changed_definitions_with_discovery
    SELECT
      object_project,
      object_dataset,
      object_name,
      object_type,
      generation_type,
      definition_text,
      definition_hash,
      `__UDF__`(
        definition_text,
        '[]',
        @options_json,
        NULL
      ) AS source_discovery_json
    FROM (
      SELECT
        c.*,
        DIV(
          ROW_NUMBER() OVER (
            ORDER BY
              object_project, object_dataset, object_name,
              object_type, generation_type, definition_hash
          ) - 1,
          @chunk_size
        ) AS discovery_chunk
      FROM changed_definitions_to_analyze AS c
    )
    WHERE discovery_chunk = @chunk_index
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in batch source-discovery SQL.';

  SET discovery_udf_chunk_index = 0;

  WHILE discovery_udf_chunk_index < discovery_udf_chunk_count DO
    EXECUTE IMMEDIATE rendered_sql
    USING
      TO_JSON_STRING(STRUCT(TRUE AS source_discovery_only)) AS options_json,
      discovery_udf_chunk_size AS chunk_size,
      discovery_udf_chunk_index AS chunk_index;

    SET discovery_udf_chunk_index = discovery_udf_chunk_index + 1;
  END WHILE;

  -- ==========================================================================
  -- Batch analysis and publish (full set-based STEP 3).
  --
  -- The former per-object FOR loop invoked the UDF and issued ~20 EXECUTE
  -- IMMEDIATE statements per changed object, running ~15-20N serial BigQuery
  -- jobs. This block replaces that with a fixed, set-based pipeline whose job
  -- count does not grow with N:
  --   1. Scope physical-column metadata for every object in one query.
  --   2. Run the persistent UDF once across all analyzable objects.
  --   3. Stage dependencies and diagnostics for all objects in set queries.
  --   4. Publish with a small number of set-based DML statements.
  --
  -- Semantics preserved from the per-object design:
  --   * COMPLETED objects: direct dependencies and diagnostics are replaced.
  --   * Non-COMPLETED UDF results: dependencies are NOT touched (last known-good
  --     rows are preserved, ADR-0004); diagnostics are replaced and a
  --     UDF_RESULT_NOT_PUBLISHABLE row is recorded; registry -> FAILED.
  --   * Pre-analysis failures (source discovery did not COMPLETE, or scoped
  --     metadata exceeds the single-call limit): dependencies untouched, an
  --     ANALYSIS_EXECUTION_FAILED diagnostic is appended, registry -> FAILED.
  --
  -- Behavior change vs the per-object loop: publication is now batch-atomic
  -- rather than per-object. All staging is computed first; the destructive DML
  -- runs inside a block that, on any error, restores the affected direct
  -- dependency and diagnostic rows from pre-publish backups and re-raises. A
  -- single object can no longer be skipped mid-run while its siblings commit;
  -- either the whole publish succeeds or the repository is left unchanged. The
  -- UDF never throws (it returns analysis_status), so per-object failures are
  -- still isolated as data, not as aborts.
  -- ==========================================================================
  BEGIN
    DECLARE batch_analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
    -- Declared in this enclosing block (not the publish block) so it stays
    -- visible inside the publish block's EXCEPTION handler: BigQuery does not
    -- expose a variable to the EXCEPTION section of the same BEGIN block.
    DECLARE publish_err_message STRING;

    -- The lineage UDF is run in fixed-size chunks rather than one query over all
    -- analyzable objects. A single query calling the JavaScript UDF across
    -- thousands of rows accumulates V8 heap in the per-slot UDF context and hits
    -- "Resource exceeded during query execution: UDF out of memory" as the target
    -- set grows (no single object is large; the peak is aggregate). Splitting the
    -- run into separate EXECUTE IMMEDIATE jobs of analysis_udf_chunk_size rows
    -- each bounds how many invocations share a context. Lower this if OOM
    -- persists; raise it to reduce per-run job overhead.
    DECLARE analysis_udf_chunk_size INT64 DEFAULT 200;
    DECLARE analysis_udf_chunk_count INT64 DEFAULT 0;
    DECLARE analysis_udf_chunk_index INT64 DEFAULT 0;

    -- ------------------------------------------------------------------------
    -- 1. Scope physical-column metadata for every object with COMPLETED source
    -- discovery. This is the set-based form of the loop's Phase 2; the object
    -- key columns thread the per-object identity through every stage. Objects
    -- with no matched columns still receive '[]' via the final LEFT JOIN.
    -- ------------------------------------------------------------------------
    CREATE OR REPLACE TEMP TABLE batch_object_metadata AS
    WITH obj AS (
      SELECT
        object_project,
        object_dataset,
        object_name,
        object_type,
        generation_type,
        definition_hash,
        source_discovery_json
      FROM changed_definitions_with_discovery
      WHERE COALESCE(
        JSON_VALUE(source_discovery_json, '$.analysis.analysis_status'),
        'UNKNOWN'
      ) = 'COMPLETED'
    ),
    discovered_sources AS (
      SELECT DISTINCT
        o.object_project,
        o.object_dataset,
        o.object_name,
        o.object_type,
        o.generation_type,
        o.definition_hash,
        LOWER(JSON_VALUE(source_row, '$')) AS source_name,
        STRPOS(JSON_VALUE(source_row, '$'), '*') > 0 AS is_wildcard,
        CONCAT(
          '^',
          REPLACE(
            REPLACE(LOWER(JSON_VALUE(source_row, '$')), '.', '\\.'),
            '*', '.*'
          ),
          '$'
        ) AS name_regex
      FROM obj AS o,
      UNNEST(
        COALESCE(
          JSON_QUERY_ARRAY(o.source_discovery_json, '$.source_tables'),
          CAST([] AS ARRAY<STRING>)
        )
      ) AS source_row
      WHERE JSON_VALUE(source_row, '$') IS NOT NULL
    ),
    metadata_tables AS (
      SELECT DISTINCT table_catalog, table_schema, table_name
      FROM current_target_columns
    ),
    exact_matches AS (
      SELECT
        source.object_project,
        source.object_dataset,
        source.object_name,
        source.object_type,
        source.generation_type,
        source.definition_hash,
        metadata.table_catalog,
        metadata.table_schema,
        metadata.table_name,
        metadata.table_catalog AS display_catalog,
        metadata.table_schema AS display_schema,
        metadata.table_name AS display_name
      FROM metadata_tables AS metadata
      INNER JOIN discovered_sources AS source
        ON source.is_wildcard = FALSE
       AND (
         source.source_name = LOWER(FORMAT(
           '%s.%s.%s',
           metadata.table_catalog, metadata.table_schema, metadata.table_name
         ))
         OR source.source_name = LOWER(FORMAT(
           '%s.%s', metadata.table_schema, metadata.table_name
         ))
         OR source.source_name = LOWER(metadata.table_name)
       )
    ),
    wildcard_ranked AS (
      SELECT
        source.object_project,
        source.object_dataset,
        source.object_name,
        source.object_type,
        source.generation_type,
        source.definition_hash,
        metadata.table_catalog,
        metadata.table_schema,
        metadata.table_name,
        source.source_name,
        ROW_NUMBER() OVER (
          PARTITION BY
            source.object_project,
            source.object_dataset,
            source.object_name,
            source.object_type,
            source.generation_type,
            source.definition_hash,
            source.source_name,
            metadata.table_catalog,
            metadata.table_schema
          ORDER BY metadata.table_name DESC
        ) AS shard_rank
      FROM metadata_tables AS metadata
      INNER JOIN discovered_sources AS source
        ON source.is_wildcard = TRUE
       AND (
         REGEXP_CONTAINS(
           LOWER(FORMAT(
             '%s.%s.%s',
             metadata.table_catalog, metadata.table_schema, metadata.table_name
           )),
           source.name_regex
         )
         OR REGEXP_CONTAINS(
           LOWER(FORMAT(
             '%s.%s', metadata.table_schema, metadata.table_name
           )),
           source.name_regex
         )
         OR REGEXP_CONTAINS(LOWER(metadata.table_name), source.name_regex)
       )
    ),
    wildcard_matches AS (
      SELECT
        object_project,
        object_dataset,
        object_name,
        object_type,
        generation_type,
        definition_hash,
        table_catalog,
        table_schema,
        table_name,
        table_catalog AS display_catalog,
        table_schema AS display_schema,
        SPLIT(source_name, '.')[SAFE_OFFSET(
          ARRAY_LENGTH(SPLIT(source_name, '.')) - 1
        )] AS display_name
      FROM wildcard_ranked
      WHERE shard_rank = 1
    ),
    discovered_metadata_tables AS (
      SELECT
        object_project, object_dataset, object_name, object_type,
        generation_type, definition_hash,
        table_catalog, table_schema, table_name,
        display_catalog, display_schema, display_name
      FROM exact_matches
      UNION DISTINCT
      SELECT
        object_project, object_dataset, object_name, object_type,
        generation_type, definition_hash,
        table_catalog, table_schema, table_name,
        display_catalog, display_schema, display_name
      FROM wildcard_matches
    ),
    top_level_columns AS (
      SELECT
        discovered.object_project,
        discovered.object_dataset,
        discovered.object_name,
        discovered.object_type,
        discovered.generation_type,
        discovered.definition_hash,
        discovered.display_catalog AS table_project,
        discovered.display_schema AS table_dataset,
        discovered.display_name AS table_name,
        column_info.column_name,
        column_info.column_name AS field_path,
        column_info.ordinal_position,
        column_info.data_type,
        column_info.is_nullable
      FROM current_target_columns AS column_info
      INNER JOIN discovered_metadata_tables AS discovered
        ON discovered.table_catalog = column_info.table_catalog
       AND discovered.table_schema = column_info.table_schema
       AND discovered.table_name = column_info.table_name
    ),
    nested_field_paths AS (
      SELECT
        discovered.object_project,
        discovered.object_dataset,
        discovered.object_name,
        discovered.object_type,
        discovered.generation_type,
        discovered.definition_hash,
        discovered.display_catalog AS table_project,
        discovered.display_schema AS table_dataset,
        discovered.display_name AS table_name,
        field.column_name,
        field.field_path,
        column_info.ordinal_position,
        field.data_type,
        CAST(NULL AS STRING) AS is_nullable
      FROM current_target_column_field_paths AS field
      INNER JOIN discovered_metadata_tables AS discovered
        ON discovered.table_catalog = field.table_catalog
       AND discovered.table_schema = field.table_schema
       AND discovered.table_name = field.table_name
      LEFT JOIN current_target_columns AS column_info
        ON column_info.table_catalog = field.table_catalog
       AND column_info.table_schema = field.table_schema
       AND column_info.table_name = field.table_name
       AND column_info.column_name = field.column_name
      WHERE field.field_path IS NOT NULL
        AND field.field_path != field.column_name
        AND STRPOS(field.field_path, '.') > 0
    ),
    scoped AS (
      SELECT * FROM top_level_columns
      UNION ALL
      SELECT * FROM nested_field_paths
    ),
    agg AS (
      SELECT
        object_project,
        object_dataset,
        object_name,
        object_type,
        generation_type,
        definition_hash,
        -- Only the fields the lineage engine actually reads are shipped to the
        -- UDF: table_name / column_name / field_path (name resolution) and
        -- ordinal_position (candidate ordering). data_type and is_nullable are
        -- parsed but never emitted in the exported output, so they are dropped
        -- from the per-object payload. This materially shrinks the JSON for
        -- objects referencing wide / deeply-nested tables (a complex nested
        -- data_type signature can dominate a column's bytes) and reduces the
        -- JavaScript UDF's peak memory ("UDF out of memory") as the target set
        -- grows.
        TO_JSON_STRING(ARRAY_AGG(
          STRUCT(
            LOWER(FORMAT('%s.%s.%s', table_project, table_dataset, table_name)) AS table_name,
            LOWER(column_name) AS column_name,
            LOWER(field_path) AS field_path,
            ordinal_position AS ordinal_position
          )
          ORDER BY table_project, table_dataset, table_name, ordinal_position, field_path
        )) AS physical_columns_json,
        SUM(BYTE_LENGTH(TO_JSON_STRING(STRUCT(
          LOWER(FORMAT('%s.%s.%s', table_project, table_dataset, table_name)) AS table_name,
          LOWER(column_name) AS column_name,
          LOWER(field_path) AS field_path,
          ordinal_position AS ordinal_position
        ))) + 1) AS physical_metadata_json_bytes
      FROM scoped
      GROUP BY
        object_project, object_dataset, object_name,
        object_type, generation_type, definition_hash
    )
    SELECT
      obj.object_project,
      obj.object_dataset,
      obj.object_name,
      obj.object_type,
      obj.generation_type,
      obj.definition_hash,
      COALESCE(agg.physical_columns_json, '[]') AS physical_columns_json,
      COALESCE(agg.physical_metadata_json_bytes, 2) AS physical_metadata_json_bytes
    FROM obj
    LEFT JOIN agg
      USING (
        object_project, object_dataset, object_name,
        object_type, generation_type, definition_hash
      );

    -- ------------------------------------------------------------------------
    -- 2. Assemble the analysis input for every changed object. Each row carries
    -- a stable analysis_id (materialized here so it is identical in the result
    -- column and the UDF context), the scoped metadata, and a pre-analysis
    -- classification. Objects that cannot be analyzed (discovery incomplete or
    -- metadata over the single-call limit) are flagged, not dropped.
    -- ------------------------------------------------------------------------
    CREATE OR REPLACE TEMP TABLE batch_analysis_input AS
    SELECT
      t.*,
      (t.preanalysis_failure_reason IS NULL) AS is_analyzable,
      -- Chunk number for the UDF run. Analyzable rows are numbered contiguously
      -- (partitioned on analyzability so the numbering ignores skipped rows) and
      -- grouped into buckets of analysis_udf_chunk_size; non-analyzable rows get
      -- NULL. The UDF is executed one chunk per job to bound per-context memory.
      CASE
        WHEN t.preanalysis_failure_reason IS NULL THEN
          DIV(
            ROW_NUMBER() OVER (
              PARTITION BY (t.preanalysis_failure_reason IS NULL)
              ORDER BY
                t.object_project, t.object_dataset, t.object_name,
                t.object_type, t.generation_type, t.definition_hash
            ) - 1,
            analysis_udf_chunk_size
          )
        ELSE NULL
      END AS udf_chunk
    FROM (
      SELECT
        c.object_project,
        c.object_dataset,
        c.object_name,
        c.object_type,
        c.generation_type,
        c.definition_hash,
        c.definition_text,
        GENERATE_UUID() AS analysis_id,
        COALESCE(
          JSON_VALUE(c.source_discovery_json, '$.analysis.analysis_status'),
          'UNKNOWN'
        ) AS discovery_status,
        JSON_VALUE(c.source_discovery_json, '$.error.message')
          AS discovery_error_message,
        COALESCE(m.physical_columns_json, '[]') AS physical_columns_json,
        COALESCE(m.physical_metadata_json_bytes, 2) AS physical_metadata_json_bytes,
        CASE
          WHEN COALESCE(
            JSON_VALUE(c.source_discovery_json, '$.analysis.analysis_status'),
            'UNKNOWN'
          ) != 'COMPLETED' THEN 'SOURCE_DISCOVERY'
          WHEN COALESCE(m.physical_metadata_json_bytes, 2) >= 900000
            THEN 'METADATA_TOO_LARGE'
          ELSE NULL
        END AS preanalysis_failure_reason
      FROM changed_definitions_with_discovery AS c
      LEFT JOIN batch_object_metadata AS m
        ON m.object_project = c.object_project
       AND m.object_dataset = c.object_dataset
       AND m.object_name = c.object_name
       AND m.object_type = c.object_type
       AND m.generation_type = c.generation_type
       AND m.definition_hash = c.definition_hash
    ) AS t;

    -- ------------------------------------------------------------------------
    -- 3. Run the persistent lineage UDF for every analyzable object, in
    -- fixed-size chunks. A single query calling the JavaScript UDF across all
    -- rows accumulates V8 heap in the per-slot UDF context and hits "UDF out of
    -- memory" as the target set grows, even though no single object is large.
    -- The result table is created empty once (WHERE FALSE, so the UDF is not
    -- evaluated but the schema is fixed), then one INSERT job per chunk appends
    -- its rows. Each job/context handles at most analysis_udf_chunk_size
    -- invocations. The result JSON lives in a table column (no 1 MiB
    -- script-variable limit).
    -- ------------------------------------------------------------------------
    SET sql_template = """
      CREATE OR REPLACE TEMP TABLE batch_udf_results AS
      SELECT
        x.object_project,
        x.object_dataset,
        x.object_name,
        x.object_type,
        x.generation_type,
        x.definition_hash,
        x.analysis_id,
        x.analyzed_at,
        x.exported_json,
        COALESCE(
          JSON_VALUE(x.exported_json, '$.analysis.analysis_status'),
          'UNKNOWN'
        ) AS udf_analysis_status,
        JSON_VALUE(x.exported_json, '$.analysis.message') AS udf_analysis_message
      FROM (
        SELECT
          p.object_project,
          p.object_dataset,
          p.object_name,
          p.object_type,
          p.generation_type,
          p.definition_hash,
          p.analysis_id,
          @analyzed_at AS analyzed_at,
          `__UDF__`(
            p.definition_text,
            p.physical_columns_json,
            TO_JSON_STRING(STRUCT(
              @strict_mode AS strict_mode,
              TRUE AS compact_export
            )),
            TO_JSON_STRING(STRUCT(
              p.analysis_id AS analysis_id,
              p.object_project AS view_project,
              p.object_dataset AS view_dataset,
              p.object_name AS view_name,
              @analyzed_at_iso AS analyzed_at
            ))
          ) AS exported_json
        FROM batch_analysis_input AS p
        WHERE FALSE
      ) AS x
    """;

    SET rendered_sql = render_dynamic_sql(
      sql_template,
      repository_project_id,
      repository_dataset,
      target_project_id,
      job_region,
      udf_project_id,
      udf_dataset,
      udf_function_name,
      repo_tables
    );

    ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
    AS 'Unresolved placeholder in batch UDF result-table SQL.';

    -- Create the empty result table (no UDF invocation: WHERE FALSE).
    EXECUTE IMMEDIATE rendered_sql
    USING
      strict_mode AS strict_mode,
      batch_analyzed_at AS analyzed_at,
      FORMAT_TIMESTAMP('%FT%H:%M:%E*S%Ez', batch_analyzed_at) AS analyzed_at_iso;

    SET analysis_udf_chunk_count = (
      SELECT DIV(COUNT(*) + analysis_udf_chunk_size - 1, analysis_udf_chunk_size)
      FROM batch_analysis_input
      WHERE is_analyzable
    );

    -- Per-chunk INSERT template. Rendered once; @chunk_index selects the slice.
    SET sql_template = """
      INSERT INTO batch_udf_results
      SELECT
        x.object_project,
        x.object_dataset,
        x.object_name,
        x.object_type,
        x.generation_type,
        x.definition_hash,
        x.analysis_id,
        x.analyzed_at,
        x.exported_json,
        COALESCE(
          JSON_VALUE(x.exported_json, '$.analysis.analysis_status'),
          'UNKNOWN'
        ) AS udf_analysis_status,
        JSON_VALUE(x.exported_json, '$.analysis.message') AS udf_analysis_message
      FROM (
        SELECT
          p.object_project,
          p.object_dataset,
          p.object_name,
          p.object_type,
          p.generation_type,
          p.definition_hash,
          p.analysis_id,
          @analyzed_at AS analyzed_at,
          `__UDF__`(
            p.definition_text,
            p.physical_columns_json,
            TO_JSON_STRING(STRUCT(
              @strict_mode AS strict_mode,
              TRUE AS compact_export
            )),
            TO_JSON_STRING(STRUCT(
              p.analysis_id AS analysis_id,
              p.object_project AS view_project,
              p.object_dataset AS view_dataset,
              p.object_name AS view_name,
              @analyzed_at_iso AS analyzed_at
            ))
          ) AS exported_json
        FROM batch_analysis_input AS p
        WHERE p.is_analyzable
          AND p.udf_chunk = @chunk_index
      ) AS x
    """;

    SET rendered_sql = render_dynamic_sql(
      sql_template,
      repository_project_id,
      repository_dataset,
      target_project_id,
      job_region,
      udf_project_id,
      udf_dataset,
      udf_function_name,
      repo_tables
    );

    ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
    AS 'Unresolved placeholder in batch UDF analysis SQL.';

    SET analysis_udf_chunk_index = 0;

    WHILE analysis_udf_chunk_index < analysis_udf_chunk_count DO
      EXECUTE IMMEDIATE rendered_sql
      USING
        strict_mode AS strict_mode,
        batch_analyzed_at AS analyzed_at,
        FORMAT_TIMESTAMP('%FT%H:%M:%E*S%Ez', batch_analyzed_at) AS analyzed_at_iso,
        analysis_udf_chunk_index AS chunk_index;

      SET analysis_udf_chunk_index = analysis_udf_chunk_index + 1;
    END WHILE;

    -- ------------------------------------------------------------------------
    -- 4. Object key sets driving the set-based publish.
    -- ------------------------------------------------------------------------
    -- Per-object source-existence flags. A DAG/generated table can reference
    -- source tables that were temporary or short-lived and no longer exist. The
    -- engine reports a source with no collected columns as PHYSICAL_METADATA_
    -- NOT_FOUND / SOURCE_METADATA_NOT_COLLECTED (WARNING), which alone would push
    -- the object to COMPLETED_WITH_WARNINGS and make it non-publishable. We split
    -- the two causes using INFORMATION_SCHEMA:
    --   has_absent_source            : a discovered source is NOT in
    --                                  INFORMATION_SCHEMA.TABLES (genuinely gone;
    --                                  the not-found is expected, suppress it).
    --   has_present_uncollected_source: a discovered source IS in TABLES but has
    --                                  no columns collected (a real coverage gap;
    --                                  keep surfacing it).
    -- Wildcard sources (events_*) match by regex, matching the metadata-scoping
    -- rules above.
    CREATE OR REPLACE TEMP TABLE batch_object_source_flags AS
    WITH obj AS (
      SELECT
        object_project, object_dataset, object_name,
        object_type, generation_type, definition_hash, source_discovery_json
      FROM changed_definitions_with_discovery
      WHERE COALESCE(
        JSON_VALUE(source_discovery_json, '$.analysis.analysis_status'),
        'UNKNOWN'
      ) = 'COMPLETED'
    ),
    discovered_sources AS (
      SELECT DISTINCT
        o.object_project, o.object_dataset, o.object_name,
        o.object_type, o.generation_type, o.definition_hash,
        LOWER(JSON_VALUE(source_row, '$')) AS source_name,
        STRPOS(JSON_VALUE(source_row, '$'), '*') > 0 AS is_wildcard,
        CONCAT(
          '^',
          REPLACE(
            REPLACE(LOWER(JSON_VALUE(source_row, '$')), '.', '\\.'),
            '*', '.*'
          ),
          '$'
        ) AS name_regex
      FROM obj AS o,
      UNNEST(
        COALESCE(
          JSON_QUERY_ARRAY(o.source_discovery_json, '$.source_tables'),
          CAST([] AS ARRAY<STRING>)
        )
      ) AS source_row
      WHERE JSON_VALUE(source_row, '$') IS NOT NULL
    ),
    tables AS (
      SELECT DISTINCT table_catalog, table_schema, table_name
      FROM current_target_tables
    ),
    cols AS (
      SELECT DISTINCT table_catalog, table_schema, table_name
      FROM current_target_columns
    ),
    tables_matched AS (
      SELECT DISTINCT
        s.object_project, s.object_dataset, s.object_name,
        s.object_type, s.generation_type, s.definition_hash, s.source_name
      FROM discovered_sources AS s
      JOIN tables AS m
        ON (
          s.is_wildcard = FALSE
          AND (
            s.source_name = LOWER(FORMAT('%s.%s.%s', m.table_catalog, m.table_schema, m.table_name))
            OR s.source_name = LOWER(FORMAT('%s.%s', m.table_schema, m.table_name))
            OR s.source_name = LOWER(m.table_name)
          )
        )
        OR (
          s.is_wildcard = TRUE
          AND (
            REGEXP_CONTAINS(LOWER(FORMAT('%s.%s.%s', m.table_catalog, m.table_schema, m.table_name)), s.name_regex)
            OR REGEXP_CONTAINS(LOWER(FORMAT('%s.%s', m.table_schema, m.table_name)), s.name_regex)
            OR REGEXP_CONTAINS(LOWER(m.table_name), s.name_regex)
          )
        )
    ),
    cols_matched AS (
      SELECT DISTINCT
        s.object_project, s.object_dataset, s.object_name,
        s.object_type, s.generation_type, s.definition_hash, s.source_name
      FROM discovered_sources AS s
      JOIN cols AS m
        ON (
          s.is_wildcard = FALSE
          AND (
            s.source_name = LOWER(FORMAT('%s.%s.%s', m.table_catalog, m.table_schema, m.table_name))
            OR s.source_name = LOWER(FORMAT('%s.%s', m.table_schema, m.table_name))
            OR s.source_name = LOWER(m.table_name)
          )
        )
        OR (
          s.is_wildcard = TRUE
          AND (
            REGEXP_CONTAINS(LOWER(FORMAT('%s.%s.%s', m.table_catalog, m.table_schema, m.table_name)), s.name_regex)
            OR REGEXP_CONTAINS(LOWER(FORMAT('%s.%s', m.table_schema, m.table_name)), s.name_regex)
            OR REGEXP_CONTAINS(LOWER(m.table_name), s.name_regex)
          )
        )
    ),
    per_source AS (
      SELECT
        s.object_project, s.object_dataset, s.object_name,
        s.object_type, s.generation_type, s.definition_hash,
        (tm.source_name IS NOT NULL) AS exists_in_tables,
        (cm.source_name IS NOT NULL) AS has_columns
      FROM discovered_sources AS s
      LEFT JOIN tables_matched AS tm
        USING (object_project, object_dataset, object_name,
               object_type, generation_type, definition_hash, source_name)
      LEFT JOIN cols_matched AS cm
        USING (object_project, object_dataset, object_name,
               object_type, generation_type, definition_hash, source_name)
    )
    SELECT
      object_project, object_dataset, object_name,
      object_type, generation_type, definition_hash,
      LOGICAL_OR(NOT exists_in_tables) AS has_absent_source,
      LOGICAL_OR(exists_in_tables AND NOT has_columns) AS has_present_uncollected_source
    FROM per_source
    GROUP BY
      object_project, object_dataset, object_name,
      object_type, generation_type, definition_hash;

    -- Resolve each analyzed object to a publishable / not-publishable verdict.
    -- Publishable = exact COMPLETED, OR COMPLETED_WITH_WARNINGS whose warnings are
    -- explained entirely by sources absent from INFORMATION_SCHEMA.TABLES (i.e.
    -- no present-but-uncollected source). Such objects finish normally: their
    -- resolved dependencies are published, the absent-source warnings are NOT
    -- recorded, and is_changed is cleared so they stop being retried.
    CREATE OR REPLACE TEMP TABLE batch_object_status AS
    SELECT
      r.object_project, r.object_dataset, r.object_name,
      r.object_type, r.generation_type, r.definition_hash,
      r.udf_analysis_status,
      r.udf_analysis_message,
      CASE
        WHEN r.udf_analysis_status = 'COMPLETED' THEN TRUE
        WHEN r.udf_analysis_status = 'COMPLETED_WITH_WARNINGS'
          AND NOT COALESCE(f.has_present_uncollected_source, FALSE) THEN TRUE
        ELSE FALSE
      END AS is_publishable
    FROM batch_udf_results AS r
    LEFT JOIN batch_object_source_flags AS f
      USING (object_project, object_dataset, object_name,
             object_type, generation_type, definition_hash);

    CREATE OR REPLACE TEMP TABLE batch_completed_objects AS
    SELECT
      object_project, object_dataset, object_name,
      object_type, generation_type, definition_hash
    FROM batch_object_status
    WHERE is_publishable;

    CREATE OR REPLACE TEMP TABLE batch_udf_failed_objects AS
    SELECT
      object_project, object_dataset, object_name,
      object_type, generation_type, definition_hash
    FROM batch_object_status
    WHERE NOT is_publishable;

    -- Every object that entered the UDF (COMPLETED or not). Diagnostics for all
    -- of these are replaced; pre-analysis failures are handled separately.
    CREATE OR REPLACE TEMP TABLE batch_analyzed_objects AS
    SELECT
      object_project, object_dataset, object_name,
      object_type, generation_type, definition_hash
    FROM batch_udf_results;

    CREATE OR REPLACE TEMP TABLE batch_preanalysis_failures AS
    SELECT
      object_project,
      object_dataset,
      object_name,
      object_type,
      generation_type,
      definition_hash,
      definition_text,
      preanalysis_failure_reason,
      CASE preanalysis_failure_reason
        WHEN 'SOURCE_DISCOVERY' THEN FORMAT(
          'Source discovery did not complete for %s.%s.%s: %s',
          object_project, object_dataset, object_name,
          COALESCE(discovery_error_message, discovery_status)
        )
        WHEN 'METADATA_TOO_LARGE' THEN FORMAT(
          'Scoped physical-column metadata is too large for one UDF call (%d bytes).',
          physical_metadata_json_bytes
        )
        ELSE 'Pre-analysis failure.'
      END AS failure_message
    FROM batch_analysis_input
    WHERE NOT is_analyzable;

    -- ------------------------------------------------------------------------
    -- 5. Stage direct dependencies (COMPLETED objects only) and diagnostics
    -- (all analyzed objects). These are the set-based forms of the loop's
    -- staged_direct_dependency / staged_lineage_diagnostic builds; joins that
    -- were implicit for a single object now carry the object key explicitly.
    -- ------------------------------------------------------------------------
    CREATE OR REPLACE TEMP TABLE batch_staged_direct_dependency AS
    WITH lineage_path_rows AS (
      SELECT
        r.object_project,
        r.object_dataset,
        r.object_name,
        r.object_type,
        r.generation_type,
        r.definition_hash,
        SAFE_CAST(JSON_VALUE(path_row, '$.output_column_id') AS INT64)
          AS output_column_id,
        SAFE_CAST(JSON_VALUE(path_row, '$.output_scope_id') AS INT64)
          AS output_scope_id,
        JSON_VALUE(path_row, '$.output_column_name') AS output_column_name,
        JSON_VALUE(path_row, '$.physical_table_name') AS physical_table_name,
        JSON_VALUE(path_row, '$.physical_column_name') AS physical_column_name,
        JSON_VALUE(path_row, '$.field_path') AS field_path
      FROM batch_udf_results AS r,
      UNNEST(
        JSON_QUERY_ARRAY(r.exported_json, '$.exported_tables.lineage_paths')
      ) AS path_row
      WHERE EXISTS (
        SELECT 1
        FROM batch_completed_objects AS pub
        WHERE pub.object_project = r.object_project
          AND pub.object_dataset = r.object_dataset
          AND pub.object_name = r.object_name
          AND pub.object_type = r.object_type
          AND pub.generation_type = r.generation_type
          AND pub.definition_hash = r.definition_hash
      )
    ),
    output_lineage_rows AS (
      SELECT
        r.object_project,
        r.object_dataset,
        r.object_name,
        r.object_type,
        r.generation_type,
        r.definition_hash,
        SAFE_CAST(JSON_VALUE(output_row, '$.output_column_id') AS INT64)
          AS output_column_id,
        SAFE_CAST(JSON_VALUE(output_row, '$.output_scope_id') AS INT64)
          AS output_scope_id,
        JSON_VALUE(output_row, '$.expression_text') AS expression_text,
        JSON_VALUE(output_row, '$.lineage_status') AS lineage_status
      FROM batch_udf_results AS r,
      UNNEST(
        JSON_QUERY_ARRAY(r.exported_json, '$.exported_tables.output_lineages')
      ) AS output_row
      WHERE EXISTS (
        SELECT 1
        FROM batch_completed_objects AS pub
        WHERE pub.object_project = r.object_project
          AND pub.object_dataset = r.object_dataset
          AND pub.object_name = r.object_name
          AND pub.object_type = r.object_type
          AND pub.generation_type = r.generation_type
          AND pub.definition_hash = r.definition_hash
      )
    ),
    parsed_edges AS (
      SELECT
        path.definition_hash AS definition_hash,
        LOWER(
          CASE ARRAY_LENGTH(SPLIT(path.physical_table_name, '.'))
            WHEN 3 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(0)]
            ELSE path.object_project
          END
        ) AS source_project,
        LOWER(
          CASE ARRAY_LENGTH(SPLIT(path.physical_table_name, '.'))
            WHEN 3 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(1)]
            WHEN 2 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(0)]
            ELSE path.object_dataset
          END
        ) AS source_dataset,
        LOWER(
          CASE ARRAY_LENGTH(SPLIT(path.physical_table_name, '.'))
            WHEN 3 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(2)]
            WHEN 2 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(1)]
            ELSE SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(0)]
          END
        ) AS source_object,
        LOWER(
          COALESCE(path.field_path, path.physical_column_name)
        ) AS source_column,
        LOWER(path.object_project) AS target_project,
        LOWER(path.object_dataset) AS target_dataset,
        LOWER(path.object_name) AS target_object,
        path.object_type AS target_object_type,
        LOWER(path.output_column_name) AS target_column,
        path.generation_type AS generation_type,
        'COLUMN' AS dependency_type,
        output.expression_text AS expression,
        'SELECT' AS usage_type,
        COALESCE(output.lineage_status, 'RESOLVED')
          AS resolution_status,
        CAST(NULL AS STRING) AS resolution_reason,
        batch_analyzed_at AS analyzed_at
      FROM lineage_path_rows AS path
      LEFT JOIN output_lineage_rows AS output
        ON output.output_column_id = path.output_column_id
       AND output.output_scope_id = path.output_scope_id
       AND output.object_project = path.object_project
       AND output.object_dataset = path.object_dataset
       AND output.object_name = path.object_name
       AND output.object_type = path.object_type
       AND output.generation_type = path.generation_type
      WHERE path.physical_table_name IS NOT NULL
        AND path.output_column_name IS NOT NULL
    ),
    normalized_edges AS (
      SELECT
        parsed.* EXCEPT(target_object_type),
        CASE
          WHEN source_registry.object_type = 'VIEW' THEN 'VIEW'
          WHEN source_table.table_type = 'VIEW' THEN 'VIEW'
          ELSE 'TABLE'
        END AS source_object_type,
        parsed.target_object_type
      FROM parsed_edges AS parsed
      LEFT JOIN
        active_view_definitions
          AS source_registry
        ON source_registry.is_active = TRUE
       AND LOWER(source_registry.object_project) = parsed.source_project
       AND LOWER(source_registry.object_dataset) = parsed.source_dataset
       AND LOWER(source_registry.object_name) = parsed.source_object
       AND source_registry.object_type = 'VIEW'
      LEFT JOIN
        current_target_tables AS source_table
        ON LOWER(source_table.table_catalog) = parsed.source_project
       AND LOWER(source_table.table_schema) = parsed.source_dataset
       AND LOWER(source_table.table_name) = parsed.source_object
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY
          parsed.definition_hash,
          parsed.source_project,
          parsed.source_dataset,
          parsed.source_object,
          parsed.source_column,
          parsed.target_project,
          parsed.target_dataset,
          parsed.target_object,
          parsed.target_column,
          parsed.generation_type
        ORDER BY
          source_registry.updated_at DESC NULLS LAST
      ) = 1
    )
    SELECT DISTINCT
      definition_hash,
      source_project,
      source_dataset,
      source_object,
      source_object_type,
      source_column,
      target_project,
      target_dataset,
      target_object,
      target_object_type,
      target_column,
      generation_type,
      dependency_type,
      expression,
      usage_type,
      resolution_status,
      resolution_reason,
      TO_HEX(SHA256(CONCAT(
        COALESCE(source_project, ''), '|',
        COALESCE(source_dataset, ''), '|',
        COALESCE(source_object, ''), '|',
        COALESCE(source_column, '*'), '|',
        COALESCE(target_project, ''), '|',
        COALESCE(target_dataset, ''), '|',
        COALESCE(target_object, ''), '|',
        COALESCE(target_column, '*'), '|',
        generation_type
      ))) AS edge_key,
      analyzed_at
    FROM normalized_edges;

    -- Diagnostics emitted by the UDF for every analyzed object (COMPLETED and
    -- non-COMPLETED alike). generation_type is carried for precise joins but is
    -- not part of the diagnostic table schema.
    CREATE OR REPLACE TEMP TABLE batch_staged_lineage_diagnostic AS
    SELECT
      r.definition_hash AS definition_hash,
      LOWER(r.object_project) AS object_project,
      LOWER(r.object_dataset) AS object_dataset,
      LOWER(r.object_name) AS object_name,
      r.object_type AS object_type,
      r.generation_type AS generation_type,
      COALESCE(JSON_VALUE(diagnostic_row, '$.code'), 'UNKNOWN')
        AS diagnostic_code,
      JSON_VALUE(diagnostic_row, '$.stage') AS engine_stage,
      COALESCE(JSON_VALUE(diagnostic_row, '$.severity'), 'INFO')
        AS severity,
      CAST(NULL AS STRING) AS output_column,
      CAST(NULL AS STRING) AS expression,
      JSON_VALUE(diagnostic_row, '$.message') AS message,
      SAFE.PARSE_JSON(
        JSON_VALUE(diagnostic_row, '$.diagnostic_json')
      ) AS diagnostic_json,
      r.analyzed_at AS analyzed_at
    FROM batch_udf_results AS r,
    UNNEST(
      COALESCE(
        JSON_QUERY_ARRAY(r.exported_json, '$.exported_tables.diagnostics'),
        CAST([] AS ARRAY<STRING>)
      )
    ) AS diagnostic_row
    -- Only stage diagnostics for objects that are NOT publishable. Publishable
    -- objects (exact COMPLETED, or COMPLETED_WITH_WARNINGS whose warnings are all
    -- from sources absent in INFORMATION_SCHEMA.TABLES) contribute no diagnostics,
    -- so absent-source not-found warnings are never recorded.
    WHERE EXISTS (
      SELECT 1
      FROM batch_udf_failed_objects AS fail
      WHERE fail.object_project = r.object_project
        AND fail.object_dataset = r.object_dataset
        AND fail.object_name = r.object_name
        AND fail.object_type = r.object_type
        AND fail.generation_type = r.generation_type
        AND fail.definition_hash = r.definition_hash
    );

    -- Synthetic UDF_RESULT_NOT_PUBLISHABLE diagnostic for non-publishable objects.
    CREATE OR REPLACE TEMP TABLE batch_nonpublishable_diagnostic AS
    SELECT
      r.definition_hash AS definition_hash,
      LOWER(r.object_project) AS object_project,
      LOWER(r.object_dataset) AS object_dataset,
      LOWER(r.object_name) AS object_name,
      r.object_type AS object_type,
      'UDF_RESULT_NOT_PUBLISHABLE' AS diagnostic_code,
      '06_analyze_changed_objects' AS engine_stage,
      'ERROR' AS severity,
      CAST(NULL AS STRING) AS output_column,
      CAST(NULL AS STRING) AS expression,
      FORMAT(
        'Lineage UDF returned a non-publishable status: %s',
        r.udf_analysis_status
      ) AS message,
      JSON_OBJECT(
        'udf_analysis_status', r.udf_analysis_status,
        'analysis_message', r.udf_analysis_message
      ) AS diagnostic_json,
      r.analyzed_at AS analyzed_at
    FROM batch_udf_results AS r
    WHERE EXISTS (
      SELECT 1
      FROM batch_udf_failed_objects AS fail
      WHERE fail.object_project = r.object_project
        AND fail.object_dataset = r.object_dataset
        AND fail.object_name = r.object_name
        AND fail.object_type = r.object_type
        AND fail.generation_type = r.generation_type
        AND fail.definition_hash = r.definition_hash
    );

    -- Synthetic ANALYSIS_EXECUTION_FAILED diagnostic for pre-analysis failures.
    CREATE OR REPLACE TEMP TABLE batch_preanalysis_diagnostic AS
    SELECT
      f.definition_hash AS definition_hash,
      LOWER(f.object_project) AS object_project,
      LOWER(f.object_dataset) AS object_dataset,
      LOWER(f.object_name) AS object_name,
      f.object_type AS object_type,
      'ANALYSIS_EXECUTION_FAILED' AS diagnostic_code,
      '06_analyze_changed_objects' AS engine_stage,
      'ERROR' AS severity,
      CAST(NULL AS STRING) AS output_column,
      CAST(NULL AS STRING) AS expression,
      f.failure_message AS message,
      JSON_OBJECT(
        'preanalysis_failure_reason', f.preanalysis_failure_reason
      ) AS diagnostic_json,
      batch_analyzed_at AS analyzed_at
    FROM batch_preanalysis_failures AS f;

    -- ------------------------------------------------------------------------
    -- 6. Back up the direct-dependency and diagnostic rows the publish will
    -- overwrite, so the EXCEPTION handler can restore them if any publish
    -- statement fails (batch equivalent of the loop's per-object backups).
    -- ------------------------------------------------------------------------
    SET sql_template = """
      CREATE OR REPLACE TEMP TABLE batch_previous_direct_dependency AS
      SELECT dependency.*
      FROM `__T_DIRECT_DEP__` AS dependency
      WHERE EXISTS (
        SELECT 1
        FROM batch_completed_objects AS obj
        WHERE LOWER(dependency.target_project) = LOWER(obj.object_project)
          AND LOWER(dependency.target_dataset) = LOWER(obj.object_dataset)
          AND LOWER(dependency.target_object) = LOWER(obj.object_name)
          AND dependency.target_object_type = obj.object_type
          AND dependency.generation_type = obj.generation_type
      )
    """;
    SET rendered_sql = render_dynamic_sql(
      sql_template,
      repository_project_id,
      repository_dataset,
      target_project_id,
      job_region,
      udf_project_id,
      udf_dataset,
      udf_function_name,
      repo_tables
    );
    ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
    AS 'Unresolved placeholder in batch dependency backup SQL.';
    EXECUTE IMMEDIATE rendered_sql;

    SET sql_template = """
      CREATE OR REPLACE TEMP TABLE batch_previous_lineage_diagnostic AS
      SELECT diagnostic.*
      FROM `__T_DIAGNOSTIC__` AS diagnostic
      WHERE EXISTS (
        SELECT 1
        FROM batch_analyzed_objects AS obj
        WHERE LOWER(diagnostic.object_project) = LOWER(obj.object_project)
          AND LOWER(diagnostic.object_dataset) = LOWER(obj.object_dataset)
          AND LOWER(diagnostic.object_name) = LOWER(obj.object_name)
          AND diagnostic.object_type = obj.object_type
      )
    """;
    SET rendered_sql = render_dynamic_sql(
      sql_template,
      repository_project_id,
      repository_dataset,
      target_project_id,
      job_region,
      udf_project_id,
      udf_dataset,
      udf_function_name,
      repo_tables
    );
    ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
    AS 'Unresolved placeholder in batch diagnostic backup SQL.';
    EXECUTE IMMEDIATE rendered_sql;

    -- ------------------------------------------------------------------------
    -- 7. Publish. Every statement is set-based and keyed by the object sets
    -- above. On any failure the handler restores the backed-up rows and
    -- re-raises, leaving the repository as it was before the publish.
    -- ------------------------------------------------------------------------
    BEGIN
      -- 7a. Replace direct dependencies for COMPLETED objects.
      SET sql_template = """
        DELETE FROM `__T_DIRECT_DEP__` AS dependency
        WHERE EXISTS (
          SELECT 1
          FROM batch_completed_objects AS obj
          WHERE LOWER(dependency.target_project) = LOWER(obj.object_project)
            AND LOWER(dependency.target_dataset) = LOWER(obj.object_dataset)
            AND LOWER(dependency.target_object) = LOWER(obj.object_name)
            AND dependency.target_object_type = obj.object_type
            AND dependency.generation_type = obj.generation_type
        )
      """;
      SET rendered_sql = render_dynamic_sql(
        sql_template,
        repository_project_id, repository_dataset, target_project_id,
        job_region, udf_project_id, udf_dataset, udf_function_name, repo_tables
      );
      ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
      AS 'Unresolved placeholder in batch dependency DELETE SQL.';
      EXECUTE IMMEDIATE rendered_sql;

      SET sql_template = """
        INSERT INTO `__T_DIRECT_DEP__` (
          definition_hash, source_project, source_dataset, source_object,
          source_object_type, source_column, target_project, target_dataset,
          target_object, target_object_type, target_column, generation_type,
          dependency_type, expression, usage_type, resolution_status,
          resolution_reason, edge_key, analyzed_at
        )
        SELECT
          definition_hash, source_project, source_dataset, source_object,
          source_object_type, source_column, target_project, target_dataset,
          target_object, target_object_type, target_column, generation_type,
          dependency_type, expression, usage_type, resolution_status,
          resolution_reason, edge_key, analyzed_at
        FROM batch_staged_direct_dependency
      """;
      SET rendered_sql = render_dynamic_sql(
        sql_template,
        repository_project_id, repository_dataset, target_project_id,
        job_region, udf_project_id, udf_dataset, udf_function_name, repo_tables
      );
      ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
      AS 'Unresolved placeholder in batch dependency INSERT SQL.';
      EXECUTE IMMEDIATE rendered_sql;

      -- 7b. Replace diagnostics for all analyzed objects, then insert the UDF
      -- diagnostics, the non-publishable markers, and (appended) the
      -- pre-analysis failure diagnostics.
      SET sql_template = """
        DELETE FROM `__T_DIAGNOSTIC__` AS diagnostic
        WHERE EXISTS (
          SELECT 1
          FROM batch_analyzed_objects AS obj
          WHERE LOWER(diagnostic.object_project) = LOWER(obj.object_project)
            AND LOWER(diagnostic.object_dataset) = LOWER(obj.object_dataset)
            AND LOWER(diagnostic.object_name) = LOWER(obj.object_name)
            AND diagnostic.object_type = obj.object_type
        )
      """;
      SET rendered_sql = render_dynamic_sql(
        sql_template,
        repository_project_id, repository_dataset, target_project_id,
        job_region, udf_project_id, udf_dataset, udf_function_name, repo_tables
      );
      ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
      AS 'Unresolved placeholder in batch diagnostic DELETE SQL.';
      EXECUTE IMMEDIATE rendered_sql;

      SET sql_template = """
        INSERT INTO `__T_DIAGNOSTIC__` (
          definition_hash, object_project, object_dataset, object_name,
          object_type, diagnostic_code, engine_stage, severity, output_column,
          expression, message, diagnostic_json, analyzed_at
        )
        SELECT
          definition_hash, object_project, object_dataset, object_name,
          object_type, diagnostic_code, engine_stage, severity, output_column,
          expression, message, diagnostic_json, analyzed_at
        FROM batch_staged_lineage_diagnostic
        UNION ALL
        SELECT
          definition_hash, object_project, object_dataset, object_name,
          object_type, diagnostic_code, engine_stage, severity, output_column,
          expression, message, diagnostic_json, analyzed_at
        FROM batch_nonpublishable_diagnostic
        UNION ALL
        SELECT
          definition_hash, object_project, object_dataset, object_name,
          object_type, diagnostic_code, engine_stage, severity, output_column,
          expression, message, diagnostic_json, analyzed_at
        FROM batch_preanalysis_diagnostic
      """;
      SET rendered_sql = render_dynamic_sql(
        sql_template,
        repository_project_id, repository_dataset, target_project_id,
        job_region, udf_project_id, udf_dataset, udf_function_name, repo_tables
      );
      ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
      AS 'Unresolved placeholder in batch diagnostic INSERT SQL.';
      EXECUTE IMMEDIATE rendered_sql;

      -- 7c. Registry: COMPLETED objects.
      SET sql_template = """
        UPDATE `__T_DEF_REGISTRY__` AS reg
        SET
          is_changed = FALSE,
          analysis_status = 'COMPLETED',
          last_analyzed_hash = obj.definition_hash,
          last_analyzed_at = @analyzed_at,
          updated_at = @analyzed_at
        FROM batch_completed_objects AS obj
        WHERE LOWER(reg.object_project) = LOWER(obj.object_project)
          AND LOWER(reg.object_dataset) = LOWER(obj.object_dataset)
          AND LOWER(reg.object_name) = LOWER(obj.object_name)
          AND reg.object_type = obj.object_type
          AND reg.generation_type = obj.generation_type
          AND reg.definition_hash = obj.definition_hash
      """;
      SET rendered_sql = render_dynamic_sql(
        sql_template,
        repository_project_id, repository_dataset, target_project_id,
        job_region, udf_project_id, udf_dataset, udf_function_name, repo_tables
      );
      ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
      AS 'Unresolved placeholder in batch registry COMPLETED UPDATE SQL.';
      EXECUTE IMMEDIATE rendered_sql
      USING batch_analyzed_at AS analyzed_at;

      -- 7d. Registry: FAILED objects (non-COMPLETED UDF results + pre-analysis
      -- failures).
      SET sql_template = """
        UPDATE `__T_DEF_REGISTRY__` AS reg
        SET
          is_changed = TRUE,
          analysis_status = 'FAILED',
          last_analyzed_at = @analyzed_at,
          updated_at = @analyzed_at
        FROM (
          SELECT
            object_project, object_dataset, object_name,
            object_type, generation_type, definition_hash
          FROM batch_udf_failed_objects
          UNION DISTINCT
          SELECT
            object_project, object_dataset, object_name,
            object_type, generation_type, definition_hash
          FROM batch_preanalysis_failures
        ) AS obj
        WHERE LOWER(reg.object_project) = LOWER(obj.object_project)
          AND LOWER(reg.object_dataset) = LOWER(obj.object_dataset)
          AND LOWER(reg.object_name) = LOWER(obj.object_name)
          AND reg.object_type = obj.object_type
          AND reg.generation_type = obj.generation_type
          AND reg.definition_hash = obj.definition_hash
      """;
      SET rendered_sql = render_dynamic_sql(
        sql_template,
        repository_project_id, repository_dataset, target_project_id,
        job_region, udf_project_id, udf_dataset, udf_function_name, repo_tables
      );
      ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
      AS 'Unresolved placeholder in batch registry FAILED UPDATE SQL.';
      EXECUTE IMMEDIATE rendered_sql
      USING batch_analyzed_at AS analyzed_at;

    EXCEPTION WHEN ERROR THEN
      -- Capture the error, restore the pre-publish dependency and diagnostic
      -- rows, then re-raise so the failed run is visible and the repository is
      -- left exactly as it was before this publish began.
      SET publish_err_message = @@error.message;

      SET sql_template = """
        DELETE FROM `__T_DIRECT_DEP__` AS dependency
        WHERE EXISTS (
          SELECT 1
          FROM batch_completed_objects AS obj
          WHERE LOWER(dependency.target_project) = LOWER(obj.object_project)
            AND LOWER(dependency.target_dataset) = LOWER(obj.object_dataset)
            AND LOWER(dependency.target_object) = LOWER(obj.object_name)
            AND dependency.target_object_type = obj.object_type
            AND dependency.generation_type = obj.generation_type
        )
      """;
      SET rendered_sql = render_dynamic_sql(
        sql_template,
        repository_project_id, repository_dataset, target_project_id,
        job_region, udf_project_id, udf_dataset, udf_function_name, repo_tables
      );
      ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
      AS 'Unresolved placeholder in batch rollback dependency DELETE SQL.';
      EXECUTE IMMEDIATE rendered_sql;

      SET sql_template = """
        INSERT INTO `__T_DIRECT_DEP__`
        SELECT * FROM batch_previous_direct_dependency
      """;
      SET rendered_sql = render_dynamic_sql(
        sql_template,
        repository_project_id, repository_dataset, target_project_id,
        job_region, udf_project_id, udf_dataset, udf_function_name, repo_tables
      );
      ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
      AS 'Unresolved placeholder in batch rollback dependency INSERT SQL.';
      EXECUTE IMMEDIATE rendered_sql;

      SET sql_template = """
        DELETE FROM `__T_DIAGNOSTIC__` AS diagnostic
        WHERE EXISTS (
          SELECT 1
          FROM batch_analyzed_objects AS obj
          WHERE LOWER(diagnostic.object_project) = LOWER(obj.object_project)
            AND LOWER(diagnostic.object_dataset) = LOWER(obj.object_dataset)
            AND LOWER(diagnostic.object_name) = LOWER(obj.object_name)
            AND diagnostic.object_type = obj.object_type
        )
      """;
      SET rendered_sql = render_dynamic_sql(
        sql_template,
        repository_project_id, repository_dataset, target_project_id,
        job_region, udf_project_id, udf_dataset, udf_function_name, repo_tables
      );
      ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
      AS 'Unresolved placeholder in batch rollback diagnostic DELETE SQL.';
      EXECUTE IMMEDIATE rendered_sql;

      SET sql_template = """
        INSERT INTO `__T_DIAGNOSTIC__`
        SELECT * FROM batch_previous_lineage_diagnostic
      """;
      SET rendered_sql = render_dynamic_sql(
        sql_template,
        repository_project_id, repository_dataset, target_project_id,
        job_region, udf_project_id, udf_dataset, udf_function_name, repo_tables
      );
      ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
      AS 'Unresolved placeholder in batch rollback diagnostic INSERT SQL.';
      EXECUTE IMMEDIATE rendered_sql;

      RAISE USING MESSAGE = FORMAT(
        'Batch publish failed and was rolled back: %s',
        publish_err_message
      );
    END;

    -- ------------------------------------------------------------------------
    -- 8. Retain every non-COMPLETED and pre-analysis result for the final
    -- operational result set (set-based form of the loop's per-object inserts).
    -- ------------------------------------------------------------------------
    -- Non-COMPLETED UDF results: one row per emitted diagnostic.
    INSERT INTO non_completed_udf_results
    SELECT
      LOWER(r.object_project),
      LOWER(r.object_dataset),
      LOWER(r.object_name),
      r.object_type,
      r.udf_analysis_status,
      ARRAY_LENGTH(COALESCE(
        JSON_QUERY_ARRAY(r.exported_json, '$.exported_tables.diagnostics'),
        CAST([] AS ARRAY<STRING>)
      )),
      ARRAY_LENGTH(COALESCE(
        JSON_QUERY_ARRAY(r.exported_json, '$.exported_tables.output_lineages'),
        CAST([] AS ARRAY<STRING>)
      )),
      ARRAY_LENGTH(COALESCE(
        JSON_QUERY_ARRAY(r.exported_json, '$.exported_tables.lineage_paths'),
        CAST([] AS ARRAY<STRING>)
      )),
      COALESCE(JSON_VALUE(diagnostic_row, '$.code'), 'UNKNOWN'),
      JSON_VALUE(diagnostic_row, '$.stage'),
      COALESCE(JSON_VALUE(diagnostic_row, '$.severity'), 'INFO'),
      JSON_VALUE(diagnostic_row, '$.message'),
      SAFE.PARSE_JSON(JSON_VALUE(diagnostic_row, '$.diagnostic_json')),
      SAFE.PARSE_JSON(JSON_VALUE(r.exported_json, '$.analysis.error_nodes_json')),
      r.exported_json
    FROM batch_udf_results AS r,
    UNNEST(
      COALESCE(
        JSON_QUERY_ARRAY(r.exported_json, '$.exported_tables.diagnostics'),
        CAST([] AS ARRAY<STRING>)
      )
    ) AS diagnostic_row
    WHERE EXISTS (
      SELECT 1
      FROM batch_udf_failed_objects AS fail
      WHERE fail.object_project = r.object_project
        AND fail.object_dataset = r.object_dataset
        AND fail.object_name = r.object_name
        AND fail.object_type = r.object_type
        AND fail.generation_type = r.generation_type
        AND fail.definition_hash = r.definition_hash
    );

    -- Non-publishable UDF results with no diagnostic row: a single summary row.
    INSERT INTO non_completed_udf_results
    SELECT
      LOWER(r.object_project),
      LOWER(r.object_dataset),
      LOWER(r.object_name),
      r.object_type,
      r.udf_analysis_status,
      0,
      ARRAY_LENGTH(COALESCE(
        JSON_QUERY_ARRAY(r.exported_json, '$.exported_tables.output_lineages'),
        CAST([] AS ARRAY<STRING>)
      )),
      ARRAY_LENGTH(COALESCE(
        JSON_QUERY_ARRAY(r.exported_json, '$.exported_tables.lineage_paths'),
        CAST([] AS ARRAY<STRING>)
      )),
      CAST(NULL AS STRING),
      CAST(NULL AS STRING),
      CAST(NULL AS STRING),
      JSON_VALUE(r.exported_json, '$.analysis.message'),
      CAST(NULL AS JSON),
      SAFE.PARSE_JSON(JSON_VALUE(r.exported_json, '$.analysis.error_nodes_json')),
      r.exported_json
    FROM batch_udf_results AS r
    WHERE EXISTS (
      SELECT 1
      FROM batch_udf_failed_objects AS fail
      WHERE fail.object_project = r.object_project
        AND fail.object_dataset = r.object_dataset
        AND fail.object_name = r.object_name
        AND fail.object_type = r.object_type
        AND fail.generation_type = r.generation_type
        AND fail.definition_hash = r.definition_hash
    )
      AND ARRAY_LENGTH(COALESCE(
        JSON_QUERY_ARRAY(r.exported_json, '$.exported_tables.diagnostics'),
        CAST([] AS ARRAY<STRING>)
      )) = 0;

    -- Pre-analysis failures.
    INSERT INTO non_completed_udf_results
    SELECT
      LOWER(f.object_project),
      LOWER(f.object_dataset),
      LOWER(f.object_name),
      f.object_type,
      'EXECUTION_FAILED',
      1,
      CAST(NULL AS INT64),
      CAST(NULL AS INT64),
      'ANALYSIS_EXECUTION_FAILED',
      '06_analyze_changed_objects',
      'ERROR',
      f.failure_message,
      JSON_OBJECT('preanalysis_failure_reason', f.preanalysis_failure_reason),
      JSON_ARRAY(JSON_OBJECT(
        'severity', 'ERROR',
        'diagnostic_code', 'ANALYSIS_EXECUTION_FAILED',
        'message', f.failure_message,
        'original_sql', f.definition_text
      )),
      CAST(NULL AS STRING)
    FROM batch_preanalysis_failures AS f;

    -- ------------------------------------------------------------------------
    -- 9. Run counters for the summary below.
    -- ------------------------------------------------------------------------
    SET analyzed_object_count = (
      SELECT COUNT(*) FROM batch_completed_objects
    );
    SET failed_object_count = (
      SELECT COUNT(*) FROM batch_udf_failed_objects
    ) + (
      SELECT COUNT(*) FROM batch_preanalysis_failures
    );
  END;

  -- --------------------------------------------------------------------------
  -- Run summary.
  -- 04_rebuild_impact_table.sql is executed after this script in daily operation.
  -- --------------------------------------------------------------------------
  SET sql_template = """
    SELECT
      @p_run_started_at AS run_started_at,
      CURRENT_TIMESTAMP() AS run_finished_at,
      @p_analyzed_object_count AS analyzed_object_count,
      @p_failed_object_count AS failed_object_count,
      (
        SELECT COUNT(*)
        FROM
          `__T_DEF_REGISTRY__`
        WHERE is_active = TRUE
          AND is_changed = TRUE
      ) AS remaining_changed_object_count,
      (
        SELECT COUNT(*)
        FROM
          `__T_DIRECT_DEP__`
      ) AS direct_dependency_count,
      (
        SELECT COUNT(*)
        FROM
          `__T_DIAGNOSTIC__`
        WHERE severity = 'ERROR'
      ) AS error_diagnostic_count
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in STEP 3 run summary SQL.';

  EXECUTE IMMEDIATE rendered_sql
  USING
    run_started_at AS p_run_started_at,
    analyzed_object_count AS p_analyzed_object_count,
    failed_object_count AS p_failed_object_count;
END;

-- ============================================================================
-- STEP 4: Rebuild ranked impact paths
-- ============================================================================
BEGIN
  DECLARE snapshot_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
  DECLARE max_rank INT64 DEFAULT configured_max_impact_rank;

  SET sql_template = """
  CREATE OR REPLACE TABLE
    `__T_IMPACT__`
  PARTITION BY DATE(snapshot_at)
  CLUSTER BY
    origin_project,
    origin_dataset,
    origin_object,
    origin_column
  AS
  WITH RECURSIVE impact_tree AS (
    SELECT
      LOWER(edge.source_project) AS origin_project,
      LOWER(edge.source_dataset) AS origin_dataset,
      LOWER(edge.source_object) AS origin_object,
      edge.source_object_type AS origin_object_type,
      LOWER(edge.source_column) AS origin_column,
      1 AS impact_rank,
      LOWER(edge.target_project) AS impacted_project,
      LOWER(edge.target_dataset) AS impacted_dataset,
      LOWER(edge.target_object) AS impacted_object,
      edge.target_object_type AS impacted_object_type,
      LOWER(edge.target_column) AS impacted_column,
      LOWER(edge.source_project) AS direct_source_project,
      LOWER(edge.source_dataset) AS direct_source_dataset,
      LOWER(edge.source_object) AS direct_source_object,
      edge.source_object_type AS direct_source_object_type,
      LOWER(edge.source_column) AS direct_source_column,
      [
        CONCAT(
          COALESCE(LOWER(edge.source_project), ''), '.',
          COALESCE(LOWER(edge.source_dataset), ''), '.',
          LOWER(edge.source_object), '.',
          COALESCE(LOWER(edge.source_column), '*')
        ),
        CONCAT(
          COALESCE(LOWER(edge.target_project), ''), '.',
          COALESCE(LOWER(edge.target_dataset), ''), '.',
          LOWER(edge.target_object), '.',
          COALESCE(LOWER(edge.target_column), '*')
        )
      ] AS dependency_path,
      edge.generation_type,
      edge.resolution_status,
      FALSE AS is_cycle
    FROM
      `__T_DIRECT_DEP__` AS edge
    WHERE edge.resolution_status IN (
      'RESOLVED',
      'SOURCE_RESOLVED',
      'PARTIALLY_RESOLVED'
    )

    UNION ALL

    SELECT
      parent.origin_project,
      parent.origin_dataset,
      parent.origin_object,
      parent.origin_object_type,
      parent.origin_column,
      parent.impact_rank + 1,
      LOWER(child.target_project),
      LOWER(child.target_dataset),
      LOWER(child.target_object),
      child.target_object_type,
      LOWER(child.target_column),
      LOWER(child.source_project),
      LOWER(child.source_dataset),
      LOWER(child.source_object),
      child.source_object_type,
      LOWER(child.source_column),
      ARRAY_CONCAT(
        parent.dependency_path,
        [CONCAT(
          COALESCE(LOWER(child.target_project), ''), '.',
          COALESCE(LOWER(child.target_dataset), ''), '.',
          LOWER(child.target_object), '.',
          COALESCE(LOWER(child.target_column), '*')
        )]
      ),
      child.generation_type,
      child.resolution_status,
      CONCAT(
        COALESCE(LOWER(child.target_project), ''), '.',
        COALESCE(LOWER(child.target_dataset), ''), '.',
        LOWER(child.target_object), '.',
        COALESCE(LOWER(child.target_column), '*')
      ) IN UNNEST(parent.dependency_path) AS is_cycle
    FROM impact_tree AS parent
    JOIN
      `__T_DIRECT_DEP__` AS child
      ON LOWER(child.source_project) =
        LOWER(parent.impacted_project)
     AND LOWER(child.source_dataset) =
        LOWER(parent.impacted_dataset)
     AND LOWER(child.source_object) =
        LOWER(parent.impacted_object)
     AND (
       LOWER(child.source_column) =
         LOWER(parent.impacted_column)
       OR child.source_column IS NULL
       OR parent.impacted_column IS NULL
     )
    WHERE parent.impact_rank < @p_max_rank
      AND parent.is_cycle = FALSE
      AND child.resolution_status IN (
        'RESOLVED',
        'SOURCE_RESOLVED',
        'PARTIALLY_RESOLVED'
      )
  )
  SELECT DISTINCT
    @p_snapshot_time AS snapshot_at,
    origin_project,
    origin_dataset,
    origin_object,
    origin_object_type,
    origin_column,
    impact_rank,
    impacted_project,
    impacted_dataset,
    impacted_object,
    impacted_object_type,
    impacted_column,
    direct_source_project,
    direct_source_dataset,
    direct_source_object,
    direct_source_object_type,
    direct_source_column,
    dependency_path,
    TO_HEX(
      SHA256(ARRAY_TO_STRING(dependency_path, ' -> '))
    ) AS path_hash,
    generation_type,
    resolution_status,
    is_cycle
  FROM impact_tree
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in lineage_impact rebuild SQL.';

  EXECUTE IMMEDIATE rendered_sql
  USING
    snapshot_time AS p_snapshot_time,
    max_rank AS p_max_rank;

  SET sql_template = """
    SELECT
      'REBUILD_IMPACT' AS step_name,
      @p_snapshot_time AS step_started_at,
      CURRENT_TIMESTAMP() AS step_finished_at,
      (
        SELECT COUNT(*)
        FROM `__T_IMPACT__`
      ) AS impact_row_count
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    repo_tables
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in REBUILD_IMPACT summary SQL.';

  EXECUTE IMMEDIATE rendered_sql
  USING snapshot_time AS p_snapshot_time;
END;

-- ============================================================================
-- PIPELINE SUMMARY
-- ============================================================================
SET sql_template = """
  SELECT
    CURRENT_TIMESTAMP() AS pipeline_finished_at,
    (
      SELECT COUNT(*)
      FROM `__T_DEF_REGISTRY__`
      WHERE is_active = TRUE
    ) AS active_definition_count,
    (
      SELECT COUNT(*)
      FROM `__T_DEF_REGISTRY__`
      WHERE is_active = TRUE
        AND is_changed = TRUE
    ) AS remaining_changed_definition_count,
    (
      SELECT COUNT(*)
      FROM `__T_DIRECT_DEP__`
    ) AS direct_dependency_count,
    (
      SELECT COUNT(*)
      FROM `__T_IMPACT__`
    ) AS impact_count,
    (
      SELECT COUNT(*)
      FROM `__T_DIAGNOSTIC__`
      WHERE severity = 'ERROR'
    ) AS error_diagnostic_count
""";

SET rendered_sql = render_dynamic_sql(
  sql_template,
  repository_project_id,
  repository_dataset,
  target_project_id,
  job_region,
  udf_project_id,
  udf_dataset,
  udf_function_name,
  repo_tables
);

ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
AS 'Unresolved placeholder in pipeline summary SQL.';

EXECUTE IMMEDIATE rendered_sql;
END;


-- ============================================================================
-- FINAL OPERATIONAL RESULT
-- COMPLETED is intentionally excluded. During stabilization, every warning,
-- partial resolution, failure, unknown status, and execution exception is shown.
-- ============================================================================
SELECT
  object_project,
  object_dataset,
  object_name,
  object_type,
  analysis_status,
  diagnostic_count,
  output_lineage_count,
  lineage_path_count,
  diagnostic_code,
  engine_stage,
  severity,
  message,
  diagnostic_json,
  error_nodes_json,
  analysis_result_json
FROM non_completed_udf_results
ORDER BY
  object_project,
  object_dataset,
  object_name,
  severity DESC,
  diagnostic_code;
