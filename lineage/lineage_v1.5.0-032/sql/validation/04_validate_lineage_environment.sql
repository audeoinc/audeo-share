-- ============================================================================
-- 04_validate_lineage_environment.sql
-- BigQuery Physical Lineage Repository - Integration validation
-- ============================================================================
SET @@location = 'asia-northeast1';

-- ============================================================================
-- Bootstrap values
--
-- Keep these values aligned with 01_setup_lineage_environment.sql and the
-- parameter block of 03_run_daily_lineage_pipeline.sql. There is no
-- lineage_config table; the checks below compare the live repository against
-- these expected values.
-- ============================================================================
DECLARE bootstrap_repository_project_id STRING DEFAULT 'project_id';
DECLARE bootstrap_repository_dataset STRING DEFAULT 'lineage_repository';
DECLARE bootstrap_repository_location STRING DEFAULT 'asia-northeast1';

DECLARE bootstrap_udf_project_id STRING DEFAULT 'project_id';
DECLARE bootstrap_udf_dataset STRING DEFAULT 'dataset';
DECLARE bootstrap_udf_function_name STRING DEFAULT 'analyze_lineage_json';
DECLARE bootstrap_udf_library_uri STRING DEFAULT
  'gs://YOUR_BUCKET/YOUR_PATH/lineage_udf_bundle.js';

DECLARE bootstrap_target_project_id STRING DEFAULT 'project_id';
DECLARE bootstrap_target_region STRING DEFAULT 'asia-northeast1';
DECLARE bootstrap_target_datasets ARRAY<STRING> DEFAULT ['dataset'];

DECLARE bootstrap_parser_strict_mode BOOL DEFAULT FALSE;
DECLARE bootstrap_compact_export BOOL DEFAULT TRUE;
DECLARE bootstrap_max_impact_rank INT64 DEFAULT 100;

DECLARE repository_dataset_full_name STRING DEFAULT FORMAT(
  '%s.%s',
  bootstrap_repository_project_id,
  bootstrap_repository_dataset
);

DECLARE validation_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
DECLARE sample_dataset STRING;
DECLARE sample_dataset_full_name STRING;
DECLARE udf_full_name STRING;
DECLARE smoke_test_result STRING;
DECLARE smoke_test_status STRING;

CREATE TEMP TABLE validation_result
(
  validation_order INT64,
  validation_group STRING,
  validation_name STRING,
  validation_status STRING,
  expected_value STRING,
  actual_value STRING,
  message STRING,
  validated_at TIMESTAMP
);

-- ============================================================================
-- 1. Derived names
--
-- The lineage_config table was removed; expected values come from the bootstrap
-- block above. Repository object / UDF / data checks below run against them.
-- ============================================================================
SET sample_dataset = bootstrap_target_datasets[SAFE_OFFSET(0)];

ASSERT sample_dataset IS NOT NULL
AS 'bootstrap_target_datasets must contain at least one dataset.';

SET sample_dataset_full_name = FORMAT(
  '%s.%s',
  bootstrap_target_project_id,
  sample_dataset
);

SET udf_full_name = FORMAT(
  '%s.%s.%s',
  bootstrap_udf_project_id,
  bootstrap_udf_dataset,
  bootstrap_udf_function_name
);

-- ============================================================================
-- 2. Configuration integrity
-- ============================================================================
INSERT INTO validation_result
SELECT
  20,
  'CONFIGURATION',
  'repository and target location match',
  IF(
    bootstrap_repository_location = bootstrap_target_region,
    'PASS',
    'FAIL'
  ),
  bootstrap_repository_location,
  bootstrap_target_region,
  'Repository and scanned metadata must be in the same region.',
  CURRENT_TIMESTAMP();

INSERT INTO validation_result
SELECT
  21,
  'CONFIGURATION',
  'GCS library URI configured',
  IF(
    STARTS_WITH(bootstrap_udf_library_uri, 'gs://')
    AND NOT STARTS_WITH(bootstrap_udf_library_uri, 'gs://YOUR_'),
    'PASS',
    'FAIL'
  ),
  'gs://<bucket>/<path>/lineage_udf_bundle.js',
  bootstrap_udf_library_uri,
  'The persistent UDF library must point to the uploaded bundle.',
  CURRENT_TIMESTAMP();

-- Execution service-account validation (result ids 22-24) was removed together
-- with the lineage_execution_account_config table. Service accounts now live in
-- the STEP 2 parameter block of 03_run_daily_lineage_pipeline.sql.

