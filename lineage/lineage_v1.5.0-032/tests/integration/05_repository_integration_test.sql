-- ============================================================================
-- 05_repository_integration_test.sql
-- BigQuery Physical Lineage Repository - Repository integration assertions
-- ============================================================================
SET @@location = 'asia-northeast1';

DECLARE repository_project_id STRING DEFAULT 'project_id';
DECLARE repository_dataset STRING DEFAULT 'lineage_repository';
DECLARE target_project_id STRING DEFAULT 'project_id';
DECLARE target_dataset STRING DEFAULT 'dataset';
DECLARE scheduled_query_user_email STRING DEFAULT
  'project_id@appspot.gserviceaccount.com';
-- Expected impact-rank cap (mirrors 03's configured_max_impact_rank; there is no
-- lineage_config table to read it from).
DECLARE bootstrap_max_impact_rank INT64 DEFAULT 100;

DECLARE repository_full_name STRING DEFAULT FORMAT(
  '%s.%s',
  repository_project_id,
  repository_dataset
);

DECLARE target_full_name STRING DEFAULT FORMAT(
  '%s.%s',
  target_project_id,
  target_dataset
);

DECLARE test_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();

CREATE TEMP TABLE integration_test_result
(
  test_order INT64,
  test_group STRING,
  test_name STRING,
  test_status STRING,
  expected_value STRING,
  actual_value STRING,
  message STRING,
  tested_at TIMESTAMP
);

-- ============================================================================
-- 1. Sample data correctness
-- ============================================================================
BEGIN
  DECLARE customer_count INT64 DEFAULT 0;
  DECLARE order_count INT64 DEFAULT 0;
  DECLARE order_item_count INT64 DEFAULT 0;
  DECLARE customer_sales_count INT64 DEFAULT 0;
  DECLARE c001_sales_amount NUMERIC DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT COUNT(*)
    FROM `%s.customers`
    ''',
    target_full_name
  )
  INTO customer_count;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT COUNT(*)
    FROM `%s.sales_orders`
    ''',
    target_full_name
  )
  INTO order_count;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT COUNT(*)
    FROM `%s.sales_order_items`
    ''',
    target_full_name
  )
  INTO order_item_count;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT
      COUNT(*),
      MAX(IF(customer_id = 'C001', sales_amount, NULL))
    FROM `%s.v_customer_sales`
    ''',
    target_full_name
  )
  INTO
    customer_sales_count,
    c001_sales_amount;

  INSERT INTO integration_test_result
  VALUES
    (
      100,
      'SAMPLE_DATA',
      'customer fixture count',
      IF(customer_count = 3, 'PASS', 'FAIL'),
      '3',
      CAST(customer_count AS STRING),
      'The sample customer fixture must be reproducible.',
      CURRENT_TIMESTAMP()
    ),
    (
      101,
      'SAMPLE_DATA',
      'order fixture count',
      IF(order_count = 3, 'PASS', 'FAIL'),
      '3',
      CAST(order_count AS STRING),
      'The sample sales-order fixture must be reproducible.',
      CURRENT_TIMESTAMP()
    ),
    (
      102,
      'SAMPLE_DATA',
      'order-item fixture count',
      IF(order_item_count = 4, 'PASS', 'FAIL'),
      '4',
      CAST(order_item_count AS STRING),
      'The sample sales-order-item fixture must be reproducible.',
      CURRENT_TIMESTAMP()
    ),
    (
      103,
      'SAMPLE_DATA',
      'customer-sales output count',
      IF(customer_sales_count = 3, 'PASS', 'FAIL'),
      '3',
      CAST(customer_sales_count AS STRING),
      'All sample customers must remain in the left-joined output.',
      CURRENT_TIMESTAMP()
    ),
    (
      104,
      'SAMPLE_DATA',
      'C001 sales amount',
      IF(c001_sales_amount = NUMERIC '129250', 'PASS', 'FAIL'),
      '129250',
      CAST(c001_sales_amount AS STRING),
      'Validates the sample JOIN, arithmetic, grouping, and View chain.',
      CURRENT_TIMESTAMP()
    );
END;

