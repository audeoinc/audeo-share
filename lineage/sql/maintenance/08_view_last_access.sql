-- ============================================================================
-- 08_view_last_access.sql
-- BigQuery Physical Lineage Repository - View last-access report (audit logs)
-- ============================================================================
-- Reports the last time each tracked VIEW was accessed by a query, from BigQuery
-- audit logs sinked into BigQuery (the "new" format: BigQueryAuditMetadata in
-- protopayload_auditlog.metadataJson). Audit logs are the authoritative source
-- for view access because they expose a dedicated `referencedViews` array that
-- identifies the VIEW itself, separate from `referencedTables` -- unlike
-- INFORMATION_SCHEMA.JOBS.referenced_tables, which does not reliably distinguish
-- a view from its underlying base tables.
--
-- The audit accesses are LEFT JOINed to the lineage definition registry, so
-- views never queried in the window show last_accessed_at = NULL
-- (unused-view candidates) alongside the pipeline's own timestamps
-- (last_seen_at = last pipeline observation, last_analyzed_at = last analysis).
--
-- Read-only report; not part of the daily pipeline. Run it on demand.
--
-- WHERE THE VIEW IS IDENTIFIED:
--   protopayload_auditlog.metadataJson (JSON) ->
--     $.jobChange.job.jobStats.queryStats.referencedViews
--   Each element is a resource name: projects/P/datasets/D/tables/VIEW
--   (views use the /tables/ path but are listed under referencedViews).
--
-- CAVEATS:
--   1. New format assumed: protopayload_auditlog.metadataJson
--      (BigQueryAuditMetadata). If your sink is the legacy format, read
--      protopayload_auditlog.servicedata_v1_bigquery.jobCompletedEvent.job
--      .jobStatistics.referencedViews instead. Check which by whether
--      metadataJson IS NOT NULL.
--   2. Use the *_cloudaudit_googleapis_com_data_access sink table (data access),
--      not _activity. Set audit_project/dataset/table below.
--   3. @@location must match the location of BOTH the audit table and the lineage
--      repository (the query joins them). This system is single-region, so they
--      are expected to share @@location. If they are in different regions, run
--      the pure-audit variant at the bottom (no registry join) instead.
--   4. The window is bounded by how much history the sink table retains
--      (independent of the JOBS ~180-day limit; configure lookback_days to it).
--   5. Whether cache-hit queries populate referencedViews should be verified in
--      your environment; if they do not, a cached-only access can still look like
--      no access.
--
-- Not yet validated against BigQuery.
-- ============================================================================
SET @@location = 'asia-northeast1';

