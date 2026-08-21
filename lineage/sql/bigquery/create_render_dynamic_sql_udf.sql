-- ============================================================================
-- create_render_dynamic_sql_udf.sql
-- Persistent dynamic-SQL renderer redeployment helper
-- ============================================================================
-- lnge_render_dynamic_sql expands the __TARGET_PROJECT__ / __JOB_REGION__ / __UDF__
-- / __T_*__ identifier placeholders used by 03_run_daily_lineage_pipeline.sql.
-- It is deployed by 01_setup_lineage_environment.sql during initial setup; run
-- this helper only to recreate it in place (e.g. after editing the body)
-- without re-running full setup. The function is a pure SQL scalar UDF and does
-- not depend on the JavaScript bundle.
--
-- It is created in the UDF dataset, alongside lnge_analyze_json. 03 invokes
-- it dynamically using its udf_project_id / udf_dataset DECLAREs, so keep the
-- values below in step with the UDF location.
-- ============================================================================
SET @@location = 'asia-northeast1';

BEGIN
  DECLARE udf_project_id STRING DEFAULT 'project_id';
  DECLARE udf_dataset STRING DEFAULT 'dataset';
  DECLARE udf_render_function_name STRING DEFAULT 'lnge_render_dynamic_sql';

  ASSERT REGEXP_CONTAINS(udf_project_id, r'^[A-Za-z0-9._:-]+$')
  AS 'Invalid udf_project_id.';
  ASSERT REGEXP_CONTAINS(udf_dataset, r'^[A-Za-z0-9_]+$')
  AS 'Invalid udf_dataset.';
  ASSERT REGEXP_CONTAINS(udf_render_function_name, r'^[A-Za-z0-9_]+$')
  AS 'Invalid udf_render_function_name.';

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
    udf_project_id,
    udf_dataset,
    udf_render_function_name
  );

  SELECT
    FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_render_function_name)
      AS recreated_function,
    CURRENT_TIMESTAMP() AS recreated_at;
END;