-- ============================================================================
-- 2. Registry consistency
-- ============================================================================
BEGIN
  DECLARE missing_registry_count INT64 DEFAULT 0;
  DECLARE hash_mismatch_count INT64 DEFAULT 0;
  DECLARE remaining_changed_count INT64 DEFAULT 0;
  DECLARE failed_registry_count INT64 DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT COUNT(*)
    FROM `%s.INFORMATION_SCHEMA.VIEWS` AS view_info
    LEFT JOIN `%s.lineage_definition_registry` AS registry
      ON registry.object_project = LOWER(view_info.table_catalog)
     AND registry.object_dataset = LOWER(view_info.table_schema)
     AND registry.object_name = LOWER(view_info.table_name)
     AND registry.object_type = 'VIEW'
     AND registry.is_active = TRUE
    WHERE registry.object_name IS NULL
    ''',
    target_full_name,
    repository_full_name
  )
  INTO missing_registry_count;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT COUNT(*)
    FROM `%s.INFORMATION_SCHEMA.VIEWS` AS view_info
    JOIN `%s.lineage_definition_registry` AS registry
      ON registry.object_project = LOWER(view_info.table_catalog)
     AND registry.object_dataset = LOWER(view_info.table_schema)
     AND registry.object_name = LOWER(view_info.table_name)
     AND registry.object_type = 'VIEW'
     AND registry.is_active = TRUE
    WHERE registry.definition_hash
      != TO_HEX(SHA256(view_info.view_definition))
    ''',
    target_full_name,
    repository_full_name
  )
  INTO hash_mismatch_count;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT
      COUNTIF(is_active AND is_changed),
      COUNTIF(is_active AND analysis_status = 'FAILED')
    FROM `%s.lineage_definition_registry`
    ''',
    repository_full_name
  )
  INTO
    remaining_changed_count,
    failed_registry_count;

  INSERT INTO integration_test_result
  VALUES
    (
      200,
      'REGISTRY',
      'all active Views registered',
      IF(missing_registry_count = 0, 'PASS', 'FAIL'),
      '0 missing',
      CAST(missing_registry_count AS STRING),
      'Every current View must have one active Registry definition.',
      CURRENT_TIMESTAMP()
    ),
    (
      201,
      'REGISTRY',
      'View hashes match current definitions',
      IF(hash_mismatch_count = 0, 'PASS', 'FAIL'),
      '0 mismatches',
      CAST(hash_mismatch_count AS STRING),
      'Registry hashes must represent the current View SQL.',
      CURRENT_TIMESTAMP()
    ),
    (
      202,
      'REGISTRY',
      'no remaining changed definitions',
      IF(remaining_changed_count = 0, 'PASS', 'FAIL'),
      '0',
      CAST(remaining_changed_count AS STRING),
      'The daily pipeline must finish all changed definitions.',
      CURRENT_TIMESTAMP()
    ),
    (
      203,
      'REGISTRY',
      'no active failed definitions',
      IF(failed_registry_count = 0, 'PASS', 'FAIL'),
      '0',
      CAST(failed_registry_count AS STRING),
      'A failed active definition blocks repository acceptance.',
      CURRENT_TIMESTAMP()
    );
END;

-- ============================================================================
-- 3. Direct dependency integrity
-- ============================================================================
BEGIN
  DECLARE dependency_count INT64 DEFAULT 0;
  DECLARE duplicate_edge_key_count INT64 DEFAULT 0;
  DECLARE orphan_target_count INT64 DEFAULT 0;
  DECLARE uppercase_identifier_count INT64 DEFAULT 0;
  DECLARE expected_nested_edge_count INT64 DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT
      COUNT(*),
      COUNTIF(
        source_project != LOWER(source_project)
        OR source_dataset != LOWER(source_dataset)
        OR source_object != LOWER(source_object)
        OR source_column != LOWER(source_column)
        OR target_project != LOWER(target_project)
        OR target_dataset != LOWER(target_dataset)
        OR target_object != LOWER(target_object)
        OR target_column != LOWER(target_column)
      )
    FROM `%s.lineage_direct_dependency`
    ''',
    repository_full_name
  )
  INTO
    dependency_count,
    uppercase_identifier_count;

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
    repository_full_name
  )
  INTO duplicate_edge_key_count;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT COUNT(*)
    FROM `%s.lineage_direct_dependency` AS dependency
    LEFT JOIN `%s.lineage_definition_registry` AS registry
      ON registry.object_project = dependency.target_project
     AND registry.object_dataset = dependency.target_dataset
     AND registry.object_name = dependency.target_object
     AND registry.object_type = dependency.target_object_type
     AND registry.generation_type = dependency.generation_type
     AND registry.is_active = TRUE
    WHERE registry.object_name IS NULL
    ''',
    repository_full_name,
    repository_full_name
  )
  INTO orphan_target_count;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT COUNT(*)
    FROM `%s.lineage_direct_dependency`
    WHERE source_dataset = @target_dataset
      AND target_dataset = @target_dataset
      AND (
        (
          source_object = 'customers'
          AND source_column = 'address.prefecture'
          AND target_object = 'v_customer_profile'
          AND target_column = 'customer_prefecture'
        )
        OR
        (
          source_object = 'customers'
          AND source_column = 'contacts.contact_value'
          AND target_object = 'v_customer_primary_contact'
          AND target_column = 'contact_value'
        )
      )
    ''',
    repository_full_name
  )
  INTO expected_nested_edge_count
  USING target_dataset AS target_dataset;

  INSERT INTO integration_test_result
  VALUES
    (
      300,
      'DIRECT_DEPENDENCY',
      'dependency rows exist',
      IF(dependency_count > 0, 'PASS', 'FAIL'),
      'greater than 0',
      CAST(dependency_count AS STRING),
      'The sample Views must produce direct physical dependencies.',
      CURRENT_TIMESTAMP()
    ),
    (
      301,
      'DIRECT_DEPENDENCY',
      'edge keys are unique',
      IF(duplicate_edge_key_count = 0, 'PASS', 'FAIL'),
      '0 duplicate keys',
      CAST(duplicate_edge_key_count AS STRING),
      'Re-running the pipeline must not duplicate dependencies.',
      CURRENT_TIMESTAMP()
    ),
    (
      302,
      'DIRECT_DEPENDENCY',
      'no orphan dependency targets',
      IF(orphan_target_count = 0, 'PASS', 'FAIL'),
      '0',
      CAST(orphan_target_count AS STRING),
      'Published dependencies must belong to active definitions.',
      CURRENT_TIMESTAMP()
    ),
    (
      303,
      'DIRECT_DEPENDENCY',
      'identifiers normalized to lowercase',
      IF(uppercase_identifier_count = 0, 'PASS', 'FAIL'),
      '0',
      CAST(uppercase_identifier_count AS STRING),
      'Repository identifiers use lowercase normalization.',
      CURRENT_TIMESTAMP()
    ),
    (
      304,
      'DIRECT_DEPENDENCY',
      'nested STRUCT and ARRAY edges resolved',
      IF(expected_nested_edge_count = 2, 'PASS', 'FAIL'),
      '2',
      CAST(expected_nested_edge_count AS STRING),
      'Validates STRUCT field paths and UNNEST ARRAY<STRUCT> lineage.',
      CURRENT_TIMESTAMP()
    );
