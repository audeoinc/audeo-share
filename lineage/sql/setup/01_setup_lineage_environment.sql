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
-- ============================================================================
-- CONFIGURATION (edit here)
-- ============================================================================
-- Settings are split so it is obvious what to touch:
--   [A] REQUIRED per deployment / region -- review and set these every time.
--   [B] BEHAVIOR OPTIONS -- safe to leave at the defaults; tune as needed.
--   [C] DERIVED / INTERNAL -- computed from [A] or @@location; DO NOT edit.
-- The REGION is set once at `SET @@location` at the top of this file.
--
-- ----------------------------------------------------------------------------
-- [A] REQUIRED per deployment / region -- set these
-- ----------------------------------------------------------------------------
-- Variables are grouped by purpose below; each group is labeled with a one-line
-- header. Full descriptions follow the block under "Variable notes".
-- GCP project: auto-detected at runtime; its DECLARE lives in [B] (pin it there
-- only to run against a different project).
-- Project-token substitution
DECLARE bootstrap_project_token_pattern STRING DEFAULT r'^([^-]+)';
-- Datasets (repository / UDF)
DECLARE bootstrap_repository_dataset STRING DEFAULT 'lineage_repository';
DECLARE bootstrap_udf_dataset STRING DEFAULT 'dataset';
-- Table naming (prefix / suffix)
DECLARE bootstrap_table_name_prefix STRING DEFAULT '';
DECLARE bootstrap_table_name_suffix STRING DEFAULT '';
-- UDF naming (prefix / suffix)
DECLARE bootstrap_udf_name_prefix STRING DEFAULT '';
DECLARE bootstrap_udf_name_suffix STRING DEFAULT '';
-- UDF JS bundle location (GCS)
DECLARE bootstrap_udf_library_uri STRING DEFAULT
  'gs://YOUR_BUCKET/YOUR_PATH/lineage_udf_bundle.js';
--
-- Variable notes (keyed by name):
--   bootstrap_project_token_pattern
--     Project-token substitution. A token extracted from the auto-detected project
--     id by this regex (REGEXP_EXTRACT; if it has a capture group, group 1 is
--     used) is substituted for every literal '{project_token}' placeholder in the
--     dataset names and the table/view/UDF prefixes & suffixes below. Example: for
--     project id 'mycompany-prod-123', pattern r'-([^-]+)-' yields 'prod', so a
--     dataset written as 'lineage_repository_{project_token}' becomes
--     'lineage_repository_prod'. Set the pattern to match your project-id format;
--     the default takes the first hyphen-delimited segment. An unmatched pattern
--     yields '' (empty), and any '{project_token}' left unreplaced fails the name
--     ASSERTs (so typos surface).
--   bootstrap_repository_dataset / bootstrap_udf_dataset
--     Repository dataset (holds the lineage_* tables) and UDF dataset (holds the
--     functions created here). Their *_project_id are in [C].
--   bootstrap_table_name_prefix / bootstrap_table_name_suffix
--     Repository table naming. Physical table names are assembled as
--       prefix + marker + canonical base name + suffix
--     in the SET lines below. The prefix and suffix change per environment (e.g. a
--     region tag like suffix='_tky'); the master/transaction marker ('m_' / 't_')
--     is an inline literal in each SET line (edit it only to reclassify a table).
--     Include any '_' separators in the prefix and suffix; leave a segment empty
--     to omit it. Allowed characters: letters, digits, '_', and '-' (every
--     reference to these tables is backtick-quoted, so a hyphen like suffix='-tky'
--     is safe). Dataset and UDF names still allow only letters/digits/'_' (no '-').
--   bootstrap_udf_name_prefix / bootstrap_udf_name_suffix
--     UDF (routine) naming. UDF names are assembled as
--       udf_prefix + 'lnge_' + canonical base + udf_suffix
--     in [C], keeping the system 'lnge_' identity. Kept separate from the table
--     prefix/suffix because routine names allow only letters/digits/'_' (no '-',
--     unlike backtick-quoted tables); a hyphen here fails the UDF name ASSERT.
--   bootstrap_udf_library_uri
--     GCS URI of the uploaded lineage_udf_bundle.js (deployment-specific).