-- ============================================================================
-- 3. Repository object validation
-- ============================================================================
BEGIN
  DECLARE required_tables ARRAY<STRING> DEFAULT [
    'lineage_definition_registry',
    'lineage_direct_dependency',
    'lineage_impact',
    'lineage_diagnostic',
    'lineage_job_registry'
  ];

  FOR required_table IN (
    SELECT table_name
    FROM UNNEST(required_tables) AS table_name
  )
  DO
    BEGIN
      DECLARE actual_count INT64 DEFAULT 0;

      EXECUTE IMMEDIATE FORMAT(
        '''
        SELECT COUNT(*)
        FROM `%s.INFORMATION_SCHEMA.TABLES`
        WHERE table_name = @table_name
          AND table_type = 'BASE TABLE'
        ''',
        repository_dataset_full_name
      )
      INTO actual_count
      USING required_table.table_name AS table_name;

      INSERT INTO validation_result
      VALUES (
        100 + (
          SELECT offset_value
          FROM UNNEST(required_tables) AS name WITH OFFSET AS offset_value
          WHERE name = required_table.table_name
        ),
        'REPOSITORY_OBJECT',
        FORMAT('%s exists', required_table.table_name),
        IF(actual_count = 1, 'PASS', 'FAIL'),
        '1',
        CAST(actual_count AS STRING),
        FORMAT(
          'Repository table %s must exist.',
          required_table.table_name
        ),
        CURRENT_TIMESTAMP()
      );
    END;
  END FOR;
END;

-- ============================================================================
-- 4. Sample environment validation
-- ============================================================================
BEGIN
  DECLARE required_physical_tables ARRAY<STRING> DEFAULT [
    'customers',
    'products',
    'sales_orders',
    'sales_order_items',
    'daily_customer_sales'
  ];

  DECLARE required_views ARRAY<STRING> DEFAULT [
    'v_order_item_detail',
    'v_order_summary',
    'v_customer_primary_contact',
    'v_customer_primary_contact_on_true',
    'v_customer_profile',
    'v_customer_sales',
    'v_customer_sales_ranked'
  ];

  FOR required_table IN (
    SELECT table_name
    FROM UNNEST(required_physical_tables) AS table_name
  )
  DO
    BEGIN
      DECLARE actual_count INT64 DEFAULT 0;

      EXECUTE IMMEDIATE FORMAT(
        '''
        SELECT COUNT(*)
        FROM `%s.INFORMATION_SCHEMA.TABLES`
        WHERE table_name = @table_name
          AND table_type = 'BASE TABLE'
        ''',
        sample_dataset_full_name
      )
      INTO actual_count
      USING required_table.table_name AS table_name;

      INSERT INTO validation_result
      VALUES (
        200 + (
          SELECT offset_value
          FROM UNNEST(required_physical_tables) AS name
          WITH OFFSET AS offset_value
          WHERE name = required_table.table_name
        ),
        'SAMPLE_OBJECT',
        FORMAT('%s physical table exists', required_table.table_name),
        IF(actual_count = 1, 'PASS', 'FAIL'),
        '1',
        CAST(actual_count AS STRING),
        FORMAT(
          'Run 02_setup_sample_environment.sql to create %s.',
          required_table.table_name
        ),
        CURRENT_TIMESTAMP()
      );
    END;
  END FOR;

  FOR required_view IN (
    SELECT view_name
    FROM UNNEST(required_views) AS view_name
  )
  DO
    BEGIN
      DECLARE actual_count INT64 DEFAULT 0;

      EXECUTE IMMEDIATE FORMAT(
        '''
        SELECT COUNT(*)
        FROM `%s.INFORMATION_SCHEMA.VIEWS`
        WHERE table_name = @view_name
        ''',
        sample_dataset_full_name
      )
      INTO actual_count
      USING required_view.view_name AS view_name;

      INSERT INTO validation_result
      VALUES (
        220 + (
          SELECT offset_value
          FROM UNNEST(required_views) AS name
          WITH OFFSET AS offset_value
          WHERE name = required_view.view_name
        ),
        'SAMPLE_OBJECT',
        FORMAT('%s view exists', required_view.view_name),
        IF(actual_count = 1, 'PASS', 'FAIL'),
        '1',
        CAST(actual_count AS STRING),
        FORMAT(
          'Run 02_setup_sample_environment.sql to create %s.',
          required_view.view_name
        ),
        CURRENT_TIMESTAMP()
      );
    END;
  END FOR;
END;