END;

-- ============================================================================
-- 4. Impact integrity
-- ============================================================================
BEGIN
  DECLARE impact_count INT64 DEFAULT 0;
  DECLARE duplicate_path_count INT64 DEFAULT 0;
  DECLARE invalid_rank_count INT64 DEFAULT 0;
  DECLARE deep_path_count INT64 DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT
      COUNT(*),
      COUNTIF(
        impact_rank < 1
        OR impact_rank > @max_impact_rank
      ),
      COUNTIF(
        origin_dataset = @target_dataset
        AND impacted_object = 'v_customer_sales_ranked'
        AND impact_rank >= 3
      )
    FROM `%s.lineage_impact`
    ''',
    repository_full_name
  )
  INTO
    impact_count,
    invalid_rank_count,
    deep_path_count
  USING
    target_dataset AS target_dataset,
    bootstrap_max_impact_rank AS max_impact_rank;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT COUNT(*)
    FROM (
      SELECT
        snapshot_at,
        origin_project,
        origin_dataset,
        origin_object,
        origin_column,
        path_hash
      FROM `%s.lineage_impact`
      GROUP BY
        snapshot_at,
        origin_project,
        origin_dataset,
        origin_object,
        origin_column,
        path_hash
      HAVING COUNT(*) > 1
    )
    ''',
    repository_full_name
  )
  INTO duplicate_path_count;

  INSERT INTO integration_test_result
  VALUES
    (
      400,
      'IMPACT',
      'impact rows exist',
      IF(impact_count > 0, 'PASS', 'FAIL'),
      'greater than 0',
      CAST(impact_count AS STRING),
      'Direct dependencies must be expanded into ranked impact paths.',
      CURRENT_TIMESTAMP()
    ),
    (
      401,
      'IMPACT',
      'impact path rows are unique',
      IF(duplicate_path_count = 0, 'PASS', 'FAIL'),
      '0 duplicate paths',
      CAST(duplicate_path_count AS STRING),
      'A snapshot must not contain duplicate path hashes.',
      CURRENT_TIMESTAMP()
    ),
    (
      402,
      'IMPACT',
      'impact ranks respect configuration',
      IF(invalid_rank_count = 0, 'PASS', 'FAIL'),
      '0 invalid ranks',
      CAST(invalid_rank_count AS STRING),
      'Impact rank must remain between 1 and max_impact_rank.',
      CURRENT_TIMESTAMP()
    ),
    (
      403,
      'IMPACT',
      'deep View propagation resolved',
      IF(deep_path_count > 0, 'PASS', 'FAIL'),
      'greater than 0',
      CAST(deep_path_count AS STRING),
      'Physical columns must reach v_customer_sales_ranked through multiple Views.',
      CURRENT_TIMESTAMP()
    );
