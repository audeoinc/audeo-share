-- ============================================================================
-- test_persistent_lineage_udf.sql
-- Persistent UDF contract smoke test
-- ============================================================================
-- This test does not read or update repository tables.
-- A successful run returns COMPLETED, two output columns, two lineage paths,
-- and no ERROR diagnostics.
-- ============================================================================
SET @@location = 'asia-northeast1';

BEGIN
  DECLARE udf_project_id STRING DEFAULT 'project_id';
  DECLARE udf_dataset STRING DEFAULT 'dataset';
  DECLARE udf_function_name STRING DEFAULT 'lnge_analyze_json';

  DECLARE udf_identifier STRING DEFAULT FORMAT(
    '%s.%s.%s',
    udf_project_id,
    udf_dataset,
    udf_function_name
  );
  DECLARE result_json STRING;
  DECLARE rendered_sql STRING;
  DECLARE analysis_status STRING;
  DECLARE output_lineage_count INT64;
  DECLARE lineage_path_count INT64;
  DECLARE error_diagnostic_count INT64;

  ASSERT REGEXP_CONTAINS(udf_project_id, r'^[A-Za-z0-9._:-]+$')
  AS 'Invalid udf_project_id.';
  ASSERT REGEXP_CONTAINS(udf_dataset, r'^[A-Za-z0-9_]+$')
  AS 'Invalid udf_dataset.';
  ASSERT REGEXP_CONTAINS(udf_function_name, r'^[A-Za-z0-9_]+$')
  AS 'Invalid udf_function_name.';

  SET rendered_sql = REPLACE(
    """
      SELECT `__UDF__`(
        @sql_text,
        @physical_columns_json,
        @options_json,
        @context_json
      )
    """,
    '__UDF__',
    udf_identifier
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in UDF smoke test SQL.';

  EXECUTE IMMEDIATE rendered_sql
  INTO result_json
  USING
    """
      SELECT
        sales.customer_id,
        SUM(sales.amount) AS total_amount
      FROM `project.dataset.sales` AS sales
      GROUP BY sales.customer_id
    """ AS sql_text,
    TO_JSON_STRING([
      STRUCT(
        'project.dataset.sales' AS table_name,
        'customer_id' AS column_name,
        'customer_id' AS field_path,
        1 AS ordinal_position,
        'INT64' AS data_type,
        'YES' AS is_nullable
      ),
      STRUCT(
        'project.dataset.sales' AS table_name,
        'amount' AS column_name,
        'amount' AS field_path,
        2 AS ordinal_position,
        'NUMERIC' AS data_type,
        'YES' AS is_nullable
      )
    ]) AS physical_columns_json,
    TO_JSON_STRING(STRUCT(
      FALSE AS strict_mode,
      TRUE AS compact_export
    )) AS options_json,
    TO_JSON_STRING(STRUCT(
      'persistent_udf_smoke_test' AS analysis_id,
      'project' AS view_project,
      'dataset' AS view_dataset,
      'smoke_test_view' AS view_name,
      FORMAT_TIMESTAMP(
        '%FT%H:%M:%E*S%Ez',
        CURRENT_TIMESTAMP()
      ) AS analyzed_at
    )) AS context_json;

  SET analysis_status = JSON_VALUE(
    result_json,
    '$.analysis.analysis_status'
  );
  SET output_lineage_count = ARRAY_LENGTH(COALESCE(
    JSON_QUERY_ARRAY(result_json, '$.exported_tables.output_lineages'),
    CAST([] AS ARRAY<STRING>)
  ));
  SET lineage_path_count = ARRAY_LENGTH(COALESCE(
    JSON_QUERY_ARRAY(result_json, '$.exported_tables.lineage_paths'),
    CAST([] AS ARRAY<STRING>)
  ));
  SET error_diagnostic_count = (
    SELECT COUNTIF(
      JSON_VALUE(diagnostic, '$.severity') = 'ERROR'
    )
    FROM UNNEST(COALESCE(
      JSON_QUERY_ARRAY(result_json, '$.exported_tables.diagnostics'),
      CAST([] AS ARRAY<STRING>)
    )) AS diagnostic
  );

  ASSERT analysis_status = 'COMPLETED'
  AS 'Persistent UDF did not return COMPLETED.';
  ASSERT output_lineage_count = 2
  AS 'Unexpected output lineage count.';
  ASSERT lineage_path_count = 2
  AS 'Unexpected lineage path count.';
  ASSERT error_diagnostic_count = 0
  AS 'Persistent UDF returned ERROR diagnostics.';

  SELECT
    udf_identifier AS tested_udf,
    analysis_status,
    output_lineage_count,
    lineage_path_count,
    error_diagnostic_count,
    SAFE.PARSE_JSON(result_json) AS result_json;
END;