BEGIN
  -- --------------------------------------------------------------------------
  -- [A] REQUIRED per deployment / region -- set these
  -- --------------------------------------------------------------------------
  -- Variables are grouped by purpose below; each group is labeled with a one-line
  -- header. Full descriptions follow the block under "Variable notes".
  -- GCP project: auto-detected at runtime; its DECLARE lives in [B] (pin it there
  -- only to run against a different project).
  -- Project-token substitution
  DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
  -- Repository dataset & table naming
  DECLARE repository_dataset STRING DEFAULT 'lineage_repository';
  DECLARE table_name_prefix STRING DEFAULT '';
  DECLARE table_name_suffix STRING DEFAULT '';
  -- Audit log sink (project / dataset / table)
  DECLARE audit_project_id STRING DEFAULT NULL;
  DECLARE audit_dataset STRING DEFAULT 'audit_logs';
  DECLARE audit_table STRING DEFAULT 'cloudaudit_googleapis_com_data_access';
  --
  -- Variable notes (keyed by name):
  --   project_token_pattern
  --     Project-token substitution regex (keep in step with 01). A token extracted
  --     from the auto-detected project id replaces every '{project_token}'
  --     placeholder in the dataset names and table prefix/suffix. Default: first
  --     hyphen segment.
  --   repository_dataset / table_name_prefix / table_name_suffix
  --     Lineage repository dataset (holds the definition registry). Its physical
  --     registry table name is assembled from the prefix/suffix -- keep them in
  --     step with 01 setup.
  --   audit_project_id / audit_dataset / audit_table
  --     Audit log sink location (the *_data_access table). The sink can
  --     legitimately live in a separate project, so pin audit_project_id to a
  --     literal when the sink is elsewhere; otherwise it takes the auto-detected
  --     default.

  -- --------------------------------------------------------------------------
  -- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
  -- --------------------------------------------------------------------------
  -- GCP project. Declared here (not in [A]) because it is normally not set by hand:
  -- it is auto-detected in [C] from INFORMATION_SCHEMA.SCHEMATA (the project the job
  -- runs in). To pin it, set a literal in [C]. The views (target) and the lineage
  -- repository share one project; their *_project_id variables live in [C] and take
  -- this.
  DECLARE default_project_id STRING;
  -- How far back to scan (days). Bounded by the sink table's retention.
  DECLARE lookback_days INT64 DEFAULT 180;
  -- Optional dataset-name regex filters on the reported views (empty = all).
  DECLARE include_dataset_patterns ARRAY<STRING> DEFAULT [];
  DECLARE exclude_dataset_patterns ARRAY<STRING> DEFAULT [];

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]; DO NOT edit
  -- --------------------------------------------------------------------------
  -- Views' project and the repository project take default_project_id (auto-
  -- detected below); pin a line to a literal only if that role's objects live in a
  -- separate project.
  DECLARE target_project_id STRING DEFAULT NULL;
  DECLARE repository_project_id STRING DEFAULT NULL;
  DECLARE audit_fqn STRING;
  DECLARE registry_fqn STRING;
  DECLARE rendered_sql STRING;
  -- Token extracted from the project id (see project_token_pattern).
  DECLARE project_token STRING;

  -- Auto-detect the running GCP project from INFORMATION_SCHEMA.SCHEMATA
  -- (catalog_name). The region-qualified identifier is built from @@location; to
  -- pin the project, replace this SET with a literal. Roles take it unless pinned.
  EXECUTE IMMEDIATE FORMAT(
    "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
    @@location
  ) INTO default_project_id;
  ASSERT default_project_id IS NOT NULL AS
    'Could not auto-detect the project id from INFORMATION_SCHEMA.SCHEMATA; set default_project_id to a literal.';
  SET target_project_id = COALESCE(target_project_id, default_project_id);
  SET repository_project_id = COALESCE(repository_project_id, default_project_id);
  SET audit_project_id = COALESCE(audit_project_id, default_project_id);
  -- Project-token substitution in the name inputs (before names are used).
  SET project_token =
    COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
  SET repository_dataset =
    REPLACE(repository_dataset, '{project_token}', project_token);
  SET audit_dataset = REPLACE(audit_dataset, '{project_token}', project_token);
  SET table_name_prefix =
    REPLACE(table_name_prefix, '{project_token}', project_token);
  SET table_name_suffix =
    REPLACE(table_name_suffix, '{project_token}', project_token);

  -- Guard: an unsubstituted '{project_token}' (or any invalid character) in a dataset
  -- name is surfaced here instead of failing later at query time.
  ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
    AS 'repository_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
  ASSERT REGEXP_CONTAINS(audit_dataset, r'^[A-Za-z0-9_]+$')
    AS 'audit_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';

  ASSERT lookback_days >= 1 AS 'lookback_days must be >= 1.';

  SET audit_fqn = FORMAT('%s.%s.%s', audit_project_id, audit_dataset, audit_table);
  SET registry_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    table_name_prefix || 'lnge_' || 'm_' || 'definition_registry' || table_name_suffix
  );

  SET rendered_sql = FORMAT(
    """
    WITH view_accesses AS (
      SELECT
        SPLIT(view_resource, '/')[SAFE_OFFSET(1)] AS object_project,
        SPLIT(view_resource, '/')[SAFE_OFFSET(3)] AS object_dataset,
        SPLIT(view_resource, '/')[SAFE_OFFSET(5)] AS object_name,
        a.timestamp AS accessed_at,
        a.protopayload_auditlog.authenticationInfo.principalEmail AS principal_email,
        JSON_VALUE(
          a.protopayload_auditlog.metadataJson,
          '$.jobChange.job.jobConfig.labels.data_source_id'
        ) AS data_source_id
      FROM `%s` AS a,
        UNNEST(JSON_VALUE_ARRAY(
          a.protopayload_auditlog.metadataJson,
          '$.jobChange.job.jobStats.queryStats.referencedViews'
        )) AS view_resource
      WHERE a.timestamp >=
        TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookback_days DAY)
    ),
    per_view AS (
      SELECT
        object_project,
        object_dataset,
        object_name,
        MAX(accessed_at) AS last_accessed_at,
        COUNT(*) AS access_event_count,
        COUNT(DISTINCT principal_email) AS distinct_users,
        ARRAY_AGG(principal_email ORDER BY accessed_at DESC LIMIT 1)[SAFE_OFFSET(0)]
          AS last_accessed_by,
        ARRAY_AGG(data_source_id ORDER BY accessed_at DESC LIMIT 1)[SAFE_OFFSET(0)]
          AS last_data_source_id
      FROM view_accesses
      WHERE object_project = @target_project_id
      GROUP BY object_project, object_dataset, object_name
    )
    SELECT
      reg.object_project,
      reg.object_dataset,
      reg.object_name,
      reg.object_type,
      pv.last_accessed_at,
      TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), pv.last_accessed_at, DAY)
        AS days_since_last_access,
      COALESCE(pv.access_event_count, 0) AS access_event_count,
      COALESCE(pv.distinct_users, 0) AS distinct_users,
      pv.last_accessed_by,
      pv.last_data_source_id,
      reg.is_active,
      reg.last_seen_at,
      reg.last_analyzed_at
    FROM `%s` AS reg
    LEFT JOIN per_view AS pv
      ON  LOWER(pv.object_project) = LOWER(reg.object_project)
      AND LOWER(pv.object_dataset) = LOWER(reg.object_dataset)
      AND LOWER(pv.object_name)    = LOWER(reg.object_name)
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
    ORDER BY pv.last_accessed_at DESC NULLS LAST
    """,
    audit_fqn,
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
-- Pure-audit variant (caveat #3): no registry join, so the audit table and the
-- lineage repository may live in different regions. Lists only views that WERE
-- accessed in the window (cannot surface never-accessed views). Replace the
-- audit table name and adjust @@location to the audit table's region.
-- ============================================================================
-- SET @@location = 'asia-northeast1';
-- SELECT
--   SPLIT(v, '/')[SAFE_OFFSET(1)] AS object_project,
--   SPLIT(v, '/')[SAFE_OFFSET(3)] AS object_dataset,
--   SPLIT(v, '/')[SAFE_OFFSET(5)] AS object_name,
--   MAX(timestamp) AS last_accessed_at,
--   COUNT(*)       AS access_event_count,
--   COUNT(DISTINCT protopayload_auditlog.authenticationInfo.principalEmail)
--     AS distinct_users
-- FROM `project_id.audit_logs.cloudaudit_googleapis_com_data_access`,
--   UNNEST(JSON_VALUE_ARRAY(
--     protopayload_auditlog.metadataJson,
--     '$.jobChange.job.jobStats.queryStats.referencedViews'
--   )) AS v
-- WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 180 DAY)
--   AND SPLIT(v, '/')[SAFE_OFFSET(1)] = 'project_id'
-- GROUP BY object_project, object_dataset, object_name
-- ORDER BY last_accessed_at DESC;
