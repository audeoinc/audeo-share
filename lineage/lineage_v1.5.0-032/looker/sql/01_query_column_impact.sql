-- =============================================================================
-- Root TABLE column downstream impact report
-- =============================================================================
-- Purpose:
--   Returns VIEW columns affected by a specified Root TABLE column.
--
-- Added report fields:
--   impact_type
--     VALUE_DEPENDENCY : the source column participates in output value creation.
--     ROW_DEPENDENCY   : the source column affects row selection, joining,
--                        grouping, ordering, or window behavior.
--     UNKNOWN          : usage_type is not currently classifiable.
--
--   dependency_usage_type
--     The usage_type stored on the final direct dependency edge.
--
--   dependency_path_display
--     Human-readable downstream path joined with an arrow.
--
-- Current limitation:
--   The current repository publishing process mainly records usage_type = SELECT.
--   Therefore GROUP_BY, JOIN, WHERE, and other clause-specific classifications
--   will become more precise after clause usage is exported by the parser.
-- =============================================================================

WITH impact_with_final_edge AS (
  SELECT
    impact.snapshot_at,
    impact.origin_project,
    impact.origin_dataset,
    impact.origin_object,
    impact.origin_object_type,
    impact.origin_column,
    impact.impact_rank,
    impact.impacted_project,
    impact.impacted_dataset,
    impact.impacted_object,
    impact.impacted_object_type,
    impact.impacted_column,
    impact.direct_source_project,
    impact.direct_source_dataset,
    impact.direct_source_object,
    impact.direct_source_object_type,
    impact.direct_source_column,
    impact.dependency_path,
    impact.path_hash,
    impact.generation_type,
    impact.resolution_status,
    impact.is_cycle,
    direct_dependency.dependency_type,
    COALESCE(direct_dependency.usage_type, 'UNKNOWN')
      AS dependency_usage_type,
    direct_dependency.expression AS impacted_expression
  FROM
    `project_id.lineage_repository.lineage_impact` AS impact
  LEFT JOIN
    `project_id.lineage_repository.lineage_direct_dependency`
      AS direct_dependency
  ON
    impact.direct_source_project = direct_dependency.source_project
    AND impact.direct_source_dataset = direct_dependency.source_dataset
    AND impact.direct_source_object = direct_dependency.source_object
    AND COALESCE(impact.direct_source_column, '')
      = COALESCE(direct_dependency.source_column, '')
    AND impact.impacted_project = direct_dependency.target_project
    AND impact.impacted_dataset = direct_dependency.target_dataset
    AND impact.impacted_object = direct_dependency.target_object
    AND COALESCE(impact.impacted_column, '')
      = COALESCE(direct_dependency.target_column, '')
)

SELECT DISTINCT
  CONCAT(
    origin_project,
    '.',
    origin_dataset,
    '.',
    origin_object
  ) AS root_table_path,
  origin_column AS root_column_name,

  CONCAT(
    impacted_project,
    '.',
    impacted_dataset,
    '.',
    impacted_object
  ) AS impacted_view_path,
  impacted_column AS impacted_column_name,
  impact_rank,

  CASE
    WHEN dependency_usage_type IN (
      'WHERE',
      'JOIN',
      'JOIN_ON',
      'GROUP_BY',
      'HAVING',
      'QUALIFY',
      'ORDER_BY',
      'WINDOW_PARTITION',
      'WINDOW_ORDER'
    ) THEN 'ROW_DEPENDENCY'
    WHEN dependency_usage_type IN (
      'SELECT',
      'EXPRESSION',
      'UNNEST'
    ) THEN 'VALUE_DEPENDENCY'
    ELSE 'UNKNOWN'
  END AS impact_type,

  dependency_usage_type,
  ARRAY_TO_STRING(dependency_path, ' → ')
    AS dependency_path_display,

  dependency_path,
  impacted_expression,
  generation_type,
  resolution_status,
  is_cycle,
  snapshot_at

FROM
  impact_with_final_edge

WHERE
  -- Sample Root TABLE
  origin_project = 'project_id'
  AND origin_dataset = 'dataset'
  AND origin_object = 'customers'

  -- Sample Root column
  AND origin_column = 'customer_id'

  -- Report only impacted VIEWs
  AND impacted_object_type = 'VIEW'

ORDER BY
  impact_rank,
  impacted_view_path,
  impacted_column_name;
