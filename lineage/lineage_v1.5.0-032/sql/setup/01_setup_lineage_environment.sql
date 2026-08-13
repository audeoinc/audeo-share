-- ============================================================================
-- 01_setup_lineage_environment.sql
-- BigQuery Physical Lineage Repository - Environment setup
-- ============================================================================
SET @@location = 'asia-northeast1';

-- ============================================================================
-- Bootstrap values
--
-- Edit this section when installing the repository in another environment.
-- These values are used directly by the setup steps below.
--
-- There is no lineage_config table: the daily pipeline
-- (03_run_daily_lineage_pipeline.sql) is configured independently in its own
-- top-of-file parameter block. This script only creates/replaces the repository
-- tables and the persistent UDF, so it only needs the values below. Runtime
-- knobs (job lookback, max impact rank, scan scope, service accounts) live in
-- 03 and are intentionally not duplicated here.
--
-- Prerequisite:
--   Upload lineage_udf_bundle.js to the configured GCS URI before execution.
-- ============================================================================
DECLARE bootstrap_repository_project_id STRING DEFAULT 'project_id';
DECLARE bootstrap_repository_dataset STRING DEFAULT 'lineage_repository';
DECLARE bootstrap_repository_location STRING DEFAULT 'asia-northeast1';

DECLARE bootstrap_udf_project_id STRING DEFAULT 'project_id';
DECLARE bootstrap_udf_dataset STRING DEFAULT 'dataset';
DECLARE bootstrap_udf_function_name STRING DEFAULT 'analyze_lineage_json';
-- Companion scalar UDF that returns a SQL structural fingerprint. Used by
-- 03_run_daily_lineage_pipeline.sql to collapse structurally-identical
-- rotating-destination JOBS (temp / ephemeral). Shares the same GCS bundle.
DECLARE bootstrap_udf_fingerprint_function_name STRING
  DEFAULT 'fingerprint_lineage_sql';
DECLARE bootstrap_udf_library_uri STRING DEFAULT
  'gs://YOUR_BUCKET/YOUR_PATH/lineage_udf_bundle.js';

-- Target project/dataset are used only by the UDF smoke test below (to build a
-- representative physical-column identity). The pipeline's own scan scope is set
-- in 03_run_daily_lineage_pipeline.sql.
DECLARE bootstrap_target_project_id STRING DEFAULT 'project_id';
DECLARE bootstrap_target_datasets ARRAY<STRING> DEFAULT ['dataset'];