END;

-- ============================================================================
-- 5. Scheduled Query / DAG collection integrity
-- ============================================================================
BEGIN
  DECLARE invalid_scheduled_query_user_count INT64 DEFAULT 0;
  DECLARE duplicate_job_count INT64 DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT COUNT(*)
    FROM `%s.lineage_job_registry`
    WHERE execution_source = 'SCHEDULED_QUERY'
      AND user_email != @scheduled_query_user_email
    ''',
    repository_full_name
  )
  INTO invalid_scheduled_query_user_count
  USING scheduled_query_user_email AS scheduled_query_user_email;

  EXECUTE IMMEDIATE FORMAT(
    '''
    SELECT COUNT(*)
    FROM (
      SELECT job_project, job_id
      FROM `%s.lineage_job_registry`
      GROUP BY job_project, job_id
      HAVING COUNT(*) > 1
    )
    ''',
    repository_full_name
  )
  INTO duplicate_job_count;

  INSERT INTO integration_test_result
  VALUES
    (
      500,
      'JOB_REGISTRY',
      'Scheduled Query user filter applied',
      IF(invalid_scheduled_query_user_count = 0, 'PASS', 'FAIL'),
      '0 invalid users',
      CAST(invalid_scheduled_query_user_count AS STRING),
      FORMAT(
        'Scheduled Query jobs must use %s.',
        scheduled_query_user_email
      ),
      CURRENT_TIMESTAMP()
    ),
    (
      501,
      'JOB_REGISTRY',
      'job keys are unique',
      IF(duplicate_job_count = 0, 'PASS', 'FAIL'),
      '0 duplicate jobs',
      CAST(duplicate_job_count AS STRING),
      'MERGE must keep one row per project and job ID.',
      CURRENT_TIMESTAMP()
    );
END;

-- ============================================================================
-- 6. Diagnostic acceptance
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
    repository_full_name
  )
  INTO
    error_count,
    warning_count;

  INSERT INTO integration_test_result
  VALUES
    (
      600,
      'DIAGNOSTIC',
      'no error diagnostics',
      IF(error_count = 0, 'PASS', 'FAIL'),
      '0',
      CAST(error_count AS STRING),
      'All ERROR diagnostics must be investigated.',
      CURRENT_TIMESTAMP()
    ),
    (
      601,
      'DIAGNOSTIC',
      'warning diagnostics reviewed',
      IF(warning_count = 0, 'PASS', 'WARN'),
      '0 preferred',
      CAST(warning_count AS STRING),
      'Warnings do not automatically reject the repository but require review.',
      CURRENT_TIMESTAMP()
    );
END;

-- ============================================================================
-- 7. Results
-- ============================================================================
SELECT
  test_order,
  test_group,
  test_name,
  test_status,
  expected_value,
  actual_value,
  message,
  tested_at
FROM integration_test_result
ORDER BY test_order;

SELECT
  test_started_at,
  CURRENT_TIMESTAMP() AS test_finished_at,
  COUNT(*) AS test_count,
  COUNTIF(test_status = 'PASS') AS pass_count,
  COUNTIF(test_status = 'WARN') AS warning_count,
  COUNTIF(test_status = 'FAIL') AS fail_count,
  CASE
    WHEN COUNTIF(test_status = 'FAIL') > 0
      THEN 'FAILED'
    WHEN COUNTIF(test_status = 'WARN') > 0
      THEN 'COMPLETED_WITH_WARNINGS'
    ELSE 'COMPLETED'
  END AS overall_status
FROM integration_test_result;