-- ============================================================================
-- 5. Persistent UDF validation and smoke test
-- ============================================================================
BEGIN
  DECLARE actual_count INT64 DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT COUNT(*)
    FROM `%s.%s.INFORMATION_SCHEMA.ROUTINES`
    WHERE routine_name = @routine_name
      AND routine_type = 'FUNCTION'
    ''',
    bootstrap_udf_project_id,
    bootstrap_udf_dataset
  )
  INTO actual_count
  USING bootstrap_udf_function_name AS routine_name;

  INSERT INTO validation_result
  VALUES (
    300,
    'PERSISTENT_UDF',
    'persistent lineage UDF exists',
    IF(actual_count = 1, 'PASS', 'FAIL'),
    '1',
    CAST(actual_count AS STRING),
    FORMAT('Expected UDF: %s', udf_full_name),
    CURRENT_TIMESTAMP()
  );

  IF actual_count = 1 THEN
    BEGIN
      EXECUTE IMMEDIATE FORMAT(
        '''
        SELECT `%s`(
          'SELECT customer_id FROM `%s.customers`',
          TO_JSON_STRING([
            STRUCT(
              '%s.customers' AS table_name,
              'customer_id' AS column_name,
              'customer_id' AS field_path,
              1 AS ordinal_position,
              'STRING' AS data_type,
              'NO' AS is_nullable
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
            'validation_smoke_test' AS view_name,
            FORMAT_TIMESTAMP(
              '%%FT%%H:%%M:%%E*S%%Ez',
              CURRENT_TIMESTAMP()
            ) AS analyzed_at
          ))
        )
        ''',
        udf_full_name,
        sample_dataset_full_name,
        sample_dataset_full_name
      )
      INTO smoke_test_result
      USING
        bootstrap_parser_strict_mode AS strict_mode,
        bootstrap_compact_export AS compact_export,
        bootstrap_target_project_id AS target_project_id,
        sample_dataset AS target_dataset;

      SET smoke_test_status = COALESCE(
        JSON_VALUE(
          smoke_test_result,
          '$.analysis.analysis_status'
        ),
        'UNKNOWN'
      );

      INSERT INTO validation_result
      VALUES (
        301,
        'PERSISTENT_UDF',
        'persistent UDF smoke test',
        IF(
          smoke_test_status IN (
            'COMPLETED',
            'COMPLETED_WITH_WARNINGS'
          ),
          'PASS',
          'FAIL'
        ),
        'COMPLETED or COMPLETED_WITH_WARNINGS',
        smoke_test_status,
        'Validates GCS access, bundle loading, function name, and signature.',
        CURRENT_TIMESTAMP()
      );

    EXCEPTION WHEN ERROR THEN
      INSERT INTO validation_result
      VALUES (
        301,
        'PERSISTENT_UDF',
        'persistent UDF smoke test',
        'FAIL',
        'successful execution',
        @@error.message,
        @@error.formatted_stack_trace,
        CURRENT_TIMESTAMP()
      );
    END;
  END IF;
END;

-- ============================================================================
-- 6. Definition Registry validation
-- ============================================================================
BEGIN
  DECLARE active_view_count INT64 DEFAULT 0;
  DECLARE changed_count INT64 DEFAULT 0;
  DECLARE failed_count INT64 DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT
      COUNTIF(
        is_active = TRUE
        AND object_type = 'VIEW'
        AND object_dataset = @sample_dataset
      ),
      COUNTIF(
        is_active = TRUE
        AND is_changed = TRUE
      ),
      COUNTIF(
        is_active = TRUE
        AND analysis_status = 'FAILED'
      )
    FROM `%s.lineage_definition_registry`
    ''',
    repository_dataset_full_name
  )
  INTO
    active_view_count,
    changed_count,
    failed_count
  USING sample_dataset AS sample_dataset;

  INSERT INTO validation_result
  VALUES (
    400,
    'DEFINITION_REGISTRY',
    'sample views registered',
    IF(active_view_count >= 6, 'PASS', 'FAIL'),
    'at least 6',
    CAST(active_view_count AS STRING),
    'Run 03_run_daily_lineage_pipeline.sql after sample setup.',
    CURRENT_TIMESTAMP()
  );

  INSERT INTO validation_result
  VALUES (
    401,
    'DEFINITION_REGISTRY',
    'no remaining changed definitions',
    IF(changed_count = 0, 'PASS', 'WARN'),
    '0',
    CAST(changed_count AS STRING),
    IF(
      changed_count = 0,
      'All active changed definitions were analyzed.',
      'Run the daily pipeline again or inspect diagnostics.'
    ),
    CURRENT_TIMESTAMP()
  );

  INSERT INTO validation_result
  VALUES (
    402,
    'DEFINITION_REGISTRY',
    'no failed active definitions',
    IF(failed_count = 0, 'PASS', 'FAIL'),
    '0',
    CAST(failed_count AS STRING),
    'Inspect lineage_diagnostic for failed objects.',
    CURRENT_TIMESTAMP()
  );
