-- ============================================================================
-- create_render_dynamic_sql_udf.sql
-- Persistent dynamic-SQL renderer redeployment helper
-- ============================================================================
-- render_dynamic_sql expands the __TARGET_PROJECT__ / __JOB_REGION__ / __UDF__
-- / __T_*__ identifier placeholders used by 03_run_daily_lineage_pipeline.sql.
-- It is deployed by 01_setup_lineage_environment.sql during initial setup; run
-- this helper only to recreate it in place (e.g. after editing the body)
-- without re-running full setup. The function is a pure SQL scalar UDF and does
-- not depend on the JavaScript bundle.
--
-- 03 references this function by the fully-qualified name
-- `<repository_project>.<repository_dataset>.render_dynamic_sql`; keep the
-- values below (and the literal in 03) in step with the repository location.
-- ============================================================================
SET @@location = 'asia-northeast1';

BEGIN
  DECLARE repository_project_id STRING DEFAULT 'project_id';
  DECLARE repository_dataset STRING DEFAULT 'lineage_repository';

  DECLARE repository_dataset_full_name STRING DEFAULT FORMAT(
    '%s.%s',
    repository_project_id,
    repository_dataset
  );

  ASSERT REGEXP_CONTAINS(repository_project_id, r'^[A-Za-z0-9._:-]+$')
  AS 'Invalid repository_project_id.';
  ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
  AS 'Invalid repository_dataset.';

  EXECUTE IMMEDIATE FORMAT(
    '''
    CREATE OR REPLACE FUNCTION `%s.render_dynamic_sql`(
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
    repository_dataset_full_name
  );

  SELECT
    FORMAT('%s.render_dynamic_sql', repository_dataset_full_name)
      AS recreated_function,
    CURRENT_TIMESTAMP() AS recreated_at;
END;
