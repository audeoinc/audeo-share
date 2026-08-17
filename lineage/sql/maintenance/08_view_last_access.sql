-- ============================================================================
-- 08_view_last_access.sql
-- BigQuery Physical Lineage Repository - View last-access report (standalone)
-- ============================================================================
-- Reports the last time each tracked VIEW was accessed by a query, derived from
-- INFORMATION_SCHEMA.JOBS_BY_PROJECT.referenced_tables, joined against the
-- lineage definition registry so that:
--   - views never queried in the window show last_accessed_at = NULL
--     (unused-view candidates), and
--   - access metrics sit next to the pipeline's own timestamps
--     (last_seen_at = last pipeline observation, last_analyzed_at = last
--     lineage analysis).
--
-- This is a read-only report. It does NOT modify the repository and is not part
-- of the daily pipeline. Run it on demand.
--
-- CAVEATS (read before trusting the numbers):
--   1. JOBS_BY_PROJECT retains roughly the last 180 days of jobs. Accesses older
--      than lookback_days / the retention window are not visible here. For
--      longer history, export Cloud Audit Logs (BigQueryAuditMetadata data-access
--      events) and aggregate those instead.
--   2. JOBS_BY_PROJECT only contains jobs that RAN IN jobs_project_id. If the
--      views are queried from jobs billed to other projects, set jobs_project_id
--      accordingly or union several projects' JOBS_BY_PROJECT (or use
--      JOBS_BY_ORGANIZATION, which needs organization-level permission).
--   3. referenced_tables must list the VIEW itself for a view access to be
--      counted here. Verify this holds in your environment before relying on the
--      NULLs as "unused" (see the verification query at the bottom); if only the
--      underlying base tables appear, view-level access needs audit logs instead.
--   4. @@location must equal the region whose JOBS_BY_PROJECT you read.
--
-- Not yet validated against BigQuery.
-- ============================================================================
SET @@location = 'asia-northeast1';

BEGIN
  -- Region is the single source of truth: derived from @@location above.
  DECLARE job_region STRING DEFAULT @@location;

  -- Project whose job history to scan (where the querying jobs ran / were billed).
  DECLARE jobs_project_id STRING DEFAULT 'project_id';
  -- Project the views live in (filters referenced_tables to these objects).
  DECLARE target_project_id STRING DEFAULT 'project_id';

  -- Lineage repository location (holds the definition registry).
  DECLARE repository_project_id STRING DEFAULT 'project_id';
  DECLARE repository_dataset STRING DEFAULT 'lineage_repository';
  -- Physical registry table name: keep prefix/suffix in step with 01 setup
  -- (bootstrap_table_name_prefix / suffix). Default is m_lineage_definition_registry.
  DECLARE table_name_prefix STRING DEFAULT '';
  DECLARE table_name_suffix STRING DEFAULT '';

  -- How far back to scan job history (days). Bounded by JOBS retention (~180d).
  DECLARE lookback_days INT64 DEFAULT 180;

  -- Optional dataset-name regex filters on the reported views (empty = all).
  -- Case-insensitive REGEXP_CONTAINS, same convention as the pipeline.
  DECLARE include_dataset_patterns ARRAY<STRING> DEFAULT [];
  DECLARE exclude_dataset_patterns ARRAY<STRING> DEFAULT [];

  DECLARE registry_fqn STRING;
  DECLARE rendered_sql STRING;

  ASSERT REGEXP_CONTAINS(job_region, r'^[A-Za-z0-9-]+$')
  AS 'Invalid job_region.';
  ASSERT lookback_days BETWEEN 1 AND 180
  AS 'lookback_days must be between 1 and 180 (JOBS_BY_PROJECT retention).';

  SET registry_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    table_name_prefix || 'm_' || 'lineage_definition_registry' || table_name_suffix
  );

  SET rendered_sql = FORMAT(
    """
    WITH accesses AS (
      SELECT
        ref.project_id AS object_project,
        ref.dataset_id AS object_dataset,
        ref.table_id   AS object_name,
        j.creation_time,
        j.user_email
      FROM `%s.region-%s`.INFORMATION_SCHEMA.JOBS_BY_PROJECT AS j,
        UNNEST(j.referenced_tables) AS ref
      WHERE j.job_type = 'QUERY'
        AND j.state = 'DONE'
        AND j.error_result IS NULL
        AND j.creation_time >=
          TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookback_days DAY)
        AND ref.project_id = @target_project_id
    ),
    per_object AS (
      SELECT
        object_project,
        object_dataset,
        object_name,
        MAX(creation_time) AS last_accessed_at,
        COUNT(*) AS access_job_count,
        COUNT(DISTINCT user_email) AS distinct_users,
        ARRAY_AGG(user_email ORDER BY creation_time DESC LIMIT 1)[SAFE_OFFSET(0)]
          AS last_accessed_by
      FROM accesses
      GROUP BY object_project, object_dataset, object_name
    )
    SELECT
      reg.object_project,
      reg.object_dataset,
      reg.object_name,
      reg.object_type,
      po.last_accessed_at,
      TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), po.last_accessed_at, DAY)
        AS days_since_last_access,
      COALESCE(po.access_job_count, 0) AS access_job_count,
      COALESCE(po.distinct_users, 0) AS distinct_users,
      po.last_accessed_by,
      reg.is_active,
      reg.last_seen_at,
      reg.last_analyzed_at
    FROM `%s` AS reg
    LEFT JOIN per_object AS po
      ON  LOWER(po.object_project) = LOWER(reg.object_project)
      AND LOWER(po.object_dataset) = LOWER(reg.object_dataset)
      AND LOWER(po.object_name)    = LOWER(reg.object_name)
    WHERE reg.object_type = 'VIEW'
      AND reg.is_active = TRUE
      AND (
        ARRAY_LENGTH(@include_dataset_patterns) = 0
        OR EXISTS (
          SELECT 1 FROM UNNEST(@include_dataset_patterns) AS p
          WHERE REGEXP_CONTAINS(LOWER(reg.object_dataset), LOWER(p))
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM UNNEST(@exclude_dataset_patterns) AS p
        WHERE REGEXP_CONTAINS(LOWER(reg.object_dataset), LOWER(p))
      )
    ORDER BY po.last_accessed_at DESC NULLS LAST
    """,
    jobs_project_id,
    job_region,
    registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING
    lookback_days AS lookback_days,
    target_project_id AS target_project_id,
    include_dataset_patterns AS include_dataset_patterns,
    exclude_dataset_patterns AS exclude_dataset_patterns;
END;

-- ============================================================================
-- Verification helper (caveat #3): does referenced_tables list VIEWS at all?
-- Run this once for a view you KNOW was queried recently. A non-zero count means
-- view-level access is captured and the NULLs above are trustworthy as "unused".
-- ============================================================================
-- SET @@location = 'asia-northeast1';
-- SELECT COUNT(*) AS view_reference_hits
-- FROM `project_id.region-asia-northeast1`.INFORMATION_SCHEMA.JOBS_BY_PROJECT AS j,
--   UNNEST(j.referenced_tables) AS ref
-- WHERE j.creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
--   AND ref.project_id = 'project_id'
--   AND ref.dataset_id = 'your_dataset'
--   AND ref.table_id   = 'your_recently_queried_view';
