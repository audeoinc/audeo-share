-- ============================================================================
-- 10_create_column_usage_impact_view.sql
-- BigQuery Physical Lineage Repository - Column-usage x impact depth view
-- ============================================================================
-- Creates a VIEW that joins the per-reference column usage index
-- (t_lineage_column_usage) to the ranked impact graph (t_lineage_impact), so a
-- Looker report can pick an ORIGIN column (a table/view column whose requirements
-- change) and see every place it is used downstream, WITH A DEPTH -- the same
-- notion as impact_rank -- and the path it travels.
--
-- WHY A VIEW (not a stored column on the usage table): depth is relative to a
-- chosen origin column. The same usage site sits at different depths for
-- different origins, so a single stored rank on t_lineage_column_usage would be
-- ambiguous. The view computes depth per (origin, usage-site) on read, joining
-- the usage index to impact -- no data duplication, always consistent with the
-- current impact rebuild (03 STEP 4 fully replaces the impact table each run, so
-- it always holds exactly one -- the latest -- snapshot).
--
-- DEPTH CONVENTION (as requested):
--   depth = 1                      -- the usage references the ORIGIN column
--                                     directly (the first level of use)
--   depth = impact_rank + 1        -- the usage references a column that is
--                                     impacted by the origin at impact_rank
--   (so a column at rank r from the origin has its users at depth r+1)
--
-- COLUMNS:
--   origin_*         the column whose change is being assessed (pick these in Looker)
--   depth            1 for direct references; impact_rank + 1 downstream
--   ref_source_*     the column actually referenced at the site (= origin when
--                    depth = 1; the intermediate impacted column when deeper)
--   usage_object_*   the object whose SQL contains the reference
--   usage_type       the clause (SELECT / WHERE / JOIN_ON / GROUP_BY / ...)
--   reference_name, line_number, column_number, line_text  -- where/how
--   dependency_path  the value-flow route origin -> ... -> ref_source (NULL for
--                    depth = 1, i.e. a direct reference)
--
-- Read-only definition; run once (and again whenever the repository table names
-- change). Not part of the daily pipeline.
--
-- Not yet validated against BigQuery.
-- ============================================================================
SET @@location = 'asia-northeast1';

BEGIN
  -- --------------------------------------------------------------------------
  -- [A] REQUIRED per deployment / region -- set these
  -- --------------------------------------------------------------------------
  -- GCP project holding the lineage repository.
  DECLARE default_project_id STRING DEFAULT 'project_id';
  -- Repository dataset and the physical table-name prefix/suffix (keep in step
  -- with 01 setup / 03 pipeline).
  DECLARE repository_dataset STRING DEFAULT 'lineage_repository';
  DECLARE table_name_prefix STRING DEFAULT '';
  DECLARE table_name_suffix STRING DEFAULT '';

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]; DO NOT edit
  -- --------------------------------------------------------------------------
  DECLARE repository_project_id STRING DEFAULT default_project_id;
  DECLARE column_usage_fqn STRING;
  DECLARE impact_fqn STRING;
  DECLARE view_fqn STRING;
  DECLARE view_name STRING;

  ASSERT REGEXP_CONTAINS(repository_project_id, r'^[A-Za-z0-9._:-]+$')
  AS 'Invalid repository_project_id.';
  ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
  AS 'Invalid repository_dataset.';

  SET view_name =
    table_name_prefix || 'v_' || 'lineage_column_usage_impact'
      || table_name_suffix;
  ASSERT REGEXP_CONTAINS(view_name, r'^[A-Za-z0-9_-]+$')
  AS 'Invalid view_name.';

  SET column_usage_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id, repository_dataset,
    table_name_prefix || 't_' || 'lineage_column_usage' || table_name_suffix
  );
  SET impact_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id, repository_dataset,
    table_name_prefix || 't_' || 'lineage_impact' || table_name_suffix
  );
  SET view_fqn = FORMAT(
    '%s.%s.%s', repository_project_id, repository_dataset, view_name
  );

  EXECUTE IMMEDIATE FORMAT(
    """
    CREATE OR REPLACE VIEW `%s`
    OPTIONS (
      description = 'Column usage joined to impact: for a chosen origin column, every downstream usage site with a depth (1 = direct reference; impact_rank + 1 deeper) and the value-flow path.'
    )
    AS
    -- depth = 1: the usage references the origin column directly.
    SELECT
      u.source_project      AS origin_project,
      u.source_dataset      AS origin_dataset,
      u.source_object       AS origin_object,
      u.source_object_type  AS origin_object_type,
      u.source_column       AS origin_column,
      1                     AS depth,
      u.source_project      AS ref_source_project,
      u.source_dataset      AS ref_source_dataset,
      u.source_object       AS ref_source_object,
      u.source_object_type  AS ref_source_object_type,
      u.source_column       AS ref_source_column,
      u.source_field_path   AS ref_source_field_path,
      u.object_project      AS usage_object_project,
      u.object_dataset      AS usage_object_dataset,
      u.object_name         AS usage_object_name,
      u.object_type         AS usage_object_type,
      u.generation_type     AS usage_generation_type,
      u.usage_type,
      u.reference_name,
      u.line_number,
      u.column_number,
      u.line_text,
      u.resolution_status,
      CAST(NULL AS ARRAY<STRING>) AS dependency_path
    FROM `%s` AS u
    UNION ALL
    -- depth = impact_rank + 1: the usage references a column impacted by the
    -- origin. impact holds exactly the current snapshot (03 STEP 4 replaces it).
    SELECT
      i.origin_project,
      i.origin_dataset,
      i.origin_object,
      i.origin_object_type,
      i.origin_column,
      i.impact_rank + 1     AS depth,
      u.source_project      AS ref_source_project,
      u.source_dataset      AS ref_source_dataset,
      u.source_object       AS ref_source_object,
      u.source_object_type  AS ref_source_object_type,
      u.source_column       AS ref_source_column,
      u.source_field_path   AS ref_source_field_path,
      u.object_project      AS usage_object_project,
      u.object_dataset      AS usage_object_dataset,
      u.object_name         AS usage_object_name,
      u.object_type         AS usage_object_type,
      u.generation_type     AS usage_generation_type,
      u.usage_type,
      u.reference_name,
      u.line_number,
      u.column_number,
      u.line_text,
      u.resolution_status,
      i.dependency_path
    FROM `%s` AS i
    JOIN `%s` AS u
      ON  LOWER(u.source_project) = LOWER(i.impacted_project)
      AND LOWER(u.source_dataset) = LOWER(i.impacted_dataset)
      AND LOWER(u.source_object)  = LOWER(i.impacted_object)
      AND LOWER(u.source_column)  = LOWER(i.impacted_column)
    """,
    view_fqn,
    column_usage_fqn,
    impact_fqn,
    column_usage_fqn
  );

  SELECT FORMAT('Created or replaced view %s', view_fqn) AS result;
END;
