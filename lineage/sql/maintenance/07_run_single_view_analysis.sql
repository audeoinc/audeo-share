-- ============================================================================
-- 07_run_single_view_analysis.sql
-- Read-only single-View lineage analysis and cost measurement
-- ============================================================================
-- Processing scope:
--   1. Read one View definition from INFORMATION_SCHEMA.VIEWS.
--   2. Build physical-column metadata in the same format as the daily pipeline.
--   3. Invoke the current persistent JavaScript UDF exactly once.
--   4. Return the analysis result and script-level cost/performance counters.
--
-- No persistent repository or target table is updated.
-- Change target_view_name before execution. Change the other environment
-- settings only when the deployed environment differs from the defaults.
--
-- The final result includes @@script.* values accumulated before the final
-- SELECT. For finalized job statistics, query INFORMATION_SCHEMA.JOBS after
-- completion using the returned script_job_id.
-- ============================================================================
SET @@location = 'asia-northeast1';

CREATE TEMP FUNCTION lnge_render_dynamic_sql(
  sql_template STRING,
  target_project_id STRING,
  target_dataset STRING,
  udf_project_id STRING,
  udf_dataset STRING,
  udf_function_name STRING
)
RETURNS STRING
AS (
  REPLACE(
    REPLACE(
      sql_template,
      '__TARGET__',
      target_project_id || '.' || target_dataset
    ),
    '__UDF__',
    udf_project_id || '.' || udf_dataset || '.' || udf_function_name
  )
);