-- ----------------------------------------------------------------------------
-- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
-- ----------------------------------------------------------------------------
-- Single source of truth for the GCP project. Declared here (not in [A]) because
-- it is normally not set by hand: it is auto-detected in [C] from
-- INFORMATION_SCHEMA.SCHEMATA (the project the job runs in). To pin it instead,
-- set a literal in [C]. The repository, the UDFs, and the smoke-test target all
-- live in this one project; the role-specific bootstrap_*_project_id variables
-- live in [C] and take this unless individually pinned.
DECLARE bootstrap_default_project_id STRING;
-- UDF function names created in bootstrap_udf_dataset (assembled in [C] from the
-- udf prefix/suffix above; keep them in step with 03). The main analysis UDF, the
-- structural-fingerprint UDF (collapses rotating-destination JOBS; same GCS
-- bundle), and the dynamic-SQL identifier renderer.
DECLARE bootstrap_udf_function_name STRING;
DECLARE bootstrap_udf_fingerprint_function_name STRING;
DECLARE bootstrap_udf_render_function_name STRING;
-- Target dataset(s) used only by the UDF smoke test below (to build a
-- representative physical-column identity). The pipeline's own scan scope is set
-- in 03_run_daily_lineage_pipeline.sql.
DECLARE bootstrap_target_datasets ARRAY<STRING> DEFAULT ['dataset'];
-- Smoke-test parser options (mirror 03's parser_strict_mode / compact_export).
DECLARE bootstrap_parser_strict_mode BOOL DEFAULT FALSE;
DECLARE bootstrap_compact_export BOOL DEFAULT TRUE;

-- ----------------------------------------------------------------------------
-- [C] DERIVED / INTERNAL -- computed from [A] or @@location; DO NOT edit
-- ----------------------------------------------------------------------------
-- Role-specific projects take bootstrap_default_project_id (auto-detected below);
-- to pin one role to a separate project, set its DEFAULT to a literal here (a
-- non-NULL value wins via COALESCE in the SET block below). The repository
-- location mirrors @@location (the single source of truth set at the top).
DECLARE bootstrap_repository_project_id STRING DEFAULT NULL;
DECLARE bootstrap_repository_location STRING DEFAULT @@location;
DECLARE bootstrap_udf_project_id STRING DEFAULT NULL;
DECLARE bootstrap_target_project_id STRING DEFAULT NULL;

-- Repository physical table names, assembled by the SET lines below from
-- bootstrap_table_name_prefix / _suffix ([A]); plus smoke-test work variables.
DECLARE table_definition_registry STRING;
DECLARE table_direct_dependency STRING;
DECLARE table_impact STRING;
DECLARE table_diagnostic STRING;
DECLARE table_job_registry STRING;
DECLARE table_column_usage STRING;
DECLARE view_column_usage_impact STRING;

DECLARE repository_dataset_full_name STRING;
-- Token extracted from the project id (see bootstrap_project_token_pattern).
DECLARE bootstrap_project_token STRING;

DECLARE smoke_test_result STRING;
DECLARE smoke_test_status STRING;
DECLARE fingerprint_smoke_result BOOL;

-- Auto-detect the running GCP project from INFORMATION_SCHEMA.SCHEMATA
-- (catalog_name = the project the job runs in). The region-qualified identifier
-- cannot be parameterized, so it is built from @@location. To pin the project,
-- replace this SET with a literal (e.g. SET bootstrap_default_project_id =
-- 'my-project';). Role projects then take it unless individually pinned above.
EXECUTE IMMEDIATE FORMAT(
  "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
  @@location
) INTO bootstrap_default_project_id;
ASSERT bootstrap_default_project_id IS NOT NULL AS
  'Could not auto-detect the project id from INFORMATION_SCHEMA.SCHEMATA (no datasets in this region?); set bootstrap_default_project_id to a literal.';
SET bootstrap_repository_project_id =
  COALESCE(bootstrap_repository_project_id, bootstrap_default_project_id);
SET bootstrap_udf_project_id =
  COALESCE(bootstrap_udf_project_id, bootstrap_default_project_id);
SET bootstrap_target_project_id =
  COALESCE(bootstrap_target_project_id, bootstrap_default_project_id);

-- Extract the project token and substitute it for the '{project_token}'
-- placeholder in every name input BEFORE the names are assembled/asserted.
SET bootstrap_project_token =
  COALESCE(REGEXP_EXTRACT(bootstrap_default_project_id, bootstrap_project_token_pattern), '');
SET bootstrap_repository_dataset =
  REPLACE(bootstrap_repository_dataset, '{project_token}', bootstrap_project_token);
SET bootstrap_udf_dataset =
  REPLACE(bootstrap_udf_dataset, '{project_token}', bootstrap_project_token);
SET bootstrap_table_name_prefix =
  REPLACE(bootstrap_table_name_prefix, '{project_token}', bootstrap_project_token);
SET bootstrap_table_name_suffix =
  REPLACE(bootstrap_table_name_suffix, '{project_token}', bootstrap_project_token);
SET bootstrap_udf_name_prefix =
  REPLACE(bootstrap_udf_name_prefix, '{project_token}', bootstrap_project_token);
SET bootstrap_udf_name_suffix =
  REPLACE(bootstrap_udf_name_suffix, '{project_token}', bootstrap_project_token);
SET bootstrap_udf_library_uri =
  REPLACE(bootstrap_udf_library_uri, '{project_token}', bootstrap_project_token);
SET bootstrap_target_datasets = ARRAY(
  SELECT REPLACE(d, '{project_token}', bootstrap_project_token)
  FROM UNNEST(bootstrap_target_datasets) AS d
);

-- Guard: surface an unsubstituted '{project_token}' (or any invalid character) in a
-- name input here, rather than as a confusing failure at DDL time. Dataset names
-- must be valid identifiers (letters/digits/underscore); the GCS library URI is not
-- an identifier, so it is only checked for a leftover placeholder.
ASSERT REGEXP_CONTAINS(bootstrap_repository_dataset, r'^[A-Za-z0-9_]+$')
  AS 'bootstrap_repository_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
ASSERT REGEXP_CONTAINS(bootstrap_udf_dataset, r'^[A-Za-z0-9_]+$')
  AS 'bootstrap_udf_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
ASSERT NOT EXISTS (
  SELECT 1 FROM UNNEST(bootstrap_target_datasets) AS d
  WHERE NOT REGEXP_CONTAINS(d, r'^[A-Za-z0-9_]+$')
) AS 'Each bootstrap_target_datasets entry must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
ASSERT STRPOS(bootstrap_udf_library_uri, '{project_token}') = 0
  AS 'bootstrap_udf_library_uri still contains {project_token}; check bootstrap_project_token_pattern.';

-- UDF names: udf_prefix + 'lnge_' + canonical base + udf_suffix (no marker).
SET bootstrap_udf_function_name =
  bootstrap_udf_name_prefix || 'lnge_' || 'analyze_json' || bootstrap_udf_name_suffix;
SET bootstrap_udf_fingerprint_function_name =
  bootstrap_udf_name_prefix || 'lnge_' || 'fingerprint_sql' || bootstrap_udf_name_suffix;
SET bootstrap_udf_render_function_name =
  bootstrap_udf_name_prefix || 'lnge_' || 'render_dynamic_sql' || bootstrap_udf_name_suffix;
ASSERT REGEXP_CONTAINS(bootstrap_udf_function_name, r'^[A-Za-z0-9_]+$')
AS 'Invalid udf function name (letters/digits/_ only; no hyphen in udf prefix/suffix).';
ASSERT REGEXP_CONTAINS(bootstrap_udf_fingerprint_function_name, r'^[A-Za-z0-9_]+$')
AS 'Invalid udf fingerprint function name (letters/digits/_ only; no hyphen).';
ASSERT REGEXP_CONTAINS(bootstrap_udf_render_function_name, r'^[A-Za-z0-9_]+$')
AS 'Invalid udf render function name (letters/digits/_ only; no hyphen).';

-- Physical table names: prefix + marker + canonical base + suffix.
-- The 'm_' / 't_' marker literal is inline; edit it to reclassify a table.
SET table_definition_registry =
  bootstrap_table_name_prefix || 'lnge_' || 'm_' || 'definition_registry'
    || bootstrap_table_name_suffix;
SET table_job_registry =
  bootstrap_table_name_prefix || 'lnge_' || 'm_' || 'job_registry'
    || bootstrap_table_name_suffix;
SET table_direct_dependency =
  bootstrap_table_name_prefix || 'lnge_' || 't_' || 'direct_dependency'
    || bootstrap_table_name_suffix;
SET table_impact =
  bootstrap_table_name_prefix || 'lnge_' || 't_' || 'impact'
    || bootstrap_table_name_suffix;
SET table_diagnostic =
  bootstrap_table_name_prefix || 'lnge_' || 't_' || 'diagnostic'
    || bootstrap_table_name_suffix;
SET table_column_usage =
  bootstrap_table_name_prefix || 'lnge_' || 't_' || 'column_usage'
    || bootstrap_table_name_suffix;
-- View naming convention: prefix + 'vw_' + marker + canonical base + suffix, where
-- the marker is 't_' / 'm_' (transaction / master) like the tables. This view is
-- built over the transaction tables lnge_t_column_usage / lnge_t_impact, so
-- its marker is 't_' -> lnge_vw_t_column_usage_impact.
SET view_column_usage_impact =
  bootstrap_table_name_prefix || 'lnge_' || 'vw_' || 't_' || 'column_usage_impact'
    || bootstrap_table_name_suffix;

ASSERT REGEXP_CONTAINS(table_definition_registry, r'^[A-Za-z0-9_-]+$')
AS 'Invalid table_definition_registry name.';
ASSERT REGEXP_CONTAINS(table_direct_dependency, r'^[A-Za-z0-9_-]+$')
AS 'Invalid table_direct_dependency name.';
ASSERT REGEXP_CONTAINS(table_impact, r'^[A-Za-z0-9_-]+$')
AS 'Invalid table_impact name.';
ASSERT REGEXP_CONTAINS(table_diagnostic, r'^[A-Za-z0-9_-]+$')
AS 'Invalid table_diagnostic name.';
ASSERT REGEXP_CONTAINS(table_job_registry, r'^[A-Za-z0-9_-]+$')
AS 'Invalid table_job_registry name.';
ASSERT REGEXP_CONTAINS(table_column_usage, r'^[A-Za-z0-9_-]+$')
AS 'Invalid table_column_usage name.';
ASSERT REGEXP_CONTAINS(view_column_usage_impact, r'^[A-Za-z0-9_-]+$')
AS 'Invalid view_column_usage_impact name.';

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
    -- Variable names DECLAREd in the parent BigQuery script (resolved via the
    -- job's parent_job_id) for JOBS-derived objects that are child statements of a
    -- multi-statement script. Passed to the analysis UDF as script_variables so an
    -- unqualified reference to a script variable -- which is indistinguishable from
    -- a column in the child statement's stored SQL text -- is treated as an opaque
    -- value instead of a missing column. NULL / empty for Views and non-script jobs.
    script_variables ARRAY<STRING>,
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

-- MIGRATION (existing deployments): this CREATE OR REPLACE recreates the registry
-- from scratch, which is fine for a fresh setup but would drop data on an existing
-- repository. To add the script_variables column in place without losing data, run
-- once instead of re-running this CREATE:
--   ALTER TABLE `<project>.<dataset>.<lnge_m_definition_registry>`
--     ADD COLUMN IF NOT EXISTS script_variables ARRAY<STRING>;

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
    -- How this object's SQL was obtained: 'VIEW_DEFINITION' for a View (its SQL is
    -- INFORMATION_SCHEMA.VIEWS.view_definition), or a job execution source
    -- ('SCHEDULED_QUERY' / 'DAG' / ...) for a generated table (its SQL is the
    -- INFORMATION_SCHEMA.JOBS query). Lets a reader tell a view definition from a
    -- job SQL without joining the registry (object_type only says VIEW vs TABLE).
    generation_type STRING,
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

-- MIGRATION (existing deployments): this table is new. Re-running 01 recreates it
-- (CREATE OR REPLACE, destructive for the other tables too), but 03 also issues a
-- CREATE TABLE IF NOT EXISTS for it at startup, so an existing deployment picks it
-- up on the next pipeline run without re-running 01. Keep this schema and 03's
-- IF NOT EXISTS copy in step.
--
-- Column usage index: one row per resolved physical-column reference inside a
-- published object's SQL, across ALL clauses (SELECT / WHERE / JOIN / GROUP BY /
-- HAVING / QUALIFY / ORDER BY), not only value-flow (SELECT) lineage. Answers
-- "where and how is <table/view>.<column> used" for impact review: which object,
-- which line, and in what clause. Populated by 03 STEP 3 from the analysis UDF's
-- physical_column_references (which now carry line_number / line_text). Filter by
-- the source_* columns to find every place a given column is referenced; join to
-- the impact table (origin/impacted + dependency_path) for the transitive
-- downstream reach and to trace a downstream SELECTed column back to its origin.
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.%s`
  (
    -- Referenced physical column (the selectable object.column in the report).
    source_project STRING,
    source_dataset STRING,
    source_object STRING NOT NULL,
    source_object_type STRING NOT NULL,
    source_column STRING NOT NULL,
    source_field_path STRING,
    -- Object whose SQL contains the reference.
    object_project STRING NOT NULL,
    object_dataset STRING NOT NULL,
    object_name STRING NOT NULL,
    object_type STRING NOT NULL,
    generation_type STRING NOT NULL,
    definition_hash STRING NOT NULL,
    -- How and where it is used.
    usage_type STRING NOT NULL,
    reference_name STRING,
    line_number INT64,
    column_number INT64,
    -- The single source line that contains the reference token (per requirement;
    -- the full expression is identifiable via reference_name).
    line_text STRING,
    resolution_status STRING,
    -- Stable identity of one usage site (object + source column + clause +
    -- position), so a re-publish of the same object is idempotent.
    usage_key STRING NOT NULL,
    analyzed_at TIMESTAMP NOT NULL
  )
  CLUSTER BY source_project, source_dataset, source_object, source_column
  OPTIONS (
    description = 'Per-reference column usage index (all clauses) for impact review'
  )
  ''',
  repository_dataset_full_name,
  table_column_usage
);

-- Column-usage x impact depth view. Joins the usage index to the impact graph so
-- a report can pick an ORIGIN column and see every downstream usage site with a
-- DEPTH (relative to that origin: 1 = direct reference, impact_rank + 1 deeper)
-- and the value-flow path. Depth is origin-relative -- the same usage site sits
-- at different depths for different origins -- so it is a view (computed per
-- (origin, usage-site) on read), never a stored rank on the usage table. Impact
-- is fully replaced each 03 STEP 4 run, so the view always holds the current
-- snapshot with no snapshot filter. Created here, after the tables it reads
-- (lnge_t_column_usage / lnge_t_impact).
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE VIEW `%s.%s`
  OPTIONS (
    description = 'Column usage joined to impact: for a chosen origin column, every downstream usage site with a depth (1 = direct reference; impact_rank + 1 deeper) and the value-flow path.'
  )
  AS
  -- depth = 1: the usage references the origin column directly.
  SELECT
    u.source_project      AS origin_project,
    u.source_dataset      AS origin_dataset,
    u.source_object       AS origin_object,
    u.source_object_type  AS origin_object_type,
    u.source_column       AS origin_column,
    1                     AS depth,
    u.source_project      AS ref_source_project,
    u.source_dataset      AS ref_source_dataset,
    u.source_object       AS ref_source_object,
    u.source_object_type  AS ref_source_object_type,
    u.source_column       AS ref_source_column,
    u.source_field_path   AS ref_source_field_path,
    u.object_project      AS usage_object_project,
    u.object_dataset      AS usage_object_dataset,
    u.object_name         AS usage_object_name,
    u.object_type         AS usage_object_type,
    u.generation_type     AS usage_generation_type,
    -- definition_hash of the object that CONTAINS the reference. Use it as the key
    -- to pull that object's actual SQL (e.g. from lnge_m_definition_registry)
    -- when the metadata + line number are not enough to understand the usage.
    u.definition_hash     AS usage_definition_hash,
    u.usage_type,
    u.reference_name,
    u.line_number,
    u.column_number,
    u.line_text,
    u.resolution_status,
    CAST(NULL AS ARRAY<STRING>) AS dependency_path
  FROM `%s.%s` AS u
  UNION ALL
  -- depth = impact_rank + 1: the usage references a column impacted by the origin.
  SELECT
    i.origin_project,
    i.origin_dataset,
    i.origin_object,
    i.origin_object_type,
    i.origin_column,
    i.impact_rank + 1     AS depth,
    u.source_project      AS ref_source_project,
    u.source_dataset      AS ref_source_dataset,
    u.source_object       AS ref_source_object,
    u.source_object_type  AS ref_source_object_type,
    u.source_column       AS ref_source_column,
    u.source_field_path   AS ref_source_field_path,
    u.object_project      AS usage_object_project,
    u.object_dataset      AS usage_object_dataset,
    u.object_name         AS usage_object_name,
    u.object_type         AS usage_object_type,
    u.generation_type     AS usage_generation_type,
    u.definition_hash     AS usage_definition_hash,
    u.usage_type,
    u.reference_name,
    u.line_number,
    u.column_number,
    u.line_text,
    u.resolution_status,
    i.dependency_path
  FROM `%s.%s` AS i
  JOIN `%s.%s` AS u
    ON  LOWER(u.source_project) = LOWER(i.impacted_project)
    AND LOWER(u.source_dataset) = LOWER(i.impacted_dataset)
    AND LOWER(u.source_object)  = LOWER(i.impacted_object)
    AND LOWER(u.source_column)  = LOWER(i.impacted_column)
  ''',
  repository_dataset_full_name, view_column_usage_impact,
  repository_dataset_full_name, table_column_usage,
  repository_dataset_full_name, table_impact,
  repository_dataset_full_name, table_column_usage
);

-- ============================================================================
-- 4b. Persistent dynamic-SQL renderer
--
-- lnge_render_dynamic_sql expands the __TARGET_PROJECT__ / __JOB_REGION__ / __UDF__
-- / __T_*__ identifier placeholders used by 03's dynamic SQL templates. It was
-- formerly a script-level TEMP FUNCTION inside 03, but BigQuery prepends every
-- script TEMP FUNCTION's DDL to the query text of every child job, so the
-- console's "All results" list showed only "create temp function
-- lnge_render_dynamic_sql(" for each statement. Deploying it as a persistent function
-- here removes that prepend, so each statement (and the per-step progress
-- markers) shows its own SQL. The function is created in the UDF dataset,
-- alongside lnge_analyze_json (bootstrap_udf_project_id /
-- bootstrap_udf_dataset). 03 invokes it dynamically using its udf_project_id /
-- udf_dataset DECLAREs, so keep this deployment location in step with those.
-- ============================================================================
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE FUNCTION `%s.%s.%s`(
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
  )
  ''',
  bootstrap_udf_project_id,
  bootstrap_udf_dataset,
  bootstrap_udf_render_function_name
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
  bootstrap_default_project_id AS project_id,
  bootstrap_project_token AS project_token,
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
  FORMAT(
    '%s.%s.%s',
    bootstrap_udf_project_id,
    bootstrap_udf_dataset,
    bootstrap_udf_render_function_name
  ) AS render_udf,
  bootstrap_udf_library_uri,
  bootstrap_target_project_id,
  bootstrap_target_datasets,
  bootstrap_parser_strict_mode,
  bootstrap_compact_export,
  smoke_test_status,
  CURRENT_TIMESTAMP() AS setup_finished_at;