-- Smoke-test parser options (mirror 03's parser_strict_mode / compact_export).
DECLARE bootstrap_parser_strict_mode BOOL DEFAULT FALSE;
DECLARE bootstrap_compact_export BOOL DEFAULT TRUE;

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
-- empty to omit it.
-- ----------------------------------------------------------------------------
DECLARE bootstrap_table_name_prefix STRING DEFAULT '';
DECLARE bootstrap_table_name_suffix STRING DEFAULT '';

DECLARE table_definition_registry STRING;
DECLARE table_direct_dependency STRING;
DECLARE table_impact STRING;
DECLARE table_diagnostic STRING;
DECLARE table_job_registry STRING;

DECLARE repository_dataset_full_name STRING;

DECLARE smoke_test_result STRING;
DECLARE smoke_test_status STRING;
DECLARE fingerprint_smoke_result BOOL;

-- Physical table names: prefix + marker + canonical base + suffix.
-- The 'm_' / 't_' marker literal is inline; edit it to reclassify a table.
SET table_definition_registry =
  bootstrap_table_name_prefix || 'm_' || 'lineage_definition_registry'
    || bootstrap_table_name_suffix;
SET table_job_registry =
  bootstrap_table_name_prefix || 'm_' || 'lineage_job_registry'
    || bootstrap_table_name_suffix;
SET table_direct_dependency =
  bootstrap_table_name_prefix || 't_' || 'lineage_direct_dependency'
    || bootstrap_table_name_suffix;
SET table_impact =
  bootstrap_table_name_prefix || 't_' || 'lineage_impact'
    || bootstrap_table_name_suffix;
SET table_diagnostic =
  bootstrap_table_name_prefix || 't_' || 'lineage_diagnostic'
    || bootstrap_table_name_suffix;

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

SET repository_dataset_full_name = FORMAT(
  '%s.%s',
  bootstrap_repository_project_id,
  bootstrap_repository_dataset
);

-- ============================================================================
-- 1. Repository Dataset
--
-- Dataset (SCHEMA) creation is intentionally disabled. The repository dataset
-- is expected to already exist; this setup script only creates/replaces the
-- tables and the UDF within it. Uncomment the block below to have the script
-- create the dataset.
-- ============================================================================
-- EXECUTE IMMEDIATE FORMAT(
--   '''
--   CREATE SCHEMA IF NOT EXISTS `%s`
--   OPTIONS (
--     location = '%s',
--     description = 'BigQuery physical lineage repository'
--   )
--   ''',
--   repository_dataset_full_name,
--   bootstrap_repository_location
-- );

-- ============================================================================
-- 2. Bootstrap validation
--
-- The typed lineage_config table has been removed; the daily pipeline is
-- configured directly in 03_run_daily_lineage_pipeline.sql. These checks
-- validate the bootstrap values this setup script relies on.
-- ============================================================================
ASSERT NOT STARTS_WITH(bootstrap_udf_library_uri, 'gs://YOUR_')
AS 'Replace bootstrap_udf_library_uri with the uploaded GCS library URI.';

ASSERT ARRAY_LENGTH(bootstrap_target_datasets) > 0
AS 'bootstrap_target_datasets must contain at least one dataset.';

-- ============================================================================
-- 3. Execution service-account configuration
--
-- Removed. Execution service accounts (Scheduled Query / DAG) are no longer
-- stored in a repository table; they are declared directly in the STEP 2
-- parameter block of 03_run_daily_lineage_pipeline.sql, so the pipeline is
-- configured in a single file and no separate table needs maintaining.
-- ============================================================================

-- ============================================================================
-- 4. Repository tables
-- ============================================================================
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.%s`
  (
    object_project STRING NOT NULL,
    object_dataset STRING NOT NULL,
    object_name STRING NOT NULL,
    object_type STRING NOT NULL,
    generation_type STRING NOT NULL,
    definition_source STRING NOT NULL,
    definition_text STRING,
    definition_hash STRING NOT NULL,
    previous_definition_hash STRING,
    -- Structural fingerprint (literal-normalized SHA256) of the SQL. Set for
    -- JOBS-derived objects; NULL for Views. For EPHEMERAL objects it is also the
    -- definition_hash and the identity key. Persistent generated tables carry it
    -- for reference but keep a text-based definition_hash and real identity.
    sql_fingerprint STRING,
    -- TRUE for JOBS-derived objects whose destination does not persist (temp /
    -- rotating-name jobs), which are collapsed by fingerprint to one stable
    -- synthetic identity `<project>.<ephemeral_dataset>.fp_<hash>`. FALSE for
    -- Views and persistent generated tables (which keep their real identity).
    is_ephemeral BOOL,
    source_job_id STRING,
    source_job_time TIMESTAMP,
    source_user_email STRING,
    -- Job labels (dag_id, task_id, ...) carried over from the source job for
    -- generated TABLEs, so a FAILED object can be traced to its DAG without
    -- joining to the job registry. NULL for Views (which have no job labels).
    labels ARRAY<STRUCT<key STRING, value STRING>>,
    is_changed BOOL NOT NULL,
    is_active BOOL NOT NULL,
    analysis_status STRING,
    last_analyzed_hash STRING,
    first_seen_at TIMESTAMP NOT NULL,
    last_seen_at TIMESTAMP NOT NULL,
    last_analyzed_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL
  )
  CLUSTER BY object_project, object_dataset, object_name
  OPTIONS (
    description = 'Current analyzable SQL definition for each target object'
  )
  ''',
  repository_dataset_full_name,
  table_definition_registry
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.%s`
  (
    definition_hash STRING NOT NULL,
    source_project STRING,
    source_dataset STRING,
    source_object STRING NOT NULL,
    source_object_type STRING NOT NULL,
    source_column STRING,
    target_project STRING NOT NULL,
    target_dataset STRING NOT NULL,
    target_object STRING NOT NULL,
    target_object_type STRING NOT NULL,
    target_column STRING,
    generation_type STRING NOT NULL,
    dependency_type STRING NOT NULL,
    expression STRING,
    usage_type STRING,
    resolution_status STRING,
    resolution_reason STRING,
    edge_key STRING NOT NULL,
    analyzed_at TIMESTAMP NOT NULL
  )
  CLUSTER BY source_project, source_dataset, source_object, source_column
  OPTIONS (
    description = 'Published direct source-to-target physical dependencies'
  )
  ''',
  repository_dataset_full_name,
  table_direct_dependency
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.%s`
  (
    snapshot_at TIMESTAMP NOT NULL,
    origin_project STRING,
    origin_dataset STRING,
    origin_object STRING NOT NULL,
    origin_object_type STRING NOT NULL,
    origin_column STRING,
    impact_rank INT64 NOT NULL,
    impacted_project STRING,
    impacted_dataset STRING,
    impacted_object STRING NOT NULL,
    impacted_object_type STRING NOT NULL,
    impacted_column STRING,
    direct_source_project STRING,
    direct_source_dataset STRING,
    direct_source_object STRING NOT NULL,
    direct_source_object_type STRING NOT NULL,
    direct_source_column STRING,
    dependency_path ARRAY<STRING>,
    path_hash STRING NOT NULL,
    generation_type STRING,
    resolution_status STRING,
    is_cycle BOOL NOT NULL
  )
  PARTITION BY DATE(snapshot_at)
  CLUSTER BY origin_project, origin_dataset, origin_object, origin_column
  OPTIONS (
    description = 'Transitive and ranked downstream impact paths'
  )
  ''',
  repository_dataset_full_name,
  table_impact
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.%s`
  (
    definition_hash STRING NOT NULL,
    object_project STRING NOT NULL,
    object_dataset STRING NOT NULL,
    object_name STRING NOT NULL,
    object_type STRING NOT NULL,
    diagnostic_code STRING NOT NULL,
    engine_stage STRING,
    severity STRING NOT NULL,
    output_column STRING,
    expression STRING,
    message STRING,
    diagnostic_json JSON,
    analyzed_at TIMESTAMP NOT NULL
  )
  CLUSTER BY object_project, object_dataset, object_name, diagnostic_code
  OPTIONS (
    description = 'Parser, resolver, export, and execution diagnostics'
  )
  ''',
  repository_dataset_full_name,
  table_diagnostic
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.%s`
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
    -- Structural fingerprint (literal-normalized SHA256), computed for every
    -- collected job. Jobs whose SQL differs only in literals share one
    -- fingerprint; used to collapse rotating-destination (temp/ephemeral) jobs.
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
  OPTIONS (
    description = 'Collected Scheduled Query and DAG-generated table jobs'
  )
  ''',
  repository_dataset_full_name,
  table_job_registry
);

-- ============================================================================
-- 5. Persistent JavaScript UDF using the external GCS bundle
--
-- Dataset (SCHEMA) creation for the UDF dataset is intentionally disabled. The
-- UDF dataset is expected to already exist; this setup script only
-- creates/replaces the function within it. Uncomment the block below to have
-- the script create the dataset.
-- ============================================================================
-- EXECUTE IMMEDIATE FORMAT(
--   '''
--   CREATE SCHEMA IF NOT EXISTS `%s.%s`
--   OPTIONS (
--     location = '%s'
--   )
--   ''',
--   bootstrap_udf_project_id,
--   bootstrap_udf_dataset,
--   bootstrap_repository_location
-- );

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE FUNCTION `%s.%s.%s`(
    sql_text STRING,
    physical_columns_json STRING,
    options_json STRING,
    export_metadata_json STRING
  )
  RETURNS STRING
  LANGUAGE js
  OPTIONS (
    library = [
      '%s'
    ]
  )
  AS r"""
    return analyzeLineageForBigQuery(
      sql_text,
      physical_columns_json,
      options_json,
      export_metadata_json
    );
  """
  ''',
  bootstrap_udf_project_id,
  bootstrap_udf_dataset,
  bootstrap_udf_function_name,
  bootstrap_udf_library_uri
);