BEGIN
  -- ==========================================================================
  -- Runtime environment settings
  -- ==========================================================================
  -- --------------------------------------------------------------------------
  -- [A] REQUIRED per deployment / region -- set these
  -- --------------------------------------------------------------------------
  -- Variables are grouped by purpose below; each group is labeled with a one-line
  -- header. Full descriptions follow the block under "Variable notes".
  -- GCP project: auto-detected at runtime; its DECLARE lives in [B] (pin it there
  -- only to run against a different project).
  -- Project-token substitution
  DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
  -- Region, target VIEW & datasets
  DECLARE job_region STRING DEFAULT 'asia-northeast1';
  DECLARE target_dataset STRING DEFAULT 'dataset';
  DECLARE target_view_name STRING DEFAULT 'v_customer_sales_cost_sample';
  DECLARE udf_dataset STRING DEFAULT 'dataset';
  -- UDF naming (prefix / suffix)
  DECLARE udf_name_prefix STRING DEFAULT '';
  DECLARE udf_name_suffix STRING DEFAULT '';
  --
  -- Variable notes (keyed by name):
  --   project_token_pattern
  --     Project-token substitution regex (keep in step with 01). A token extracted
  --     from the auto-detected project id replaces every '{project_token}'
  --     placeholder in the dataset names and udf prefix/suffix. Default: first
  --     hyphen segment.
  --   job_region / target_dataset / target_view_name / udf_dataset
  --     Region (must equal @@location) and the single VIEW to analyze.
  --   udf_name_prefix / udf_name_suffix
  --     Analysis UDF name: assembled in [C] as udf_prefix + 'lnge_' + base +
  --     udf_suffix (must match 01). Routine names allow only letters/digits/'_'
  --     (no '-').

  -- --------------------------------------------------------------------------
  -- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
  -- --------------------------------------------------------------------------
  -- GCP project. Declared here (not in [A]) because it is normally not set by hand:
  -- it is auto-detected in [C] from INFORMATION_SCHEMA.SCHEMATA (the project the job
  -- runs in). To pin it, set a literal in [C]. Target and UDFs share one project;
  -- the role-specific *_project_id variables live in [C] and take this.
  DECLARE default_project_id STRING;
  -- Analysis UDF function name: assembled in [C] from the udf prefix/suffix in [A]
  -- (must match 01). Routine names allow only letters/digits/'_' (no '-').
  DECLARE udf_function_name STRING;
  DECLARE parser_strict_mode BOOL DEFAULT FALSE;
  DECLARE compact_export BOOL DEFAULT TRUE;

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]; DO NOT edit
  -- --------------------------------------------------------------------------
  -- Role-specific projects take default_project_id (auto-detected below); pin a
  -- line to a literal only if that role's objects live in a separate project.
  DECLARE target_project_id STRING DEFAULT NULL;
  DECLARE udf_project_id STRING DEFAULT NULL;
  DECLARE sql_template STRING;
  DECLARE rendered_sql STRING;
  DECLARE view_definition STRING;
  DECLARE source_discovery_json STRING;
  DECLARE source_discovery_status STRING;
  DECLARE physical_columns_json STRING;
  DECLARE physical_metadata_json_bytes INT64;
  DECLARE result_json STRING;
  DECLARE analysis_id STRING DEFAULT GENERATE_UUID();
  DECLARE analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
  DECLARE analysis_status STRING;
  -- Token extracted from the project id (see project_token_pattern).
  DECLARE project_token STRING;

  -- Auto-detect the running GCP project from INFORMATION_SCHEMA.SCHEMATA
  -- (catalog_name). Region-qualified identifier built from @@location; to pin the
  -- project, replace this SET with a literal. Roles take it unless pinned.
  EXECUTE IMMEDIATE FORMAT(
    "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
    @@location
  ) INTO default_project_id;
  ASSERT default_project_id IS NOT NULL AS
    'Could not auto-detect the project id from INFORMATION_SCHEMA.SCHEMATA; set default_project_id to a literal.';
  SET target_project_id = COALESCE(target_project_id, default_project_id);
  SET udf_project_id = COALESCE(udf_project_id, default_project_id);
  -- Project-token substitution in the name inputs (before names are used).
  SET project_token =
    COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
  SET target_dataset = REPLACE(target_dataset, '{project_token}', project_token);
  SET udf_dataset = REPLACE(udf_dataset, '{project_token}', project_token);
  SET udf_name_prefix = REPLACE(udf_name_prefix, '{project_token}', project_token);
  SET udf_name_suffix = REPLACE(udf_name_suffix, '{project_token}', project_token);

  -- Guard: an unsubstituted '{project_token}' (or any invalid character) in a dataset
  -- name is surfaced here instead of failing later at DDL time.
  ASSERT REGEXP_CONTAINS(target_dataset, r'^[A-Za-z0-9_]+$')
    AS 'target_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
  ASSERT REGEXP_CONTAINS(udf_dataset, r'^[A-Za-z0-9_]+$')
    AS 'udf_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';

  SET udf_function_name =
    udf_name_prefix || 'lnge_' || 'analyze_json' || udf_name_suffix;

  ASSERT @@location = job_region
  AS '@@location and job_region must be identical.';
  ASSERT REGEXP_CONTAINS(target_project_id, r'^[A-Za-z0-9._:-]+$')
  AS 'Invalid target_project_id.';
  ASSERT REGEXP_CONTAINS(target_dataset, r'^[A-Za-z0-9_]+$')
  AS 'Invalid target_dataset.';
  ASSERT REGEXP_CONTAINS(target_view_name, r'^[A-Za-z0-9_]+$')
  AS 'Invalid target_view_name.';
  ASSERT REGEXP_CONTAINS(job_region, r'^[A-Za-z0-9-]+$')
  AS 'Invalid job_region.';
  ASSERT REGEXP_CONTAINS(udf_project_id, r'^[A-Za-z0-9._:-]+$')
  AS 'Invalid udf_project_id.';
  ASSERT REGEXP_CONTAINS(udf_dataset, r'^[A-Za-z0-9_]+$')
  AS 'Invalid udf_dataset.';
  ASSERT REGEXP_CONTAINS(udf_function_name, r'^[A-Za-z0-9_]+$')
  AS 'Invalid udf_function_name.';

  -- --------------------------------------------------------------------------
  -- Read the requested View definition.
  -- --------------------------------------------------------------------------
  SET sql_template = """
    SELECT view_definition
    FROM `__TARGET__.INFORMATION_SCHEMA.VIEWS`
    WHERE LOWER(table_name) = LOWER(@target_view_name)
  """;

  SET rendered_sql = lnge_render_dynamic_sql(
    sql_template,
    target_project_id,
    target_dataset,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in View definition SQL.';

  EXECUTE IMMEDIATE rendered_sql
  INTO view_definition
  USING target_view_name AS target_view_name;

  IF view_definition IS NULL OR TRIM(view_definition) = '' THEN
    RAISE USING MESSAGE = FORMAT(
      'View was not found or has an empty definition: %s.%s.%s',
      target_project_id,
      target_dataset,
      target_view_name
    );
  END IF;

  -- --------------------------------------------------------------------------
  -- Materialize current target metadata. The JSON structure intentionally
  -- matches 03_run_daily_lineage_pipeline.sql and
  -- 06_analyze_changed_objects.sql.
  -- --------------------------------------------------------------------------
  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE current_target_columns AS
    SELECT *
    FROM `__TARGET__.INFORMATION_SCHEMA.COLUMNS`
  """;

  SET rendered_sql = lnge_render_dynamic_sql(
    sql_template,
    target_project_id,
    target_dataset,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in target columns SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE current_target_column_field_paths AS
    SELECT *
    FROM `__TARGET__.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS`
  """;

  SET rendered_sql = lnge_render_dynamic_sql(
    sql_template,
    target_project_id,
    target_dataset,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in target field paths SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  -- --------------------------------------------------------------------------
  -- Phase 1: identify this View's physical Sources without passing Metadata.
  -- --------------------------------------------------------------------------
  SET sql_template = """
    SELECT `__UDF__`(
      @view_definition,
      '[]',
      @options_json,
      NULL
    )
  """;

  SET rendered_sql = lnge_render_dynamic_sql(
    sql_template,
    target_project_id,
    target_dataset,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in source discovery UDF SQL.';

  EXECUTE IMMEDIATE rendered_sql
  INTO source_discovery_json
  USING
    view_definition AS view_definition,
    TO_JSON_STRING(STRUCT(TRUE AS source_discovery_only)) AS options_json;

  SET source_discovery_status = COALESCE(
    JSON_VALUE(source_discovery_json, '$.analysis.analysis_status'),
    'UNKNOWN'
  );

  ASSERT source_discovery_status = 'COMPLETED'
  AS COALESCE(
    JSON_VALUE(source_discovery_json, '$.error.message'),
    'Source discovery did not complete.'
  );

  -- --------------------------------------------------------------------------
  -- Phase 2: materialize only Metadata for Sources found above. Matching all
  -- three lookup forms preserves PhysicalColumnResolver's name semantics.
  -- --------------------------------------------------------------------------
  CREATE OR REPLACE TEMP TABLE discovered_metadata_tables AS
  WITH discovered_sources AS (
    SELECT DISTINCT LOWER(JSON_VALUE(source_row, '$')) AS source_name
    FROM UNNEST(
      COALESCE(
        JSON_QUERY_ARRAY(source_discovery_json, '$.source_tables'),
        CAST([] AS ARRAY<STRING>)
      )
    ) AS source_row
    WHERE JSON_VALUE(source_row, '$') IS NOT NULL
  )
  SELECT DISTINCT
    metadata.table_catalog,
    metadata.table_schema,
    metadata.table_name
  FROM current_target_columns AS metadata
  INNER JOIN discovered_sources AS source
    ON source.source_name = LOWER(FORMAT(
      '%s.%s.%s', metadata.table_catalog, metadata.table_schema, metadata.table_name
    ))
    OR source.source_name = LOWER(FORMAT(
      '%s.%s', metadata.table_schema, metadata.table_name
    ))
    OR source.source_name = LOWER(metadata.table_name);

  CREATE OR REPLACE TEMP TABLE scoped_physical_columns AS
  WITH top_level_columns AS (
    SELECT
      column_info.table_catalog AS table_project,
      column_info.table_schema AS table_dataset,
      column_info.table_name,
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
      field.table_catalog AS table_project,
      field.table_schema AS table_dataset,
      field.table_name,
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
  )
  SELECT * FROM top_level_columns
  UNION ALL
  SELECT * FROM nested_field_paths;

  SET physical_metadata_json_bytes = (
    SELECT COALESCE(SUM(BYTE_LENGTH(TO_JSON_STRING(STRUCT(
      LOWER(FORMAT('%s.%s.%s', table_project, table_dataset, table_name)) AS table_name,
      LOWER(column_name) AS column_name,
      LOWER(field_path) AS field_path,
      ordinal_position AS ordinal_position,
      data_type AS data_type,
      is_nullable AS is_nullable
    ))) + 1), 2)
    FROM scoped_physical_columns
  );

  ASSERT physical_metadata_json_bytes < 900000
  AS FORMAT(
    'Scoped physical-column metadata is too large for one UDF call (%d bytes).',
    physical_metadata_json_bytes
  );

  SET physical_columns_json = (
    SELECT COALESCE(
      TO_JSON_STRING(ARRAY_AGG(
        STRUCT(
          LOWER(FORMAT('%s.%s.%s', table_project, table_dataset, table_name)) AS table_name,
          LOWER(column_name) AS column_name,
          LOWER(field_path) AS field_path,
          ordinal_position AS ordinal_position,
          data_type AS data_type,
          is_nullable AS is_nullable
        )
        ORDER BY table_project, table_dataset, table_name, ordinal_position, field_path
      )),
      '[]'
    )
    FROM scoped_physical_columns
  );

  -- --------------------------------------------------------------------------
  -- Phase 3: invoke the full persistent UDF with scoped metadata.
  -- --------------------------------------------------------------------------
  SET sql_template = """
    SELECT `__UDF__`(
      @view_definition,
      @physical_columns_json,
      @options_json,
      @context_json
    )
  """;

  SET rendered_sql = lnge_render_dynamic_sql(
    sql_template,
    target_project_id,
    target_dataset,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in lineage UDF SQL.';

  EXECUTE IMMEDIATE rendered_sql
  INTO result_json
  USING
    view_definition AS view_definition,
    physical_columns_json AS physical_columns_json,
    TO_JSON_STRING(STRUCT(
      parser_strict_mode AS strict_mode,
      compact_export AS compact_export
    )) AS options_json,
    TO_JSON_STRING(STRUCT(
      analysis_id AS analysis_id,
      target_project_id AS view_project,
      target_dataset AS view_dataset,
      target_view_name AS view_name,
      FORMAT_TIMESTAMP(
        '%FT%H:%M:%E*S%Ez',
        analyzed_at
      ) AS analyzed_at
    )) AS context_json;

  SET analysis_status = COALESCE(
    JSON_VALUE(result_json, '$.analysis.analysis_status'),
    'UNKNOWN'
  );

  ASSERT SAFE.PARSE_JSON(result_json) IS NOT NULL
  AS 'Persistent UDF returned invalid JSON.';

  -- --------------------------------------------------------------------------
  -- Result and cost/performance counters.
  -- @@script.* counters are accumulated values before this final SELECT.
  -- --------------------------------------------------------------------------
  SELECT
    @@script.job_id AS script_job_id,
    analysis_id,
    FORMAT(
      '%s.%s.%s',
      target_project_id,
      target_dataset,
      target_view_name
    ) AS analyzed_view,
    FORMAT(
      '%s.%s.%s',
      udf_project_id,
      udf_dataset,
      udf_function_name
    ) AS invoked_udf,
    analysis_status,
    BYTE_LENGTH(view_definition) AS view_definition_bytes,
    ARRAY_LENGTH(COALESCE(
      JSON_QUERY_ARRAY(source_discovery_json, '$.source_tables'),
      CAST([] AS ARRAY<STRING>)
    )) AS discovered_source_table_count,
    physical_metadata_json_bytes,
    ARRAY_LENGTH(COALESCE(
      JSON_QUERY_ARRAY(physical_columns_json, '$'),
      CAST([] AS ARRAY<STRING>)
    )) AS physical_column_metadata_count,
    ARRAY_LENGTH(COALESCE(
      JSON_QUERY_ARRAY(
        result_json,
        '$.exported_tables.output_lineages'
      ),
      CAST([] AS ARRAY<STRING>)
    )) AS output_lineage_count,
    ARRAY_LENGTH(COALESCE(
      JSON_QUERY_ARRAY(
        result_json,
        '$.exported_tables.lineage_paths'
      ),
      CAST([] AS ARRAY<STRING>)
    )) AS lineage_path_count,
    ARRAY_LENGTH(COALESCE(
      JSON_QUERY_ARRAY(
        result_json,
        '$.exported_tables.diagnostics'
      ),
      CAST([] AS ARRAY<STRING>)
    )) AS diagnostic_count,
    @@script.bytes_processed AS script_bytes_processed_so_far,
    @@script.bytes_billed AS script_bytes_billed_so_far,
    @@script.slot_ms AS script_slot_ms_so_far,
    @@script.num_child_jobs AS completed_child_job_count,
    SAFE.PARSE_JSON(result_json) AS result_json;
END;