END;

-- ============================================================================
-- 7. Direct dependency validation
-- ============================================================================
BEGIN
  DECLARE dependency_count INT64 DEFAULT 0;
  DECLARE sample_target_count INT64 DEFAULT 0;
  DECLARE null_edge_key_count INT64 DEFAULT 0;
  DECLARE duplicate_edge_count INT64 DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT
      COUNT(*),
      COUNTIF(target_dataset = @sample_dataset),
      COUNTIF(edge_key IS NULL OR edge_key = '')
    FROM `%s.lineage_direct_dependency`
    ''',
    repository_dataset_full_name
  )
  INTO
    dependency_count,
    sample_target_count,
    null_edge_key_count
  USING sample_dataset AS sample_dataset;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT COUNT(*)
    FROM (
      SELECT edge_key
      FROM `%s.lineage_direct_dependency`
      GROUP BY edge_key
      HAVING COUNT(*) > 1
    )
    ''',
    repository_dataset_full_name
  )
  INTO duplicate_edge_count;

  INSERT INTO validation_result
  VALUES (
    500,
    'DIRECT_DEPENDENCY',
    'direct dependencies produced',
    IF(dependency_count > 0, 'PASS', 'FAIL'),
    'greater than 0',
    CAST(dependency_count AS STRING),
    'Changed definitions must publish physical dependencies.',
    CURRENT_TIMESTAMP()
  );

  INSERT INTO validation_result
  VALUES (
    501,
    'DIRECT_DEPENDENCY',
    'sample target dependencies produced',
    IF(sample_target_count > 0, 'PASS', 'FAIL'),
    'greater than 0',
    CAST(sample_target_count AS STRING),
    'Sample views should appear as dependency targets.',
    CURRENT_TIMESTAMP()
  );

  INSERT INTO validation_result
  VALUES (
    502,
    'DIRECT_DEPENDENCY',
    'all dependencies have edge_key',
    IF(null_edge_key_count = 0, 'PASS', 'FAIL'),
    '0',
    CAST(null_edge_key_count AS STRING),
    'edge_key is required for stable dependency identification.',
    CURRENT_TIMESTAMP()
  );

  INSERT INTO validation_result
  VALUES (
    503,
    'DIRECT_DEPENDENCY',
    'edge_key is unique',
    IF(duplicate_edge_count = 0, 'PASS', 'FAIL'),
    '0 duplicate keys',
    CAST(duplicate_edge_count AS STRING),
    'Published direct dependencies should be de-duplicated.',
    CURRENT_TIMESTAMP()
  );
END;

-- ============================================================================
-- 8. Expected sample lineage validation
-- ============================================================================
BEGIN
  DECLARE expected_edge_count INT64 DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT(
    '''
    WITH expected_edges AS (
      SELECT
        'sales_orders' AS source_object,
        'customer_id' AS source_column,
        'v_order_item_detail' AS target_object,
        'customer_id' AS target_column
      UNION ALL
      SELECT
        'sales_order_items',
        'quantity',
        'v_order_item_detail',
        'quantity'
      UNION ALL
      SELECT
        'products',
        'product_name',
        'v_order_item_detail',
        'product_name'
      UNION ALL
      SELECT
        'customers',
        'contacts.contact_value',
        'v_customer_primary_contact',
        'contact_value'
      UNION ALL
      SELECT
        'customers',
        'address.prefecture',
        'v_customer_profile',
        'customer_prefecture'
    )
    SELECT COUNT(*)
    FROM expected_edges AS expected
    JOIN `%s.lineage_direct_dependency` AS actual
      ON actual.source_dataset = @sample_dataset
     AND actual.target_dataset = @sample_dataset
     AND actual.source_object = expected.source_object
     AND actual.source_column = expected.source_column
     AND actual.target_object = expected.target_object
     AND actual.target_column = expected.target_column
    ''',
    repository_dataset_full_name
  )
  INTO expected_edge_count
  USING sample_dataset AS sample_dataset;

  INSERT INTO validation_result
  VALUES (
    600,
    'EXPECTED_LINEAGE',
    'representative sample edges resolved',
    IF(expected_edge_count = 5, 'PASS', 'FAIL'),
    '5',
    CAST(expected_edge_count AS STRING),
    'Validates JOIN, physical columns, STRUCT, and UNNEST lineage.',
    CURRENT_TIMESTAMP()
  );
END;