-- Companion fingerprint UDF (same library bundle). Returns a literal-normalized
-- canonical SQL string; the pipeline hashes it with SHA256 to group
-- structurally-identical SELECT jobs.
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE FUNCTION `%s.%s.%s`(
    sql_text STRING
  )
  RETURNS STRING
  LANGUAGE js
  OPTIONS (
    library = [
      '%s'
    ]
  )
  AS r"""
    return fingerprintSqlForBigQuery(sql_text);
  """
  ''',
  bootstrap_udf_project_id,
  bootstrap_udf_dataset,
  bootstrap_udf_fingerprint_function_name,
  bootstrap_udf_library_uri
);

-- ============================================================================
-- 6. UDF smoke test
-- ============================================================================
EXECUTE IMMEDIATE FORMAT(
  '''
  SELECT `%s.%s.%s`(
    'SELECT customer_id FROM sample_sales',
    TO_JSON_STRING([
      STRUCT(
        '%s.%s.sample_sales' AS table_name,
        'customer_id' AS column_name,
        'customer_id' AS field_path,
        1 AS ordinal_position,
        'STRING' AS data_type,
        'YES' AS is_nullable
      )
    ]),
    TO_JSON_STRING(STRUCT(
      @strict_mode AS strict_mode,
      @compact_export AS compact_export
    )),
    TO_JSON_STRING(STRUCT(
      GENERATE_UUID() AS analysis_id,
      @target_project_id AS view_project,
      @target_dataset AS view_dataset,
      'setup_smoke_test' AS view_name,
      FORMAT_TIMESTAMP(
        '%%FT%%H:%%M:%%E*S%%Ez',
        CURRENT_TIMESTAMP()
      ) AS analyzed_at
    ))
  )
  ''',
  bootstrap_udf_project_id,
  bootstrap_udf_dataset,
  bootstrap_udf_function_name,
  bootstrap_target_project_id,
  bootstrap_target_datasets[SAFE_OFFSET(0)]
)
INTO smoke_test_result
USING
  bootstrap_parser_strict_mode AS strict_mode,
  bootstrap_compact_export AS compact_export,
  bootstrap_target_project_id AS target_project_id,
  bootstrap_target_datasets[SAFE_OFFSET(0)] AS target_dataset;

SET smoke_test_status = COALESCE(
  JSON_VALUE(smoke_test_result, '$.analysis.analysis_status'),
  'UNKNOWN'
);

ASSERT smoke_test_status IN (
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS'
)
AS 'Persistent lineage UDF smoke test did not complete successfully.';

-- Fingerprint UDF smoke test: two SELECTs differing only in a literal must
-- produce the same fingerprint, and a structurally different SELECT must not.
EXECUTE IMMEDIATE FORMAT(
  '''
  SELECT
    `%s.%s.%s`('SELECT a FROM t WHERE d = 1')
      = `%s.%s.%s`('SELECT a FROM t WHERE d = 2')
    AND `%s.%s.%s`('SELECT a FROM t WHERE d = 1')
      != `%s.%s.%s`('SELECT a, b FROM t WHERE d = 1')
  ''',
  bootstrap_udf_project_id, bootstrap_udf_dataset,
  bootstrap_udf_fingerprint_function_name,
  bootstrap_udf_project_id, bootstrap_udf_dataset,
  bootstrap_udf_fingerprint_function_name,
  bootstrap_udf_project_id, bootstrap_udf_dataset,
  bootstrap_udf_fingerprint_function_name,
  bootstrap_udf_project_id, bootstrap_udf_dataset,
  bootstrap_udf_fingerprint_function_name
)
INTO fingerprint_smoke_result;

ASSERT fingerprint_smoke_result
AS 'Persistent fingerprint UDF smoke test did not behave as expected.';

-- ============================================================================
-- 7. Setup summary
-- ============================================================================
SELECT
  FORMAT(
    '%s.%s',
    bootstrap_repository_project_id,
    bootstrap_repository_dataset
  ) AS repository_dataset,
  bootstrap_repository_location,
  FORMAT(
    '%s.%s.%s',
    bootstrap_udf_project_id,
    bootstrap_udf_dataset,
    bootstrap_udf_function_name
  ) AS persistent_udf,
  FORMAT(
    '%s.%s.%s',
    bootstrap_udf_project_id,
    bootstrap_udf_dataset,
    bootstrap_udf_fingerprint_function_name
  ) AS fingerprint_udf,
  bootstrap_udf_library_uri,
  bootstrap_target_project_id,
  bootstrap_target_datasets,
  bootstrap_parser_strict_mode,
  bootstrap_compact_export,
  smoke_test_status,
  CURRENT_TIMESTAMP() AS setup_finished_at;
