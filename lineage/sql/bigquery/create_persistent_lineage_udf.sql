-- ============================================================================
-- create_persistent_lineage_udf.sql
-- Persistent JavaScript UDF redeployment helper
-- ============================================================================
-- Use 01_setup_lineage_environment.sql for initial environment setup.
-- Run this helper only when the JavaScript bundle has been replaced and the
-- persistent UDF must be recreated without rebuilding the repository.
-- ============================================================================
SET @@location = 'asia-northeast1';

BEGIN
  DECLARE udf_project_id STRING DEFAULT 'project_id';
  DECLARE udf_dataset STRING DEFAULT 'dataset';
  DECLARE udf_function_name STRING DEFAULT 'lnge_analyze_json';
  DECLARE bundle_uri STRING DEFAULT
    'gs://YOUR_BUCKET/YOUR_PATH/lineage_udf_bundle.js';

  DECLARE udf_identifier STRING DEFAULT FORMAT(
    '%s.%s.%s',
    udf_project_id,
    udf_dataset,
    udf_function_name
  );
  DECLARE ddl_template STRING;
  DECLARE rendered_ddl STRING;

  ASSERT REGEXP_CONTAINS(udf_project_id, r'^[A-Za-z0-9._:-]+$')
  AS 'Invalid udf_project_id.';
  ASSERT REGEXP_CONTAINS(udf_dataset, r'^[A-Za-z0-9_]+$')
  AS 'Invalid udf_dataset.';
  ASSERT REGEXP_CONTAINS(udf_function_name, r'^[A-Za-z0-9_]+$')
  AS 'Invalid udf_function_name.';
  ASSERT REGEXP_CONTAINS(
    bundle_uri,
    r'^gs://[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+\.js$'
  )
  AS 'Invalid bundle_uri.';

  SET ddl_template = """
    CREATE OR REPLACE FUNCTION `__UDF__`(
      sql_text STRING,
      physical_columns_json STRING,
      options_json STRING,
      export_metadata_json STRING
    )
    RETURNS STRING
    LANGUAGE js
    OPTIONS (
      library = ['__BUNDLE_URI__']
    )
    AS r'''
      return analyzeLineageForBigQuery(
        sql_text,
        physical_columns_json,
        options_json,
        export_metadata_json
      );
    '''
  """;

  SET rendered_ddl = REPLACE(
    REPLACE(ddl_template, '__UDF__', udf_identifier),
    '__BUNDLE_URI__',
    bundle_uri
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_ddl, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in persistent UDF DDL.';

  EXECUTE IMMEDIATE rendered_ddl;

  SELECT
    udf_identifier AS recreated_udf,
    bundle_uri AS library_uri,
    CURRENT_TIMESTAMP() AS recreated_at;
END;
