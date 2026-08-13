SELECT
  object_project, object_dataset, object_name, object_type,
  BYTE_LENGTH(definition_text)                    AS sql_bytes,
  ARRAY_LENGTH(SPLIT(definition_text, '\n'))      AS approx_lines
FROM `project_id.lineage_repository.m_lineage_definition_registry`
WHERE is_active AND is_changed AND definition_text IS NOT NULL
  AND object_type IN ('VIEW','TABLE')
ORDER BY sql_bytes DESC
LIMIT 20;
