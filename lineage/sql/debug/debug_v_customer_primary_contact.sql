-- ============================================================================
-- debug_v_customer_primary_contact.sql
-- Purpose:
--   Execute the lineage UDF only for v_customer_primary_contact and display
--   the UDF analysis status and diagnostic details.
--
-- This script does not update repository tables.
-- It is safe to run as a read-only diagnostic, except for temporary tables.
-- ============================================================================

SET @@location = 'asia-northeast1';

BEGIN
  -- --------------------------------------------------------------------------
  -- Environment settings
  -- --------------------------------------------------------------------------
  DECLARE repository_project_id STRING DEFAULT 'project_id';
  DECLARE repository_dataset STRING DEFAULT 'lineage_repository';
  DECLARE target_project_id STRING DEFAULT 'project_id';
  DECLARE target_dataset STRING DEFAULT 'dataset';

  DECLARE udf_project_id STRING DEFAULT 'project_id';
  DECLARE udf_dataset STRING DEFAULT 'dataset';
  DECLARE udf_function_name STRING DEFAULT 'analyze_lineage_json';

  DECLARE parser_strict_mode BOOL DEFAULT FALSE;
  DECLARE target_object_name STRING DEFAULT 'v_customer_primary_contact';

  DECLARE definition_text STRING;
  DECLARE definition_hash STRING;
  DECLARE object_project STRING;
  DECLARE object_dataset STRING;
  DECLARE object_type STRING;
  DECLARE generation_type STRING;

  DECLARE physical_columns_json STRING;
  DECLARE exported_json STRING;
  DECLARE udf_analysis_status STRING;
  DECLARE analysis_id STRING DEFAULT GENERATE_UUID();
  DECLARE analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();

  DECLARE sql_text STRING;

  -- --------------------------------------------------------------------------
  -- Load physical-column metadata from the target dataset
  -- --------------------------------------------------------------------------
  SET sql_text = FORMAT(
    '''
    CREATE OR REPLACE TEMP TABLE current_target_columns AS
    SELECT *
    FROM `%s.%s.INFORMATION_SCHEMA.COLUMNS`
    ''',
    target_project_id,
    target_dataset
  );

  EXECUTE IMMEDIATE sql_text;

  SET sql_text = FORMAT(
    '''
    CREATE OR REPLACE TEMP TABLE current_target_column_field_paths AS
    SELECT *
    FROM `%s.%s.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS`
    ''',
    target_project_id,
    target_dataset
  );

  EXECUTE IMMEDIATE sql_text;

  SET physical_columns_json = (
    WITH top_level_columns AS (
      SELECT
        table_catalog AS table_project,
        table_schema AS table_dataset,
        table_name,
        column_name,
        column_name AS field_path,
        ordinal_position,
        data_type,
        is_nullable
      FROM current_target_columns
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
      LEFT JOIN current_target_columns AS column_info
        ON column_info.table_catalog = field.table_catalog
       AND column_info.table_schema = field.table_schema
       AND column_info.table_name = field.table_name
       AND column_info.column_name = field.column_name
      WHERE field.field_path IS NOT NULL
        AND field.field_path != field.column_name
        AND STRPOS(field.field_path, '.') > 0
    ),
    physical_columns_source AS (
      SELECT * FROM top_level_columns
      UNION ALL
      SELECT * FROM nested_field_paths
    )
    SELECT COALESCE(
      TO_JSON_STRING(
        ARRAY_AGG(
          STRUCT(
            LOWER(FORMAT(
              '%s.%s.%s',
              table_project,
              table_dataset,
              table_name
            )) AS table_name,
            LOWER(column_name) AS column_name,
            LOWER(field_path) AS field_path,
            ordinal_position AS ordinal_position,
            data_type AS data_type,
            is_nullable AS is_nullable
          )
          ORDER BY
            table_project,
            table_dataset,
            table_name,
            ordinal_position,
            field_path
        )
      ),
      '[]'
    )
    FROM physical_columns_source
  );

  -- --------------------------------------------------------------------------
  -- Load the target View definition from the repository
  -- --------------------------------------------------------------------------
  SET sql_text = FORMAT(
    '''
    SELECT AS STRUCT
      object_project,
      object_dataset,
      object_type,
      generation_type,
      definition_text,
      definition_hash
    FROM `%s.%s.lineage_definition_registry`
    WHERE is_active = TRUE
      AND LOWER(object_name) = LOWER(@target_object_name)
      AND LOWER(object_project) = LOWER(@target_project_id)
      AND LOWER(object_dataset) = LOWER(@target_dataset)
      AND object_type = 'VIEW'
    QUALIFY ROW_NUMBER() OVER (
      ORDER BY updated_at DESC
    ) = 1
    ''',
    repository_project_id,
    repository_dataset
  );

  EXECUTE IMMEDIATE sql_text
  INTO
    object_project,
    object_dataset,
    object_type,
    generation_type,
    definition_text,
    definition_hash
  USING
    target_object_name AS target_object_name,
    target_project_id AS target_project_id,
    target_dataset AS target_dataset;

  ASSERT definition_text IS NOT NULL
  AS 'v_customer_primary_contact was not found in lineage_definition_registry.';

  -- --------------------------------------------------------------------------
  -- Execute the persistent JavaScript lineage UDF
  -- --------------------------------------------------------------------------
  SET sql_text = FORMAT(
    '''
    SELECT `%s.%s.%s`(
      @definition_text,
      @physical_columns_json,
      @options_json,
      @context_json
    )
    ''',
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  EXECUTE IMMEDIATE sql_text
  INTO exported_json
  USING
    definition_text AS definition_text,
    physical_columns_json AS physical_columns_json,
    TO_JSON_STRING(STRUCT(
      parser_strict_mode AS strict_mode,
      TRUE AS compact_export
    )) AS options_json,
    TO_JSON_STRING(STRUCT(
      analysis_id AS analysis_id,
      object_project AS view_project,
      object_dataset AS view_dataset,
      target_object_name AS view_name,
      FORMAT_TIMESTAMP(
        '%FT%H:%M:%E*S%Ez',
        analyzed_at
      ) AS analyzed_at
    )) AS context_json;

  SET udf_analysis_status = COALESCE(
    JSON_VALUE(exported_json, '$.analysis.analysis_status'),
    'UNKNOWN'
  );

  -- --------------------------------------------------------------------------
  -- Result set 1: analysis summary
  -- --------------------------------------------------------------------------
  SELECT
    target_object_name AS object_name,
    definition_hash,
    udf_analysis_status,
    JSON_VALUE(exported_json, '$.analysis.message') AS analysis_message,
    ARRAY_LENGTH(
      COALESCE(
        JSON_QUERY_ARRAY(
          exported_json,
          '$.exported_tables.diagnostics'
        ),
        CAST([] AS ARRAY<STRING>)
      )
    ) AS diagnostic_count,
    ARRAY_LENGTH(
      COALESCE(
        JSON_QUERY_ARRAY(
          exported_json,
          '$.exported_tables.output_lineages'
        ),
        CAST([] AS ARRAY<STRING>)
      )
    ) AS output_lineage_count,
    ARRAY_LENGTH(
      COALESCE(
        JSON_QUERY_ARRAY(
          exported_json,
          '$.exported_tables.lineage_paths'
        ),
        CAST([] AS ARRAY<STRING>)
      )
    ) AS lineage_path_count;

  -- --------------------------------------------------------------------------
  -- Result set 2: diagnostic details
  -- --------------------------------------------------------------------------
  SELECT
    OFFSET + 1 AS diagnostic_order,
    JSON_VALUE(diagnostic_row, '$.severity') AS severity,
    JSON_VALUE(diagnostic_row, '$.code') AS diagnostic_code,
    JSON_VALUE(diagnostic_row, '$.stage') AS engine_stage,
    JSON_VALUE(diagnostic_row, '$.message') AS message,
    JSON_VALUE(diagnostic_row, '$.diagnostic_json') AS diagnostic_json,
    diagnostic_row AS raw_diagnostic_row
  FROM UNNEST(
    COALESCE(
      JSON_QUERY_ARRAY(
        exported_json,
        '$.exported_tables.diagnostics'
      ),
      CAST([] AS ARRAY<STRING>)
    )
  ) AS diagnostic_row
  WITH OFFSET
  ORDER BY diagnostic_order;

  -- --------------------------------------------------------------------------
  -- Result set 3: output-column lineage status
  -- --------------------------------------------------------------------------
  SELECT
    OFFSET + 1 AS output_order,
    JSON_VALUE(output_row, '$.output_column_name') AS output_column_name,
    JSON_VALUE(output_row, '$.expression_text') AS expression_text,
    JSON_VALUE(output_row, '$.lineage_status') AS lineage_status,
    output_row AS raw_output_lineage_row
  FROM UNNEST(
    COALESCE(
      JSON_QUERY_ARRAY(
        exported_json,
        '$.exported_tables.output_lineages'
      ),
      CAST([] AS ARRAY<STRING>)
    )
  ) AS output_row
  WITH OFFSET
  ORDER BY output_order;

  -- --------------------------------------------------------------------------
  -- Result set 4: full UDF result
  -- Use this only when the summarized result sets are insufficient.
  -- --------------------------------------------------------------------------
  SELECT
    exported_json AS full_udf_result;
END;
