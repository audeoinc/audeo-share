-- ============================================================================
-- 09_unanalyzed_object_definitions.sql
-- BigQuery Physical Lineage Repository - Unanalyzed object SQL report
-- ============================================================================
-- Lists the SQL of objects that CURRENTLY EXIST but are NOT covered by lineage
-- analysis, so an operator can see what is missing from the lineage graph and
-- why. Two kinds of objects are surfaced:
--
--   1. VIEWs, from `target_project.dataset.INFORMATION_SCHEMA.VIEWS`
--      (view_definition is the SQL).
--   2. Generated TABLEs produced by Scheduled Query / DAG jobs, from
--      `target_project.region-<region>`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
--      (query is the SQL) -- but ONLY when the job's destination table STILL
--      EXISTS now (confirmed against region INFORMATION_SCHEMA.TABLES). A job
--      whose destination has since been dropped is a definition that no longer
--      exists and is excluded (per the report's "existing definitions only"
--      requirement).
--
-- COVERAGE (whether an object is "analyzed") is decided from the lineage
-- definition registry: an object is covered when it has a registry row with
-- analysis_status IN ('COMPLETED','COMPLETED_WITH_WARNINGS') AND that row's
-- last_analyzed_hash equals the object's CURRENT definition hash. Everything
-- else is reported, tagged by coverage_reason:
--   NOT_REGISTERED                    -- exists but no registry row (dropped by
--                                        registry-stage exclusion, or never seen)
--   REGISTERED_NOT_YET_ANALYZED       -- registered, analysis_status IS NULL
--   ANALYSIS_<status>                 -- registered, non-COMPLETED status
--                                        (e.g. ANALYSIS_FAILED, ANALYSIS_PARTIAL_FAILURE,
--                                        ANALYSIS_INACTIVE_OBJECT_NOT_FOUND)
--   DEFINITION_CHANGED_NOT_REANALYZED -- COMPLETED, but the current definition
--                                        differs from the last analyzed one
--
-- DISTINCT BY DEFINITION: the result is deduplicated on definition_hash
-- (TO_HEX(SHA256(sql))), so repeated Scheduled Query / DAG runs of the same SQL
-- collapse to a single row and the report does not pile up over time. Each
-- distinct definition appears once, keyed to its most recent occurrence.
--
-- Read-only report; not part of the daily pipeline. Run it on demand. It only
-- reads INFORMATION_SCHEMA and the lineage registry; it writes nothing.
--
-- PERSISTED TWIN: 03_run_daily_lineage_pipeline.sql STEP 5 writes an equivalent
-- snapshot to the repository table `<prefix>lnge_t_unanalyzed_definition<suffix>`
-- at the end of every run (built from the registry, so cheap). That table does NOT
-- include registry-excluded objects (coverage_reason = NOT_REGISTERED), because
-- they never enter the registry. This on-demand report DOES surface them, by
-- re-scanning INFORMATION_SCHEMA -- run it when you need the NOT_REGISTERED set or
-- an up-to-the-second view without waiting for the pipeline.
--
-- CAVEATS:
--   1. @@location must match the region of the target project's objects AND the
--      lineage repository (the query joins region INFORMATION_SCHEMA to the
--      registry). This system is single-region, so they share @@location.
--   2. Region-level JOBS_BY_PROJECT / TABLES reads require the executing account
--      to have project-level metadata / jobs read on the target project.
--   3. The JOBS window is bounded by lookback_days (and by the ~180-day
--      INFORMATION_SCHEMA.JOBS retention); a generated table whose only creating
--      job is older than the window will not be matched to a definition here.
--   4. For a generated table produced by a CTAS job, definition_text is the
--      SELECT body (the CREATE...AS prefix is stripped), which is exactly what
--      the pipeline analyzes and stores; the same normalization is applied to
--      keep definition_hash aligned with the registry's last_analyzed_hash.
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
  -- Analysis dataset scope
  DECLARE analysis_include_dataset_patterns ARRAY<STRING> DEFAULT [];
  DECLARE analysis_exclude_dataset_patterns ARRAY<STRING> DEFAULT [];
  --
  -- Variable notes (keyed by name):
  --   project_token_pattern
  --     Project-token substitution regex (keep in step with 01). A token extracted
  --     from the auto-detected project id replaces every '{project_token}'
  --     placeholder in the dataset name and table prefix/suffix. Default: first
  --     hyphen segment.
  --   repository_dataset / table_name_prefix / table_name_suffix
  --     Lineage repository dataset (holds the definition registry). Its physical
  --     registry table name is assembled from the prefix/suffix -- keep them in
  --     step with 01 setup and 03 pipeline.
  --   analysis_include_dataset_patterns / analysis_exclude_dataset_patterns
  --     Analysis dataset scope (same meaning as 03). Empty include = every dataset in
  --     the target project / region; exclude drops matches. Matching is
  --     case-insensitive (name and pattern are lowercased). Confines BOTH the VIEWS
  --     union and the generated-table jobs to these datasets.

  -- --------------------------------------------------------------------------
  -- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
  -- --------------------------------------------------------------------------
  -- GCP project. Declared here (not in [A]) because it is normally not set by hand:
  -- it is auto-detected in [C] from INFORMATION_SCHEMA.SCHEMATA (the project the job
  -- runs in). To pin it, set a literal in [C]. The target objects (views / generated
  -- tables) and the lineage repository share one project; their *_project_id
  -- variables live in [C] and take this.
  DECLARE default_project_id STRING;
  -- Set FALSE to report only Views (skip the JOBS scan for generated tables).
  DECLARE include_generated_tables BOOL DEFAULT TRUE;

  -- How far back to scan JOBS for generated-table definitions (days). Bounded by
  -- INFORMATION_SCHEMA.JOBS retention (~180 days).
  DECLARE lookback_days INT64 DEFAULT 180;

  -- statement_type values that produce a generated table (mirrors 03).
  DECLARE collected_statement_types ARRAY<STRING> DEFAULT [
    'SELECT',
    'CREATE_TABLE_AS_SELECT'
  ];

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- computed from [A]/[B] or resolved at runtime; DO NOT edit
  -- --------------------------------------------------------------------------
  -- Region string for the region-qualified INFORMATION_SCHEMA identifiers
  -- (`region-<job_region>`), which cannot be parameterized. Mirrors @@location
  -- (the single source of truth set at the top of this file); never set it here.
  DECLARE job_region STRING DEFAULT @@location;

  -- Role-specific projects take default_project_id (auto-detected below); pin a
  -- line to a literal only if that role's objects live in a separate project.
  DECLARE target_project_id STRING DEFAULT NULL;
  DECLARE repository_project_id STRING DEFAULT NULL;

  -- Target datasets resolved at runtime from target_dataset_*_patterns ([A]).
  DECLARE target_datasets ARRAY<STRING>;
  DECLARE target_datasets_lower ARRAY<STRING>;

  -- Qualified registry table name (prefix + marker + canonical base + suffix).
  DECLARE registry_table STRING;
  DECLARE registry_fqn STRING;

  -- Dynamic SQL work variables.
  DECLARE view_defs_union_sql STRING;
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
  -- Project-token substitution in the name inputs (before names are used).
  SET project_token =
    COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
  SET repository_dataset =
    REPLACE(repository_dataset, '{project_token}', project_token);
  SET table_name_prefix =
    REPLACE(table_name_prefix, '{project_token}', project_token);
  SET table_name_suffix =
    REPLACE(table_name_suffix, '{project_token}', project_token);

  -- Guard: an unsubstituted '{project_token}' (or any invalid character) in the
  -- dataset name is surfaced here instead of failing later at query time.
  ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
    AS 'repository_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';

  ASSERT lookback_days >= 1 AS 'lookback_days must be >= 1.';
  ASSERT REGEXP_CONTAINS(target_project_id, r'^[A-Za-z0-9._:-]+$')
  AS 'Invalid target_project_id.';
  ASSERT REGEXP_CONTAINS(repository_project_id, r'^[A-Za-z0-9._:-]+$')
  AS 'Invalid repository_project_id.';
  ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
  AS 'Invalid repository_dataset.';
  ASSERT REGEXP_CONTAINS(job_region, r'^[A-Za-z0-9-]+$')
  AS 'Invalid job_region.';

  -- Repository physical table name: prefix + marker + canonical base + suffix.
  -- The 'm_' marker literal is inline (mirrors 01 / 03). Every reference is
  -- backtick-quoted, so a hyphen in prefix/suffix is safe.
  SET registry_table =
    table_name_prefix || 'lnge_' || 'm_' || 'definition_registry' || table_name_suffix;
  ASSERT REGEXP_CONTAINS(registry_table, r'^[A-Za-z0-9_-]+$')
  AS 'Invalid registry_table name.';
  SET registry_fqn = FORMAT(
    '%s.%s.%s', repository_project_id, repository_dataset, registry_table
  );

  -- --------------------------------------------------------------------------
  -- Resolve target_datasets by scanning the target project's datasets in
  -- job_region and applying the include/exclude regex patterns. Dataset ids keep
  -- their real case (case-sensitive identifiers); matching is case-insensitive.
  -- --------------------------------------------------------------------------
  EXECUTE IMMEDIATE FORMAT(
    """
    SELECT ARRAY_AGG(schema_name)
    FROM `%s.region-%s`.INFORMATION_SCHEMA.SCHEMATA
    WHERE (
      ARRAY_LENGTH(@inc) = 0
      OR EXISTS (
        SELECT 1 FROM UNNEST(@inc) AS p
        WHERE REGEXP_CONTAINS(LOWER(schema_name), LOWER(p))
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM UNNEST(@exc) AS p
      WHERE REGEXP_CONTAINS(LOWER(schema_name), LOWER(p))
    )
    """,
    target_project_id, job_region
  )
  INTO target_datasets
  USING
    analysis_include_dataset_patterns AS inc,
    analysis_exclude_dataset_patterns AS exc;

  SET target_datasets = COALESCE(target_datasets, CAST([] AS ARRAY<STRING>));
  ASSERT ARRAY_LENGTH(target_datasets) > 0
  AS 'No target dataset matched analysis_include_dataset_patterns / exclude in the region.';
  ASSERT (
    SELECT LOGICAL_AND(REGEXP_CONTAINS(d, r'^[A-Za-z0-9_]+$'))
    FROM UNNEST(target_datasets) AS d
  )
  AS 'Invalid target dataset name in target_datasets.';
  SET target_datasets_lower = ARRAY(
    SELECT LOWER(d) FROM UNNEST(target_datasets) AS d
  );

  -- --------------------------------------------------------------------------
  -- Existing VIEW definitions: union `target_project.dataset.INFORMATION_SCHEMA
  -- .VIEWS` across every target dataset (VIEWS is dataset-scoped and only there
  -- exposes view_definition). object_* are lowercased for the registry join.
  -- --------------------------------------------------------------------------
  SET view_defs_union_sql = (
    SELECT STRING_AGG(
      FORMAT(
        'SELECT LOWER(table_catalog) AS object_project, '
        || 'LOWER(table_schema) AS object_dataset, '
        || 'LOWER(table_name) AS object_name, '
        || '"VIEW" AS object_type, '
        || '"VIEW_DEFINITION" AS generation_type, '
        || '"INFORMATION_SCHEMA.VIEWS" AS definition_source, '
        || 'view_definition AS definition_text, '
        || 'TO_HEX(SHA256(view_definition)) AS definition_hash, '
        || 'CAST(NULL AS STRING) AS source_job_id, '
        || 'CAST(NULL AS TIMESTAMP) AS source_job_time '
        || 'FROM `%s.%s.INFORMATION_SCHEMA.VIEWS` '
        || 'WHERE view_definition IS NOT NULL AND TRIM(view_definition) != ""',
        target_project_id, d
      ),
      ' UNION ALL '
    )
    FROM UNNEST(target_datasets) AS d
  );
  EXECUTE IMMEDIATE FORMAT(
    'CREATE OR REPLACE TEMP TABLE existing_object_definitions AS %s',
    view_defs_union_sql
  );

  -- --------------------------------------------------------------------------
  -- Existing generated-TABLE definitions from JOBS, keyed to a destination that
  -- STILL EXISTS. Only the most recent job per (destination, definition) is
  -- kept. Appended into the same temp table so the final query unions both kinds.
  -- --------------------------------------------------------------------------
  IF include_generated_tables THEN
    -- Raw outer template (r"""...""") so the CTAS-stripping regex keeps its
    -- backslashes literally instead of being read as string escapes. The regex is
    -- byte-identical to 03's normalized_definitions so definition_hash lines up
    -- with the registry's stored hash (last_analyzed_hash), letting the coverage
    -- join distinguish "analyzed" from "changed since last analysis". For a CTAS
    -- the CREATE...AS prefix is removed, so definition_text is the SELECT body --
    -- exactly the text the system analyzes and stores in the registry.
    EXECUTE IMMEDIATE FORMAT(
      r"""
      INSERT INTO existing_object_definitions
      WITH jobs AS (
        SELECT
          LOWER(destination_table.project_id) AS object_project,
          LOWER(destination_table.dataset_id) AS object_dataset,
          LOWER(destination_table.table_id)   AS object_name,
          statement_type,
          query,
          job_id,
          creation_time
        FROM `%s.region-%s`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
        WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookback_days DAY)
          AND creation_time < CURRENT_TIMESTAMP()
          AND job_type = 'QUERY'
          AND state = 'DONE'
          AND error_result IS NULL
          AND query IS NOT NULL
          AND destination_table.table_id IS NOT NULL
          AND statement_type IN UNNEST(@statement_types)
          AND LOWER(destination_table.dataset_id) IN UNNEST(@target_datasets_lower)
      ),
      normalized_jobs AS (
        SELECT
          object_project,
          object_dataset,
          object_name,
          job_id,
          creation_time,
          CASE
            WHEN statement_type = 'CREATE_TABLE_AS_SELECT'
              THEN REGEXP_REPLACE(
                query,
                r'(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+'
                r'(?:IF\s+NOT\s+EXISTS\s+)?(?:`[^`]+`|[^\s]+)'
                r'(?:\s+OPTIONS\s*\([^;]*?\))?\s+AS\s+',
                ''
              )
            ELSE query
          END AS definition_text
        FROM jobs
      ),
      existing_tables AS (
        SELECT DISTINCT
          LOWER(table_catalog) AS p,
          LOWER(table_schema)  AS d,
          LOWER(table_name)    AS t
        FROM `%s.region-%s`.INFORMATION_SCHEMA.TABLES
        WHERE table_type = 'BASE TABLE'
      )
      SELECT
        j.object_project,
        j.object_dataset,
        j.object_name,
        'GENERATED_TABLE'                    AS object_type,
        'JOBS'                               AS generation_type,
        'INFORMATION_SCHEMA.JOBS'            AS definition_source,
        j.definition_text                    AS definition_text,
        TO_HEX(SHA256(j.definition_text))    AS definition_hash,
        j.job_id                             AS source_job_id,
        j.creation_time                      AS source_job_time
      FROM normalized_jobs AS j
      JOIN existing_tables AS et
        ON  et.p = j.object_project
        AND et.d = j.object_dataset
        AND et.t = j.object_name
      WHERE j.definition_text IS NOT NULL
        AND TRIM(j.definition_text) != ''
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY j.object_project, j.object_dataset, j.object_name, TO_HEX(SHA256(j.definition_text))
        ORDER BY j.creation_time DESC
      ) = 1
      """,
      target_project_id, job_region, target_project_id, job_region
    )
    USING
      lookback_days AS lookback_days,
      collected_statement_types AS statement_types,
      target_datasets_lower AS target_datasets_lower;
  END IF;

  -- --------------------------------------------------------------------------
  -- Report: join the existing definitions to the registry for coverage, drop the
  -- fully-covered rows, dedupe by definition_hash (one row per distinct SQL).
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      d.object_project,
      d.object_dataset,
      d.object_name,
      d.object_type,
      d.generation_type,
      d.definition_source,
      d.source_job_id,
      d.source_job_time,
      reg.analysis_status,
      reg.is_active,
      reg.last_analyzed_at,
      CASE
        WHEN reg.object_name IS NULL THEN 'NOT_REGISTERED'
        WHEN reg.analysis_status IS NULL THEN 'REGISTERED_NOT_YET_ANALYZED'
        WHEN reg.analysis_status NOT IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS')
          THEN 'ANALYSIS_' || reg.analysis_status
        ELSE 'DEFINITION_CHANGED_NOT_REANALYZED'
      END AS coverage_reason,
      d.definition_hash,
      d.definition_text
    FROM existing_object_definitions AS d
    LEFT JOIN `%s` AS reg
      ON  LOWER(reg.object_project) = d.object_project
      AND LOWER(reg.object_dataset) = d.object_dataset
      AND LOWER(reg.object_name)    = d.object_name
    -- Keep everything that is NOT fully covered. Fully covered = registered AND
    -- COMPLETED AND the last analyzed definition equals the current one. Written
    -- as the explicit NULL-safe complement (IS DISTINCT FROM) so a COMPLETED row
    -- with a NULL last_analyzed_hash is surfaced, not silently dropped. Mirrors
    -- the coverage_reason CASE above.
    WHERE reg.object_name IS NULL
      OR reg.analysis_status IS NULL
      OR reg.analysis_status NOT IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS')
      OR reg.last_analyzed_hash IS DISTINCT FROM d.definition_hash
    -- DISTINCT by definition: one representative row per distinct SQL text.
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY d.definition_hash
      ORDER BY d.object_type, d.source_job_time DESC NULLS LAST
    ) = 1
    ORDER BY coverage_reason, d.object_dataset, d.object_name
    """,
    registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql;
END;
