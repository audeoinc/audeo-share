/**
 * LineageEngineの結果を、BigQueryへINSERTしやすい行配列へ変換する。
 *
 * このExporterをLineageEngineから分離する理由:
 *
 * - LineageEngineは解析処理の順序制御に集中する。
 * - BigQuery固有のanalysis_idやView識別情報を解析ロジックへ混ぜない。
 * - ASTなどの可変構造をJSON文字列へ変換する処理を一か所へ集約する。
 * - 将来、Cloud Storageや別DB向けExporterを追加しやすくする。
 */
class BigQueryExporter {
  /**
   * @param {object} metadata 解析対象を識別する共通情報
   */
  constructor(metadata = {}, options = {}) {
    this.metadata = this.#normalizeMetadata(metadata);
    this.runtimeCompact = options.runtime_compact === true;
  }

  /**
   * LineageEngineのresult.tablesをBigQuery用の行へ変換する。
   *
   * @param {object} engineResult
   * @returns {object}
   */
  export(engineResult) {
    if (!engineResult || typeof engineResult !== "object") {
      throw new TypeError("BigQueryExporter.export: engineResult must be an object.");
    }

    const tables = engineResult.tables ?? {};
    const analysisRow = this.#createAnalysisRow(engineResult);

    /*
     * 参照の位置情報(行番号・行テキスト)を付与するための索引。物理カラム参照の
     * export で start_token_seq からトークンの line_no/column_no を引き、原SQLの
     * 該当1行を取り出す(利用箇所レポート t_lineage_column_usage 用)。tokens /
     * sql_text は engineResult 直下にある。
     */
    this.tokenBySeq = new Map(
      (Array.isArray(engineResult.tokens) ? engineResult.tokens : [])
        .map((token) => [token.token_seq, token])
    );
    this.sqlLines = typeof engineResult.sql_text === "string"
      ? engineResult.sql_text.split(/\r?\n/)
      : [];

    return {
      analyses: [analysisRow],
      tokens: this.runtimeCompact
        ? []
        : this.#mapRows(tables.tokens, this.#exportToken.bind(this)),
      query_scopes: this.#mapRows(
        tables.query_scopes,
        this.#exportQueryScope.bind(this)
      ),
      sources: this.#mapRows(tables.sources, this.#exportSource.bind(this)),
      cte_definitions: this.#mapRows(
        tables.cte_definitions,
        this.#exportCteDefinition.bind(this)
      ),
      column_references: this.#mapRows(
        tables.column_references,
        this.#exportColumnReference.bind(this)
      ),
      output_columns: this.#mapRows(
        tables.output_columns,
        this.#exportOutputColumn.bind(this)
      ),
      physical_column_references: this.#mapRows(
        tables.physical_column_references,
        this.#exportPhysicalColumnReference.bind(this)
      ),
      column_usages: this.#buildColumnUsages(tables.physical_column_references),
      wildcard_expansions: this.#mapRows(
        tables.wildcard_expansions,
        this.#exportWildcardExpansion.bind(this)
      ),
      output_lineages: this.#mapRows(
        tables.output_lineages,
        this.#exportOutputLineage.bind(this)
      ),
      lineage_paths: this.#mapRows(
        tables.lineage_paths,
        this.#exportLineagePath.bind(this)
      ),
      impact_paths: this.#mapRows(
        tables.impact_paths,
        this.#exportImpactPath.bind(this)
      ),
      diagnostics: this.#mapRows(
        tables.diagnostics,
        this.#exportDiagnostic.bind(this)
      )
    };
  }

  #normalizeMetadata(metadata) {
    const analysisId = metadata.analysis_id ?? metadata.analysisId;

    if (!analysisId) {
      throw new Error("BigQueryExporter: analysis_id is required.");
    }

    return {
      analysis_id: String(analysisId),
      view_project: metadata.view_project ?? null,
      view_dataset: metadata.view_dataset ?? null,
      view_name: metadata.view_name ?? null,
      analyzed_at: metadata.analyzed_at ?? new Date().toISOString()
    };
  }

  #mapRows(rows, mapper) {
    if (!Array.isArray(rows)) {
      return [];
    }

    return rows.map((row) => mapper(row));
  }

  #withMetadata(row) {
    return {
      ...this.metadata,
      ...row
    };
  }

  #toJson(value) {
    if (value === undefined || value === null) {
      return null;
    }

    return JSON.stringify(value);
  }

  /**
   * 参照の start_token_seq から、行番号・桁番号・原SQLの該当1行を返す。
   * トークンや sql_text が無い場合(未初期化・パース前)は null を返す。line_no は
   * 1始まり(sqlLines は 0始まり配列)。参照が複数行にまたがっても、要件どおり
   * 「参照トークンのある1行」だけを返す(式全体は reference_name / fragment で別途保持)。
   */
  #referenceLocation(startTokenSeq) {
    const emptyLocation = {
      line_number: null,
      column_number: null,
      line_text: null
    };

    if (startTokenSeq === null || startTokenSeq === undefined) {
      return emptyLocation;
    }

    const token = this.tokenBySeq ? this.tokenBySeq.get(startTokenSeq) : null;

    if (!token || token.line_no === null || token.line_no === undefined) {
      return emptyLocation;
    }

    const lineText = Array.isArray(this.sqlLines)
      ? (this.sqlLines[token.line_no - 1] ?? null)
      : null;

    return {
      line_number: token.line_no,
      column_number: token.column_no ?? null,
      line_text: lineText
    };
  }

  #createAnalysisRow(engineResult) {
    const errorCount = (engineResult.diagnostics ?? []).filter(
      (item) => item.severity === "ERROR"
    ).length;
    const warningCount = (engineResult.diagnostics ?? []).filter(
      (item) => item.severity === "WARNING"
    ).length;

    return this.#withMetadata({
      analysis_status: engineResult.analysis_status ?? null,
      strict_mode: Boolean(engineResult.strict_mode),
      failed_stage: engineResult.failed_stage ?? null,
      error_count: errorCount,
      warning_count: warningCount,
      sql_text: engineResult.sql_text ?? null,
      query_ast_json: this.runtimeCompact
        ? null
        : this.#toJson(engineResult.query_ast),
      error_detail_json: this.#toJson(
        (engineResult.diagnostics ?? []).find(
          (item) => item.severity === "ERROR"
        ) ?? null
      ),
      error_nodes_json: this.#toJson(engineResult.error_nodes ?? [])
    });
  }

  #exportToken(row) {
    return this.#withMetadata({
      token_seq: row.token_seq ?? null,
      line_no: row.line_no ?? null,
      column_no: row.column_no ?? null,
      token: row.token ?? null,
      normalized_token: row.normalized_token ?? null,
      token_type: row.token_type ?? null,
      paren_depth: row.paren_depth ?? null
    });
  }

  #exportQueryScope(row) {
    return this.#withMetadata({
      scope_id: row.scope_id ?? null,
      scope_type: row.scope_type ?? null,
      parent_scope_id: row.parent_scope_id ?? null,
      query_start_token_seq: row.query_start_token_seq ?? null,
      query_end_token_seq: row.query_end_token_seq ?? null
    });
  }

  #exportSource(row) {
    return this.#withMetadata({
      source_id: row.source_id ?? null,
      source_seq: row.source_seq ?? null,
      scope_id: row.scope_id ?? null,
      source_role: row.source_role ?? null,
      join_seq: row.join_seq ?? null,
      source_type: row.source_type ?? null,
      source_name: row.source_name ?? null,
      source_alias: row.source_alias ?? null,
      resolved_source_name: row.resolved_source_name ?? null,
      cte_query_scope_id: row.cte_query_scope_id ?? null,
      subquery_scope_id: row.subquery_scope_id ?? null,
      start_token_seq: row.start_token_seq ?? null,
      end_token_seq: row.end_token_seq ?? null,
      expression_json: this.runtimeCompact ? null : this.#toJson(row.expression),
      source_json: this.runtimeCompact ? null : this.#toJson(row)
    });
  }

  #exportCteDefinition(row) {
    return this.#withMetadata({
      scope_id: row.scope_id ?? null,
      cte_name: row.cte_name ?? null,
      column_names: row.column_names ?? [],
      query_scope_id: row.query_scope_id ?? null,
      start_token_seq: row.start_token_seq ?? null,
      end_token_seq: row.end_token_seq ?? null,
      cte_json: this.runtimeCompact ? null : this.#toJson(row)
    });
  }

  #exportColumnReference(row) {
    return this.#withMetadata({
      column_reference_id: row.column_reference_id ?? null,
      scope_id: row.scope_id ?? null,
      clause_type: row.clause_type ?? null,
      select_item_seq: row.select_item_seq ?? null,
      join_seq: row.join_seq ?? null,
      group_item_seq: row.group_item_seq ?? null,
      order_item_seq: row.order_item_seq ?? null,
      reference_type: row.reference_type ?? null,
      reference_name: row.reference_name ?? null,
      qualifier: row.qualifier ?? null,
      column_name: row.column_name ?? null,
      resolution_status: row.resolution_status ?? null,
      source_id: row.source_id ?? null,
      source_type: row.source_type ?? null,
      source_name: row.source_name ?? null,
      source_alias: row.source_alias ?? null,
      candidate_source_ids: row.candidate_source_ids ?? [],
      start_token_seq: row.start_token_seq ?? null,
      end_token_seq: row.end_token_seq ?? null,
      reference_json: this.runtimeCompact ? null : this.#toJson(row)
    });
  }

  #exportOutputColumn(row) {
    return this.#withMetadata({
      output_column_id: row.output_column_id ?? null,
      output_column_seq: row.output_column_seq ?? null,
      scope_id: row.scope_id ?? null,
      output_column_name: row.output_column_name ?? null,
      original_output_alias: row.original_output_alias ?? null,
      alias_type: row.alias_type ?? null,
      name_source: row.name_source ?? null,
      output_status: row.output_status ?? null,
      wildcard_type: row.wildcard_type ?? null,
      wildcard_qualifier: row.wildcard_qualifier ?? null,
      expression_text: row.expression_text ?? null,
      start_token_seq: row.start_token_seq ?? null,
      end_token_seq: row.end_token_seq ?? null,
      expression_json: this.runtimeCompact ? null : this.#toJson(row.expression),
      output_column_json: this.runtimeCompact ? null : this.#toJson(row)
    });
  }

  /**
   * 利用箇所インデックス(t_lineage_column_usage 用)を、物理カラム参照から平坦化して
   * 作る。全句(SELECT/WHERE/JOIN/GROUP BY/HAVING/QUALIFY/ORDER BY)を対象とし、物理列に
   * 解決できた参照だけを残す(派生/未解決は除外)。1参照が複数物理列に解決した場合は
   * 物理列ごとに1行。各行は解決済み source 物理列・使われ方(usage_type=clause)・
   * 行番号/桁番号/該当1行(line_text)を平坦なフィールドで持つ(03 が JSON_VALUE で直読み
   * できるよう、physical_columns_json のような入れ子 JSON にしない)。
   */
  #buildColumnUsages(physicalColumnReferences) {
    if (!Array.isArray(physicalColumnReferences)) {
      return [];
    }

    const usages = [];

    for (const reference of physicalColumnReferences) {
      const physicalColumns = Array.isArray(reference.physical_columns)
        ? reference.physical_columns
        : [];

      if (physicalColumns.length === 0) {
        continue;
      }

      const location = this.#referenceLocation(reference.start_token_seq ?? null);

      for (const physicalColumn of physicalColumns) {
        if (!physicalColumn || !physicalColumn.physical_table_name) {
          continue;
        }

        usages.push(this.#withMetadata({
          usage_type: reference.clause_type ?? null,
          reference_name: reference.reference_name ?? null,
          column_name: reference.column_name ?? null,
          physical_resolution_status:
            reference.physical_resolution_status ?? null,
          physical_table_name: physicalColumn.physical_table_name ?? null,
          physical_column_name: physicalColumn.physical_column_name ?? null,
          field_path: physicalColumn.field_path ?? null,
          scope_id: reference.scope_id ?? null,
          start_token_seq: reference.start_token_seq ?? null,
          end_token_seq: reference.end_token_seq ?? null,
          line_number: location.line_number,
          column_number: location.column_number,
          line_text: location.line_text
        }));
      }
    }

    return usages;
  }

  #exportPhysicalColumnReference(row) {
    return this.#withMetadata({
      physical_reference_id: row.physical_reference_id ?? null,
      column_reference_id: row.column_reference_id ?? null,
      scope_id: row.scope_id ?? null,
      clause_type: row.clause_type ?? null,
      select_item_seq: row.select_item_seq ?? null,
      reference_type: row.reference_type ?? null,
      reference_name: row.reference_name ?? null,
      column_name: row.column_name ?? null,
      original_resolution_status: row.original_resolution_status ?? null,
      physical_resolution_status: row.physical_resolution_status ?? null,
      source_id: row.source_id ?? null,
      source_type: row.source_type ?? null,
      source_name: row.source_name ?? null,
      source_alias: row.source_alias ?? null,
      candidate_source_ids: row.candidate_source_ids ?? [],
      start_token_seq: row.start_token_seq ?? null,
      end_token_seq: row.end_token_seq ?? null,
      physical_columns_json: this.#toJson(row.physical_columns ?? []),
      reference_json: this.runtimeCompact ? null : this.#toJson(row)
    });
  }

  #exportWildcardExpansion(row) {
    return this.#withMetadata({
      scope_id: row.scope_id ?? null,
      output_column_id: row.output_column_id ?? null,
      wildcard_type: row.wildcard_type ?? null,
      wildcard_qualifier: row.wildcard_qualifier ?? null,
      source_id: row.source_id ?? null,
      physical_table_name: row.physical_table_name ?? null,
      physical_column_name: row.physical_column_name ?? null,
      field_path: row.field_path ?? null,
      expansion_json: this.runtimeCompact ? null : this.#toJson(row)
    });
  }

  #exportOutputLineage(row) {
    return this.#withMetadata({
      lineage_id: row.lineage_id ?? null,
      output_column_id: row.output_column_id ?? null,
      output_scope_id: row.output_scope_id ?? null,
      output_column_seq: row.output_column_seq ?? null,
      output_column_name: row.output_column_name ?? null,
      expression_text: row.expression_text ?? null,
      lineage_status: row.lineage_status ?? null,
      lineage_path: row.lineage_path ?? [],
      start_token_seq: row.start_token_seq ?? null,
      end_token_seq: row.end_token_seq ?? null,
      dependencies_json: this.#toJson(row.dependencies ?? []),
      output_lineage_json: this.runtimeCompact ? null : this.#toJson(row)
    });
  }

  #exportLineagePath(row) {
    return this.#withMetadata({
      output_column_id: row.output_column_id ?? null,
      output_column_name: row.output_column_name ?? null,
      output_scope_id: row.output_scope_id ?? null,
      physical_table_name: row.physical_table_name ?? null,
      physical_column_name: row.physical_column_name ?? null,
      field_path: row.field_path ?? null,
      lineage_path: row.lineage_path ?? [],
      lineage_path_json: this.runtimeCompact ? null : this.#toJson(row)
    });
  }

  #exportImpactPath(row) {
    return this.#withMetadata({
      output_column_id: row.output_column_id ?? null,
      output_column_name: row.output_column_name ?? null,
      output_scope_id: row.output_scope_id ?? null,
      physical_table_name: row.physical_table_name ?? null,
      physical_column_name: row.physical_column_name ?? null,
      field_path: row.field_path ?? null,
      impact_path: row.impact_path ?? [],
      impact_path_json: this.runtimeCompact ? null : this.#toJson(row)
    });
  }

  #exportDiagnostic(row) {
    return this.#withMetadata({
      diagnostic_seq: row.diagnostic_seq ?? null,
      severity: row.severity ?? null,
      code: row.code ?? null,
      message: row.message ?? null,
      stage: row.stage ?? null,
      error_name: row.error_name ?? null,
      node_id: row.node_id ?? null,
      node_type: row.node_type ?? null,
      scope_id: row.scope_id ?? null,
      scope_type: row.scope_type ?? null,
      output_column_name: row.output_column_name ?? null,
      referenced_column_name: row.referenced_column_name ?? null,
      start_token_seq: row.start_token_seq ?? null,
      end_token_seq: row.end_token_seq ?? null,
      line_number: row.line_number ?? null,
      column_number: row.column_number ?? null,
      sql_fragment: row.sql_fragment ?? null,
      sql_context: row.sql_context ?? null,
      original_sql: row.original_sql ?? null,
      diagnostic_json: this.#toJson(row)
    });
  }
}
