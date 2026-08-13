-- ============================================================================
-- 06_analyze_changed_objects.sql
-- EXECUTION ORDER: Initial setup 08 / Daily operation 03
-- ============================================================================
-- Standalone changed-object analysis.
-- Project and dataset identifiers are declared below, rendered into SQL
-- templates, and executed with EXECUTE IMMEDIATE in the same manner as 03.
-- ============================================================================
SET @@location = 'asia-northeast1';

-- ============================================================================
-- Common dynamic SQL renderer
-- ============================================================================
-- Only SQL identifiers are replaced here.
-- Runtime values continue to be passed with EXECUTE IMMEDIATE ... USING.
CREATE TEMP FUNCTION render_dynamic_sql(
  sql_template STRING,
  repository_project_id STRING,
  repository_dataset STRING,
  target_project_id STRING,
  target_dataset STRING,
  job_region STRING,
  udf_project_id STRING,
  udf_dataset STRING,
  udf_function_name STRING
)
RETURNS STRING
AS (
  REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            sql_template,
            '__REPOSITORY__',
            repository_project_id || '.' || repository_dataset
          ),
          '__TARGET__',
          target_project_id || '.' || target_dataset
        ),
        '__TARGET_PROJECT__',
        target_project_id
      ),
      '__JOB_REGION__',
      job_region
    ),
    '__UDF__',
    udf_project_id || '.' || udf_dataset || '.' || udf_function_name
  )
);