-- ============================================================================
-- 9. Impact validation
-- ============================================================================
BEGIN
  DECLARE impact_count INT64 DEFAULT 0;
  DECLARE max_impact_rank INT64 DEFAULT 0;
  DECLARE cycle_count INT64 DEFAULT 0;
  DECLARE expected_multilevel_count INT64 DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT
      COUNT(*),
      COALESCE(MAX(impact_rank), 0),
      COUNTIF(is_cycle)
    FROM `%s.lineage_impact`
    ''',
    repository_dataset_full_name
  )
  INTO
    impact_count,
    max_impact_rank,
    cycle_count;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT COUNT(*)
    FROM `%s.lineage_impact`
    WHERE origin_dataset = @sample_dataset
      AND origin_object IN (
        'customers',
        'sales_orders',
        'sales_order_items',
        'products'
      )
      AND impacted_object = 'v_customer_sales_ranked'
      AND impact_rank >= 2
    ''',
    repository_dataset_full_name
  )
  INTO expected_multilevel_count
  USING sample_dataset AS sample_dataset;

  INSERT INTO validation_result
  VALUES (
    700,
    'IMPACT',
    'impact rows produced',
    IF(impact_count > 0, 'PASS', 'FAIL'),
    'greater than 0',
    CAST(impact_count AS STRING),
    'The daily pipeline must rebuild lineage_impact.',
    CURRENT_TIMESTAMP()
  );

  INSERT INTO validation_result
  VALUES (
    701,
    'IMPACT',
    'multi-level impact resolved',
    IF(
      max_impact_rank >= 2
      AND expected_multilevel_count > 0,
      'PASS',
      'FAIL'
    ),
    'rank >= 2',
    FORMAT(
      'max_rank=%d, expected_paths=%d',
      max_impact_rank,
      expected_multilevel_count
    ),
    'Validates propagation through multiple View levels.',
    CURRENT_TIMESTAMP()
  );

  INSERT INTO validation_result
  VALUES (
    702,
    'IMPACT',
    'no unexpected cycle',
    IF(cycle_count = 0, 'PASS', 'WARN'),
    '0',
    CAST(cycle_count AS STRING),
    'Cycle rows are retained for investigation when detected.',
    CURRENT_TIMESTAMP()
  );

  INSERT INTO validation_result
  VALUES (
    703,
    'IMPACT',
    'maximum rank within configuration',
    IF(
      max_impact_rank <= bootstrap_max_impact_rank,
      'PASS',
      'FAIL'
    ),
    FORMAT('<= %d', bootstrap_max_impact_rank),
    CAST(max_impact_rank AS STRING),
    'Recursive impact must respect max_impact_rank.',
    CURRENT_TIMESTAMP()
  );
END;

-- ============================================================================
-- 10. Diagnostic validation
-- ============================================================================
BEGIN
  DECLARE error_count INT64 DEFAULT 0;
  DECLARE warning_count INT64 DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT
      COUNTIF(severity = 'ERROR'),
      COUNTIF(severity = 'WARNING')
    FROM `%s.lineage_diagnostic`
    ''',
    repository_dataset_full_name
  )
  INTO
    error_count,
    warning_count;

  INSERT INTO validation_result
  VALUES (
    800,
    'DIAGNOSTIC',
    'no error diagnostics',
    IF(error_count = 0, 'PASS', 'FAIL'),
    '0',
    CAST(error_count AS STRING),
    'Review ERROR diagnostics before accepting integration results.',
    CURRENT_TIMESTAMP()
  );

  INSERT INTO validation_result
  VALUES (
    801,
    'DIAGNOSTIC',
    'warning diagnostic count',
    IF(warning_count = 0, 'PASS', 'WARN'),
    '0 preferred',
    CAST(warning_count AS STRING),
    'Warnings may be acceptable but should be reviewed.',
    CURRENT_TIMESTAMP()
  );
END;

-- ============================================================================
-- 11. Final validation results
-- ============================================================================
SELECT
  validation_order,
  validation_group,
  validation_name,
  validation_status,
  expected_value,
  actual_value,
  message,
  validated_at
FROM validation_result
ORDER BY validation_order;

SELECT
  validation_started_at,
  CURRENT_TIMESTAMP() AS validation_finished_at,
  COUNT(*) AS validation_count,
  COUNTIF(validation_status = 'PASS') AS pass_count,
  COUNTIF(validation_status = 'WARN') AS warning_count,
  COUNTIF(validation_status = 'FAIL') AS fail_count,
  CASE
    WHEN COUNTIF(validation_status = 'FAIL') > 0
      THEN 'FAILED'
    WHEN COUNTIF(validation_status = 'WARN') > 0
      THEN 'COMPLETED_WITH_WARNINGS'
    ELSE 'COMPLETED'
  END AS overall_status
FROM validation_result;