BEGIN
  -- ==========================================================================
  -- Runtime environment settings
  -- ==========================================================================
  DECLARE repository_project_id STRING DEFAULT 'project_id';
  DECLARE repository_dataset STRING DEFAULT 'lineage_repository';
  DECLARE target_project_id STRING DEFAULT 'project_id';
  DECLARE target_dataset STRING DEFAULT 'dataset';
  DECLARE job_region STRING DEFAULT 'asia-northeast1';
  DECLARE udf_project_id STRING DEFAULT 'project_id';
  DECLARE udf_dataset STRING DEFAULT 'dataset';
  DECLARE udf_function_name STRING DEFAULT 'analyze_lineage_json';
  DECLARE parser_strict_mode BOOL DEFAULT FALSE;

  DECLARE sql_template STRING;
  DECLARE rendered_sql STRING;

  -- Repository tables are resolved using the declared repository identifiers.
  SET @@dataset_project_id = repository_project_id;
  SET @@dataset_id = repository_dataset;

  ASSERT @@location = job_region
  AS '@@location and job_region must be identical.';
  ASSERT REGEXP_CONTAINS(repository_project_id, r'^[A-Za-z0-9._:-]+$')
  AS 'Invalid repository_project_id.';
  ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
  AS 'Invalid repository_dataset.';
  ASSERT REGEXP_CONTAINS(target_project_id, r'^[A-Za-z0-9._:-]+$')
  AS 'Invalid target_project_id.';
  ASSERT REGEXP_CONTAINS(target_dataset, r'^[A-Za-z0-9_]+$')
  AS 'Invalid target_dataset.';
  ASSERT REGEXP_CONTAINS(job_region, r'^[A-Za-z0-9-]+$')
  AS 'Invalid job_region.';
  ASSERT REGEXP_CONTAINS(udf_project_id, r'^[A-Za-z0-9._:-]+$')
  AS 'Invalid udf_project_id.';
  ASSERT REGEXP_CONTAINS(udf_dataset, r'^[A-Za-z0-9_]+$')
  AS 'Invalid udf_dataset.';
  ASSERT REGEXP_CONTAINS(udf_function_name, r'^[A-Za-z0-9_]+$')
  AS 'Invalid udf_function_name.';

  -- Materialize target metadata through placeholder-rendered dynamic SQL.
  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE current_target_tables AS
    SELECT
      LOWER(table_catalog) AS table_catalog,
      LOWER(table_schema) AS table_schema,
      LOWER(table_name) AS table_name,
      table_type
    FROM `__TARGET_PROJECT__.region-__JOB_REGION__`.INFORMATION_SCHEMA.TABLES
    WHERE LOWER(table_schema) = LOWER(@target_dataset)
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    target_dataset,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in current_target_tables SQL.';

  EXECUTE IMMEDIATE rendered_sql
  USING target_dataset AS target_dataset;

  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE current_target_columns AS
    SELECT *
    FROM `__TARGET__.INFORMATION_SCHEMA.COLUMNS`
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    target_dataset,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in current_target_columns SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE current_target_column_field_paths AS
    SELECT *
    FROM `__TARGET__.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS`
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    target_dataset,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in current_target_column_field_paths SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  BEGIN
    -- ============================================================================
    -- 06_analyze_changed_objects.sql
    -- EXECUTION ORDER: Initial setup 08 / Daily operation 03
    -- ============================================================================
    -- ============================================================================
    -- Changed definitions -> persistent lineage UDF -> direct dependency repository
    --
    -- Design principles:
    --   - No explicit transaction.
    --   - Re-runnable and idempotent.
    --   - Existing dependencies are not touched until UDF parsing and staging finish.
    --   - Dependency replacement uses DELETE + INSERT.
    --   - If replacement DML fails inside the object block, the previous dependency
    --     rows are restored from temporary backup tables.
    --   - is_changed becomes FALSE only after dependency and diagnostic persistence
    --     both finish successfully.
    --
    -- Environment-dependent scalar values are declared at the top of this file.
    -- (This maintenance script re-analyzes already-registered objects and does
    -- not collect from INFORMATION_SCHEMA.JOBS, so no execution service accounts
    -- are needed here.)
    -- ============================================================================

    DECLARE run_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
    DECLARE strict_mode BOOL DEFAULT parser_strict_mode;
    DECLARE source_discovery_json STRING;
    DECLARE source_discovery_status STRING;
    DECLARE physical_columns_json STRING;
    DECLARE physical_metadata_json_bytes INT64;
    DECLARE analyzed_object_count INT64 DEFAULT 0;
    DECLARE failed_object_count INT64 DEFAULT 0;

    -- --------------------------------------------------------------------------
    -- Remove repository rows whose target definition is no longer active.
    -- --------------------------------------------------------------------------
    DELETE FROM
      `lineage_direct_dependency` AS dependency
    WHERE NOT EXISTS (
      SELECT 1
      FROM
        `lineage_definition_registry` AS registry
      WHERE registry.is_active = TRUE
        AND LOWER(registry.object_project) = LOWER(dependency.target_project)
        AND LOWER(registry.object_dataset) = LOWER(dependency.target_dataset)
        AND LOWER(registry.object_name) = LOWER(dependency.target_object)
        AND registry.object_type = dependency.target_object_type
        AND registry.generation_type = dependency.generation_type
    );

    DELETE FROM
      `lineage_diagnostic` AS diagnostic
    WHERE NOT EXISTS (
      SELECT 1
      FROM
        `lineage_definition_registry` AS registry
      WHERE registry.is_active = TRUE
        AND LOWER(registry.object_project) = LOWER(diagnostic.object_project)
        AND LOWER(registry.object_dataset) = LOWER(diagnostic.object_dataset)
        AND LOWER(registry.object_name) = LOWER(diagnostic.object_name)
        AND registry.object_type = diagnostic.object_type
    );

    -- --------------------------------------------------------------------------
    -- Analyze active definitions whose current definition has changed.
    -- --------------------------------------------------------------------------
    FOR target IN (
      SELECT
        object_project,
        object_dataset,
        object_name,
        object_type,
        generation_type,
        definition_text,
        definition_hash
      FROM
        `lineage_definition_registry`
      WHERE is_active = TRUE
        AND is_changed = TRUE
        AND definition_text IS NOT NULL
        AND object_type IN ('VIEW', 'TABLE')
      ORDER BY
        object_project,
        object_dataset,
        object_name,
        generation_type
    )
    DO
      BEGIN
        -- Variables declared in this outer block remain visible to the inner
        -- EXCEPTION handler. BigQuery does not expose variables declared in the
        -- same BEGIN block to that block's EXCEPTION section.
        DECLARE analysis_id STRING DEFAULT GENERATE_UUID();
        DECLARE analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
        DECLARE exported_json STRING;
        DECLARE udf_analysis_status STRING;
        DECLARE replacement_started BOOL DEFAULT FALSE;

        BEGIN
          -- Phase 1: discover physical Source names before building metadata.
          SET sql_template = """
            SELECT `__UDF__`(
              @definition_text,
              '[]',
              @options_json,
              NULL
            )
          """;

          SET rendered_sql = render_dynamic_sql(
            sql_template,
            repository_project_id,
            repository_dataset,
            target_project_id,
            target_dataset,
            job_region,
            udf_project_id,
            udf_dataset,
            udf_function_name
          );

          ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
          AS 'Unresolved placeholder in source discovery UDF SQL.';

          EXECUTE IMMEDIATE rendered_sql
          INTO source_discovery_json
          USING
            target.definition_text AS definition_text,
            TO_JSON_STRING(STRUCT(TRUE AS source_discovery_only)) AS options_json;

          SET source_discovery_status = COALESCE(
            JSON_VALUE(source_discovery_json, '$.analysis.analysis_status'),
            'UNKNOWN'
          );

          ASSERT source_discovery_status = 'COMPLETED'
          AS FORMAT(
            'Source discovery did not complete for %s.%s.%s: %s',
            target.object_project,
            target.object_dataset,
            target.object_name,
            COALESCE(JSON_VALUE(source_discovery_json, '$.error.message'), source_discovery_status)
          );

          -- Phase 2: preserve the resolver's 3-part, 2-part, and 1-part
          -- lookup behavior while limiting Metadata to discovered candidates.
          CREATE OR REPLACE TEMP TABLE discovered_metadata_tables AS
          WITH discovered_sources AS (
            SELECT DISTINCT LOWER(JSON_VALUE(source_row, '$')) AS source_name
            FROM UNNEST(
              COALESCE(
                JSON_QUERY_ARRAY(source_discovery_json, '$.source_tables'),
                CAST([] AS ARRAY<STRING>)
              )
            ) AS source_row
            WHERE JSON_VALUE(source_row, '$') IS NOT NULL
          )
          SELECT DISTINCT
            metadata.table_catalog,
            metadata.table_schema,
            metadata.table_name
          FROM current_target_columns AS metadata
          INNER JOIN discovered_sources AS source
            ON source.source_name = LOWER(FORMAT(
              '%s.%s.%s', metadata.table_catalog, metadata.table_schema, metadata.table_name
            ))
            OR source.source_name = LOWER(FORMAT(
              '%s.%s', metadata.table_schema, metadata.table_name
            ))
            OR source.source_name = LOWER(metadata.table_name);

          CREATE OR REPLACE TEMP TABLE scoped_physical_columns AS
          WITH top_level_columns AS (
            SELECT
              column_info.table_catalog AS table_project,
              column_info.table_schema AS table_dataset,
              column_info.table_name,
              column_info.column_name,
              column_info.column_name AS field_path,
              column_info.ordinal_position,
              column_info.data_type,
              column_info.is_nullable
            FROM current_target_columns AS column_info
            INNER JOIN discovered_metadata_tables AS discovered
              ON discovered.table_catalog = column_info.table_catalog
             AND discovered.table_schema = column_info.table_schema
             AND discovered.table_name = column_info.table_name
          ),
          nested_field_paths AS (
            SELECT
              field.table_catalog AS table_project,
              field.table_schema AS table_dataset,
              field.table_name,
              field.column_name,
              field.field_path,
              column_info.ordinal_position,
              field.data_type,
              CAST(NULL AS STRING) AS is_nullable
            FROM current_target_column_field_paths AS field
            INNER JOIN discovered_metadata_tables AS discovered
              ON discovered.table_catalog = field.table_catalog
             AND discovered.table_schema = field.table_schema
             AND discovered.table_name = field.table_name
            LEFT JOIN current_target_columns AS column_info
              ON column_info.table_catalog = field.table_catalog
             AND column_info.table_schema = field.table_schema
             AND column_info.table_name = field.table_name
             AND column_info.column_name = field.column_name
            WHERE field.field_path IS NOT NULL
              AND field.field_path != field.column_name
              AND STRPOS(field.field_path, '.') > 0
          )
          SELECT * FROM top_level_columns
          UNION ALL
          SELECT * FROM nested_field_paths;

          SET physical_metadata_json_bytes = (
            SELECT COALESCE(SUM(BYTE_LENGTH(TO_JSON_STRING(STRUCT(
              LOWER(FORMAT('%s.%s.%s', table_project, table_dataset, table_name)) AS table_name,
              LOWER(column_name) AS column_name,
              LOWER(field_path) AS field_path,
              ordinal_position AS ordinal_position,
              data_type AS data_type,
              is_nullable AS is_nullable
            ))) + 1), 2)
            FROM scoped_physical_columns
          );

          ASSERT physical_metadata_json_bytes < 900000
          AS FORMAT(
            'Scoped physical-column metadata is too large for one UDF call (%d bytes).',
            physical_metadata_json_bytes
          );

          SET physical_columns_json = (
            SELECT COALESCE(
              TO_JSON_STRING(ARRAY_AGG(
                STRUCT(
                  LOWER(FORMAT('%s.%s.%s', table_project, table_dataset, table_name)) AS table_name,
                  LOWER(column_name) AS column_name,
                  LOWER(field_path) AS field_path,
                  ordinal_position AS ordinal_position,
                  data_type AS data_type,
                  is_nullable AS is_nullable
                )
                ORDER BY table_project, table_dataset, table_name, ordinal_position, field_path
              )),
              '[]'
            )
            FROM scoped_physical_columns
          );

          -- Phase 3: execute the normal parser and resolver with scoped metadata.
          SET sql_template = """
          SELECT `__UDF__`(
            @definition_text,
            @physical_columns_json,
            @options_json,
            @context_json
          )
        """;

        SET rendered_sql = render_dynamic_sql(
          sql_template,
          repository_project_id,
          repository_dataset,
          target_project_id,
          target_dataset,
          job_region,
          udf_project_id,
          udf_dataset,
          udf_function_name
        );

        ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
        AS 'Unresolved placeholder in lineage UDF SQL.';

        EXECUTE IMMEDIATE rendered_sql
        INTO exported_json
        USING
          target.definition_text AS definition_text,
          physical_columns_json AS physical_columns_json,
          TO_JSON_STRING(STRUCT(
            strict_mode AS strict_mode,
            TRUE AS compact_export
          )) AS options_json,
          TO_JSON_STRING(STRUCT(
            analysis_id AS analysis_id,
            target.object_project AS view_project,
            target.object_dataset AS view_dataset,
            target.object_name AS view_name,
            FORMAT_TIMESTAMP(
              '%FT%H:%M:%E*S%Ez',
              analyzed_at
            ) AS analyzed_at
          )) AS context_json;

        SET udf_analysis_status = COALESCE(
          JSON_VALUE(exported_json, '$.analysis.analysis_status'),
          'UNKNOWN'
        );

        -- ----------------------------------------------------------------------
        -- Always stage UDF diagnostics before deciding whether the result can be
        -- published. This preserves the original parser/resolver diagnostics for
        -- PARTIAL_FAILURE and other non-publishable statuses.
        -- ----------------------------------------------------------------------
        CREATE OR REPLACE TEMP TABLE staged_lineage_diagnostic AS
        SELECT
          target.definition_hash AS definition_hash,
          LOWER(target.object_project) AS object_project,
          LOWER(target.object_dataset) AS object_dataset,
          LOWER(target.object_name) AS object_name,
          target.object_type AS object_type,
          COALESCE(JSON_VALUE(diagnostic_row, '$.code'), 'UNKNOWN')
            AS diagnostic_code,
          JSON_VALUE(diagnostic_row, '$.stage') AS engine_stage,
          COALESCE(JSON_VALUE(diagnostic_row, '$.severity'), 'INFO')
            AS severity,
          CAST(NULL AS STRING) AS output_column,
          CAST(NULL AS STRING) AS expression,
          JSON_VALUE(diagnostic_row, '$.message') AS message,
          SAFE.PARSE_JSON(
            JSON_VALUE(diagnostic_row, '$.diagnostic_json')
          ) AS diagnostic_json,
          analyzed_at AS analyzed_at
        FROM UNNEST(
          COALESCE(
            JSON_QUERY_ARRAY(
              exported_json,
              '$.exported_tables.diagnostics'
            ),
            CAST([] AS ARRAY<STRING>)
          )
        ) AS diagnostic_row;

        IF udf_analysis_status = 'COMPLETED' THEN
          CREATE OR REPLACE TEMP TABLE staged_direct_dependency AS
        WITH lineage_path_rows AS (
          SELECT
            SAFE_CAST(JSON_VALUE(path_row, '$.output_column_id') AS INT64)
              AS output_column_id,
            SAFE_CAST(JSON_VALUE(path_row, '$.output_scope_id') AS INT64)
              AS output_scope_id,
            JSON_VALUE(path_row, '$.output_column_name') AS output_column_name,
            JSON_VALUE(path_row, '$.physical_table_name') AS physical_table_name,
            JSON_VALUE(path_row, '$.physical_column_name') AS physical_column_name,
            JSON_VALUE(path_row, '$.field_path') AS field_path
          FROM UNNEST(
            JSON_QUERY_ARRAY(
              exported_json,
              '$.exported_tables.lineage_paths'
            )
          ) AS path_row
        ),
        output_lineage_rows AS (
          SELECT
            SAFE_CAST(JSON_VALUE(output_row, '$.output_column_id') AS INT64)
              AS output_column_id,
            SAFE_CAST(JSON_VALUE(output_row, '$.output_scope_id') AS INT64)
              AS output_scope_id,
            JSON_VALUE(output_row, '$.expression_text') AS expression_text,
            JSON_VALUE(output_row, '$.lineage_status') AS lineage_status
          FROM UNNEST(
            JSON_QUERY_ARRAY(
              exported_json,
              '$.exported_tables.output_lineages'
            )
          ) AS output_row
        ),
        parsed_edges AS (
          SELECT
            target.definition_hash AS definition_hash,
            LOWER(
              CASE ARRAY_LENGTH(SPLIT(path.physical_table_name, '.'))
                WHEN 3 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(0)]
                ELSE target.object_project
              END
            ) AS source_project,
            LOWER(
              CASE ARRAY_LENGTH(SPLIT(path.physical_table_name, '.'))
                WHEN 3 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(1)]
                WHEN 2 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(0)]
                ELSE target.object_dataset
              END
            ) AS source_dataset,
            LOWER(
              CASE ARRAY_LENGTH(SPLIT(path.physical_table_name, '.'))
                WHEN 3 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(2)]
                WHEN 2 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(1)]
                ELSE SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(0)]
              END
            ) AS source_object,
            LOWER(
              COALESCE(path.field_path, path.physical_column_name)
            ) AS source_column,
            LOWER(target.object_project) AS target_project,
            LOWER(target.object_dataset) AS target_dataset,
            LOWER(target.object_name) AS target_object,
            target.object_type AS target_object_type,
            LOWER(path.output_column_name) AS target_column,
            target.generation_type AS generation_type,
            'COLUMN' AS dependency_type,
            output.expression_text AS expression,
            'SELECT' AS usage_type,
            COALESCE(output.lineage_status, 'RESOLVED')
              AS resolution_status,
            CAST(NULL AS STRING) AS resolution_reason,
            analyzed_at AS analyzed_at
          FROM lineage_path_rows AS path
          LEFT JOIN output_lineage_rows AS output
            ON output.output_column_id = path.output_column_id
           AND output.output_scope_id = path.output_scope_id
          WHERE path.physical_table_name IS NOT NULL
            AND path.output_column_name IS NOT NULL
        ),
        normalized_edges AS (
          SELECT
            parsed.* EXCEPT(target_object_type),
            CASE
              WHEN source_registry.object_type = 'VIEW' THEN 'VIEW'
              WHEN source_table.table_type = 'VIEW' THEN 'VIEW'
              ELSE 'TABLE'
            END AS source_object_type,
            parsed.target_object_type
          FROM parsed_edges AS parsed
          LEFT JOIN
            `lineage_definition_registry`
              AS source_registry
            ON source_registry.is_active = TRUE
           AND LOWER(source_registry.object_project) = parsed.source_project
           AND LOWER(source_registry.object_dataset) = parsed.source_dataset
           AND LOWER(source_registry.object_name) = parsed.source_object
           AND source_registry.object_type = 'VIEW'
          LEFT JOIN
            current_target_tables AS source_table
            ON LOWER(source_table.table_catalog) = parsed.source_project
           AND LOWER(source_table.table_schema) = parsed.source_dataset
           AND LOWER(source_table.table_name) = parsed.source_object
          QUALIFY ROW_NUMBER() OVER (
            PARTITION BY
              parsed.definition_hash,
              parsed.source_project,
              parsed.source_dataset,
              parsed.source_object,
              parsed.source_column,
              parsed.target_project,
              parsed.target_dataset,
              parsed.target_object,
              parsed.target_column,
              parsed.generation_type
            ORDER BY
              source_registry.updated_at DESC NULLS LAST
          ) = 1
        )
        SELECT DISTINCT
          definition_hash,
          source_project,
          source_dataset,
          source_object,
          source_object_type,
          source_column,
          target_project,
          target_dataset,
          target_object,
          target_object_type,
          target_column,
          generation_type,
          dependency_type,
          expression,
          usage_type,
          resolution_status,
          resolution_reason,
          TO_HEX(SHA256(CONCAT(
            COALESCE(source_project, ''), '|',
            COALESCE(source_dataset, ''), '|',
            COALESCE(source_object, ''), '|',
            COALESCE(source_column, '*'), '|',
            COALESCE(target_project, ''), '|',
            COALESCE(target_dataset, ''), '|',
            COALESCE(target_object, ''), '|',
            COALESCE(target_column, '*'), '|',
            generation_type
          ))) AS edge_key,
          analyzed_at
        FROM normalized_edges;


        CREATE OR REPLACE TEMP TABLE previous_direct_dependency AS
        SELECT *
        FROM
          `lineage_direct_dependency`
        WHERE LOWER(target_project) = LOWER(target.object_project)
          AND LOWER(target_dataset) = LOWER(target.object_dataset)
          AND LOWER(target_object) = LOWER(target.object_name)
          AND target_object_type = target.object_type
          AND generation_type = target.generation_type;

        CREATE OR REPLACE TEMP TABLE previous_lineage_diagnostic AS
        SELECT *
        FROM
          `lineage_diagnostic`
        WHERE LOWER(object_project) = LOWER(target.object_project)
          AND LOWER(object_dataset) = LOWER(target.object_dataset)
          AND LOWER(object_name) = LOWER(target.object_name)
          AND object_type = target.object_type;

        SET replacement_started = TRUE;

        DELETE FROM
          `lineage_direct_dependency`
        WHERE LOWER(target_project) = LOWER(target.object_project)
          AND LOWER(target_dataset) = LOWER(target.object_dataset)
          AND LOWER(target_object) = LOWER(target.object_name)
          AND target_object_type = target.object_type
          AND generation_type = target.generation_type;

        INSERT INTO
          `lineage_direct_dependency`
        SELECT *
        FROM staged_direct_dependency;

        DELETE FROM
          `lineage_diagnostic`
        WHERE LOWER(object_project) = LOWER(target.object_project)
          AND LOWER(object_dataset) = LOWER(target.object_dataset)
          AND LOWER(object_name) = LOWER(target.object_name)
          AND object_type = target.object_type;

        INSERT INTO
          `lineage_diagnostic`
        SELECT *
        FROM staged_lineage_diagnostic;

        UPDATE
          `lineage_definition_registry`
        SET
          is_changed = FALSE,
          analysis_status = udf_analysis_status,
          last_analyzed_hash = definition_hash,
          last_analyzed_at = analyzed_at,
          updated_at = analyzed_at
        WHERE LOWER(object_project) = LOWER(target.object_project)
          AND LOWER(object_dataset) = LOWER(target.object_dataset)
          AND LOWER(object_name) = LOWER(target.object_name)
          AND object_type = target.object_type
          AND generation_type = target.generation_type
          AND definition_hash = target.definition_hash;

          SET analyzed_object_count = analyzed_object_count + 1;
        ELSE
          -- Do not replace the last known-good dependency rows when the UDF
          -- reports PARTIAL_FAILURE or another non-publishable status.
          -- Replace only the diagnostics so the actual parser/resolver reason is
          -- available in lineage_diagnostic for troubleshooting.
          DELETE FROM
            `lineage_diagnostic`
          WHERE LOWER(object_project) = LOWER(target.object_project)
            AND LOWER(object_dataset) = LOWER(target.object_dataset)
            AND LOWER(object_name) = LOWER(target.object_name)
            AND object_type = target.object_type;

          INSERT INTO
            `lineage_diagnostic`
          SELECT *
          FROM staged_lineage_diagnostic;

          INSERT INTO
            `lineage_diagnostic`
          (
            definition_hash,
            object_project,
            object_dataset,
            object_name,
            object_type,
            diagnostic_code,
            engine_stage,
            severity,
            output_column,
            expression,
            message,
            diagnostic_json,
            analyzed_at
          )
          VALUES (
            target.definition_hash,
            LOWER(target.object_project),
            LOWER(target.object_dataset),
            LOWER(target.object_name),
            target.object_type,
            'UDF_RESULT_NOT_PUBLISHABLE',
            '06_analyze_changed_objects',
            'ERROR',
            NULL,
            NULL,
            FORMAT(
              'Lineage UDF returned a non-publishable status: %s',
              udf_analysis_status
            ),
            JSON_OBJECT(
              'udf_analysis_status', udf_analysis_status,
              'analysis_message', JSON_VALUE(
                exported_json,
                '$.analysis.message'
              )
            ),
            analyzed_at
          );

          UPDATE
            `lineage_definition_registry`
          SET
            is_changed = TRUE,
            analysis_status = 'FAILED',
            last_analyzed_at = analyzed_at,
            updated_at = analyzed_at
          WHERE LOWER(object_project) = LOWER(target.object_project)
            AND LOWER(object_dataset) = LOWER(target.object_dataset)
            AND LOWER(object_name) = LOWER(target.object_name)
            AND object_type = target.object_type
            AND generation_type = target.generation_type
            AND definition_hash = target.definition_hash;

          -- Keep every non-COMPLETED UDF result for the final result set.
          -- When the UDF returned no diagnostic row, insert a summary-only row so
          -- the status and complete JSON result are still visible.
          INSERT INTO non_completed_udf_results
          SELECT
            LOWER(target.object_project),
            LOWER(target.object_dataset),
            LOWER(target.object_name),
            target.object_type,
            udf_analysis_status,
            ARRAY_LENGTH(COALESCE(
              JSON_QUERY_ARRAY(exported_json, '$.exported_tables.diagnostics'),
              CAST([] AS ARRAY<STRING>)
            )),
            ARRAY_LENGTH(COALESCE(
              JSON_QUERY_ARRAY(exported_json, '$.exported_tables.output_lineages'),
              CAST([] AS ARRAY<STRING>)
            )),
            ARRAY_LENGTH(COALESCE(
              JSON_QUERY_ARRAY(exported_json, '$.exported_tables.lineage_paths'),
              CAST([] AS ARRAY<STRING>)
            )),
            diagnostic_code,
            engine_stage,
            severity,
            message,
            diagnostic_json,
            SAFE.PARSE_JSON(JSON_VALUE(
              exported_json,
              '$.analysis.error_nodes_json'
            )),
            exported_json
          FROM staged_lineage_diagnostic;

          IF (SELECT COUNT(*) FROM staged_lineage_diagnostic) = 0 THEN
            INSERT INTO non_completed_udf_results VALUES (
              LOWER(target.object_project),
              LOWER(target.object_dataset),
              LOWER(target.object_name),
              target.object_type,
              udf_analysis_status,
              0,
              ARRAY_LENGTH(COALESCE(
                JSON_QUERY_ARRAY(exported_json, '$.exported_tables.output_lineages'),
                CAST([] AS ARRAY<STRING>)
              )),
              ARRAY_LENGTH(COALESCE(
                JSON_QUERY_ARRAY(exported_json, '$.exported_tables.lineage_paths'),
                CAST([] AS ARRAY<STRING>)
              )),
              NULL,
              NULL,
              NULL,
              JSON_VALUE(exported_json, '$.analysis.message'),
              NULL,
              SAFE.PARSE_JSON(JSON_VALUE(
                exported_json,
                '$.analysis.error_nodes_json'
              )),
              exported_json
            );
          END IF;

          SET failed_object_count = failed_object_count + 1;
        END IF;

        EXCEPTION WHEN ERROR THEN
          IF replacement_started THEN
          DELETE FROM
            `lineage_direct_dependency`
          WHERE LOWER(target_project) = LOWER(target.object_project)
            AND LOWER(target_dataset) = LOWER(target.object_dataset)
            AND LOWER(target_object) = LOWER(target.object_name)
            AND target_object_type = target.object_type
            AND generation_type = target.generation_type;

          INSERT INTO
            `lineage_direct_dependency`
          SELECT *
          FROM previous_direct_dependency;

          DELETE FROM
            `lineage_diagnostic`
          WHERE LOWER(object_project) = LOWER(target.object_project)
            AND LOWER(object_dataset) = LOWER(target.object_dataset)
            AND LOWER(object_name) = LOWER(target.object_name)
            AND object_type = target.object_type;

          INSERT INTO
            `lineage_diagnostic`
          SELECT *
          FROM previous_lineage_diagnostic;
        END IF;

        UPDATE
          `lineage_definition_registry`
        SET
          is_changed = TRUE,
          analysis_status = 'FAILED',
          updated_at = CURRENT_TIMESTAMP()
        WHERE LOWER(object_project) = LOWER(target.object_project)
          AND LOWER(object_dataset) = LOWER(target.object_dataset)
          AND LOWER(object_name) = LOWER(target.object_name)
          AND object_type = target.object_type
          AND generation_type = target.generation_type
          AND definition_hash = target.definition_hash;

        INSERT INTO
          `lineage_diagnostic`
        (
          definition_hash,
          object_project,
          object_dataset,
          object_name,
          object_type,
          diagnostic_code,
          engine_stage,
          severity,
          output_column,
          expression,
          message,
          diagnostic_json,
          analyzed_at
        )
        VALUES (
          target.definition_hash,
          LOWER(target.object_project),
          LOWER(target.object_dataset),
          LOWER(target.object_name),
          target.object_type,
          'ANALYSIS_EXECUTION_FAILED',
          '06_analyze_changed_objects',
          'ERROR',
          NULL,
          NULL,
          @@error.message,
          JSON_OBJECT(
            'statement_text', @@error.statement_text,
            'formatted_stack_trace', @@error.formatted_stack_trace
          ),
          CURRENT_TIMESTAMP()
        );

        INSERT INTO non_completed_udf_results VALUES (
          LOWER(target.object_project),
          LOWER(target.object_dataset),
          LOWER(target.object_name),
          target.object_type,
          'EXECUTION_FAILED',
          1,
          NULL,
          NULL,
          'ANALYSIS_EXECUTION_FAILED',
          '06_analyze_changed_objects',
          'ERROR',
          @@error.message,
          JSON_OBJECT(
            'statement_text', @@error.statement_text,
            'formatted_stack_trace', @@error.formatted_stack_trace
          ),
          JSON_ARRAY(JSON_OBJECT(
            'severity', 'ERROR',
            'diagnostic_code', 'ANALYSIS_EXECUTION_FAILED',
            'message', @@error.message,
            'original_sql', target.definition_text
          )),
          exported_json
        );

          SET failed_object_count = failed_object_count + 1;
        END;
      END;
    END FOR;

    -- --------------------------------------------------------------------------
    -- Run summary.
    -- 04_rebuild_impact_table.sql is executed after this script in daily operation.
    -- --------------------------------------------------------------------------
    SELECT
      run_started_at,
      CURRENT_TIMESTAMP() AS run_finished_at,
      analyzed_object_count,
      failed_object_count,
      (
        SELECT COUNT(*)
        FROM
          `lineage_definition_registry`
        WHERE is_active = TRUE
          AND is_changed = TRUE
      ) AS remaining_changed_object_count,
      (
        SELECT COUNT(*)
        FROM
          `lineage_direct_dependency`
      ) AS direct_dependency_count,
      (
        SELECT COUNT(*)
        FROM
          `lineage_diagnostic`
        WHERE severity = 'ERROR'
      ) AS error_diagnostic_count;
  END;
END;
