"use strict";

/**
 * AUTO-GENERATED FILE.
 * scripts/build_udf.jsから生成されるため、直接編集しない。
 */

// ============================================================
// SOURCE: src/ast_factory.js
// ============================================================
/**
 * AST Nodeの種類を一元管理する定数オブジェクト。
 *
 * JavaScriptでは存在しないプロパティ参照はundefinedになるため、
 * AstFactoryはNode生成時にnode_typeを必ず検証する。
 */
const NodeType = Object.freeze({
  ARITHMETIC_EXPRESSION: "ARITHMETIC_EXPRESSION",
  LOGICAL_EXPRESSION: "LOGICAL_EXPRESSION",
  COMPARISON_EXPRESSION: "COMPARISON_EXPRESSION",
  CONCATENATION_EXPRESSION: "CONCATENATION_EXPRESSION",
  UNARY_EXPRESSION: "UNARY_EXPRESSION",
  BETWEEN_EXPRESSION: "BETWEEN_EXPRESSION",
  IN_EXPRESSION: "IN_EXPRESSION",
  IS_EXPRESSION: "IS_EXPRESSION",
  DISTINCT_FROM_EXPRESSION: "DISTINCT_FROM_EXPRESSION",
  IDENTIFIER_EXPRESSION: "IDENTIFIER_EXPRESSION",
  WILDCARD_EXPRESSION: "WILDCARD_EXPRESSION",
  LITERAL_EXPRESSION: "LITERAL_EXPRESSION",
  FUNCTION_CALL_EXPRESSION: "FUNCTION_CALL_EXPRESSION",
  PARENTHESIZED_EXPRESSION: "PARENTHESIZED_EXPRESSION",
  EXPRESSION_LIST: "EXPRESSION_LIST",
  SUBQUERY_EXPRESSION: "SUBQUERY_EXPRESSION",
  ARRAY_SUBQUERY_EXPRESSION: "ARRAY_SUBQUERY_EXPRESSION",
  RAW_EXPRESSION: "RAW_EXPRESSION",
  CASE_EXPRESSION: "CASE_EXPRESSION",
  CASE_WHEN_CLAUSE: "CASE_WHEN_CLAUSE",
  EXISTS_EXPRESSION: "EXISTS_EXPRESSION",
  WINDOW_EXPRESSION: "WINDOW_EXPRESSION",
  WINDOW_SPECIFICATION: "WINDOW_SPECIFICATION",
  WINDOW_ORDER_ITEM: "WINDOW_ORDER_ITEM"
});

/**
 * AST Node生成と入力検証だけを担当するFactory。
 *
 * ParserからNode生成を分離する理由:
 * - ParserはSQL文法を読む処理へ集中できる。
 * - AST形式を変更するときの修正箇所を集約できる。
 * - 壊れたNodeを生成時点で検出できる。
 */
class AstFactory {
  static createBinary(nodeType, operator, leftNode, rightNode) {
    AstFactory.#validateNodeType(nodeType);
    AstFactory.#validateAstNode(leftNode, "leftNode");
    AstFactory.#validateAstNode(rightNode, "rightNode");

    return AstFactory.#createNode(nodeType, leftNode.start_token_seq, rightNode.end_token_seq, {
      operator,
      left: leftNode,
      right: rightNode
    });
  }

  static createUnary(operator, operatorTokenSeq, operandNode) {
    AstFactory.#validateAstNode(operandNode, "operandNode");

    return AstFactory.#createNode(
      NodeType.UNARY_EXPRESSION,
      operatorTokenSeq,
      operandNode.end_token_seq,
      { operator, operand: operandNode }
    );
  }

  static createBetween(expressionNode, lowerNode, upperNode, negated) {
    AstFactory.#validateAstNode(expressionNode, "expressionNode");
    AstFactory.#validateAstNode(lowerNode, "lowerNode");
    AstFactory.#validateAstNode(upperNode, "upperNode");

    return AstFactory.#createNode(
      NodeType.BETWEEN_EXPRESSION,
      expressionNode.start_token_seq,
      upperNode.end_token_seq,
      {
        expression: expressionNode,
        lower_bound: lowerNode,
        upper_bound: upperNode,
        negated: Boolean(negated)
      }
    );
  }

  static createIn(expressionNode, valuesNode, negated) {
    AstFactory.#validateAstNode(expressionNode, "expressionNode");
    AstFactory.#validateAstNode(valuesNode, "valuesNode");

    return AstFactory.#createNode(
      NodeType.IN_EXPRESSION,
      expressionNode.start_token_seq,
      valuesNode.end_token_seq,
      { expression: expressionNode, values: valuesNode, negated: Boolean(negated) }
    );
  }

  static createIs(expressionNode, test, negated, endTokenSeq) {
    AstFactory.#validateAstNode(expressionNode, "expressionNode");

    return AstFactory.#createNode(
      NodeType.IS_EXPRESSION,
      expressionNode.start_token_seq,
      endTokenSeq,
      { expression: expressionNode, test, negated: Boolean(negated) }
    );
  }

  static createDistinctFrom(leftNode, rightNode, negated) {
    AstFactory.#validateAstNode(leftNode, "leftNode");
    AstFactory.#validateAstNode(rightNode, "rightNode");

    return AstFactory.#createNode(
      NodeType.DISTINCT_FROM_EXPRESSION,
      leftNode.start_token_seq,
      rightNode.end_token_seq,
      { left: leftNode, right: rightNode, negated: Boolean(negated) }
    );
  }

  static createIdentifier(nameTokens) {
    if (!Array.isArray(nameTokens) || nameTokens.length === 0) {
      throw new TypeError("AstFactory.createIdentifier: nameTokens is required.");
    }

    const name = nameTokens.map((token) => token.token).join("");
    const parts = nameTokens
      .filter((token) => token.token !== ".")
      .map((token) => token.normalized_token);

    return AstFactory.#createNode(
      NodeType.IDENTIFIER_EXPRESSION,
      nameTokens[0].token_seq,
      nameTokens[nameTokens.length - 1].token_seq,
      { name, parts }
    );
  }

  static createWildcard(nameTokens) {
    const lastToken = nameTokens[nameTokens.length - 1];
    const qualifierTokens = nameTokens.slice(0, -2);

    return AstFactory.#createNode(
      NodeType.WILDCARD_EXPRESSION,
      nameTokens[0].token_seq,
      lastToken.token_seq,
      {
        qualifier: qualifierTokens.length > 0
          ? qualifierTokens.map((token) => token.token).join("")
          : null
      }
    );
  }

  static createLiteral(token, literalType, value) {
    return AstFactory.#createNode(
      NodeType.LITERAL_EXPRESSION,
      token.token_seq,
      token.token_seq,
      { literal_type: literalType, value }
    );
  }

  static createFunctionCall(nameTokens, argumentsList, openToken, closeToken, argumentModifier = null) {
    AstFactory.#validateAstNodeList(argumentsList, "argumentsList");

    return AstFactory.#createNode(
      NodeType.FUNCTION_CALL_EXPRESSION,
      nameTokens[0].token_seq,
      closeToken.token_seq,
      {
        function_name: nameTokens.map((token) => token.token).join(""),
        function_name_parts: nameTokens
          .filter((token) => token.token !== ".")
          .map((token) => token.normalized_token),
        arguments: argumentsList,
        argument_modifier: argumentModifier,
        open_parenthesis_seq: openToken.token_seq,
        close_parenthesis_seq: closeToken.token_seq
      }
    );
  }

  static createParenthesized(expressionNode, openToken, closeToken) {
    AstFactory.#validateAstNode(expressionNode, "expressionNode");

    return AstFactory.#createNode(
      NodeType.PARENTHESIZED_EXPRESSION,
      openToken.token_seq,
      closeToken.token_seq,
      { expression: expressionNode }
    );
  }

  static createExpressionList(items, openToken, closeToken) {
    AstFactory.#validateAstNodeList(items, "items");

    return AstFactory.#createNode(
      NodeType.EXPRESSION_LIST,
      openToken.token_seq,
      closeToken.token_seq,
      { items }
    );
  }

  static createSubquery(openToken, closeToken, subqueryTokens, queryAst, subqueryKind = "SCALAR") {
    const nodeType = subqueryKind === "ARRAY"
      ? NodeType.ARRAY_SUBQUERY_EXPRESSION
      : NodeType.SUBQUERY_EXPRESSION;

    return AstFactory.#createNode(
      nodeType,
      openToken.token_seq,
      closeToken.token_seq,
      {
        subquery_kind: subqueryKind,
        query_start_token_seq: subqueryTokens[0]?.token_seq || null,
        query_end_token_seq: subqueryTokens.at(-1)?.token_seq || null,
        query_text: subqueryTokens.map((token) => token.token).join(""),
        query_ast: queryAst
      }
    );
  }

  static createCaseWhen(conditionNode, resultNode, whenTokenSeq) {
    AstFactory.#validateAstNode(conditionNode, "conditionNode");
    AstFactory.#validateAstNode(resultNode, "resultNode");

    return AstFactory.#createNode(
      NodeType.CASE_WHEN_CLAUSE,
      whenTokenSeq,
      resultNode.end_token_seq,
      { condition: conditionNode, result: resultNode }
    );
  }

  static createCase(caseToken, caseOperand, whenClauses, elseExpression, endToken) {
    if (caseOperand !== null) {
      AstFactory.#validateAstNode(caseOperand, "caseOperand");
    }

    AstFactory.#validateAstNodeList(whenClauses, "whenClauses");

    if (elseExpression !== null) {
      AstFactory.#validateAstNode(elseExpression, "elseExpression");
    }

    return AstFactory.#createNode(
      NodeType.CASE_EXPRESSION,
      caseToken.token_seq,
      endToken.token_seq,
      {
        case_operand: caseOperand,
        when_clauses: whenClauses,
        else_expression: elseExpression
      }
    );
  }

  static createExists(existsTokenSeq, subqueryNode, negated) {
    AstFactory.#validateAstNode(subqueryNode, "subqueryNode");

    return AstFactory.#createNode(
      NodeType.EXISTS_EXPRESSION,
      existsTokenSeq,
      subqueryNode.end_token_seq,
      { subquery: subqueryNode, negated: Boolean(negated) }
    );
  }


  static createWindowExpression(functionNode, windowSpecification, overTokenSeq) {
    AstFactory.#validateAstNode(functionNode, "functionNode");
    AstFactory.#validateAstNode(windowSpecification, "windowSpecification");

    return AstFactory.#createNode(
      NodeType.WINDOW_EXPRESSION,
      functionNode.start_token_seq,
      windowSpecification.end_token_seq,
      {
        function: functionNode,
        over_token_seq: overTokenSeq,
        window: windowSpecification
      }
    );
  }

  static createWindowSpecification(openToken, closeToken, partitionBy, orderBy, frameTokens, windowName = null) {
    AstFactory.#validateAstNodeList(partitionBy, "partitionBy");
    AstFactory.#validateAstNodeList(orderBy, "orderBy");

    const startTokenSeq = openToken ? openToken.token_seq : windowName.start_token_seq;
    const endTokenSeq = closeToken ? closeToken.token_seq : windowName.end_token_seq;

    return AstFactory.#createNode(
      NodeType.WINDOW_SPECIFICATION,
      startTokenSeq,
      endTokenSeq,
      {
        window_name: windowName ? windowName.name : null,
        partition_by: partitionBy,
        order_by: orderBy,
        frame_tokens: frameTokens
      }
    );
  }

  static createWindowOrderItem(expressionNode, direction, nullsOrder) {
    AstFactory.#validateAstNode(expressionNode, "expressionNode");

    return AstFactory.#createNode(
      NodeType.WINDOW_ORDER_ITEM,
      expressionNode.start_token_seq,
      expressionNode.end_token_seq,
      { expression: expressionNode, direction, nulls_order: nullsOrder }
    );
  }

  static #createNode(nodeType, startTokenSeq, endTokenSeq, properties) {
    AstFactory.#validateNodeType(nodeType);

    if (!Number.isInteger(startTokenSeq) || !Number.isInteger(endTokenSeq)) {
      throw new TypeError("AstFactory: token_seq range must contain integers.");
    }

    return {
      node_type: nodeType,
      start_token_seq: startTokenSeq,
      end_token_seq: endTokenSeq,
      ...properties
    };
  }

  static #validateNodeType(nodeType) {
    if (!nodeType || !Object.values(NodeType).includes(nodeType)) {
      throw new TypeError(`AstFactory: invalid nodeType "${nodeType}".`);
    }
  }

  static #validateAstNode(node, argumentName) {
    if (!node || typeof node !== "object") {
      throw new TypeError(`AstFactory: ${argumentName} must be an AST Node.`);
    }

    AstFactory.#validateNodeType(node.node_type);

    if (!Number.isInteger(node.start_token_seq) || !Number.isInteger(node.end_token_seq)) {
      throw new TypeError(`AstFactory: ${argumentName} has an invalid token_seq range.`);
    }
  }

  static #validateAstNodeList(nodes, argumentName) {
    if (!Array.isArray(nodes)) {
      throw new TypeError(`AstFactory: ${argumentName} must be an array.`);
    }

    for (const node of nodes) {
      AstFactory.#validateAstNode(node, argumentName);
    }
  }
}

// ============================================================
// SOURCE: src/bigquery_exporter.js
// ============================================================
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

// ============================================================
// SOURCE: src/token_reader.js
// ============================================================
/**
 * Lexerが生成したToken配列を読み取るための補助クラス。
 *
 * 設計方針:
 *
 * - TokenReader内部のポインタ操作には配列indexを使う。
 * - 外部へ公開する位置情報にはtoken_seqを使う。
 * - Token配列自体は変更しない。
 */
class TokenReader {
  constructor(tokens, startTokenSeq = null) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("TokenReader: tokens must be an array.");
    }

    this.tokens = tokens;
    this.index = 0;

    if (startTokenSeq !== null) {
      this.moveToTokenSeq(startTokenSeq);
    }
  }

  get length() {
    return this.tokens.length;
  }

  /**
   * 現在Tokenのtoken_seqを返す。
   * EOFの場合はnullを返す。
   */
  get positionTokenSeq() {
    const currentToken = this.current();

    return currentToken ? currentToken.token_seq : null;
  }

  hasCurrent() {
    return this.index >= 0 && this.index < this.tokens.length;
  }

  isEnd() {
    return this.index >= this.tokens.length;
  }

  current() {
    return this.tokens[this.index] || null;
  }

  peek(offset = 0) {
    if (!Number.isInteger(offset)) {
      throw new TypeError("TokenReader.peek: offset must be an integer.");
    }

    const targetIndex = this.index + offset;

    return this.tokens[targetIndex] || null;
  }

  previous() {
    return this.peek(-1);
  }

  nextToken() {
    return this.peek(1);
  }

  consume() {
    const currentToken = this.current();

    if (this.hasCurrent()) {
      this.index++;
    }

    return currentToken;
  }

  advance(count = 1) {
    if (!Number.isInteger(count) || count < 0) {
      throw new TypeError(
        "TokenReader.advance: count must be a non-negative integer."
      );
    }

    const targetIndex = this.index + count;

    if (targetIndex > this.tokens.length) {
      throw new RangeError(
        `TokenReader.advance: cannot advance from index ${this.index} by ${count}. ` +
        `Target index ${targetIndex} exceeds EOF (${this.tokens.length}).`
      );
    }

    this.index = targetIndex;

    return this;
  }

  rewind(count = 1) {
    if (!Number.isInteger(count) || count < 0) {
      throw new TypeError(
        "TokenReader.rewind: count must be a non-negative integer."
      );
    }

    const targetIndex = this.index - count;

    if (targetIndex < 0) {
      throw new RangeError(
        `TokenReader.rewind: cannot rewind from index ${this.index} by ${count}. ` +
        `Target index ${targetIndex} is before the beginning of the token array.`
      );
    }

    this.index = targetIndex;

    return this;
  }

  reset() {
    this.index = 0;

    return this;
  }

  /**
   * 現在位置をtoken_seqとして保存する。
   * EOFの場合はnullを返す。
   */
  mark() {
    const currentToken = this.current();

    return currentToken ? currentToken.token_seq : null;
  }

  /**
   * mark()で保存したtoken_seqへ戻る。
   * nullの場合はEOFへ移動する。
   */
  restore(markedTokenSeq) {
    if (markedTokenSeq === null) {
      this.index = this.tokens.length;
      return this;
    }

    return this.moveToTokenSeq(markedTokenSeq);
  }

  /**
   * 指定token_seqへ移動する。
   */
  moveToTokenSeq(tokenSeq) {
    if (!Number.isInteger(tokenSeq)) {
      throw new TypeError(
        "TokenReader.moveToTokenSeq: tokenSeq must be an integer."
      );
    }

    const targetIndex = this.#findIndexByTokenSeq(tokenSeq);

    if (targetIndex < 0) {
      throw new RangeError(
        `TokenReader.moveToTokenSeq: token_seq ${tokenSeq} was not found.`
      );
    }

    this.index = targetIndex;

    return this;
  }

  matches(value, normalized = true) {
    const currentToken = this.current();

    if (!currentToken) {
      return false;
    }

    const actualValue = normalized
      ? currentToken.normalized_token
      : currentToken.token;

    const expectedValue = normalized
      ? String(value).toUpperCase()
      : String(value);

    return actualValue === expectedValue;
  }

  matchesType(tokenType) {
    const currentToken = this.current();

    return currentToken !== null && currentToken.token_type === tokenType;
  }

  matchesAny(values, normalized = true) {
    if (!Array.isArray(values)) {
      throw new TypeError("TokenReader.matchesAny: values must be an array.");
    }

    return values.some((value) => this.matches(value, normalized));
  }

  consumeIf(value, normalized = true) {
    if (!this.matches(value, normalized)) {
      return null;
    }

    return this.consume();
  }

  consumeTypeIf(tokenType) {
    if (!this.matchesType(tokenType)) {
      return null;
    }

    return this.consume();
  }

  skipComments() {
    while (this.hasCurrent() && this.matchesType("COMMENT")) {
      this.advance();
    }

    return this;
  }

  /**
   * 現在位置以降で最初の非COMMENT Tokenを返す。
   *
   * 現在位置は変更しない。
   * 位置情報が必要な場合は返却Tokenのtoken_seqを利用する。
   */
  peekNonComment(startOffset = 0) {
    if (!Number.isInteger(startOffset) || startOffset < 0) {
      throw new TypeError(
        "TokenReader.peekNonComment: startOffset must be a non-negative integer."
      );
    }

    let targetIndex = this.index + startOffset;

    while (targetIndex < this.tokens.length) {
      const targetToken = this.tokens[targetIndex];

      if (targetToken.token_type !== "COMMENT") {
        return targetToken;
      }

      targetIndex++;
    }

    return null;
  }

  /**
   * 指定token_seqの開き括弧に対応する閉じ括弧Tokenを返す。
   */
  findMatchingCloseParenthesis(openTokenSeq) {
    const openIndex = this.#findIndexByTokenSeq(openTokenSeq);
    const openToken = openIndex >= 0 ? this.tokens[openIndex] : null;

    if (!openToken || openToken.token !== "(") {
      return null;
    }

    const targetDepth = openToken.paren_depth;

    for (
      let tokenIndex = openIndex + 1;
      tokenIndex < this.tokens.length;
      tokenIndex++
    ) {
      const currentToken = this.tokens[tokenIndex];

      if (
        currentToken.token === ")" &&
        currentToken.paren_depth === targetDepth
      ) {
        return currentToken;
      }
    }

    return null;
  }

  /**
   * 指定token_seqの開き角括弧に対応する閉じ角括弧Tokenを返す。
   */
  findMatchingCloseBracket(openTokenSeq) {
    const openIndex = this.#findIndexByTokenSeq(openTokenSeq);
    const openToken = openIndex >= 0 ? this.tokens[openIndex] : null;

    if (!openToken || openToken.token !== "[") {
      return null;
    }

    const targetDepth = openToken.paren_depth;

    for (
      let tokenIndex = openIndex + 1;
      tokenIndex < this.tokens.length;
      tokenIndex++
    ) {
      const currentToken = this.tokens[tokenIndex];

      if (
        currentToken.token === "]" &&
        currentToken.paren_depth === targetDepth
      ) {
        return currentToken;
      }
    }

    return null;
  }

  /**
   * token_seqの範囲でTokenを切り出す。
   *
   * startTokenSeqとendTokenSeqの両方を含む。
   */
  sliceByTokenSeq(startTokenSeq, endTokenSeq) {
    if (!Number.isInteger(startTokenSeq) || !Number.isInteger(endTokenSeq)) {
      throw new TypeError(
        "TokenReader.sliceByTokenSeq: token sequences must be integers."
      );
    }

    if (endTokenSeq < startTokenSeq) {
      throw new RangeError(
        `TokenReader.sliceByTokenSeq: endTokenSeq ${endTokenSeq} ` +
        `is smaller than startTokenSeq ${startTokenSeq}.`
      );
    }

    return this.tokens.filter(
      (token) =>
        token.token_seq >= startTokenSeq &&
        token.token_seq <= endTokenSeq
    );
  }

  /**
   * 指定文字列に一致する最初のTokenを前方検索する。
   *
   * startTokenSeqを省略した場合は現在位置から検索する。
   */
  findForward(value, options = {}) {
    const {
      startTokenSeq = this.positionTokenSeq,
      normalized = true,
      targetDepth = null,
      skipComments = true
    } = options;

    let startIndex = this.index;

    if (startTokenSeq !== null) {
      startIndex = this.#findIndexByTokenSeq(startTokenSeq);

      if (startIndex < 0) {
        throw new RangeError(
          `TokenReader.findForward: startTokenSeq ${startTokenSeq} was not found.`
        );
      }
    }

    const expectedValue = normalized
      ? String(value).toUpperCase()
      : String(value);

    for (
      let tokenIndex = startIndex;
      tokenIndex < this.tokens.length;
      tokenIndex++
    ) {
      const currentToken = this.tokens[tokenIndex];

      if (skipComments && currentToken.token_type === "COMMENT") {
        continue;
      }

      if (targetDepth !== null && currentToken.paren_depth !== targetDepth) {
        continue;
      }

      const actualValue = normalized
        ? currentToken.normalized_token
        : currentToken.token;

      if (actualValue === expectedValue) {
        return currentToken;
      }
    }

    return null;
  }

  clone(startTokenSeq = this.positionTokenSeq) {
    return new TokenReader(this.tokens, startTokenSeq);
  }

  /**
   * TokenReader内部専用。
   *
   * token_seqから配列indexへ変換する。
   * Parserなど外部からは利用しない。
   */
  #findIndexByTokenSeq(tokenSeq) {
    return this.tokens.findIndex((token) => token.token_seq === tokenSeq);
  }
}

// ============================================================
// SOURCE: src/clause_parser.js
// ============================================================
/**
 * Lexerが生成したToken配列から、SQLのClause境界を抽出するParser。
 *
 * Clause Parserの責務:
 *
 * - SELECT、FROM、WHEREなどのClause開始位置を見つける。
 * - GROUP BY、ORDER BYのような複数TokenのClause名を1つにまとめる。
 * - 各Clauseの本文がどのtoken_seqからどこまでかを確定する。
 *
 * この段階では、SELECT項目やFROMのテーブル名など、Clause本文の
 * 詳細な意味解析は行わない。それらは後続のSelect Parser、From Parserへ
 * 委譲する。
 *
 * 基本版の対象Clause:
 *
 * - SELECT
 * - FROM
 * - WHERE
 * - GROUP BY
 * - HAVING
 * - QUALIFY
 * - ORDER BY
 * - LIMIT
 *
 * 返却する位置情報はすべてtoken_seq。
 * JavaScript配列のindexはTokenReaderやこのクラス内部の走査だけで使用し、
 * 後続Parserへは公開しない。
 *
 * @example
 * SELECT customer_id FROM sales WHERE amount > 0
 *
 * おおむね次の結果を返す。
 *
 * {
 *   clause_seq: 1,
 *   clause_type: "SELECT",
 *   clause_start_seq: 1,
 *   clause_end_seq: 1,
 *   body_start_seq: 2,
 *   body_end_seq: 2,
 *   paren_depth: 0
 * }
 */
class ClauseParser {
  /**
   * Clause Parserを初期化する。
   *
   * Token配列を直接走査する処理と、現在位置を進める処理を分離するため、
   * TokenReaderを内部に持つ。ClauseParser自身がindex管理を重複実装せず、
   * Readerのcurrent()、advance()、matches()などを利用する。
   *
   * @param {Array<object>} tokens Lexerが生成したToken配列
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("ClauseParser: tokens must be an array.");
    }

    /*
     * this.tokens:
     *   Clause本文の終了位置を求めるとき、Token全体を前後に確認するために使う。
     *
     * this.reader:
     *   メイン解析で現在位置を左から右へ進めるために使う。
     */
    this.tokens = tokens;
    this.reader = new TokenReader(tokens);
  }

  /**
   * Token配列を先頭から走査し、トップレベルClause一覧を返す。
   *
   * 処理の流れ:
   *
   * 1. Readerを先頭へ戻す。
   * 2. COMMENTと括弧内部のTokenをClause候補から除外する。
   * 3. 現在TokenがClause開始か#matchClause()で判定する。
   * 4. Clause開始・本文開始情報を一旦保存する。
   * 5. 全Clause検出後、次のClause位置を使って本文終了位置を設定する。
   *
   * 本文終了位置を後から設定する理由:
   * 現在Clauseを発見した時点では、次のClauseがどこに現れるかまだ
   * 分からないため。まず開始位置だけ集め、2回目の処理で境界を確定する。
   *
   * @returns {Array<object>} 検出したClause一覧
   */
  parse() {
    const clauses = [];

    // 同じParserインスタンスでparse()を再実行しても先頭から解析できるようにする。
    this.reader.reset();

    while (!this.reader.isEnd()) {
      const currentToken = this.reader.current();

      /*
       * COMMENT内のSELECTやFROMという文字列をClauseと誤認しないため、
       * COMMENT Tokenは判定対象から除外する。
       */
      if (currentToken.token_type === "COMMENT") {
        this.reader.advance();
        continue;
      }

      /*
       * この基本版ではSQL全体のトップレベルClauseだけを抽出する。
       *
       * 例:
       *
       * SELECT (SELECT x FROM inner_table) FROM outer_table
       *
       * 内側SELECT/FROMはparen_depthが1以上になるため除外し、
       * 外側SELECT/FROMだけをClauseとして返す。
       * サブクエリ解析は後続のQuery Parserへ委譲する。
       */
      if (currentToken.paren_depth !== 0) {
        this.reader.advance();
        continue;
      }

      // 現在位置が対応対象のClause開始か判定する。
      const clauseMatch = this.#matchClause();

      /*
       * Clauseではない通常Tokenなら、1Token進めて次を確認する。
       * 位置を進めないと同じTokenを評価し続けて無限ループになる。
       */
      if (!clauseMatch) {
        this.reader.advance();
        continue;
      }

      /*
       * Clauseを発見した時点ではbody_end_seqだけ未確定。
       * 次のClause開始位置が必要なので、parse()後半の#setBodyEndSeq()で設定する。
       */
      clauses.push({
        clause_seq: clauses.length + 1,
        clause_type: clauseMatch.clause_type,
        clause_start_seq: currentToken.token_seq,
        clause_end_seq: clauseMatch.clause_end_seq,
        body_start_seq: clauseMatch.body_start_seq,
        body_end_seq: null,
        paren_depth: currentToken.paren_depth
      });

      /*
       * Clause名を構成するTokenをまとめて消費する。
       *
       * SELECTなら1Token、GROUP BYならコメントを含めてBYまで進める。
       * ここで適切に進めることで、BYを単独Tokenとして再評価しない。
       */
      this.reader.advance(clauseMatch.token_count);
    }

    // すべてのClause開始位置が揃った後、各本文の終了位置を確定する。
    this.#setBodyEndSeq(clauses);

    return clauses;
  }


  /**
   * 現在位置のFROMが、Clause開始ではなく
   * IS [NOT] DISTINCT FROM演算子の一部か判定する。
   *
   * ClauseParserはトップレベルKeywordを走査するため、単純にFROMだけを見ると、
   * WHERE old_value IS DISTINCT FROM new_value
   * のFROMまで新しいFROM Clauseとして誤認してしまう。
   *
   * 現在Tokenより前の非COMMENT Tokenを確認し、
   *
   * - IS DISTINCT FROM
   * - IS NOT DISTINCT FROM
   *
   * の並びならClause開始ではないと判断する。
   *
   * @returns {boolean}
   */
  #isDistinctFromOperator() {
    const currentToken = this.reader.current();
    const currentIndex = this.tokens.findIndex(
      (token) => token.token_seq === currentToken.token_seq
    );
    const previousKeywords = [];

    for (let tokenIndex = currentIndex - 1; tokenIndex >= 0; tokenIndex--) {
      const token = this.tokens[tokenIndex];

      if (token.token_type === "COMMENT") {
        continue;
      }

      previousKeywords.unshift(token.normalized_token);

      if (previousKeywords.length === 3) {
        break;
      }
    }

    const lastTwo = previousKeywords.slice(-2).join(" ");
    const lastThree = previousKeywords.slice(-3).join(" ");

    return lastTwo === "IS DISTINCT" || lastThree === "IS NOT DISTINCT";
  }

  /**
   * 現在Reader位置が、対応対象のClause開始Tokenか判定する。
   *
   * このメソッドが必要な理由:
   * parse()本体に全Keyword判定を直接書くと、走査処理とClause定義が混ざり、
   * Clause追加時の修正範囲が広くなる。判定をprivateメソッドへ分離することで、
   * parse()は「走査」、このメソッドは「Clause種類の識別」に専念できる。
   *
   * 1 Token Clauseは#createSingleTokenClause()、2 Token Clauseは
   * #createTwoTokenClause()へ処理を委譲し、戻り値の形式を統一する。
   *
   * @returns {object|null} Clause情報。Clause開始でなければnull
   */
  #matchClause() {
    if (this.reader.matches("SELECT")) {
      return this.#createSingleTokenClause("SELECT");
    }

    if (this.reader.matches("FROM") && !this.#isDistinctFromOperator()) {
      return this.#createSingleTokenClause("FROM");
    }

    if (this.reader.matches("WHERE")) {
      return this.#createSingleTokenClause("WHERE");
    }

    if (this.reader.matches("HAVING")) {
      return this.#createSingleTokenClause("HAVING");
    }

    if (this.reader.matches("QUALIFY")) {
      return this.#createSingleTokenClause("QUALIFY");
    }

    if (this.reader.matches("WINDOW")) {
      return this.#createSingleTokenClause("WINDOW");
    }

    if (this.reader.matches("LIMIT")) {
      return this.#createSingleTokenClause("LIMIT");
    }

    /*
     * GROUP単独ではClause確定にできない。
     * 次の非COMMENT TokenがBYの場合だけGROUP_BYとして返す。
     */
    if (this.reader.matches("GROUP")) {
      return this.#createTwoTokenClause("GROUP_BY", "BY");
    }

    /*
     * ORDERも同様に、次の非COMMENT TokenがBYの場合だけORDER_BYとする。
     */
    if (this.reader.matches("ORDER")) {
      return this.#createTwoTokenClause("ORDER_BY", "BY");
    }

    return null;
  }

  /**
   * SELECTやFROMなど、1 Tokenで名前が完成するClause情報を作る。
   *
   * このメソッドが必要な理由:
   * 1 Token Clauseごとにclause_end_seqやbody_start_seqの計算を重複して
   * 書かず、同じ規則を必ず適用するため。
   *
   * Clause本文は、Clause Keywordの次にある最初の非COMMENT Tokenから始まる。
   * Keyword直後がSQL末尾なら本文は存在しないためnullを返す。
   *
   * @param {string} clauseType 正規化したClause種別
   * @returns {object} parse()が利用するClause一致情報
   */
  #createSingleTokenClause(clauseType) {
    const currentToken = this.reader.current();
    const nextToken = this.reader.peekNonComment(1);

    return {
      clause_type: clauseType,
      clause_end_seq: currentToken.token_seq,
      body_start_seq: nextToken ? nextToken.token_seq : null,
      token_count: 1
    };
  }

  /**
   * GROUP BYやORDER BYなど、2つのKeywordで名前が完成するClause情報を作る。
   *
   * COMMENTを無視して次Keywordを確認する理由:
   *
   *   GROUP
   *   -- comment
   *   BY customer_id
   *
   * のようなSQLでもGROUP BYとして認識できるようにするため。
   *
   * token_countには現在位置からBYまでに存在する全Token数を設定する。
   * コメントTokenもReader配列上には存在するため、それを含めて進めないと
   * Reader位置がBYより前に残ってしまう。
   *
   * @param {string} clauseType 正規化したClause種別
   * @param {string} secondKeyword Clause名の2番目のKeyword
   * @returns {object|null} 一致情報。2番目のKeywordがなければnull
   */
  #createTwoTokenClause(clauseType, secondKeyword) {
    const secondToken = this.reader.peekNonComment(1);

    if (!secondToken || secondToken.normalized_token !== secondKeyword) {
      return null;
    }

    /*
     * peekNonComment()はTokenを返すが、Readerを進めるには現在位置からの
     * offsetが必要。そのためtoken_seqを基準にoffsetを求める。
     */
    const secondTokenOffset = this.#findOffsetByTokenSeq(secondToken.token_seq);
    const bodyStartToken = this.reader.peekNonComment(secondTokenOffset + 1);

    return {
      clause_type: clauseType,
      clause_end_seq: secondToken.token_seq,
      body_start_seq: bodyStartToken ? bodyStartToken.token_seq : null,
      token_count: secondTokenOffset + 1
    };
  }

  /**
   * 各Clause本文の終了token_seqを確定する。
   *
   * 境界規則:
   *
   * - 次のClauseがある場合:
   *     次Clause開始直前の非COMMENT Tokenまで。
   *
   * - 最後のClauseの場合:
   *     SQL末尾の非COMMENT Tokenまで。
   *
   * COMMENTを本文終了にしない理由:
   * 後続Parserがbody_end_seqを使って式を切り出す際、末尾コメントではなく
   * 実際のSQL要素までを本文範囲として扱いやすくするため。
   *
   * @param {Array<object>} clauses parse()が検出したClause一覧
   */
  #setBodyEndSeq(clauses) {
    for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex++) {
      const currentClause = clauses[clauseIndex];
      const nextClause = clauses[clauseIndex + 1];

      // Clause Keywordの後にTokenがなければ、本文開始・終了ともnullのままにする。
      if (currentClause.body_start_seq === null) {
        currentClause.body_end_seq = null;
        continue;
      }

      if (nextClause) {
        currentClause.body_end_seq = this.#findPreviousNonCommentTokenSeq(
          nextClause.clause_start_seq
        );

        continue;
      }

      currentClause.body_end_seq = this.#findLastNonCommentTokenSeq();
    }
  }

  /**
   * 現在Reader位置から、指定token_seqまでの配列offsetを求める。
   *
   * このメソッドが必要な理由:
   * TokenReaderの外部座標はtoken_seqで統一している一方、peek(offset)や
   * advance(count)は「現在位置から何Token離れているか」を必要とするため。
   * indexそのものを外部へ公開せず、ClauseParser内部で一時的にoffsetへ変換する。
   *
   * @param {number} tokenSeq 探すTokenのtoken_seq
   * @returns {number} 現在位置を0とした相対offset
   */
  #findOffsetByTokenSeq(tokenSeq) {
    let offset = 0;

    while (true) {
      const targetToken = this.reader.peek(offset);

      /*
       * 呼び出し元が渡したtoken_seqは直前のpeekNonComment()で得たものなので
       * 通常は必ず見つかる。見つからない場合は内部整合性が崩れているため、
       * nullで続行せずRangeErrorとして検出する。
       */
      if (!targetToken) {
        throw new RangeError(
          `ClauseParser: token_seq ${tokenSeq} was not found after the current position.`
        );
      }

      if (targetToken.token_seq === tokenSeq) {
        return offset;
      }

      offset++;
    }
  }

  /**
   * 指定token_seqより前にある最後の非COMMENT Tokenのtoken_seqを返す。
   *
   * 次Clause開始位置から単純に1を引かない理由:
   * token_seqの直前にCOMMENT Tokenがある場合、本文終了位置がコメントに
   * なってしまうため。Token配列を先頭から確認し、最後の有効Tokenを保持する。
   *
   * @param {number} tokenSeq 次Clauseの開始token_seq
   * @returns {number|null} 直前の非COMMENT Tokenのtoken_seq
   */
  #findPreviousNonCommentTokenSeq(tokenSeq) {
    let previousTokenSeq = null;

    for (const token of this.tokens) {
      if (token.token_seq >= tokenSeq) {
        break;
      }

      if (token.token_type !== "COMMENT") {
        previousTokenSeq = token.token_seq;
      }
    }

    return previousTokenSeq;
  }

  /**
   * SQL全体の末尾にある非COMMENT Tokenのtoken_seqを返す。
   *
   * 最後のClauseには次Clauseがないため、本文終了位置を決めるには
   * SQL末尾側から最初に見つかる有効Tokenを探す必要がある。
   * 後ろから検索することで、末尾コメントを効率的に飛ばせる。
   *
   * @returns {number|null} 最後の非COMMENT Tokenのtoken_seq
   */
  #findLastNonCommentTokenSeq() {
    for (let tokenIndex = this.tokens.length - 1; tokenIndex >= 0; tokenIndex--) {
      const currentToken = this.tokens[tokenIndex];

      if (currentToken.token_type !== "COMMENT") {
        return currentToken.token_seq;
      }
    }

    // TokenがすべてCOMMENT、または空配列の場合。
    return null;
  }
}


/**
 * 未対応のBigQuery固有構文を、解析全体を停止させず保持するための暫定AST。
 * 識別子参照だけは子Nodeとして保持し、ColumnResolverの汎用走査で回収する。
 */
function createRawExpressionAst(tokens) {
  const content = (tokens || []).filter((token) => token.token_type !== "COMMENT");
  const children = [];
  const ignoredWords = new Set([
    "ARRAY", "STRUCT", "STRING", "DATE", "DATETIME", "TIMESTAMP", "TIME",
    "INT64", "INTEGER", "FLOAT64", "NUMERIC", "BIGNUMERIC", "BOOL", "BOOLEAN",
    "BYTES", "JSON", "GEOGRAPHY", "AS", "ORDER", "BY", "LIMIT", "ASC", "DESC",
    "EXCEPT", "REPLACE", "DISTINCT", "NULLS", "FIRST", "LAST"
  ]);

  for (let index = 0; index < content.length; index++) {
    const token = content[index];
    if (!["IDENTIFIER", "BACKTICK_IDENTIFIER"].includes(token.token_type)) continue;
    if (ignoredWords.has(token.normalized_token)) continue;
    if (content[index - 1]?.normalized_token === "AS") continue;

    /* 関数名は列参照ではない。名前空間付き関数も直後の(で判定する。 */
    let functionEndIndex = index;
    while (
      content[functionEndIndex + 1]?.token === "." &&
      ["IDENTIFIER", "BACKTICK_IDENTIFIER"].includes(content[functionEndIndex + 2]?.token_type)
    ) {
      functionEndIndex += 2;
    }
    if (content[functionEndIndex + 1]?.token === "(") {
      index = functionEndIndex;
      continue;
    }

    const nameTokens = [token];
    while (
      content[index + 1]?.token === "." &&
      ["IDENTIFIER", "BACKTICK_IDENTIFIER"].includes(content[index + 2]?.token_type)
    ) {
      nameTokens.push(content[index + 1], content[index + 2]);
      index += 2;
    }
    children.push(AstFactory.createIdentifier(nameTokens));
  }

  return {
    node_type: NodeType.RAW_EXPRESSION,
    start_token_seq: content[0]?.token_seq ?? null,
    end_token_seq: content.at(-1)?.token_seq ?? null,
    raw_text: content.map((token) => token.token).join(""),
    children
  };
}

// ============================================================
// SOURCE: src/select_parser.js
// ============================================================
/**
 * Clause Parserが抽出したSELECT句本文を、SELECT項目単位へ分解する。
 *
 * このParserの責務:
 *
 * 1. SELECT句本文だけをToken配列から取り出す。
 * 2. SELECT句と同じ階層にあるカンマで項目を分割する。
 * 3. 各項目から明示的・暗黙的な出力aliasを分離する。
 * 4. 単純カラムやWildcardの出力情報を整理する。
 * 5. 後続のExpression Parserが解析できるよう、式のtoken_seq範囲を返す。
 *
 * このParserが行わないこと:
 *
 * - 式の内部構造の解析
 * - カラムがどのテーブルに属するかの解決
 * - Wildcardの物理カラム展開
 *
 * これらは後続のExpression ParserやResolverの責務とする。
 */
class SelectParser {
  /**
   * @param {Array<object>} tokens Lexerが生成した全Token
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("SelectParser: tokens must be an array.");
    }

    this.tokens = tokens;
    this.reader = new TokenReader(tokens);
  }

  /**
   * SELECT Clauseを解析し、SELECT項目一覧を返す。
   *
   * selectClauseにはClauseParserが返したSELECT Clauseを渡す。
   * body_start_seqとbody_end_seqがSELECT本文の範囲を表すため、
   * SelectParser自身がSQL全体からSELECTやFROMを探し直す必要はない。
   *
   * @param {object} selectClause ClauseParserが返したSELECT Clause
   * @returns {Array<object>}
   */
  parse(selectClause) {
    this.#validateSelectClause(selectClause);

    const selectTokens = this.reader.sliceByTokenSeq(
      selectClause.body_start_seq,
      selectClause.body_end_seq
    );

    const contentTokens = this.#removeSelectModifiers(selectTokens);
    const itemTokenGroups = this.#splitTopLevelByComma(
      contentTokens,
      selectClause.paren_depth
    );

    return itemTokenGroups.map((itemTokens, itemIndex) => {
      return this.#parseSelectItem(itemTokens, itemIndex + 1);
    });
  }

  /**
   * ClauseParserから渡された値がSELECT Clauseとして利用可能か確認する。
   *
   * 早い段階で明確な例外を出すことで、SelectParser内部の別処理で
   * null参照や不自然な空配列が発生し、原因が分かりにくくなるのを防ぐ。
   *
   * @param {object} selectClause
   */
  #validateSelectClause(selectClause) {
    if (!selectClause || typeof selectClause !== "object") {
      throw new TypeError("SelectParser.parse: selectClause must be an object.");
    }

    if (selectClause.clause_type !== "SELECT") {
      throw new TypeError(
        `SelectParser.parse: clause_type must be SELECT, but received ` +
        `${String(selectClause.clause_type)}.`
      );
    }

    if (
      !Number.isInteger(selectClause.body_start_seq) ||
      !Number.isInteger(selectClause.body_end_seq)
    ) {
      throw new TypeError(
        "SelectParser.parse: SELECT body token sequences must be integers."
      );
    }

    if (!Number.isInteger(selectClause.paren_depth)) {
      throw new TypeError(
        "SelectParser.parse: selectClause.paren_depth must be an integer."
      );
    }
  }

  /**
   * SELECT本文の先頭にあるSELECT修飾子を取り除く。
   *
   * 例えば次のDISTINCTはSELECT項目ではない。
   *
   *   SELECT DISTINCT customer_id, amount
   *          ^^^^^^^^
   *
   * これを残したままにすると、最初の項目が
   * "DISTINCT customer_id"という式として扱われてしまう。
   *
   * DISTINCT、ALL、AS STRUCT、AS VALUEを対象とする。
   * これらはSELECT項目そのものではなく、SELECT全体の出力形式を指定する。
   *
   * COMMENTは修飾子判定を妨げないが、元のToken列には残す。
   * そのため修飾子直前までのCOMMENTも合わせて除外する。
   *
   * @param {Array<object>} tokens SELECT本文Token
   * @returns {Array<object>}
   */
  #removeSelectModifiers(tokens) {
    let firstContentIndex = 0;

    while (
      firstContentIndex < tokens.length &&
      tokens[firstContentIndex].token_type === "COMMENT"
    ) {
      firstContentIndex++;
    }

    const firstContentToken = tokens[firstContentIndex];

    // Only a KEYWORD DISTINCT/ALL is the SELECT set-quantifier. A string literal
    // whose contents happen to spell ALL/DISTINCT (e.g. SELECT 'ALL' AS col1)
    // shares the normalized_token but is token_type STRING, and must NOT be
    // stripped — doing so left the item with no expression.
    if (
      firstContentToken &&
      firstContentToken.token_type === "KEYWORD" &&
      ["DISTINCT", "ALL"].includes(firstContentToken.normalized_token)
    ) {
      return tokens.slice(firstContentIndex + 1);
    }

    const secondContentIndex = this.#findNextNonCommentIndex(
      tokens,
      firstContentIndex + 1
    );

    const secondContentToken = secondContentIndex >= 0
      ? tokens[secondContentIndex]
      : null;

    // As above, only a KEYWORD AS introduces AS STRUCT / AS VALUE; a string
    // literal 'AS' (token_type STRING) must not be treated as the modifier.
    if (
      firstContentToken?.token_type === "KEYWORD" &&
      firstContentToken?.normalized_token === "AS" &&
      ["STRUCT", "VALUE"].includes(secondContentToken?.normalized_token)
    ) {
      return tokens.slice(secondContentIndex + 1);
    }

    return tokens;
  }


  /**
   * 指定位置以降で最初の非COMMENT Tokenの配列indexを返す。
   *
   * SELECT AS STRUCT / AS VALUEでは、ASとSTRUCT/VALUEの間に
   * コメントが挟まる可能性があるため、単純なindex + 1ではなく
   * 次の実内容Tokenを探す必要がある。
   *
   * @param {Array<object>} tokens
   * @param {number} startIndex
   * @returns {number}
   */
  #findNextNonCommentIndex(tokens, startIndex) {
    for (let tokenIndex = startIndex; tokenIndex < tokens.length; tokenIndex++) {
      if (tokens[tokenIndex].token_type !== "COMMENT") {
        return tokenIndex;
      }
    }

    return -1;
  }

  /**
   * SELECT本文を、SELECT項目ごとのToken配列へ分割する。
   *
   * 単純にすべてのカンマで分割してはいけない。
   * 関数引数やSTRUCT内部にもカンマが存在するためである。
   *
   *   SELECT IF(a > 0, b, c), customer_id
   *                         ^ ここだけが項目区切り
   *
   * Clauseと同じparen_depthのカンマだけを項目区切りとして扱う。
   * 括弧内部のカンマはより深いparen_depthを持つため分割されない。
   *
   * @param {Array<object>} tokens SELECT本文Token
   * @param {number} itemDepth SELECT項目区切りが存在するdepth
   * @returns {Array<Array<object>>}
   */
  #splitTopLevelByComma(tokens, itemDepth) {
    const result = [];
    let currentItem = [];
    let angleDepth = 0;
    let previousMeaningful = null;

    for (const token of tokens) {
      /*
       * 型パラメータの山括弧 STRUCT<...> / ARRAY<...> 内部のカンマは項目区切りに
       * しない。paren_depth は () / [] しか数えないため、山括弧の深さを別に追う。
       * '<' が型を開くのは STRUCT / ARRAY（またはネスト型を閉じた '>'）の直後だけで、
       * 値の比較 a < b では加算しないため通常の比較には影響しない。
       */
      if (
        token.token === "<" &&
        previousMeaningful &&
        (["STRUCT", "ARRAY"].includes(previousMeaningful.normalized_token) ||
          previousMeaningful.token === ">")
      ) {
        angleDepth += 1;
      } else if (token.token === ">" && angleDepth > 0) {
        angleDepth -= 1;
      }

      if (
        token.token === "," &&
        token.paren_depth === itemDepth &&
        angleDepth === 0
      ) {
        const trimmedItem = this.#removeCommentTokens(currentItem);

        if (trimmedItem.length === 0) {
          throw new SyntaxError(
            `SelectParser: empty SELECT item before token_seq ${token.token_seq}.`
          );
        }

        result.push(trimmedItem);
        currentItem = [];

        if (token.token_type !== "COMMENT") {
          previousMeaningful = token;
        }

        continue;
      }

      currentItem.push(token);

      if (token.token_type !== "COMMENT") {
        previousMeaningful = token;
      }
    }

    const lastItem = this.#removeCommentTokens(currentItem);

    if (lastItem.length > 0) {
      result.push(lastItem);
    }

    /*
     * BigQueryではSELECTリスト末尾のカンマが許容される。
     *
     *   SELECT
     *     column_a,
     *     column_b,
     *   FROM table_name
     *
     * 最後のカンマより後ろにSELECT項目がない場合でも、
     * それを空項目や構文エラーとして扱わない。
     */

    if (result.length === 0) {
      throw new SyntaxError("SelectParser: SELECT clause contains no items.");
    }

    return result;
  }

  /**
   * 1つのSELECT項目を解析する。
   *
   * ここでは主に「式」と「出力alias」を分離する。
   * 式そのものをASTへ変換する処理はExpression Parserへ委譲する。
   *
   * @param {Array<object>} itemTokens 1項目分のToken
   * @param {number} selectItemSeq SELECT項目の連番
   * @returns {object}
   */
  #parseSelectItem(itemTokens, selectItemSeq) {
    const aliasResult = this.#parseAlias(itemTokens);
    const wildcardResult = this.#parseWildcard(aliasResult.expression_tokens);
    const expressionTokens = aliasResult.expression_tokens;

    if (expressionTokens.length === 0) {
      throw new SyntaxError(
        `SelectParser: SELECT item ${selectItemSeq} has no expression.`
      );
    }

    return {
      select_item_seq: selectItemSeq,
      item_start_seq: itemTokens[0].token_seq,
      item_end_seq: itemTokens[itemTokens.length - 1].token_seq,
      expression_start_seq: expressionTokens[0].token_seq,
      expression_end_seq: expressionTokens[expressionTokens.length - 1].token_seq,
      expression: this.#tokensToText(expressionTokens),
      output_alias: aliasResult.output_alias,
      alias_type: aliasResult.alias_type,
      wildcard_type: wildcardResult.wildcard_type,
      wildcard_qualifier: wildcardResult.wildcard_qualifier,
      wildcard_exclusions: wildcardResult.wildcard_exclusions || [],
      wildcard_replacements: wildcardResult.wildcard_replacements || []
    };
  }

  /**
   * SELECT項目からaliasを判定し、式部分とalias部分を分離する。
   *
   * 判定順序には意味がある。
   *
   * 1. 明示的alias: expression AS alias
   * 2. 暗黙alias:   expression alias
   * 3. 単純カラムから出力名を導出
   * 4. aliasなし
   *
   * 明示的なASを最優先にすることで、式中の末尾Identifierを誤って
   * 暗黙aliasと解釈する可能性を減らす。
   *
   * @param {Array<object>} itemTokens
   * @returns {object}
   */
  #parseAlias(itemTokens) {
    const explicitAlias = this.#findExplicitAlias(itemTokens);

    if (explicitAlias) {
      return explicitAlias;
    }

    const implicitAlias = this.#findImplicitAlias(itemTokens);

    if (implicitAlias) {
      return implicitAlias;
    }

    const derivedAlias = this.#deriveColumnAlias(itemTokens);

    if (derivedAlias) {
      return derivedAlias;
    }

    return {
      expression_tokens: itemTokens,
      output_alias: null,
      alias_type: "NONE"
    };
  }

  /**
   * トップレベルのASを右側から探し、明示的aliasを抽出する。
   *
   * 右側から探す理由:
   * SELECT項目のaliasは通常末尾にあり、式内部のCAST(... AS TYPE)にある
   * ASを誤って出力aliasとして扱わないためである。
   * CAST内部のASは項目より深いparen_depthなので対象外となる。
   *
   * ASの後ろには非COMMENT Tokenが1つだけ存在することを要求する。
   * 余分なTokenがあれば曖昧なSQLを黙って受け入れずSyntaxErrorにする。
   *
   * @param {Array<object>} itemTokens
   * @returns {object|null}
   */
  #findExplicitAlias(itemTokens) {
    const itemDepth = itemTokens[0].paren_depth;

    for (let tokenIndex = itemTokens.length - 1; tokenIndex >= 0; tokenIndex--) {
      const currentToken = itemTokens[tokenIndex];

      if (
        currentToken.normalized_token !== "AS" ||
        currentToken.paren_depth !== itemDepth
      ) {
        continue;
      }

      const aliasTokens = this.#removeCommentTokens(itemTokens.slice(tokenIndex + 1));

      if (aliasTokens.length !== 1 || !this.#isAliasToken(aliasTokens[0])) {
        throw new SyntaxError(
          `SelectParser: invalid explicit alias after token_seq ` +
          `${currentToken.token_seq}.`
        );
      }

      const expressionTokens = this.#removeCommentTokens(
        itemTokens.slice(0, tokenIndex)
      );

      return {
        expression_tokens: expressionTokens,
        output_alias: aliasTokens[0].normalized_token,
        alias_type: "EXPLICIT_AS"
      };
    }

    return null;
  }

  /**
   * ASを省略した暗黙aliasを判定する。
   *
   *   SUM(amount) total_amount
   *               ^^^^^^^^^^^^
   *
   * 最後のTokenがIdentifierであり、その直前のTokenが式の終端として
   * 自然な場合だけaliasとみなす。
   *
   * 例えば「a + b」のbをaliasと誤認しないよう、直前が演算子なら
   * 暗黙aliasとして扱わない。
   *
   * @param {Array<object>} itemTokens
   * @returns {object|null}
   */
  #findImplicitAlias(itemTokens) {
    const significantTokens = itemTokens.filter(
      (token) => token.token_type !== "COMMENT"
    );

    if (significantTokens.length < 2) {
      return null;
    }

    const aliasToken = significantTokens[significantTokens.length - 1];
    const previousToken = significantTokens[significantTokens.length - 2];

    if (!this.#isAliasToken(aliasToken)) {
      return null;
    }

    if (!this.#canEndExpression(previousToken)) {
      return null;
    }

    const aliasIndex = itemTokens.indexOf(aliasToken);
    const expressionTokens = this.#removeCommentTokens(itemTokens.slice(0, aliasIndex));

    return {
      expression_tokens: expressionTokens,
      output_alias: aliasToken.normalized_token,
      alias_type: "IMPLICIT"
    };
  }

  /**
   * aliasが省略された単純カラム参照から、出力列名を導出する。
   *
   *   customer_id   -> CUSTOMER_ID
   *   c.customer_id -> CUSTOMER_ID
   *
   * 計算式や関数は出力名を安全に導出できないため対象外とする。
   *
   * @param {Array<object>} itemTokens
   * @returns {object|null}
   */
  #deriveColumnAlias(itemTokens) {
    const significantTokens = itemTokens.filter(
      (token) => token.token_type !== "COMMENT"
    );

    if (significantTokens.length === 1 && this.#isColumnNameToken(significantTokens[0])) {
      return {
        expression_tokens: itemTokens,
        output_alias: significantTokens[0].normalized_token,
        alias_type: "DERIVED_COLUMN"
      };
    }

    if (significantTokens.length >= 3) {
      const columnToken = significantTokens[significantTokens.length - 1];
      const dotToken = significantTokens[significantTokens.length - 2];

      if (dotToken.token === "." && this.#isColumnNameToken(columnToken)) {
        return {
          expression_tokens: itemTokens,
          output_alias: columnToken.normalized_token,
          alias_type: "DERIVED_COLUMN"
        };
      }
    }

    return null;
  }

  /**
   * Wildcard表現を分類する。
   *
   *   *       -> ALL
   *   sales.* -> QUALIFIED
   *
   * Wildcardの展開自体にはテーブルスキーマが必要なため、ここでは
   * 種別と修飾子だけを記録し、Physical Resolverへ引き渡す。
   *
   * @param {Array<object>} expressionTokens
   * @returns {object}
   */
  #parseWildcard(expressionTokens) {
    const significantTokens = expressionTokens.filter(
      (token) => token.token_type !== "COMMENT"
    );

    const exclusions = [];
    const replacements = [];
    let wildcardEndIndex = significantTokens.length;
    const exceptIndex = significantTokens.findIndex(
      (token) => token.normalized_token === "EXCEPT"
    );
    const replaceIndex = significantTokens.findIndex(
      (token) => token.normalized_token === "REPLACE"
    );

    for (const index of [exceptIndex, replaceIndex]) {
      if (index >= 0 && index < wildcardEndIndex) wildcardEndIndex = index;
    }

    if (exceptIndex >= 0) {
      const exceptEnd = replaceIndex > exceptIndex ? replaceIndex : significantTokens.length;
      for (let index = exceptIndex + 1; index < exceptEnd; index++) {
        const token = significantTokens[index];
        if (["IDENTIFIER", "BACKTICK_IDENTIFIER"].includes(token.token_type)) {
          exclusions.push(token.normalized_token);
        }
      }
    }

    if (replaceIndex >= 0) {
      const openIndex = significantTokens.findIndex((token, index) => {
        return index > replaceIndex && token.token === "(";
      });
      const closeIndex = significantTokens.map((token) => token.token).lastIndexOf(")");

      if (openIndex >= 0 && closeIndex > openIndex) {
        const body = significantTokens.slice(openIndex + 1, closeIndex);
        const groups = [];
        let current = [];
        const baseDepth = body.length > 0 ? body[0].paren_depth : 0;

        for (const token of body) {
          if (token.token === "," && token.paren_depth === baseDepth) {
            if (current.length > 0) groups.push(current);
            current = [];
          } else {
            current.push(token);
          }
        }
        if (current.length > 0) groups.push(current);

        for (const group of groups) {
          let asIndex = -1;
          const groupDepth = group.length > 0 ? group[0].paren_depth : 0;
          for (let index = group.length - 1; index >= 0; index--) {
            if (group[index].normalized_token === "AS" && group[index].paren_depth === groupDepth) {
              asIndex = index;
              break;
            }
          }
          if (asIndex <= 0 || asIndex >= group.length - 1) continue;
          const aliasToken = group[asIndex + 1];
          const expressionPart = group.slice(0, asIndex);
          if (!this.#isIdentifierToken(aliasToken) || expressionPart.length === 0) continue;
          replacements.push({
            output_column_name: aliasToken.normalized_token,
            expression: this.#tokensToText(expressionPart),
            expression_start_seq: expressionPart[0].token_seq,
            expression_end_seq: expressionPart[expressionPart.length - 1].token_seq
          });
        }
      }
    }

    const wildcardTokens = significantTokens.slice(0, wildcardEndIndex);

    if (wildcardTokens.length === 1 && wildcardTokens[0].token === "*") {
      return {
        wildcard_type: "ALL",
        wildcard_qualifier: null,
        wildcard_exclusions: exclusions,
        wildcard_replacements: replacements
      };
    }

    if (wildcardTokens.length >= 3) {
      const wildcardToken = wildcardTokens[wildcardTokens.length - 1];
      const dotToken = wildcardTokens[wildcardTokens.length - 2];
      const qualifierToken = wildcardTokens[wildcardTokens.length - 3];
      if (wildcardToken.token === "*" && dotToken.token === "." && this.#isIdentifierToken(qualifierToken)) {
        return {
          wildcard_type: "QUALIFIED",
          wildcard_qualifier: qualifierToken.normalized_token,
          wildcard_exclusions: exclusions,
          wildcard_replacements: replacements
        };
      }
    }

    return {
      wildcard_type: null,
      wildcard_qualifier: null,
      wildcard_exclusions: [],
      wildcard_replacements: []
    };
  }

  /**
   * Tokenがalias名として利用可能な識別子か判定する。
   *
   * 通常識別子とバッククォート識別子を許可する。
   * Keywordを無条件に許可するとSQL構造との区別が曖昧になるため、
   * Keywordをaliasにする場合はバッククォートで囲むことを前提とする。
   *
   * @param {object} token
   * @returns {boolean}
   */
  #isAliasToken(token) {
    return this.#isIdentifierToken(token);
  }

  /**
   * Tokenが通常またはバッククォート識別子か判定する。
   *
   * @param {object} token
   * @returns {boolean}
   */
  #isIdentifierToken(token) {
    return ["IDENTIFIER", "BACKTICK_IDENTIFIER"].includes(token.token_type);
  }

  /**
   * SELECT項目の暗黙出力列名として使える「列名Token」か判定する。
   *
   * `#isIdentifierToken` は IDENTIFIER / BACKTICK のみを名前として扱うが、
   * BigQueryでは `OFFSET`（`UNNEST(arr) WITH OFFSET AS offset` の別名）のように、
   * キーワードでも識別子（列名）として使える語がある。ExpressionParser は
   * これらを IDENTIFIER_EXPRESSION として解決するため、出力名の導出も同じ基準に
   * 合わせる。真に予約された語（NULL/TRUE/FALSE や論理・句キーワード）は
   * 列名にならないため除外し、無名（UNNAMED）のままにする。
   */
  #isColumnNameToken(token) {
    if (["IDENTIFIER", "BACKTICK_IDENTIFIER"].includes(token.token_type)) {
      return true;
    }

    if (token.token_type !== "KEYWORD") {
      return false;
    }

    const reserved = [
      "AND", "OR", "NOT", "IN", "BETWEEN", "IS", "LIKE", "NULL", "TRUE", "FALSE",
      "CASE", "WHEN", "THEN", "ELSE", "END", "EXISTS",
      "OVER", "PARTITION", "ORDER", "BY", "ROWS", "RANGE", "GROUPS",
      "ASC", "DESC", "NULLS", "FIRST", "LAST"
    ];

    return !reserved.includes(token.normalized_token);
  }

  /**
   * 指定Tokenの直後に暗黙aliasを置けるか判定する。
   *
   * 式の末尾として自然なものだけを許可する。
   * これにより「a + b」のbをaliasと誤認することを防ぐ。
   *
   * @param {object} token
   * @returns {boolean}
   */
  #canEndExpression(token) {
    if (["IDENTIFIER", "BACKTICK_IDENTIFIER", "NUMBER", "STRING"].includes(token.token_type)) {
      return true;
    }

    if (token.token === ")" || token.token === "]") {
      return true;
    }

    if (["END", "NULL", "TRUE", "FALSE"].includes(token.normalized_token)) {
      return true;
    }

    return false;
  }

  /**
   * Token配列の先頭と末尾にあるCOMMENT Tokenを除外する。
   *
   * 項目内部のCOMMENTは式の位置情報や再構成に必要なため残す。
   * 先頭・末尾COMMENTだけを除外することで、expression_start_seqと
   * expression_end_seqが実際の式を指すようにする。
   *
   * @param {Array<object>} tokens
   * @returns {Array<object>}
   */
  #removeCommentTokens(tokens) {
    let startIndex = 0;
    let endIndex = tokens.length - 1;

    while (startIndex <= endIndex && tokens[startIndex].token_type === "COMMENT") {
      startIndex++;
    }

    while (endIndex >= startIndex && tokens[endIndex].token_type === "COMMENT") {
      endIndex--;
    }

    return tokens.slice(startIndex, endIndex + 1);
  }

  /**
   * Token配列を確認用のSQL断片へ戻す。
   *
   * Lexerは空白Tokenを保持しないため、完全な原文復元ではない。
   * この文字列は解析結果の確認・ログ・デバッグ用途であり、
   * SQL再実行用の厳密な再構築を目的としない。
   *
   * @param {Array<object>} tokens
   * @returns {string}
   */
  #tokensToText(tokens) {
    let sqlText = "";
    let previousToken = null;

    for (const currentToken of tokens) {
      if (previousToken && this.#requiresTokenSeparator(previousToken, currentToken)) {
        sqlText += " ";
      }

      sqlText += currentToken.token;
      previousToken = currentToken;
    }

    return sqlText;
  }

  /**
   * 空白Tokenを保持しないLexerのToken列から、単語同士の境界だけを復元する。
   *
   * 例:
   *   DISTINCT + order_id -> DISTINCT order_id
   *   CASE + WHEN         -> CASE WHEN
   *   cs + . + amount     -> cs.amount
   *   SUM + (             -> SUM(
   *
   * 演算子の前後やカンマ後の整形までは行わない。expressionはSQL再生成用ではなく、
   * ログ・確認用途の読みやすいSQL断片として扱う。
   *
   * @param {object} previousToken
   * @param {object} currentToken
   * @returns {boolean}
   */
  #requiresTokenSeparator(previousToken, currentToken) {
    const wordTokenTypes = new Set([
      "KEYWORD",
      "IDENTIFIER",
      "BACKTICK_IDENTIFIER",
      "NUMBER",
      "STRING"
    ]);

    return wordTokenTypes.has(previousToken.token_type)
      && wordTokenTypes.has(currentToken.token_type);
  }
}

// ============================================================
// SOURCE: src/expression_parser.js
// ============================================================
/**
 * SQL式を演算子優先順位付きASTへ変換する再帰下降Parser。
 *
 * Public APIはparseExpression()のみ。privateメソッドの呼び出し階層が
 * SQL演算子の優先順位を表す。
 */
class ExpressionParser {
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("ExpressionParser: tokens must be an array.");
    }

    this.sourceTokens = tokens;
    this.tokens = [];
    this.index = 0;
  }

  parseExpression(startTokenSeq = null, endTokenSeq = null) {
    const expressionTokens = this.#selectExpressionTokens(startTokenSeq, endTokenSeq);

    /* 元Token配列は変更せず、Expression解析用配列だけからコメントを除く。 */
    this.tokens = this.#removeCommentTokens(expressionTokens);
    this.index = 0;

    if (this.tokens.length === 0) {
      throw new SyntaxError("ExpressionParser: expression contains no tokens.");
    }

    const expressionNode = this.#parseOrExpression();

    if (!this.#isEnd()) {
      const token = this.#current();
      throw new SyntaxError(
        `ExpressionParser: unexpected token "${token.token}" at token_seq ${token.token_seq}.`
      );
    }

    return expressionNode;
  }

  #parseOrExpression() {
    let leftNode = this.#parseAndExpression();

    while (this.#matches("OR")) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseAndExpression();
      leftNode = AstFactory.createBinary(
        NodeType.LOGICAL_EXPRESSION,
        operatorToken.normalized_token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseAndExpression() {
    let leftNode = this.#parseNotExpression();

    while (this.#matches("AND")) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseNotExpression();
      leftNode = AstFactory.createBinary(
        NodeType.LOGICAL_EXPRESSION,
        operatorToken.normalized_token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseNotExpression() {
    if (this.#matches("NOT") && this.#peek(1)?.normalized_token === "EXISTS") {
      const notToken = this.#consume();
      return this.#parseExistsExpression(true, notToken.token_seq);
    }

    if (this.#matches("NOT")) {
      const operatorToken = this.#consume();
      const operandNode = this.#parseNotExpression();
      return AstFactory.createUnary(
        operatorToken.normalized_token,
        operatorToken.token_seq,
        operandNode
      );
    }

    return this.#parseComparisonExpression();
  }

  #parseComparisonExpression() {
    const leftNode = this.#parseConcatenationExpression();

    if (this.#matchesAny(["=", "!=", "<>", "<", "<=", ">", ">="])) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseConcatenationExpression();
      return AstFactory.createBinary(
        NodeType.COMPARISON_EXPRESSION,
        operatorToken.normalized_token,
        leftNode,
        rightNode
      );
    }

    if (this.#matches("IN")) {
      this.#consume();
      return this.#parseInExpression(leftNode, false);
    }

    if (this.#matches("BETWEEN")) {
      this.#consume();
      return this.#parseBetweenExpression(leftNode, false);
    }

    if (this.#matches("IS")) {
      this.#consume();
      return this.#parseIsExpression(leftNode);
    }

    if (this.#matches("LIKE")) {
      return this.#parseLikeExpression(leftNode, false);
    }

    if (this.#matches("NOT")) {
      const markedIndex = this.index;
      this.#consume();

      if (this.#matches("IN")) {
        this.#consume();
        return this.#parseInExpression(leftNode, true);
      }

      if (this.#matches("BETWEEN")) {
        this.#consume();
        return this.#parseBetweenExpression(leftNode, true);
      }

      if (this.#matches("LIKE")) {
        return this.#parseLikeExpression(leftNode, true);
      }

      this.index = markedIndex;
    }

    return leftNode;
  }

  /*
   * `expr [NOT] LIKE pattern` を解析する。
   *
   * BigQueryの数量子付き `LIKE ANY|SOME|ALL (...)` にも対応する。数量子形は
   * パターン集合をINと同じ括弧内式リストとして取り込み、lineage上は左辺と
   * 各パターン式の依存を保持できれば十分なのでIN式として表現する。
   * 通常形は比較式(COMPARISON_EXPRESSION)として表現する。
   */
  #parseLikeExpression(leftNode, isNegated) {
    const operatorToken = this.#consume();
    const operatorText = isNegated ? "NOT LIKE" : operatorToken.normalized_token;

    if (this.#matchesAny(["ANY", "SOME", "ALL"])) {
      this.#consume();
      return this.#parseInExpression(leftNode, isNegated);
    }

    const rightNode = this.#parseConcatenationExpression();

    return AstFactory.createBinary(
      NodeType.COMPARISON_EXPRESSION,
      operatorText,
      leftNode,
      rightNode
    );
  }

  #parseConcatenationExpression() {
    let leftNode = this.#parseAdditiveExpression();

    while (this.#matches("||", false)) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseAdditiveExpression();
      leftNode = AstFactory.createBinary(
        NodeType.CONCATENATION_EXPRESSION,
        operatorToken.token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseAdditiveExpression() {
    let leftNode = this.#parseMultiplicativeExpression();

    while (this.#matchesAny(["+", "-"], false)) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseMultiplicativeExpression();
      leftNode = AstFactory.createBinary(
        NodeType.ARITHMETIC_EXPRESSION,
        operatorToken.token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseMultiplicativeExpression() {
    let leftNode = this.#parseUnaryExpression();

    while (this.#matchesAny(["*", "/", "%"], false)) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseUnaryExpression();
      leftNode = AstFactory.createBinary(
        NodeType.ARITHMETIC_EXPRESSION,
        operatorToken.token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseUnaryExpression() {
    if (this.#matchesAny(["+", "-"], false)) {
      const operatorToken = this.#consume();
      const operandNode = this.#parseUnaryExpression();
      return AstFactory.createUnary(operatorToken.token, operatorToken.token_seq, operandNode);
    }

    return this.#parsePostfixExpression();
  }

  /**
   * Primary Expressionの直後に続く後置構文を解析する。
   *
   * 現在はウィンドウ関数のOVER句を対象とする。
   * 関数呼び出しを先にPrimaryとして作成し、その後ろのOVERを結び付ける。
   */
  #parsePostfixExpression() {
    let expressionNode = this.#parsePrimaryExpression();

    while (true) {
      if (this.#matches("OVER")) {
        expressionNode = this.#parseWindowExpression(expressionNode);
        continue;
      }

      // Array element access: base[OFFSET(n)] / [SAFE_OFFSET(n)] /
      // [ORDINAL(n)] / [SAFE_ORDINAL(n)] / [expr]. A '[' here is postfix
      // (subscript); a leading '[' (array literal) is handled in the primary.
      if (this.#matches("[", false)) {
        expressionNode = this.#parseArraySubscript(expressionNode);
        continue;
      }

      // Field access on a completed value expression: fn(...).field,
      // (expr).field, arr[i].field. This '.' follows a call / parenthesized /
      // subscript result, NOT an identifier chain (a.b.c is fully consumed by
      // #parseIdentifierOrFunctionCall before it returns, so its '.' never
      // reaches here). Guard on an identifier after the dot so a stray '.' still
      // falls through unchanged.
      if (this.#matches(".", false)) {
        const afterDot = this.#peek(1);

        if (afterDot && (this.#isIdentifierToken(afterDot) || afterDot.token === "*")) {
          expressionNode = this.#parseFieldAccess(expressionNode);
          continue;
        }
      }

      break;
    }

    return expressionNode;
  }

  /**
   * 後置の配列添字アクセス base[...] を解析する。
   *
   * BigQueryの位置指定 OFFSET / SAFE_OFFSET / ORDINAL / SAFE_ORDINAL は、位置を
   * 表すだけでlineageを持たないため、その引数（添字式）だけを残す。要素値の
   * lineageは配列式（base）の元列に由来する。baseと添字式の両方を子に持つ合成
   * 呼び出しノードにして、依存収集が両者を辿れるようにする。
   */
  #parseArraySubscript(baseNode) {
    const openBracket = this.#expect("[", false);
    let indexNode;

    if (this.#matchesAny(["OFFSET", "ORDINAL", "SAFE_OFFSET", "SAFE_ORDINAL"])) {
      this.#consume();
      this.#expect("(", false);
      indexNode = this.#parseOrExpression();
      this.#expect(")", false);
    } else {
      indexNode = this.#parseOrExpression();
    }

    const closeBracket = this.#expect("]", false);

    const nameToken = {
      token_seq: baseNode.start_token_seq,
      token: "[",
      normalized_token: "["
    };

    return AstFactory.createFunctionCall(
      [nameToken],
      [baseNode, indexNode],
      openBracket,
      closeBracket
    );
  }

  /**
   * 完了済みの値式（関数呼び出し / 括弧式 / 添字アクセスの結果）に続く後置の
   * フィールドアクセス base.field を解析する。
   *
   * ここでの '.' は「値」に対するフィールド選択であり、識別子チェーン a.b.c
   * （#parseIdentifierOrFunctionCall が先に消費する）とは異なる。関数の戻り値
   * などの不透明/派生値の STRUCT フィールドを指すため、末尾フィールド名は物理列
   * として解決せず lineage を持たない。base（関数なら引数）の lineage だけを
   * 残す。位置キーワードを非計上にした配列添字 base[...] と同じ設計。
   * 例：myfn('key', event_params).string_value → 依存は event_params のみ、
   * .string_value は非計上（かつては RAW_EXPRESSION に退避して string_value を
   * 裸の列として誤解決し PHYSICAL_COLUMN_NOT_FOUND を出していた）。
   */
  #parseFieldAccess(baseNode) {
    const dotToken = this.#expect(".", false);
    const fieldToken = this.#consume();

    const nameToken = {
      token_seq: baseNode.start_token_seq,
      token: ".",
      normalized_token: "."
    };

    return AstFactory.createFunctionCall(
      [nameToken],
      [baseNode],
      dotToken,
      fieldToken
    );
  }

  #parsePrimaryExpression() {
    const token = this.#current();

    if (!token) {
      throw new SyntaxError("ExpressionParser: expression ended unexpectedly.");
    }

    if (token.normalized_token === "CASE") {
      return this.#parseCaseExpression();
    }

    if (token.normalized_token === "EXISTS") {
      return this.#parseExistsExpression(false, token.token_seq);
    }

    if (token.token === "(") {
      return this.#parseParenthesizedExpression();
    }

    if (token.token === "[") {
      return this.#parseArrayLiteral();
    }

    if (this.#isTypedLiteralPrefix(token)) {
      return this.#parseTypedLiteral();
    }

    if (token.normalized_token === "INTERVAL") {
      return this.#parseIntervalExpression();
    }

    if (this.#isLiteralToken(token)) {
      return this.#parseLiteral();
    }

    // Typed STRUCT constructor STRUCT<field type, ...>(v1, v2, ...). The angle-
    // bracket type list is not a comparison; skip it and keep the value lineage.
    if (
      token.normalized_token === "STRUCT" &&
      this.#peek(1) &&
      this.#peek(1).token === "<"
    ) {
      return this.#parseTypedStruct();
    }

    // Typed ARRAY constructor ARRAY<element type>[e1, e2, ...] (or ARRAY<...>(
    // SELECT ...)). The angle-bracket type is skipped; the element/subquery
    // lineage is kept.
    if (
      token.normalized_token === "ARRAY" &&
      this.#peek(1) &&
      this.#peek(1).token === "<"
    ) {
      return this.#parseTypedArray();
    }

    if (this.#isIdentifierToken(token) || token.token === "*") {
      return this.#parseIdentifierOrFunctionCall();
    }

    // BigQuery named query parameter @name (and @@system_variable), e.g. the
    // dbt-style @key / @limit placeholders in JOBS-collected SQL. The lexer emits
    // the whole thing as one PARAMETER token. A parameter is an external scalar
    // value, not a table column, so it carries no lineage (treated as a literal).
    if (token.token_type === "PARAMETER") {
      this.#consume();
      return AstFactory.createLiteral(token, "PARAMETER", null);
    }

    throw new SyntaxError(
      `ExpressionParser: token "${token.token}" cannot start an expression ` +
      `(token_seq ${token.token_seq}).`
    );
  }

  /**
   * 名前付きクエリパラメータ @name / システム変数 @@name を解析する。
   *
   * パラメータは外部から与えられるスカラー値であってテーブル列ではないため、
   * lineage を持たない。リテラル同様に LITERAL_EXPRESSION として扱い、列参照を
   * 生成しない。Lexer は '@' を単独 Token として返し、名前がそれに続く
   * （@@ の場合は '@' が 2 つ）。
   */
  /**
   * EXTRACT の先頭に置かれるデートパートを読み飛ばす（lineage を持たない）。
   * 単一のパート Token（MONTH / WEEK / DATE / DAYOFWEEK / ISOWEEK ...）に加え、
   * WEEK(<WEEKDAY>) の括弧付き形も消費する。
   */
  #consumeDatePart() {
    this.#consume();

    if (this.#matches("(", false)) {
      this.#consume();

      while (!this.#isEnd() && !this.#matches(")", false)) {
        this.#consume();
      }

      this.#expect(")", false);
    }
  }

  /**
   * 型付き STRUCT コンストラクタ STRUCT<field type, ...>(v1, v2, ...) を解析する。
   * 山括弧の型パラメータ（`<` ... `>`、ネスト可）は列参照を持たないため読み飛ばし、
   * 値リスト (v1, v2, ...) の各要素を lineage 付きで EXPRESSION_LIST として返す。
   */
  #parseTypedStruct() {
    this.#consume();
    this.#skipAngleBracketType();

    const openToken = this.#expect("(", false);
    const items = [];

    if (!this.#matches(")", false)) {
      while (true) {
        items.push(this.#parseOrExpression());

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    const closeToken = this.#expect(")", false);
    return AstFactory.createExpressionList(items, openToken, closeToken);
  }

  /**
   * 型付き ARRAY コンストラクタ ARRAY<element type>[e1, e2, ...] を解析する。
   * 山括弧の型を読み飛ばし、要素配列リテラル（または ARRAY<...>(SELECT ...)）の
   * lineage を保持する。
   */
  #parseTypedArray() {
    this.#consume();
    this.#skipAngleBracketType();

    if (this.#matches("[", false)) {
      return this.#parseArrayLiteral();
    }

    const openToken = this.#expect("(", false);
    return this.#parseRawSubquery(openToken, "ARRAY");
  }

  /**
   * 山括弧の型パラメータ `<` ... `>`（ネスト可）を読み飛ばす。開き山括弧に
   * 位置している前提で呼ぶ。型パラメータは列参照を持たない。
   */
  #skipAngleBracketType() {
    this.#expect("<", false);

    let angleDepth = 1;

    while (!this.#isEnd() && angleDepth > 0) {
      const typeToken = this.#consume();

      if (typeToken.token === "<") {
        angleDepth += 1;
      } else if (typeToken.token === ">") {
        angleDepth -= 1;
      }
    }
  }

  /**
   * 関数呼び出しに続くOVER句を解析する。
   *
   * 対象例:
   *   ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC)
   *
   * OVERは通常の二項演算子ではなく、直前の関数呼び出しへ
   * Window Specificationを付加する後置構文として扱う。
   */
  #parseWindowExpression(functionNode) {
    if (functionNode.node_type !== NodeType.FUNCTION_CALL_EXPRESSION) {
      throw new SyntaxError(
        "ExpressionParser: OVER must follow a function call."
      );
    }

    const overToken = this.#expect("OVER");

    /*
     * BigQueryではOVER named_windowの形式も利用できる。
     * 括弧がなければWindow名を識別子として保持する。
     */
    if (!this.#matches("(", false)) {
      const windowName = this.#parseIdentifierOrFunctionCall();

      if (windowName.node_type !== NodeType.IDENTIFIER_EXPRESSION) {
        throw new SyntaxError(
          "ExpressionParser: a window name was expected after OVER."
        );
      }

      const specification = AstFactory.createWindowSpecification(
        null,
        null,
        [],
        [],
        [],
        windowName
      );

      return AstFactory.createWindowExpression(
        functionNode,
        specification,
        overToken.token_seq
      );
    }

    const openToken = this.#expect("(", false);
    const partitionBy = [];
    const orderBy = [];
    const frameTokens = [];

    if (this.#matches("PARTITION")) {
      this.#consume();
      this.#expect("BY");

      while (true) {
        partitionBy.push(
          this.#parseWindowSubExpression(["ORDER", "ROWS", "RANGE", "GROUPS"], [",", ")"])
        );

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    if (this.#matches("ORDER")) {
      this.#consume();
      this.#expect("BY");

      while (true) {
        orderBy.push(this.#parseWindowOrderItem());

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    /*
     * ROWS / RANGE / GROUPSのFrame句は、v1では意味解析せずToken情報を保持する。
     * Window境界を失わないため、閉じ括弧までのTokenを保存する。
     */
    if (this.#matchesAny(["ROWS", "RANGE", "GROUPS"])) {
      while (!this.#isEnd() && !this.#matches(")", false)) {
        const token = this.#consume();
        frameTokens.push({
          token_seq: token.token_seq,
          token: token.token,
          normalized_token: token.normalized_token
        });
      }
    }

    const closeToken = this.#expect(")", false);
    const specification = AstFactory.createWindowSpecification(
      openToken,
      closeToken,
      partitionBy,
      orderBy,
      frameTokens
    );

    return AstFactory.createWindowExpression(
      functionNode,
      specification,
      overToken.token_seq
    );
  }

  /**
   * Window内ORDER BYの1項目を解析する。
   *
   * 通常Expressionに加えて、ASC/DESCとNULLS FIRST/LASTを属性として保持する。
   */
  #parseWindowOrderItem() {
    const expressionNode = this.#parseWindowSubExpression(
      ["ASC", "DESC", "NULLS", "ROWS", "RANGE", "GROUPS"],
      [",", ")"]
    );
    let direction = null;
    let nullsOrder = null;

    if (this.#matchesAny(["ASC", "DESC"])) {
      direction = this.#consume().normalized_token;
    }

    if (this.#matches("NULLS")) {
      this.#consume();

      if (!this.#matchesAny(["FIRST", "LAST"])) {
        throw new SyntaxError(
          "ExpressionParser: NULLS must be followed by FIRST or LAST."
        );
      }

      nullsOrder = this.#consume().normalized_token;
    }

    return AstFactory.createWindowOrderItem(
      expressionNode,
      direction,
      nullsOrder
    );
  }

  /**
   * Window Specification内の1つの式だけを切り出して解析する。
   *
   * 親ExpressionParserの現在位置を維持しながら、区切りToken直前までを
   * 子ExpressionParserへ渡す。これによりPARTITION BYやORDER BY内部でも、
   * 通常の関数・算術式・CASE式を再利用できる。
   */
  #parseWindowSubExpression(stopKeywords, stopTokens) {
    const startIndex = this.index;
    let nestedDepth = 0;

    while (!this.#isEnd()) {
      const token = this.#current();

      if (token.token === "(") {
        nestedDepth++;
        this.index++;
        continue;
      }

      if (token.token === ")") {
        /*
         * 深さ0の ")" だけがWindow Specificationやサブ式の終端になりうる。
         * 内側の関数呼び出し（例: SAFE_CAST(...)）を閉じる ")" は深さ1以上で
         * 現れるため、ここで終端と誤認せずに深さを戻して読み進める。
         */
        if (nestedDepth === 0 && stopTokens.includes(")")) {
          break;
        }

        nestedDepth--;
        this.index++;
        continue;
      }

      if (nestedDepth === 0) {
        if (stopTokens.includes(token.token)) {
          break;
        }

        if (stopKeywords.includes(token.normalized_token)) {
          break;
        }
      }

      this.index++;
    }

    const expressionTokens = this.tokens.slice(startIndex, this.index);

    if (expressionTokens.length === 0) {
      const currentToken = this.#current();
      throw new SyntaxError(
        `ExpressionParser: window expression was expected before ` +
        `"${currentToken ? currentToken.token : "EOF"}".`
      );
    }

    try {
      return new ExpressionParser(expressionTokens).parseExpression();
    } catch (error) {
      return createRawExpressionAst(expressionTokens);
    }
  }

  #parseCaseExpression() {
    const caseToken = this.#expect("CASE");
    let caseOperand = null;
    const whenClauses = [];
    let elseExpression = null;

    /* CASE直後がWHENでなければ、単純CASEの比較対象を解析する。 */
    if (!this.#matches("WHEN")) {
      caseOperand = this.#parseOrExpression();
    }

    while (this.#matches("WHEN")) {
      const whenToken = this.#consume();
      const conditionNode = this.#parseOrExpression();
      this.#expect("THEN");
      const resultNode = this.#parseOrExpression();
      whenClauses.push(
        AstFactory.createCaseWhen(conditionNode, resultNode, whenToken.token_seq)
      );
    }

    if (whenClauses.length === 0) {
      throw new SyntaxError("ExpressionParser: CASE requires at least one WHEN clause.");
    }

    if (this.#matches("ELSE")) {
      this.#consume();
      elseExpression = this.#parseOrExpression();
    }

    const endToken = this.#expect("END");
    return AstFactory.createCase(
      caseToken,
      caseOperand,
      whenClauses,
      elseExpression,
      endToken
    );
  }

  #parseExistsExpression(negated, startTokenSeq) {
    const existsToken = this.#expect("EXISTS");
    const openToken = this.#expect("(", false);

    if (!this.#matches("SELECT") && !this.#matches("WITH")) {
      throw new SyntaxError("ExpressionParser: EXISTS must contain a subquery.");
    }

    const subqueryNode = this.#parseRawSubquery(openToken);
    return AstFactory.createExists(
      negated ? startTokenSeq : existsToken.token_seq,
      subqueryNode,
      negated
    );
  }

  #parseIdentifierOrFunctionCall() {
    const nameTokens = [];
    const firstToken = this.#consume();
    nameTokens.push(firstToken);

    while (this.#matches(".", false)) {
      const dotToken = this.#consume();
      const nextToken = this.#current();

      if (!nextToken || (!this.#isIdentifierToken(nextToken) && nextToken.token !== "*")) {
        throw new SyntaxError(
          `ExpressionParser: identifier expected after token_seq ${dotToken.token_seq}.`
        );
      }

      nameTokens.push(dotToken);
      nameTokens.push(this.#consume());
    }

    if (this.#matches("(", false)) {
      return this.#parseFunctionCall(nameTokens);
    }

    if (nameTokens.at(-1).token === "*") {
      return AstFactory.createWildcard(nameTokens);
    }

    return AstFactory.createIdentifier(nameTokens);
  }

  #parseFunctionCall(nameTokens) {
    const openToken = this.#expect("(", false);
    const functionName = nameTokens
      .filter((token) => token.token !== ".")
      .map((token) => token.normalized_token)
      .join(".");

    /*
     * ARRAY(SELECT ...)は通常の関数引数ではない。
     * 括弧内を独立したQueryとして解析し、ARRAY_SUBQUERY_EXPRESSIONを返す。
     */
    if (
      functionName === "ARRAY" &&
      (this.#matches("SELECT") || this.#matches("WITH"))
    ) {
      return this.#parseRawSubquery(openToken, "ARRAY");
    }

    /*
     * CAST(expr AS type) / SAFE_CAST(expr AS type)。
     * 引数は「値式 AS 型」であり、通常の関数引数リストではない。
     * 値式だけを子Nodeに持つFUNCTION_CALLとして構築し、型指定Tokenは
     * lineageに寄与しないため読み飛ばす。型指定は精度付き型 NUMERIC(10, 2)、
     * 山括弧パラメータ ARRAY<INT64> / STRUCT<a INT64, b STRING>、末尾の
     * FORMAT 'pattern' 句を含みうる。CASTを閉じる ")" は括弧深さで判定する。
     */
    if (functionName === "CAST" || functionName === "SAFE_CAST") {
      const valueNode = this.#parseOrExpression();
      this.#expect("AS");

      let typeParenDepth = 0;
      while (!this.#isEnd()) {
        if (this.#matches("(", false)) {
          typeParenDepth += 1;
          this.#consume();
          continue;
        }
        if (this.#matches(")", false)) {
          if (typeParenDepth === 0) {
            break;
          }
          typeParenDepth -= 1;
          this.#consume();
          continue;
        }
        this.#consume();
      }

      const castCloseToken = this.#expect(")", false);
      return AstFactory.createFunctionCall(
        nameTokens,
        [valueNode],
        openToken,
        castCloseToken,
        null
      );
    }

    /*
     * EXTRACT(part FROM expr [AT TIME ZONE tz]) は通常の引数リストではない。
     * part はデートパート（MONTH / WEEK / DATE / ISOWEEK ... あるいは
     * WEEK(<WEEKDAY>)）で列参照ではないため lineage を持たない。ソース式
     * (expr) と、あれば時間帯式 (tz) だけを子として保持する。
     */
    if (functionName === "EXTRACT") {
      this.#consumeDatePart();
      this.#expect("FROM");

      const extractChildren = [this.#parseOrExpression()];

      if (this.#matches("AT")) {
        this.#consume();
        this.#expect("TIME");
        this.#expect("ZONE");
        extractChildren.push(this.#parseOrExpression());
      }

      const extractCloseToken = this.#expect(")", false);
      return AstFactory.createFunctionCall(
        nameTokens,
        extractChildren,
        openToken,
        extractCloseToken,
        null
      );
    }

    /*
     * WEEK(<WEEKDAY>) はスカラー関数ではなくデートパート（DATE_TRUNC 等の粒度
     * 指定に現れる）。WEEKDAY（MONDAY 等）は列ではないため lineage を持たない。
     */
    if (functionName === "WEEK") {
      while (!this.#isEnd() && !this.#matches(")", false)) {
        this.#consume();
      }

      const weekCloseToken = this.#expect(")", false);
      return AstFactory.createLiteral(weekCloseToken, "DATE_PART", null);
    }

    const argumentsList = [];
    let argumentModifier = null;

    /*
     * COUNT(DISTINCT column) など、関数引数の先頭に置かれる修飾子を扱う。
     * DISTINCT自体は列参照ではないため、引数ASTとは分離して保持する。
     */
    if (this.#matches("DISTINCT")) {
      argumentModifier = this.#consume().normalized_token;
    }

    if (!this.#matches(")", false)) {
      while (true) {
        argumentsList.push(this.#parseOrExpression());

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    /*
     * 集約/ナビゲーション関数の引数末尾に付く修飾句を消費する。
     *   ARRAY_AGG(x IGNORE NULLS ORDER BY ts LIMIT 5)
     *   FIRST_VALUE(x RESPECT NULLS)
     *   STRING_AGG(x, ',' ORDER BY y)
     * NULL処理(IGNORE|RESPECT NULLS)とLIMITは列系統に寄与しない。ORDER BY /
     * HAVING MAX|MIN の式は依存として引数リストへ取り込む。
     */
    this.#consumeFunctionArgumentSuffixes(argumentsList);

    const closeToken = this.#expect(")", false);
    return AstFactory.createFunctionCall(
      nameTokens,
      argumentsList,
      openToken,
      closeToken,
      argumentModifier
    );
  }

  #consumeFunctionArgumentSuffixes(argumentsList) {
    while (!this.#isEnd() && !this.#matches(")", false)) {
      if (this.#matches("IGNORE") || this.#matches("RESPECT")) {
        this.#consume();

        if (this.#matches("NULLS")) {
          this.#consume();
        }

        continue;
      }

      if (this.#matches("ORDER")) {
        this.#consume();
        this.#expect("BY");

        while (true) {
          argumentsList.push(this.#parseOrExpression());

          if (this.#matchesAny(["ASC", "DESC"])) {
            this.#consume();
          }

          if (this.#matches("NULLS")) {
            this.#consume();

            if (this.#matchesAny(["FIRST", "LAST"])) {
              this.#consume();
            }
          }

          if (!this.#matches(",", false)) {
            break;
          }

          this.#consume();
        }

        continue;
      }

      if (this.#matches("LIMIT")) {
        this.#consume();
        this.#parseOrExpression();
        continue;
      }

      if (this.#matches("HAVING")) {
        this.#consume();

        if (this.#matchesAny(["MAX", "MIN"])) {
          this.#consume();
        }

        argumentsList.push(this.#parseOrExpression());
        continue;
      }

      break;
    }
  }

  #parseParenthesizedExpression() {
    const openToken = this.#expect("(", false);

    if (this.#matches("SELECT") || this.#matches("WITH")) {
      return this.#parseRawSubquery(openToken);
    }

    const expressionNode = this.#parseOrExpression();

    /*
     * カンマが続く場合はタプル / STRUCT の行値。例：(a, b) IN (...) の左辺や、
     * 型付き STRUCT 配列リテラルの各行 (v1, v2)。各要素の lineage を保持するため
     * EXPRESSION_LIST として返す。
     */
    if (this.#matches(",", false)) {
      const items = [expressionNode];

      while (this.#matches(",", false)) {
        this.#consume();
        items.push(this.#parseOrExpression());
      }

      const listCloseToken = this.#expect(")", false);
      return AstFactory.createExpressionList(items, openToken, listCloseToken);
    }

    const closeToken = this.#expect(")", false);
    return AstFactory.createParenthesized(expressionNode, openToken, closeToken);
  }

  /*
   * 配列リテラル [e1, e2, ...] を解析する。要素式の列依存を保持できるよう
   * EXPRESSION_LIST ノードとして返す(UNNEST([...]) や SELECT [...] で使用)。
   */
  #parseArrayLiteral() {
    const openToken = this.#expect("[", false);
    const items = [];

    if (!this.#matches("]", false)) {
      while (true) {
        items.push(this.#parseOrExpression());

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    const closeToken = this.#expect("]", false);

    return AstFactory.createExpressionList(items, openToken, closeToken);
  }

  #parseInExpression(leftNode, negated) {
    /*
     * `x IN UNNEST(array_expr)` 形式。配列式の依存を保持する。
     */
    if (this.#matches("UNNEST")) {
      this.#consume();
      const unnestOpen = this.#expect("(", false);
      const arrayNode = this.#parseOrExpression();
      const unnestClose = this.#expect(")", false);
      const unnestValues = AstFactory.createExpressionList(
        [arrayNode],
        unnestOpen,
        unnestClose
      );

      return AstFactory.createIn(leftNode, unnestValues, negated);
    }

    const openToken = this.#expect("(", false);

    if (this.#matches("SELECT") || this.#matches("WITH")) {
      return AstFactory.createIn(leftNode, this.#parseRawSubquery(openToken), negated);
    }

    const values = [];

    if (!this.#matches(")", false)) {
      while (true) {
        values.push(this.#parseOrExpression());

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    const closeToken = this.#expect(")", false);
    const valuesNode = AstFactory.createExpressionList(values, openToken, closeToken);
    return AstFactory.createIn(leftNode, valuesNode, negated);
  }

  #parseBetweenExpression(leftNode, negated) {
    const lowerNode = this.#parseConcatenationExpression();
    this.#expect("AND");
    const upperNode = this.#parseConcatenationExpression();
    return AstFactory.createBetween(leftNode, lowerNode, upperNode, negated);
  }

  #parseIsExpression(leftNode) {
    let negated = false;

    if (this.#matches("NOT")) {
      this.#consume();
      negated = true;
    }

    if (this.#matches("DISTINCT")) {
      this.#consume();
      this.#expect("FROM");
      const rightNode = this.#parseConcatenationExpression();
      return AstFactory.createDistinctFrom(leftNode, rightNode, negated);
    }

    const testToken = this.#current();

    if (!testToken || !["NULL", "TRUE", "FALSE"].includes(testToken.normalized_token)) {
      throw new SyntaxError(
        "ExpressionParser: IS must be followed by NULL, TRUE, FALSE, or [NOT] DISTINCT FROM."
      );
    }

    this.#consume();
    return AstFactory.createIs(leftNode, testToken.normalized_token, negated, testToken.token_seq);
  }

  #parseLiteral() {
    const token = this.#consume();
    let literalType = token.token_type;
    let value = token.token;

    if (["NULL", "TRUE", "FALSE"].includes(token.normalized_token)) {
      literalType = token.normalized_token;
      value = token.normalized_token;
    }

    return AstFactory.createLiteral(token, literalType, value);
  }

  /*
   * 型付きリテラル(DATE '2020-01-01' / TIMESTAMP '...' / NUMERIC '1.5' 等)か
   * どうかを判定する。型キーワードの直後が文字列リテラルの場合のみ真。
   * DATE(...) のような関数呼び出しと区別するため、次Tokenが "(" の場合は
   * 型付きリテラルとしない。
   */
  #isTypedLiteralPrefix(token) {
    const typedLiteralKeywords = new Set([
      "DATE", "DATETIME", "TIME", "TIMESTAMP",
      "NUMERIC", "BIGNUMERIC", "DECIMAL", "BIGDECIMAL",
      "BYTES", "JSON", "RANGE"
    ]);

    return typedLiteralKeywords.has(token.normalized_token) &&
      this.#peek(1)?.token_type === "STRING";
  }

  #parseTypedLiteral() {
    const typeToken = this.#consume();
    const literalToken = this.#consume();

    return AstFactory.createLiteral(
      literalToken,
      typeToken.normalized_token,
      literalToken.token
    );
  }

  /*
   * INTERVAL 式を解析する。
   *
   * 対応形:
   *   INTERVAL 1 DAY
   *   INTERVAL '1' DAY
   *   INTERVAL col HOUR            -- 値が列参照なら依存として保持される
   *   INTERVAL n * 2 DAY           -- 値が算術式でも可
   *   INTERVAL '1:2:3' HOUR TO SECOND
   *
   * lineage上は値部の依存を保持できれば十分なため、値部の式ノードを返し、
   * 後続の単位(および TO 単位)は消費して構文を成立させる。
   *
   * 値部は加減算・乗除算を含む式（int64式）を取り得る。単項精度だけで解析すると
   * `INTERVAL n * 2 DAY` のように演算子の後ろへ続く単位を取りこぼし、
   * 関数引数内では「expected ) but found <part>」、素の式では単位の誤解決を招く。
   * 日付単位(DAY等)は裸のキーワードで演算子ではないため、加減算精度で解析しても
   * 必ず単位の手前で停止し、過剰消費しない。
   */
  #parseIntervalExpression() {
    this.#consume();

    const valueNode = this.#parseAdditiveExpression();

    if (this.#current() && this.#isIdentifierToken(this.#current())) {
      this.#consume();

      if (this.#matches("TO") && this.#peek(1) &&
          this.#isIdentifierToken(this.#peek(1))) {
        this.#consume();
        this.#consume();
      }
    }

    return valueNode;
  }

  #parseRawSubquery(openToken, subqueryKind = "SCALAR") {
    const startIndex = this.index;
    let nestedDepth = 0;

    while (!this.#isEnd()) {
      const token = this.#current();

      if (token.token === "(") {
        nestedDepth++;
      } else if (token.token === ")") {
        if (nestedDepth === 0) {
          const closeToken = this.#consume();
          const subqueryTokens = this.tokens.slice(startIndex, this.index - 1);
          const normalizedTokens = this.#normalizeSubqueryDepth(subqueryTokens);
          const queryAst = new QueryParser(normalizedTokens, {
            isSubquery: true
          }).parse();

          return AstFactory.createSubquery(
            openToken,
            closeToken,
            subqueryTokens,
            queryAst,
            subqueryKind
          );
        }

        nestedDepth--;
      }

      this.#consume();
    }

    throw new SyntaxError(
      `ExpressionParser: subquery beginning at token_seq ${openToken.token_seq} has no closing parenthesis.`
    );
  }

  #normalizeSubqueryDepth(subqueryTokens) {
    if (subqueryTokens.length === 0) {
      return [];
    }

    const minimumDepth = Math.min(...subqueryTokens.map((token) => token.paren_depth));

    return subqueryTokens.map((token) => ({
      ...token,
      paren_depth: token.paren_depth - minimumDepth
    }));
  }

  #selectExpressionTokens(startTokenSeq, endTokenSeq) {
    if (startTokenSeq === null && endTokenSeq === null) {
      return this.sourceTokens.slice();
    }

    if (!Number.isInteger(startTokenSeq) || !Number.isInteger(endTokenSeq)) {
      throw new TypeError(
        "ExpressionParser.parseExpression: token sequences must both be integers."
      );
    }

    if (endTokenSeq < startTokenSeq) {
      throw new RangeError(
        "ExpressionParser.parseExpression: endTokenSeq is before startTokenSeq."
      );
    }

    return this.sourceTokens.filter((token) => {
      return token.token_seq >= startTokenSeq && token.token_seq <= endTokenSeq;
    });
  }

  #removeCommentTokens(tokens) {
    return tokens.filter((token) => token.token_type !== "COMMENT");
  }

  #isLiteralToken(token) {
    return token.token_type === "NUMBER" ||
      token.token_type === "STRING" ||
      ["NULL", "TRUE", "FALSE"].includes(token.normalized_token);
  }

  #isIdentifierToken(token) {
    const reserved = [
      "AND", "OR", "NOT", "IN", "BETWEEN", "IS", "LIKE", "NULL", "TRUE", "FALSE",
      "CASE", "WHEN", "THEN", "ELSE", "END", "EXISTS",
      "OVER", "PARTITION", "ORDER", "BY", "ROWS", "RANGE", "GROUPS",
      "ASC", "DESC", "NULLS", "FIRST", "LAST"
    ];

    return token.token_type === "IDENTIFIER" ||
      token.token_type === "BACKTICK_IDENTIFIER" ||
      (token.token_type === "KEYWORD" && !reserved.includes(token.normalized_token));
  }

  #current() {
    return this.tokens[this.index] || null;
  }

  #peek(offset = 0) {
    return this.tokens[this.index + offset] || null;
  }

  #consume() {
    const token = this.#current();
    if (token) this.index++;
    return token;
  }

  #isEnd() {
    return this.index >= this.tokens.length;
  }

  #matches(value, normalized = true) {
    const token = this.#current();
    if (!token) return false;

    const actualValue = normalized ? token.normalized_token : token.token;
    const expectedValue = normalized ? String(value).toUpperCase() : String(value);
    return actualValue === expectedValue;
  }

  #matchesAny(values, normalized = true) {
    return values.some((value) => this.#matches(value, normalized));
  }

  #expect(value, normalized = true) {
    if (!this.#matches(value, normalized)) {
      const token = this.#current();
      const actualValue = token ? token.token : "EOF";
      throw new SyntaxError(
        `ExpressionParser: expected "${value}", but found "${actualValue}".`
      );
    }

    return this.#consume();
  }
}

// ============================================================
// SOURCE: src/column_resolver.js
// ============================================================
/**
 * Query AST内のIDENTIFIER_EXPRESSIONをSourceResolverのscopeへ結び付ける。
 *
 * ColumnResolverの責務:
 *
 * - SELECT、JOIN ON、WHERE、GROUP BY、HAVING、QUALIFY、ORDER BYなどから
 *   カラム参照を収集する。
 * - `s.amount`のような修飾参照では、修飾子`s`をSourceResolverで解決する。
 * - `amount`のような非修飾参照では、現在scope内の候補Sourceを列挙する。
 * - CTEとFROMサブクエリについては、SELECT出力名を利用して列名を検証する。
 * - 物理テーブルはスキーマ情報がまだ無いため、Sourceまでは解決するが、
 *   実カラムの存在確認は後続のPhysicalColumnResolverへ委譲する。
 *
 * このクラスはSQL文字列を再解析しない。
 * SelectParserがまだ式ASTを保持していない箇所だけ、token_seq範囲から
 * ExpressionParserを呼び、既存のParserロジックを再利用する。
 */
class ColumnResolver {
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("ColumnResolver: tokens must be an array.");
    }

    this.tokens = tokens;
    this.nextReferenceId = 1;
    this.queryByScopeId = new Map();
    this.scopeById = new Map();
  }

  /**
   * Query ASTとSourceResolver結果から、カラム参照一覧を作る公開入口。
   *
   * @param {object} queryAst QueryParserが生成したROOT Query AST
   * @param {object} sourceResolution SourceResolver.resolve()の戻り値
   * @returns {object}
   */
  resolve(queryAst, sourceResolution) {
    this.#validateInputs(queryAst, sourceResolution);

    this.nextReferenceId = 1;
    this.queryByScopeId = new Map();
    this.scopeById = new Map(
      sourceResolution.scopes.map((scope) => [scope.scope_id, scope])
    );

    this.#mapQueriesToScopes(queryAst, sourceResolution);

    const columnReferences = [];

    for (const scope of sourceResolution.scopes) {
      const scopedQuery = this.queryByScopeId.get(scope.scope_id);

      if (!scopedQuery) {
        continue;
      }

      this.#collectQueryReferences(
        scopedQuery,
        scope,
        sourceResolution,
        columnReferences
      );
    }

    return {
      node_type: "COLUMN_RESOLUTION",
      root_scope_id: sourceResolution.root_scope_id,
      column_references: columnReferences
    };
  }

  /**
   * Query ASTとSourceResolver scopeをtoken範囲で対応付ける。
   *
   * SourceResolverは各scopeにquery_start_token_seq / query_end_token_seqを
   * 保持しているため、Query ASTの同じ範囲と一意に対応できる。
   */
  #mapQueriesToScopes(rootQueryAst, sourceResolution) {
    const queries = [];

    this.#collectQueryAsts(rootQueryAst, queries);

    for (const scope of sourceResolution.scopes) {
      const queryAst = queries.find((query) => {
        return query.start_token_seq === scope.query_start_token_seq &&
          query.end_token_seq === scope.query_end_token_seq;
      });

      if (queryAst) {
        this.queryByScopeId.set(scope.scope_id, queryAst);
      }
    }
  }

  #collectQueryAsts(queryAst, result) {
    result.push(queryAst);

    for (const setOperation of queryAst.set_operations || []) {
      if (setOperation.query?.node_type === "QUERY") {
        this.#collectQueryAsts(setOperation.query, result);
      }
    }

    const ctes = Array.isArray(queryAst.common_table_expressions)
      ? queryAst.common_table_expressions
      : [];

    for (const cte of ctes) {
      if (cte.query?.node_type === "QUERY") {
        this.#collectQueryAsts(cte.query, result);
      }
    }

    const fromSources = [];

    if (queryAst.from?.source) {
      fromSources.push(queryAst.from.source);
    }

    for (const join of queryAst.from?.joins || []) {
      fromSources.push(join.source);
    }

    for (const source of fromSources) {
      if (source.query_ast?.node_type === "QUERY") {
        this.#collectQueryAsts(source.query_ast, result);
      }
    }

    const expressionNodes = [];
    for (const item of queryAst.select || []) if (item.expression_ast) expressionNodes.push(item.expression_ast);
    for (const join of queryAst.from?.joins || []) {
      if (join.condition) expressionNodes.push(join.condition);
      if (join.source?.source_type === "UNNEST" && join.source.expression) expressionNodes.push(join.source.expression);
    }
    if (queryAst.from?.source?.source_type === "UNNEST" && queryAst.from.source.expression) expressionNodes.push(queryAst.from.source.expression);
    if (queryAst.where?.expression) expressionNodes.push(queryAst.where.expression);
    for (const item of queryAst.group_by?.items || []) if (item.expression) expressionNodes.push(item.expression);
    if (queryAst.having?.expression) expressionNodes.push(queryAst.having.expression);
    if (queryAst.qualify?.expression) expressionNodes.push(queryAst.qualify.expression);
    for (const item of queryAst.order_by?.items || []) if (item.expression) expressionNodes.push(item.expression);

    for (const expressionNode of expressionNodes) {
      this.#collectSubqueryQueryAsts(expressionNode, result);
    }
  }

  #collectSubqueryQueryAsts(node, result) {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const item of node) this.#collectSubqueryQueryAsts(item, result);
      return;
    }

    if (
      (node.node_type === NodeType.SUBQUERY_EXPRESSION ||
       node.node_type === NodeType.ARRAY_SUBQUERY_EXPRESSION) &&
      node.query_ast?.node_type === "QUERY"
    ) {
      this.#collectQueryAsts(node.query_ast, result);
      return;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") this.#collectSubqueryQueryAsts(value, result);
    }
  }

  /**
   * 1つのQuery scopeから、ClauseごとのExpressionを収集する。
   */
  #collectQueryReferences(queryAst, scope, sourceResolution, result) {
    for (const selectItem of queryAst.select || []) {
      if (selectItem.wildcard_type) {
        this.#collectWildcardReference(selectItem, scope, sourceResolution, result);
        for (const replacement of selectItem.wildcard_replacements || []) {
          const replacementAst = this.#parseExpressionRange(
            replacement.expression_start_seq,
            replacement.expression_end_seq
          );
          this.#collectFromAst(replacementAst, {
            clause_type: "SELECT",
            select_item_seq: selectItem.select_item_seq
          }, scope, sourceResolution, result);
        }
        continue;
      }

      const expressionAst = selectItem.expression_ast || this.#parseExpressionRange(
        selectItem.expression_start_seq,
        selectItem.expression_end_seq
      );

      this.#collectFromAst(expressionAst, {
        clause_type: "SELECT",
        select_item_seq: selectItem.select_item_seq
      }, scope, sourceResolution, result);
    }

    for (const join of queryAst.from?.joins || []) {
      if (join.condition) {
        this.#collectFromAst(join.condition, {
          clause_type: "JOIN_ON",
          join_seq: join.join_seq
        }, scope, sourceResolution, result);
      }
    }

    if (queryAst.where?.expression) {
      this.#collectFromAst(queryAst.where.expression, {
        clause_type: "WHERE"
      }, scope, sourceResolution, result);
    }

    for (const item of queryAst.group_by?.items || []) {
      if (item.expression) {
        this.#collectFromAst(item.expression, {
          clause_type: "GROUP_BY",
          group_item_seq: item.group_item_seq
        }, scope, sourceResolution, result);
      }
    }

    if (queryAst.having?.expression) {
      this.#collectFromAst(queryAst.having.expression, {
        clause_type: "HAVING"
      }, scope, sourceResolution, result);
    }

    if (queryAst.qualify?.expression) {
      this.#collectFromAst(queryAst.qualify.expression, {
        clause_type: "QUALIFY"
      }, scope, sourceResolution, result);
    }

    for (const item of queryAst.order_by?.items || []) {
      if (item.expression) {
        this.#collectFromAst(item.expression, {
          clause_type: "ORDER_BY",
          order_item_seq: item.order_item_seq
        }, scope, sourceResolution, result);
      }
    }

    for (const source of scope.sources) {
      if (source.source_type === "UNNEST" && source.expression) {
        this.#collectFromAst(source.expression, {
          clause_type: source.source_role === "JOIN" ? "JOIN_UNNEST" : "FROM_UNNEST"
        }, scope, sourceResolution, result);
      }
    }
  }

  /**
   * ASTを再帰的に走査し、IDENTIFIER_EXPRESSIONだけを解決する。
   *
   * AST Nodeの形はNodeTypeごとに異なるため、特定プロパティ名を列挙せず、
   * object / arrayを汎用的に辿る。node_typeを持つIDENTIFIER Nodeを見つけたら、
   * そのNodeより下へは進まず、1参照として登録する。
   */
  #collectFromAst(node, context, scope, sourceResolution, result) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.#collectFromAst(item, context, scope, sourceResolution, result);
      }

      return;
    }

    if (node.node_type === "IDENTIFIER_EXPRESSION") {
      /*
       * BigQueryの日時関数ではDAY / MONTH / YEARなどが、文字列ではなく
       * date_partキーワードとして式中へ現れる。ExpressionParserは現段階で
       * これらをIDENTIFIER_EXPRESSIONとして保持するため、ColumnResolverで
       * 物理列参照から除外する。
       */
      if (this.#isDatePartIdentifier(node)) {
        return;
      }

      result.push(
        this.#resolveIdentifierNode(node, context, scope, sourceResolution)
      );
      return;
    }

    /* 子Query内の参照は、子scopeの走査時に解決する。 */
    if (
      node.node_type === NodeType.SUBQUERY_EXPRESSION ||
      node.node_type === NodeType.ARRAY_SUBQUERY_EXPRESSION
    ) {
      return;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        this.#collectFromAst(value, context, scope, sourceResolution, result);
      }
    }
  }

  #isDatePartIdentifier(node) {
    const parts = Array.isArray(node.parts)
      ? node.parts
      : String(node.name || "").split(".");

    if (parts.length !== 1) {
      return false;
    }

    const dateParts = new Set([
      "MICROSECOND", "MILLISECOND", "SECOND", "MINUTE", "HOUR",
      "DAY", "DAYOFWEEK", "DAYOFYEAR", "WEEK", "ISOWEEK",
      "MONTH", "QUARTER", "YEAR", "ISOYEAR"
    ]);

    return dateParts.has(this.#normalizeName(parts[0]));
  }

  #resolveIdentifierNode(node, context, scope, sourceResolution) {
    const parts = Array.isArray(node.parts)
      ? node.parts.map((part) => this.#normalizeName(part))
      : String(node.name || "").split(".").map((part) => this.#normalizeName(part));

    const columnName = parts.length >= 3 ? parts[1] : parts[parts.length - 1];
    const fieldPath = parts.length >= 3 ? parts.slice(2).join(".") : null;
    const qualifierParts = parts.length >= 3 ? [parts[0]] : parts.slice(0, -1);

    if (qualifierParts.length > 0) {
      return this.#resolveQualifiedReference(
        node,
        context,
        scope,
        sourceResolution,
        qualifierParts,
        columnName,
        fieldPath
      );
    }

    return this.#resolveUnqualifiedReference(
      node,
      context,
      scope,
      sourceResolution,
      columnName
    );
  }

  #resolveQualifiedReference(
    node,
    context,
    scope,
    sourceResolution,
    qualifierParts,
    columnName,
    fieldPath = null
  ) {
    const qualifier = qualifierParts.join(".");
    const source = this.#findSource(sourceResolution, scope.scope_id, qualifier);

    if (!source) {
      return this.#createReferenceResult(node, context, scope, {
        qualifier,
        columnName,
        fieldPath,
        status: "UNRESOLVED_SOURCE",
        source: null,
        candidateSourceIds: []
      });
    }

    const columnStatus = this.#getColumnStatus(source, columnName);

    return this.#createReferenceResult(node, context, scope, {
      qualifier,
      columnName,
      fieldPath,
      status: columnStatus,
      source,
      candidateSourceIds: [source.source_id]
    });
  }

  #resolveUnqualifiedReference(node, context, scope, sourceResolution, columnName) {
    const outputAlias = this.#findVisibleOutputAlias(
      scope.scope_id,
      columnName,
      context.clause_type
    );

    if (outputAlias) {
      return this.#createReferenceResult(node, context, scope, {
        qualifier: null,
        columnName,
        status: "SELECT_ALIAS_RESOLVED",
        source: null,
        candidateSourceIds: [],
        outputAliasSelectItemSeq: outputAlias.select_item_seq
      });
    }

    /*
     * UNNEST(...) AS v の値そのもの(素の `v`)への参照。UNNESTの別名は要素の
     * 値列そのものなので、同名の別名を持つUNNESTソースへ解決する。これを
     * 行わないと、物理テーブルとUNNESTの両方が候補になり AMBIGUOUS →
     * PHYSICAL_COLUMN_NOT_FOUND(誤ったERROR)になっていた。
     */
    const unnestValueSource = this.#findUnnestValueSource(
      scope.scope_id,
      columnName
    );

    if (unnestValueSource) {
      return this.#createReferenceResult(node, context, scope, {
        qualifier: null,
        columnName,
        status: "SOURCE_RESOLVED",
        source: unnestValueSource,
        candidateSourceIds: [unnestValueSource.source_id]
      });
    }

    const candidateSources = this.#findUnqualifiedCandidates(
      sourceResolution,
      scope.scope_id,
      columnName
    );

    if (candidateSources.length === 0) {
      return this.#createReferenceResult(node, context, scope, {
        qualifier: null,
        columnName,
        status: "UNRESOLVED_COLUMN",
        source: null,
        candidateSourceIds: []
      });
    }

    if (candidateSources.length > 1) {
      /*
       * JOIN ... USING(col) は結合キーcolを1つの論理列へ統合するため、
       * 修飾なしのcol参照は複数ソースに存在しても曖昧ではない。
       * この場合は登録順で先頭(FROM/左側)のソースへ確定解決し、
       * 誤ったAMBIGUOUS(→PHYSICAL_COLUMN_AMBIGUOUS)を避ける。
       */
      const usingColumns = Array.isArray(scope.join_using_columns)
        ? scope.join_using_columns
        : [];

      if (usingColumns.includes(columnName)) {
        /*
         * USING列は結合先のいずれかに存在すればよく、FROM/左側ソースが
         * 必ず持つとは限らない(例: FROM 物理表 JOIN cte USING(col) で col は
         * cte 側にしかない)。列を公開していると分かっている候補(CTE/派生)を
         * 優先し、確定できない(全て物理でスキーマ未連携)場合のみ先頭へ倒す。
         */
        const exposingSource = candidateSources.find(
          (candidate) => this.#getColumnStatus(candidate, columnName) === "RESOLVED"
        );
        const usingSource = exposingSource || candidateSources[0];
        const usingColumnStatus = this.#getColumnStatus(usingSource, columnName);

        return this.#createReferenceResult(node, context, scope, {
          qualifier: null,
          columnName,
          status: usingColumnStatus,
          source: usingSource,
          candidateSourceIds: [usingSource.source_id]
        });
      }

      return this.#createReferenceResult(node, context, scope, {
        qualifier: null,
        columnName,
        status: "AMBIGUOUS",
        source: null,
        candidateSourceIds: candidateSources.map((source) => source.source_id)
      });
    }

    const source = candidateSources[0];
    const columnStatus = this.#getColumnStatus(source, columnName);

    return this.#createReferenceResult(node, context, scope, {
      qualifier: null,
      columnName,
      status: columnStatus,
      source,
      candidateSourceIds: [source.source_id]
    });
  }

  /**
   * SELECT出力エイリアスを参照できるClauseでは、FROM Sourceより先に
   * 現在QueryのSELECT項目を検索する。
   *
   * BigQueryではGROUP BY / HAVING / QUALIFY / ORDER BYからSELECTの
   * 出力エイリアスを参照できる。一方、WHEREとJOIN ONでは参照できない。
   *
   * 同名エイリアスが複数ある場合は安全側に倒し、ここでは解決しない。
   * 後続の通常Source解決へ委譲することで、曖昧性を隠蔽しない。
   */
  #findVisibleOutputAlias(scopeId, columnName, clauseType) {
    const visibleClauses = new Set([
      "GROUP_BY",
      "HAVING",
      "QUALIFY",
      "ORDER_BY"
    ]);

    if (!visibleClauses.has(clauseType)) {
      return null;
    }

    const queryAst = this.queryByScopeId.get(scopeId);

    if (!queryAst) {
      return null;
    }

    const matches = (queryAst.select || []).filter((selectItem) => {
      if (selectItem.wildcard_type) {
        return false;
      }

      return this.#normalizeName(selectItem.output_alias) === columnName;
    });

    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * 非修飾列の候補を現在scopeから探す。
   *
   * CTE / SUBQUERYは出力列名が既知なので、該当列を持つ場合だけ候補にする。
   * PHYSICAL_TABLE / UNNESTは現段階でスキーマ不明のため、候補から除外できない。
   * 現在scopeに候補が無い場合だけ親scopeへ進み、相関参照の土台とする。
   */
  /*
   * scope連鎖の中から、別名が columnName に一致する UNNEST ソースを探す。
   * 一致が1つだけのときにその要素値参照として解決する(複数なら曖昧)。
   */
  #findUnnestValueSource(startScopeId, columnName) {
    let currentScope = this.scopeById.get(startScopeId);

    while (currentScope) {
      const matches = currentScope.sources.filter((source) => {
        return source.source_type === "UNNEST" &&
          (this.#normalizeName(source.source_alias) === columnName ||
           this.#normalizeName(source.offset_alias) === columnName);
      });

      if (matches.length === 1) {
        return matches[0];
      }

      if (matches.length > 1) {
        return null;
      }

      currentScope = this.scopeById.get(currentScope.parent_scope_id);
    }

    return null;
  }

  #findUnqualifiedCandidates(sourceResolution, startScopeId, columnName) {
    let currentScope = this.scopeById.get(startScopeId);

    while (currentScope) {
      const candidates = currentScope.sources.filter((source) => {
        const knownColumns = this.#getKnownOutputColumns(source);

        if (knownColumns === null) {
          return true;
        }

        return knownColumns.includes(columnName);
      });

      if (candidates.length > 0) {
        return candidates;
      }

      currentScope = this.scopeById.get(currentScope.parent_scope_id);
    }

    return [];
  }

  #getColumnStatus(source, columnName) {
    const knownColumns = this.#getKnownOutputColumns(source);

    if (knownColumns === null) {
      return "SOURCE_RESOLVED";
    }

    return knownColumns.includes(columnName)
      ? "RESOLVED"
      : "UNRESOLVED_COLUMN";
  }

  /**
   * CTE / SUBQUERYが外部へ公開する列名を返す。
   *
   * v1.3.2までは、直下SELECT項目のoutput_aliasだけを参照していたため、
   * `SELECT ca2.* FROM customer_agg2 AS ca2` のようなQueryでは、
   * ワイルドカード経由で継承される列を認識できなかった。
   *
   * v1.3.3では、Wildcardを見つけた場合に参照先Sourceの公開列を再帰的に
   * 取得する。これにより、複数段のCTEをまたぐ`alias.*`も列名を伝播できる。
   *
   * 物理テーブルとUNNESTは、このResolver段階ではスキーマ未連携のため
   * nullを返す。nullは「列集合が不明なので候補から除外しない」を意味する。
   */
  #getKnownOutputColumns(source) {
    const childScopeId = source.cte_query_scope_id || source.subquery_scope_id;

    if (!childScopeId) {
      return null;
    }

    return this.#getScopeExposedColumns(childScopeId, new Set());
  }

  /**
   * Query Scopeの公開列をSELECT順で返す。
   *
   * 同じScopeを再訪した場合は空配列を返し、再帰CTEや不正な循環参照で
   * 無限再帰にならないようにする。
   *
   * ワイルドカード(`*` / `alias.*`)が、この段階で列集合を確定できない
   * ソース(物理テーブル・UNNEST・列不明の子スコープ)を取り込む場合は、
   * 公開列が「不明」であることを示すため null を返す(空配列=列ゼロとは区別)。
   */
  #getScopeExposedColumns(scopeId, visitingScopeIds) {
    if (visitingScopeIds.has(scopeId)) {
      return [];
    }

    const queryAst = this.queryByScopeId.get(scopeId);
    const scope = this.scopeById.get(scopeId);

    if (!queryAst || !scope) {
      return [];
    }

    const nextVisitingScopeIds = new Set(visitingScopeIds);
    nextVisitingScopeIds.add(scopeId);

    const result = [];

    for (const selectItem of queryAst.select || []) {
      if (!selectItem.wildcard_type) {
        const outputName = this.#normalizeName(selectItem.output_alias);

        if (outputName !== null) {
          result.push(outputName);
        }

        continue;
      }

      const wildcardColumns = this.#getWildcardExposedColumns(
        selectItem,
        scope,
        nextVisitingScopeIds
      );

      /*
       * ワイルドカードが列集合を確定できないソース(物理テーブル・UNNEST・
       * 列不明の子スコープ)を取り込む場合、このスコープの公開列は「不明」。
       * 空集合(=列を1つも公開しない)と取り違えると、`SELECT * FROM 物理表`
       * を中身とするCTEが「列ゼロ」と誤認され、そのCTEを修飾/非修飾で
       * 参照する列が解決できなくなる。不明は null で伝播する。
       */
      if (wildcardColumns === null) {
        return null;
      }

      const exclusions = new Set(selectItem.wildcard_exclusions || []);
      for (const wildcardColumn of wildcardColumns) {
        if (!exclusions.has(wildcardColumn) && !result.includes(wildcardColumn)) {
          result.push(wildcardColumn);
        }
      }
    }

    return result;
  }

  /**
   * `*`または`alias.*`が公開する列名を参照先Sourceから取得する。
   */
  #getWildcardExposedColumns(selectItem, scope, visitingScopeIds) {
    let sources = [];

    if (selectItem.wildcard_type === "ALL") {
      sources = scope.sources;
    } else {
      const qualifier = this.#normalizeName(selectItem.wildcard_qualifier);
      const sourceId = scope.reference_map[qualifier];
      const source = scope.sources.find((item) => item.source_id === sourceId);

      if (source) {
        sources = [source];
      }
    }

    const result = [];

    for (const source of sources) {
      const childScopeId = source.cte_query_scope_id || source.subquery_scope_id;

      /*
       * 物理テーブルやUNNESTなど、この段階で列集合が判らないソースを
       * ワイルドカードが取り込む場合、公開列は確定できない(不明)。
       * skip(continue)して空集合にすると「列ゼロのCTE」と誤認されるため、
       * 不明であることを null で返す。
       */
      if (!childScopeId) {
        return null;
      }

      const childColumns = this.#getScopeExposedColumns(
        childScopeId,
        visitingScopeIds
      );

      /* 子スコープが列不明(null)なら、このワイルドカードも列不明。 */
      if (childColumns === null) {
        return null;
      }

      for (const childColumn of childColumns) {
        if (!result.includes(childColumn)) {
          result.push(childColumn);
        }
      }
    }

    return result;
  }

  #findSource(sourceResolution, startScopeId, referenceName) {
    const normalizedName = this.#normalizeName(referenceName);
    let currentScope = this.scopeById.get(startScopeId);

    while (currentScope) {
      const sourceId = currentScope.reference_map[normalizedName];

      if (sourceId !== undefined) {
        return currentScope.sources.find((source) => source.source_id === sourceId) || null;
      }

      currentScope = this.scopeById.get(currentScope.parent_scope_id);
    }

    return null;
  }

  #collectWildcardReference(selectItem, scope, sourceResolution, result) {
    if (selectItem.wildcard_type === "ALL") {
      result.push({
        column_reference_id: this.nextReferenceId++,
        scope_id: scope.scope_id,
        clause_type: "SELECT",
        select_item_seq: selectItem.select_item_seq,
        reference_type: "WILDCARD",
        reference_name: "*",
        qualifier: null,
        column_name: "*",
        resolution_status: scope.sources.length === 1 ? "RESOLVED" : "AMBIGUOUS",
        source_id: scope.sources.length === 1 ? scope.sources[0].source_id : null,
        source_type: scope.sources.length === 1 ? scope.sources[0].source_type : null,
        source_name: scope.sources.length === 1 ? scope.sources[0].source_name : null,
        source_alias: scope.sources.length === 1 ? scope.sources[0].source_alias : null,
        candidate_source_ids: scope.sources.map((source) => source.source_id),
        start_token_seq: selectItem.expression_start_seq,
        end_token_seq: selectItem.expression_end_seq
      });
      return;
    }

    const qualifier = this.#normalizeName(selectItem.wildcard_qualifier);
    const source = this.#findSource(sourceResolution, scope.scope_id, qualifier);

    result.push({
      column_reference_id: this.nextReferenceId++,
      scope_id: scope.scope_id,
      clause_type: "SELECT",
      select_item_seq: selectItem.select_item_seq,
      reference_type: "WILDCARD",
      reference_name: `${qualifier}.*`,
      qualifier,
      column_name: "*",
      resolution_status: source ? "RESOLVED" : "UNRESOLVED_SOURCE",
      source_id: source?.source_id ?? null,
      source_type: source?.source_type ?? null,
      source_name: source?.source_name ?? null,
      source_alias: source?.source_alias ?? null,
      candidate_source_ids: source ? [source.source_id] : [],
      start_token_seq: selectItem.expression_start_seq,
      end_token_seq: selectItem.expression_end_seq
    });
  }

  #createReferenceResult(node, context, scope, details) {
    return {
      column_reference_id: this.nextReferenceId++,
      scope_id: scope.scope_id,
      clause_type: context.clause_type,
      select_item_seq: context.select_item_seq ?? null,
      join_seq: context.join_seq ?? null,
      group_item_seq: context.group_item_seq ?? null,
      order_item_seq: context.order_item_seq ?? null,
      reference_type: "COLUMN",
      reference_name: node.name,
      qualifier: details.qualifier,
      column_name: details.columnName,
      field_path: details.fieldPath ?? null,
      resolution_status: details.status,
      source_id: details.source?.source_id ?? null,
      source_type: details.source?.source_type ?? null,
      source_name: details.source?.source_name ?? null,
      source_alias: details.source?.source_alias ?? null,
      candidate_source_ids: details.candidateSourceIds,
      output_alias_select_item_seq: details.outputAliasSelectItemSeq ?? null,
      start_token_seq: node.start_token_seq,
      end_token_seq: node.end_token_seq
    };
  }

  #parseExpressionRange(startTokenSeq, endTokenSeq) {
    const expressionTokens = this.tokens.filter((token) => {
      return token.token_seq >= startTokenSeq &&
        token.token_seq <= endTokenSeq &&
        token.token_type !== "COMMENT";
    });

    if (expressionTokens.length === 0) {
      throw new SyntaxError(
        `ColumnResolver: expression token range ${startTokenSeq}-${endTokenSeq} is empty.`
      );
    }

    return new ExpressionParser(expressionTokens).parseExpression();
  }

  #normalizeName(value) {
    if (value === null || value === undefined) {
      return null;
    }

    return String(value).toUpperCase();
  }

  #validateInputs(queryAst, sourceResolution) {
    if (!queryAst || queryAst.node_type !== "QUERY") {
      throw new TypeError("ColumnResolver: queryAst must be a QUERY node.");
    }

    if (!sourceResolution || !Array.isArray(sourceResolution.scopes)) {
      throw new TypeError("ColumnResolver: sourceResolution is invalid.");
    }
  }
}

// ============================================================
// SOURCE: src/from_parser.js
// ============================================================
/**
 * FROM句をテーブルソースとJOINへ分解するParser。
 *
 * FromParserの責務:
 *
 * - FROM直後の主ソースを解析する。
 * - JOIN種別とJOIN先ソースを解析する。
 * - ON条件をExpressionParserへ渡す。
 * - USING列を一覧化する。
 * - UNNESTとサブクエリを通常テーブルとは別のsource_typeで表現する。
 *
 * FromParserは、ON条件の演算子優先順位や関数呼び出しを自分では解析しない。
 * 式の意味解析をExpressionParserへ委譲することで、FROM/JOIN文法だけに責務を絞る。
 *
 * 位置情報はすべてtoken_seqで返す。配列indexはこのクラス内部だけで使用する。
 */
class FromParser {
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("FromParser: tokens must be an array.");
    }

    this.sourceTokens = tokens;
    this.tokens = [];
    this.reader = null;
    this.expressionParser = new ExpressionParser(tokens);
  }

  /**
   * ClauseParserが返したFROM Clauseを解析する。
   *
   * @param {object} fromClause ClauseParserのFROM結果
   * @returns {object} FROM構造
   */
  parse(fromClause) {
    this.#validateFromClause(fromClause);

    /*
     * 元Token配列は保持したまま、FROM本文範囲だけを切り出す。
     * コメントは文法判定に不要なので、解析用配列からのみ除外する。
     */
    this.tokens = this.sourceTokens.filter((token) =>
      token.token_seq >= fromClause.body_start_seq &&
      token.token_seq <= fromClause.body_end_seq &&
      token.token_type !== "COMMENT"
    );

    if (this.tokens.length === 0) {
      throw new SyntaxError("FromParser: FROM Clause contains no source tokens.");
    }

    this.reader = new TokenReader(this.tokens);

    const source = this.#parseSource();
    this.#parseRelationOperators(source);
    const joins = [];

    while (!this.reader.isEnd()) {
      /*
       * 旧式のカンマ区切りFROMは、意味上CROSS JOINと同じ扱いにする。
       * ただし元SQLの表現を失わないようjoin_syntaxをCOMMAとして保持する。
       */
      if (this.reader.matches(",", false)) {
        const commaToken = this.reader.consume();
        const commaSource = this.#parseSource();

        joins.push({
          join_seq: joins.length + 1,
          join_type: "CROSS",
          join_syntax: "COMMA",
          join_start_seq: commaToken.token_seq,
          source: commaSource,
          condition_type: null,
          condition: null,
          using_columns: [],
          end_token_seq: commaSource.end_token_seq
        });

        continue;
      }

      const visibleSourceNames = this.#collectVisibleSourceNames(source, joins);
      joins.push(this.#parseJoin(joins.length + 1, visibleSourceNames));
    }

    return {
      from_start_seq: fromClause.clause_start_seq,
      body_start_seq: fromClause.body_start_seq,
      body_end_seq: fromClause.body_end_seq,
      source,
      joins
    };
  }

  /**
   * 現在位置から1つのFROM/JOINソースを解析する。
   *
   * ソースの候補:
   *
   * - 通常テーブル
   * - UNNEST(...)
   * - (SELECT ...)形式のサブクエリ
   */
  #parseSource() {
    const currentToken = this.reader.current();

    if (!currentToken) {
      throw new SyntaxError("FromParser: source token was not found.");
    }

    if (currentToken.normalized_token === "UNNEST") {
      return this.#parseUnnestSource();
    }

    if (currentToken.token === "(") {
      return this.#parseSubquerySource();
    }

    return this.#parseTableSource();
  }

  /**
   * project.dataset.tableのようなドット区切りテーブル名を解析する。
   */
  #parseTableSource() {
    const startToken = this.reader.current();
    const nameParts = [];

    if (!this.#isNameToken(startToken)) {
      throw new SyntaxError(
        `FromParser: table name was expected, but found "${startToken.token}".`
      );
    }

    nameParts.push(this.#consumeHyphenatedNamePart());

    while (this.reader.matches(".", false)) {
      this.reader.consume();

      const partToken = this.reader.current();

      if (!this.#isNameToken(partToken)) {
        throw new SyntaxError("FromParser: identifier was expected after '.'.");
      }

      nameParts.push(this.#consumeHyphenatedNamePart());
    }

    /*
     * TABLESAMPLE SYSTEM (n PERCENT) はサンプリング指定で列系統に影響しない。
     * 別名の前後どちらにも書けるため、両位置で読み飛ばす。
     */
    this.#skipTableSampleClause();
    const aliasInfo = this.#parseAlias();
    this.#skipTableSampleClause();
    const endToken = aliasInfo.alias_token || this.reader.previous();

    return {
      source_type: "TABLE",
      name: nameParts.join("."),
      name_parts: nameParts,
      alias: aliasInfo.alias,
      alias_type: aliasInfo.alias_type,
      start_token_seq: startToken.token_seq,
      end_token_seq: endToken.token_seq
    };
  }

  /**
   * テーブルパスの1パートを読む。BigQuery は未クォートのテーブルパスに
   * ハイフンを許容する（特にダッシュ付きプロジェクトID `my-project-123`）。
   * Lexer は `my-project` を `my` `-` `project` に分割するため、テーブル名
   * 位置では後続の `- <識別子|数値>` を同一パートへ連結する。FROM のテーブル名
   * 位置に現れる `-` は減算ではありえず、名前の一部としてのみ意味を持つ。
   */
  #consumeHyphenatedNamePart() {
    let part = this.reader.consume().normalized_token;

    while (this.reader.matches("-", false)) {
      this.reader.consume();

      const nextToken = this.reader.current();
      const isNamePart = nextToken &&
        (this.#isNameToken(nextToken) || nextToken.token_type === "NUMBER");

      if (!isNamePart) {
        throw new SyntaxError(
          "FromParser: identifier or number was expected after '-' in a table name."
        );
      }

      part += "-" + this.reader.consume().normalized_token;
    }

    return part;
  }

  /*
   * TABLESAMPLE [method] ( ... ) を読み飛ばす。存在しなければ何もしない。
   */
  #skipTableSampleClause() {
    if (!this.reader.matches("TABLESAMPLE")) {
      return;
    }

    this.reader.consume();

    if (this.reader.hasCurrent() && !this.reader.matches("(", false)) {
      this.reader.consume();
    }

    if (this.reader.matches("(", false)) {
      let depth = 0;

      while (this.reader.hasCurrent()) {
        const token = this.reader.consume();

        if (token.token === "(") {
          depth++;
        } else if (token.token === ")") {
          depth--;

          if (depth === 0) {
            break;
          }
        }
      }
    }
  }

  /**
   * UNNEST(expression) [AS] aliasを解析する。
   *
   * 括弧内部は通常のExpressionなのでExpressionParserへ委譲する。
   */
  #parseUnnestSource() {
    const unnestToken = this.#consumeExpected("UNNEST");
    const openToken = this.#consumeExpected("(", false);
    const closeToken = this.#findMatchingCloseParenthesis(openToken);

    const expressionStartToken = this.reader.current();
    const expressionEndToken = this.#previousNonCommentToken(closeToken.token_seq);

    if (!expressionStartToken || !expressionEndToken) {
      throw new SyntaxError("FromParser: UNNEST expression is empty.");
    }

    const expression = this.expressionParser.parseExpression(
      expressionStartToken.token_seq,
      expressionEndToken.token_seq
    );

    this.reader.moveToTokenSeq(closeToken.token_seq);
    this.reader.consume();

    const aliasInfo = this.#parseAlias();
    let endToken = aliasInfo.alias_token || closeToken;

    /*
     * UNNEST(...) [AS value] WITH OFFSET [AS offset] のオフセット句を取り込む。
     * offset列は配列インデックスで物理列を持たないため、Token範囲の
     * 終端更新のみ行い、構文を成立させる。
     */
    let offsetAlias = null;

    if (this.reader.matches("WITH") &&
        this.reader.nextToken()?.normalized_token === "OFFSET") {
      this.reader.consume();
      const offsetToken = this.reader.consume();
      endToken = offsetToken;

      const offsetAliasInfo = this.#parseAlias();

      if (offsetAliasInfo.alias_token) {
        offsetAlias = offsetAliasInfo.alias;
        endToken = offsetAliasInfo.alias_token;
      }
    }

    return {
      source_type: "UNNEST",
      expression,
      alias: aliasInfo.alias,
      alias_type: aliasInfo.alias_type,
      offset_alias: offsetAlias,
      start_token_seq: unnestToken.token_seq,
      end_token_seq: endToken.token_seq
    };
  }

  /**
   * (SELECT ...) [AS] alias形式のサブクエリを解析する。
   *
   * v1ではToken範囲だけでなく、Clause一覧とSELECT項目概要も保持する。
   * FROM内部など、より深い再帰解析は後続Query Parserへ拡張できる。
   */
  #parseSubquerySource() {
    const openToken = this.#consumeExpected("(", false);
    const closeToken = this.#findMatchingCloseParenthesis(openToken);
    const innerTokens = this.sourceTokens
      .filter((token) =>
        token.token_seq > openToken.token_seq && token.token_seq < closeToken.token_seq
      )
      .map((token) => ({
        ...token,
        /*
         * ClauseParserは解析対象Queryのトップレベルをdepth=0として扱う。
         * FROMサブクエリ内Tokenは元SQL上ではdepth=1以上なので、
         * サブクエリ開始括弧の深さを差し引いたコピーを作る。
         * 元Token配列自体は変更しない。
         */
        paren_depth: token.paren_depth - 1
      }));

    const firstInnerToken = innerTokens.find((token) => token.token_type !== "COMMENT");

    if (!firstInnerToken || firstInnerToken.normalized_token !== "SELECT") {
      throw new SyntaxError(
        "FromParser: parenthesized FROM source must begin with SELECT."
      );
    }

    /*
     * FROMサブクエリを完全なQUERY ASTとして再帰解析する。
     *
     * 旧実装はclauses/select_itemsだけを保持していたため、
     * SourceResolverがQUERYノードとして認識できず、subquery_scope_idを
     * 設定できなかった。QueryParserへ委譲することでFROM/JOIN/WHERE、
     * 出力列、さらに入れ子サブクエリまで通常Queryと同じ形で保持する。
     */
    const queryAst = new QueryParser(innerTokens, {
      isSubquery: true
    }).parse();

    this.reader.moveToTokenSeq(closeToken.token_seq);
    this.reader.consume();

    const aliasInfo = this.#parseAlias();
    const endToken = aliasInfo.alias_token || closeToken;

    return {
      source_type: "SUBQUERY",
      query_start_token_seq: firstInnerToken.token_seq,
      query_end_token_seq: this.#previousNonCommentToken(closeToken.token_seq).token_seq,
      query_ast: queryAst,
      alias: aliasInfo.alias,
      alias_type: aliasInfo.alias_type,
      start_token_seq: openToken.token_seq,
      end_token_seq: endToken.token_seq
    };
  }

  /**
   * FROMソース直後のPIVOT / UNPIVOT演算子を解析する。
   *
   * BigQueryではPIVOTとUNPIVOTは独立したJOINではなく、直前の
   * from_itemへ適用される後置演算子である。旧実装はPIVOTを暗黙Alias、
   * 続く開き括弧をJOIN開始と解釈していたため、ここで明示的に消費する。
   *
   * v1.4.0-003では内部式の意味解析は行わず、トークン範囲を保持する。
   * Resolverが必要とする詳細ASTは後続版で段階的に追加する。
   */
  #parseRelationOperators(source) {
    const operators = [];

    while (
      this.reader.matches("PIVOT") ||
      this.reader.matches("UNPIVOT")
    ) {
      const operatorToken = this.reader.consume();
      let nullHandling = null;

      /*
       * UNPIVOTは演算子名と本体括弧の間に
       * INCLUDE NULLS / EXCLUDE NULLSを指定できる。
       * 生成列のLineage自体には影響しないが、構文として正しく消費し、
       * 後続Resolverが監査情報として参照できるよう保持する。
       */
      if (
        operatorToken.normalized_token === "UNPIVOT" &&
        (this.reader.matches("INCLUDE") || this.reader.matches("EXCLUDE"))
      ) {
        nullHandling = this.reader.consume().normalized_token;
        this.#consumeExpected("NULLS");
      }

      const openToken = this.#consumeExpected("(", false);
      const closeToken = this.#findMatchingCloseParenthesis(openToken);

      operators.push({
        operator_type: operatorToken.normalized_token,
        null_handling: nullHandling,
        start_token_seq: operatorToken.token_seq,
        body_start_token_seq: openToken.token_seq + 1,
        body_end_token_seq: closeToken.token_seq - 1,
        end_token_seq: closeToken.token_seq
      });

      this.reader.moveToTokenSeq(closeToken.token_seq);
      this.reader.consume();
    }

    if (operators.length > 0) {
      source.relation_operators = operators;
      source.end_token_seq = operators[operators.length - 1].end_token_seq;
    }
  }

  /**
   * JOIN種別、JOIN先、ON/USING条件を解析する。
   */
  #parseJoin(joinSeq, visibleSourceNames) {
    const joinStartToken = this.reader.current();
    const joinType = this.#parseJoinType();
    const source = this.#parseSource();
    this.#parseRelationOperators(source);

    let conditionType = null;
    let condition = null;
    let usingColumns = [];
    let endTokenSeq = source.end_token_seq;

    if (this.reader.matches("ON")) {
      conditionType = "ON";
      this.reader.consume();

      const conditionRange = this.#findJoinConditionRange();
      condition = this.expressionParser.parseExpression(
        conditionRange.start_token_seq,
        conditionRange.end_token_seq
      );
      endTokenSeq = conditionRange.end_token_seq;

      this.#moveAfterTokenSeq(conditionRange.end_token_seq);
    } else if (this.reader.matches("USING")) {
      conditionType = "USING";
      const usingResult = this.#parseUsingColumns();
      usingColumns = usingResult.columns;
      endTokenSeq = usingResult.end_token_seq;
    } else if (joinType !== "CROSS") {
      /*
       * UNNESTを右辺に取るJOINは、BigQueryではON/USINGを省略できる
       * (相関UNNEST: LEFT/INNER JOIN UNNEST(t.arr) / UNNEST(arr) など)。
       * 配列が可視ソースを明示参照していなくても(素の列名やCTE列でも)有効なため、
       * UNNESTソースなら条件省略を一律で許可する。UNNEST以外の通常JOINは
       * 従来どおりON/USINGを必須とする。
       */
      if (source.source_type !== "UNNEST") {
        throw new SyntaxError(
          `FromParser: ${joinType} JOIN requires ON or USING condition.`
        );
      }
    }

    return {
      join_seq: joinSeq,
      join_type: joinType,
      join_syntax: "JOIN",
      join_start_seq: joinStartToken.token_seq,
      source,
      condition_type: conditionType,
      condition,
      using_columns: usingColumns,
      end_token_seq: endTokenSeq
    };
  }


  /**
   * 現在までにFROMへ登録されたソース名・別名を収集する。
   * 条件省略を許可する相関UNNESTの判定だけに使用する。
   */
  #collectVisibleSourceNames(source, joins) {
    const names = new Set();
    const sources = [source, ...joins.map((join) => join.source)];

    for (const currentSource of sources) {
      if (!currentSource) continue;
      if (currentSource.alias) names.add(currentSource.alias);

      if (currentSource.name_parts?.length > 0) {
        names.add(currentSource.name_parts[currentSource.name_parts.length - 1]);
      }
    }

    return names;
  }

  /**
   * UNNEST式が左側ですでに可視なソースを参照しているか判定する。
   * 例: UNNEST(customer.contacts) は customer を参照するため相関UNNEST。
   */
  #referencesVisibleSource(node, visibleSourceNames) {
    if (!node || !(visibleSourceNames instanceof Set)) return false;

    if (Array.isArray(node)) {
      return node.some((item) =>
        this.#referencesVisibleSource(item, visibleSourceNames)
      );
    }

    if (typeof node !== "object") return false;

    if (
      node.node_type === NodeType.IDENTIFIER_EXPRESSION &&
      Array.isArray(node.parts) &&
      node.parts.length >= 2 &&
      visibleSourceNames.has(node.parts[0])
    ) {
      return true;
    }

    for (const value of Object.values(node)) {
      if (this.#referencesVisibleSource(value, visibleSourceNames)) return true;
    }

    return false;
  }

  /**
   * JOIN、INNER JOIN、LEFT [OUTER] JOINなどを正規化する。
   */
  #parseJoinType() {
    if (this.reader.matches("JOIN")) {
      this.reader.consume();
      return "INNER";
    }

    const joinTypeToken = this.reader.current();
    const allowedTypes = ["INNER", "LEFT", "RIGHT", "FULL", "CROSS"];

    if (!joinTypeToken || !allowedTypes.includes(joinTypeToken.normalized_token)) {
      const actual = joinTypeToken ? joinTypeToken.token : "EOF";
      const error = new SyntaxError(
        `FromParser: JOIN was expected, but found "${actual}".`
      );
      error.parser_stage = "FromParser";
      error.parser_token = joinTypeToken ?? null;
      throw error;
    }

    const joinType = this.reader.consume().normalized_token;

    if (this.reader.matches("OUTER")) {
      this.reader.consume();
    }

    this.#consumeExpected("JOIN");

    return joinType;
  }

  /**
   * USING (column1, column2)を解析する。
   */
  #parseUsingColumns() {
    this.#consumeExpected("USING");
    this.#consumeExpected("(", false);

    const columns = [];

    while (!this.reader.matches(")", false)) {
      const columnToken = this.reader.current();

      if (!this.#isNameToken(columnToken)) {
        throw new SyntaxError("FromParser: column name was expected in USING.");
      }

      columns.push(columnToken.normalized_token);
      this.reader.consume();

      if (this.reader.matches(",", false)) {
        this.reader.consume();
        continue;
      }

      break;
    }

    const closeToken = this.#consumeExpected(")", false);

    return {
      columns,
      end_token_seq: closeToken.token_seq
    };
  }

  /**
   * ON条件の開始から、次のJOINまたはカンマ直前までを求める。
   * 括弧内部のJOINキーワードは条件境界として扱わない。
   */
  #findJoinConditionRange() {
    const startToken = this.reader.current();

    if (!startToken) {
      throw new SyntaxError("FromParser: ON condition is empty.");
    }

    const baseDepth = startToken.paren_depth;
    let endToken = null;
    let offset = 0;

    while (true) {
      const token = this.reader.peek(offset);

      if (!token) {
        break;
      }

      if (token.paren_depth === baseDepth && this.#isJoinBoundaryAtOffset(offset)) {
        break;
      }

      endToken = token;
      offset++;
    }

    if (!endToken) {
      throw new SyntaxError("FromParser: ON condition is empty.");
    }

    return {
      start_token_seq: startToken.token_seq,
      end_token_seq: endToken.token_seq
    };
  }

  #isJoinBoundaryAtOffset(offset) {
    const token = this.reader.peek(offset);

    if (!token) return true;
    if (token.token === ",") return true;
    if (token.normalized_token === "JOIN") return true;

    return ["INNER", "LEFT", "RIGHT", "FULL", "CROSS"].includes(
      token.normalized_token
    );
  }

  /**
   * AS aliasまたは暗黙aliasを解析する。
   * JOIN/ON/USINGなど、次の文法開始キーワードはaliasとして扱わない。
   */
  #parseAlias() {
    if (this.reader.matches("AS")) {
      this.reader.consume();
      const aliasToken = this.reader.current();

      if (!this.#isNameToken(aliasToken)) {
        throw new SyntaxError("FromParser: alias was expected after AS.");
      }

      this.reader.consume();

      return {
        alias: aliasToken.normalized_token,
        alias_type: "EXPLICIT_AS",
        alias_token: aliasToken
      };
    }

    const aliasToken = this.reader.current();

    if (this.#canBeImplicitAlias(aliasToken)) {
      this.reader.consume();

      return {
        alias: aliasToken.normalized_token,
        alias_type: "IMPLICIT",
        alias_token: aliasToken
      };
    }

    return {
      alias: null,
      alias_type: null,
      alias_token: null
    };
  }

  #canBeImplicitAlias(token) {
    if (!this.#isNameToken(token)) return false;

    const reserved = [
      "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "OUTER",
      "ON", "USING", "PIVOT", "UNPIVOT",
      "WHERE", "GROUP", "HAVING", "QUALIFY", "ORDER", "LIMIT",
      "WITH", "WINDOW", "UNION", "INTERSECT", "EXCEPT", "TABLESAMPLE"
    ];

    return !reserved.includes(token.normalized_token);
  }

  #isNameToken(token) {
    /*
     * BigQueryのバッククォート付き識別子も名前Tokenとして扱う。
     *
     * Lexerは `project.dataset.table` を内部のドットで分割せず、
     * 1つのBACKTICK_IDENTIFIERとして返す。そのためFromParser側では、
     * IDENTIFIER/KEYWORDと同様にテーブル名・別名・USING列として
     * 受け入れる必要がある。
     */
    return token !== null && [
      "IDENTIFIER",
      "KEYWORD",
      "BACKTICK_IDENTIFIER"
    ].includes(token.token_type);
  }

  #findMatchingCloseParenthesis(openToken) {
    const closeToken = this.sourceTokens.find((token) =>
      token.token === ")" &&
      token.token_seq > openToken.token_seq &&
      token.paren_depth === openToken.paren_depth
    );

    if (!closeToken) {
      throw new SyntaxError("FromParser: matching ')' was not found.");
    }

    return closeToken;
  }

  #previousNonCommentToken(tokenSeq) {
    for (let index = this.sourceTokens.length - 1; index >= 0; index--) {
      const token = this.sourceTokens[index];

      if (token.token_seq < tokenSeq && token.token_type !== "COMMENT") {
        return token;
      }
    }

    return null;
  }

  #moveAfterTokenSeq(tokenSeq) {
    const nextToken = this.tokens.find((token) => token.token_seq > tokenSeq);

    if (nextToken) {
      this.reader.moveToTokenSeq(nextToken.token_seq);
    } else {
      this.reader.reset();
      this.reader.advance(this.reader.length);
    }
  }

  #consumeExpected(value, normalized = true) {
    if (!this.reader.matches(value, normalized)) {
      const token = this.reader.current();
      const actual = token ? token.token : "EOF";
      throw new SyntaxError(
        `FromParser: expected "${value}", but found "${actual}".`
      );
    }

    return this.reader.consume();
  }

  #validateFromClause(fromClause) {
    if (!fromClause || fromClause.clause_type !== "FROM") {
      throw new TypeError("FromParser.parse: a FROM Clause is required.");
    }

    if (!Number.isInteger(fromClause.body_start_seq) ||
        !Number.isInteger(fromClause.body_end_seq)) {
      throw new TypeError(
        "FromParser.parse: FROM Clause token ranges must be integers."
      );
    }
  }
}

// ============================================================
// SOURCE: src/group_by_parser.js
// ============================================================
/**
 * GROUP BY句本文を、グループ化要素の一覧へ変換するParser。
 *
 * GroupByParserの責務:
 *
 * - ClauseParserが検出したGROUP_BY Clauseの本文範囲を受け取る。
 * - トップレベルのカンマだけを区切りとして、グループ化要素を分割する。
 * - 通常の式はExpressionParserへ委譲する。
 * - ROLLUP、CUBE、GROUPING SETSはGROUP BY固有の構文として識別する。
 * - 外部へ返す位置情報は、すべてtoken_seqで統一する。
 *
 * なぜExpressionParserだけに任せないのか:
 *
 * ROLLUP(a, b)やCUBE(a, b)は見た目だけなら関数呼び出しに似ているが、
 * GROUP BYにおいては集約レベルを定義する専用文法である。
 * またGROUPING SETS ((a, b), (a), ())は、通常のExpressionではなく、
 * 複数のグループ化集合を列挙する構文である。
 * そのため、GROUP BY固有の意味付けはGroupByParserが担当する。
 */
class GroupByParser {
  /**
   * @param {Array<object>} tokens Lexerが生成したSQL全体のToken配列
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("GroupByParser: tokens must be an array.");
    }

    this.tokens = tokens;
    this.expressionParser = new ExpressionParser(tokens);
  }

  /**
   * ClauseParserが返したGROUP_BY Clauseを解析する。
   *
   * @param {object} groupByClause ClauseParserのGROUP_BY結果
   * @returns {object} GROUP BY Clauseとグループ化要素一覧
   */
  parse(groupByClause) {
    this.#validateGroupByClause(groupByClause);

    /*
     * GROUP BY本文だけを取り出す。
     * 元Token配列は変更せず、COMMENT Tokenだけ解析対象から除外する。
     */
    const bodyTokens = this.tokens.filter((token) => (
      token.token_seq >= groupByClause.body_start_seq &&
      token.token_seq <= groupByClause.body_end_seq &&
      token.token_type !== "COMMENT"
    ));

    if (bodyTokens.length === 0) {
      throw new SyntaxError("GroupByParser: GROUP BY Clause body is empty.");
    }

    /*
     * GROUP BY ALL は「集約対象でない全SELECT列でグループ化」する糖衣構文。
     * ALL自体は列参照ではないため、グループ化項目を持たない形で返す。
     * グループキーの列系統は対応するSELECT項目側で保持される。
     */
    if (bodyTokens.length === 1 && bodyTokens[0].normalized_token === "ALL") {
      return {
        clause_type: "GROUP_BY",
        group_kind: "ALL",
        clause_start_seq: groupByClause.clause_start_seq,
        clause_end_seq: groupByClause.clause_end_seq,
        body_start_seq: groupByClause.body_start_seq,
        body_end_seq: groupByClause.body_end_seq,
        items: [],
        start_token_seq: groupByClause.clause_start_seq,
        end_token_seq: groupByClause.body_end_seq
      };
    }

    /*
     * JavaScriptメモ
     * ----------------
     * map()は配列の各要素を別の値へ変換し、その結果から新しい配列を作る。
     * ここではToken範囲の配列を、GROUP BY項目オブジェクトの配列へ変換する。
     */
    const itemRanges = this.#splitByTopLevelComma(bodyTokens);
    const items = itemRanges.map((range, index) => (
      this.#parseGroupingItem(range, index + 1)
    ));

    return {
      clause_type: "GROUP_BY",
      clause_start_seq: groupByClause.clause_start_seq,
      clause_end_seq: groupByClause.clause_end_seq,
      body_start_seq: groupByClause.body_start_seq,
      body_end_seq: groupByClause.body_end_seq,
      items,
      start_token_seq: groupByClause.clause_start_seq,
      end_token_seq: groupByClause.body_end_seq
    };
  }

  /**
   * GROUP BY本文を、同じ括弧深度にあるカンマで分割する。
   *
   * 例:
   *   customer_id, DATE(created_at), IF(a, b, c)
   *
   * DATE()やIF()内部のカンマは括弧深度が深いため、項目区切りにはしない。
   *
   * @param {Array<object>} bodyTokens
   * @returns {Array<Array<object>>}
   */
  #splitByTopLevelComma(bodyTokens) {
    const ranges = [];
    let currentRange = [];
    const baseDepth = bodyTokens[0].paren_depth;

    for (const token of bodyTokens) {
      if (token.token === "," && token.paren_depth === baseDepth) {
        if (currentRange.length === 0) {
          throw new SyntaxError(
            `GroupByParser: empty GROUP BY item before token_seq ${token.token_seq}.`
          );
        }

        ranges.push(currentRange);
        currentRange = [];
        continue;
      }

      currentRange.push(token);
    }

    if (currentRange.length === 0) {
      throw new SyntaxError("GroupByParser: GROUP BY Clause ends with a comma.");
    }

    ranges.push(currentRange);
    return ranges;
  }

  /**
   * 1つのGROUP BY項目を解析する。
   *
   * @param {Array<object>} itemTokens
   * @param {number} itemSeq
   * @returns {object}
   */
  #parseGroupingItem(itemTokens, itemSeq) {
    const firstToken = itemTokens[0];
    const secondToken = itemTokens[1];

    if (firstToken.normalized_token === "ROLLUP") {
      return this.#parseRollupOrCube(itemTokens, itemSeq, "ROLLUP");
    }

    if (firstToken.normalized_token === "CUBE") {
      return this.#parseRollupOrCube(itemTokens, itemSeq, "CUBE");
    }

    if (
      firstToken.normalized_token === "GROUPING" &&
      secondToken?.normalized_token === "SETS"
    ) {
      return this.#parseGroupingSets(itemTokens, itemSeq);
    }

    const expression = this.expressionParser.parseExpression(
      firstToken.token_seq,
      itemTokens[itemTokens.length - 1].token_seq
    );

    return {
      group_item_seq: itemSeq,
      grouping_type: "EXPRESSION",
      expression,
      start_token_seq: firstToken.token_seq,
      end_token_seq: itemTokens[itemTokens.length - 1].token_seq
    };
  }

  /**
   * ROLLUP(...)またはCUBE(...)を解析する。
   *
   * @param {Array<object>} itemTokens
   * @param {number} itemSeq
   * @param {string} groupingType
   * @returns {object}
   */
  #parseRollupOrCube(itemTokens, itemSeq, groupingType) {
    const openIndex = itemTokens.findIndex((token) => token.token === "(");

    if (openIndex < 0 || itemTokens[itemTokens.length - 1].token !== ")") {
      throw new SyntaxError(
        `GroupByParser: ${groupingType} must be followed by parentheses.`
      );
    }

    const innerTokens = itemTokens.slice(openIndex + 1, -1);

    if (innerTokens.length === 0) {
      throw new SyntaxError(`GroupByParser: ${groupingType} cannot be empty.`);
    }

    const expressionRanges = this.#splitByTopLevelComma(innerTokens);
    const expressions = expressionRanges.map((range) => (
      this.expressionParser.parseExpression(
        range[0].token_seq,
        range[range.length - 1].token_seq
      )
    ));

    return {
      group_item_seq: itemSeq,
      grouping_type: groupingType,
      expressions,
      start_token_seq: itemTokens[0].token_seq,
      end_token_seq: itemTokens[itemTokens.length - 1].token_seq
    };
  }

  /**
   * GROUPING SETS ((a, b), (a), ())を解析する。
   *
   * 返却するsetsは「グループ化集合」の配列であり、各集合はExpression配列を持つ。
   * 空の括弧()は全体集計を表すため、空配列として保持する。
   *
   * @param {Array<object>} itemTokens
   * @param {number} itemSeq
   * @returns {object}
   */
  #parseGroupingSets(itemTokens, itemSeq) {
    const openIndex = itemTokens.findIndex((token, index) => (
      index >= 2 && token.token === "("
    ));

    if (openIndex < 0 || itemTokens[itemTokens.length - 1].token !== ")") {
      throw new SyntaxError(
        "GroupByParser: GROUPING SETS must be followed by parentheses."
      );
    }

    const outerOpenToken = itemTokens[openIndex];
    const outerDepth = outerOpenToken.paren_depth + 1;
    const innerTokens = itemTokens.slice(openIndex + 1, -1);
    const setRanges = this.#splitByCommaAtDepth(innerTokens, outerDepth);
    const sets = setRanges.map((range, index) => (
      this.#parseGroupingSet(range, index + 1)
    ));

    return {
      group_item_seq: itemSeq,
      grouping_type: "GROUPING_SETS",
      sets,
      start_token_seq: itemTokens[0].token_seq,
      end_token_seq: itemTokens[itemTokens.length - 1].token_seq
    };
  }

  /**
   * GROUPING SETS内の1集合を解析する。
   *
   * @param {Array<object>} setTokens
   * @param {number} setSeq
   * @returns {object}
   */
  #parseGroupingSet(setTokens, setSeq) {
    if (
      setTokens.length < 2 ||
      setTokens[0].token !== "(" ||
      setTokens[setTokens.length - 1].token !== ")"
    ) {
      throw new SyntaxError(
        "GroupByParser: each GROUPING SET must be enclosed in parentheses."
      );
    }

    const expressionTokens = setTokens.slice(1, -1);
    let expressions = [];

    if (expressionTokens.length > 0) {
      const ranges = this.#splitByTopLevelComma(expressionTokens);
      expressions = ranges.map((range) => (
        this.expressionParser.parseExpression(
          range[0].token_seq,
          range[range.length - 1].token_seq
        )
      ));
    }

    return {
      grouping_set_seq: setSeq,
      expressions,
      start_token_seq: setTokens[0].token_seq,
      end_token_seq: setTokens[setTokens.length - 1].token_seq
    };
  }

  /**
   * 指定したparen_depthにあるカンマだけで配列を分割する。
   * GROUPING SETSの外側リストを分割するために利用する。
   *
   * @param {Array<object>} tokens
   * @param {number} targetDepth
   * @returns {Array<Array<object>>}
   */
  #splitByCommaAtDepth(tokens, targetDepth) {
    const ranges = [];
    let currentRange = [];

    for (const token of tokens) {
      if (token.token === "," && token.paren_depth === targetDepth) {
        ranges.push(currentRange);
        currentRange = [];
        continue;
      }

      currentRange.push(token);
    }

    ranges.push(currentRange);
    return ranges;
  }

  /**
   * GroupByParserへ渡されたClauseを検証する。
   *
   * @param {object} groupByClause
   */
  #validateGroupByClause(groupByClause) {
    if (!groupByClause || typeof groupByClause !== "object") {
      throw new TypeError("GroupByParser: groupByClause must be an object.");
    }

    if (groupByClause.clause_type !== "GROUP_BY") {
      throw new TypeError(
        `GroupByParser: GROUP_BY Clause was expected, but received ` +
        `"${groupByClause.clause_type}".`
      );
    }

    if (!Number.isInteger(groupByClause.body_start_seq)) {
      throw new RangeError("GroupByParser: body_start_seq must be an integer.");
    }

    if (!Number.isInteger(groupByClause.body_end_seq)) {
      throw new RangeError("GroupByParser: body_end_seq must be an integer.");
    }

    if (groupByClause.body_end_seq < groupByClause.body_start_seq) {
      throw new SyntaxError("GroupByParser: GROUP BY Clause body is empty.");
    }
  }
}

// ============================================================
// SOURCE: src/having_parser.js
// ============================================================
/**
 * HAVING句本文を条件式ASTへ変換するParser。
 *
 * HavingParserの責務:
 *
 * - ClauseParserが検出したHAVING Clauseの本文範囲を受け取る。
 * - HAVING本文が空でないことを検証する。
 * - 集約関数を含む条件式の解析をExpressionParserへ委譲する。
 * - HAVING Clause自身の位置情報と、生成されたExpression ASTをまとめて返す。
 *
 * HAVINGはWHEREと同じく条件式を持つが、一般にSUM()、COUNT()、AVG()など、
 * GROUP BY後の集約結果を条件として利用する点が異なる。
 * ただし、関数呼び出しや比較演算子の解析はExpression文法の責務なので、
 * HavingParser自身では再実装せずExpressionParserを再利用する。
 *
 * 位置情報は外部APIの方針に合わせ、すべてtoken_seqで返す。
 */
class HavingParser {
  /**
   * @param {Array<object>} tokens Lexerが生成したSQL全体のToken配列
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("HavingParser: tokens must be an array.");
    }

    /*
     * SQL全体のToken配列を保持したExpressionParserを作る。
     * parse()時にHAVING本文のtoken_seq範囲を指定することで、
     * 元Token配列を変更せず、必要な範囲だけを解析する。
     */
    this.tokens = tokens;
    this.expressionParser = new ExpressionParser(tokens);
  }

  /**
   * ClauseParserが返したHAVING Clauseを解析する。
   *
   * @param {object} havingClause ClauseParserのHAVING結果
   * @returns {object} HAVING Clauseと条件式AST
   */
  parse(havingClause) {
    this.#validateHavingClause(havingClause);

    /*
     * HAVING本文の文法解析をExpressionParserへ委譲する。
     *
     * 例:
     *   SUM(amount) > 100 AND COUNT(*) >= 2
     *
     * HavingParserはClause境界だけを管理し、SUM()や比較式、ANDの
     * 優先順位はExpressionParserに任せる。
     */
    const expression = this.expressionParser.parseExpression(
      havingClause.body_start_seq,
      havingClause.body_end_seq
    );

    return {
      clause_type: "HAVING",
      clause_start_seq: havingClause.clause_start_seq,
      clause_end_seq: havingClause.clause_end_seq,
      body_start_seq: havingClause.body_start_seq,
      body_end_seq: havingClause.body_end_seq,
      expression,
      start_token_seq: havingClause.clause_start_seq,
      end_token_seq: havingClause.body_end_seq
    };
  }

  /**
   * HavingParserへ渡されたClauseが、解析可能なHAVING Clauseか検証する。
   *
   * この検証が必要な理由:
   * WHEREやQUALIFYなど別種の条件Clauseを誤って渡しても、本文だけなら
   * ExpressionParserが解析できてしまう可能性がある。入口でClause種別と
   * 本文範囲を確認し、呼び出し側の誤りを明確なエラーとして表面化させる。
   *
   * @param {object} havingClause
   */
  #validateHavingClause(havingClause) {
    if (!havingClause || typeof havingClause !== "object") {
      throw new TypeError("HavingParser: havingClause must be an object.");
    }

    if (havingClause.clause_type !== "HAVING") {
      throw new TypeError(
        `HavingParser: HAVING Clause was expected, but received ` +
        `"${havingClause.clause_type}".`
      );
    }

    if (!Number.isInteger(havingClause.body_start_seq)) {
      throw new RangeError(
        "HavingParser: body_start_seq must be an integer."
      );
    }

    if (!Number.isInteger(havingClause.body_end_seq)) {
      throw new RangeError(
        "HavingParser: body_end_seq must be an integer."
      );
    }

    if (havingClause.body_end_seq < havingClause.body_start_seq) {
      throw new SyntaxError("HavingParser: HAVING Clause body is empty.");
    }
  }
}

// ============================================================
// SOURCE: src/impact_resolver.js
// ============================================================
/**
 * 物理テーブル・物理カラムを起点として、影響を受ける出力列を逆引きする。
 *
 * LineageResolverが作成する依存関係は、次の向きである。
 *
 *   出力列 -> 物理カラム
 *
 * ImpactResolverは、その結果を逆向きに検索して次を返す。
 *
 *   物理カラム -> 影響を受ける出力列
 *
 * このクラスはSQLやASTを再解析しない。
 * LineageResolverの結果だけを利用し、影響調査に使いやすい形へ変換する。
 */
class ImpactResolver {
  constructor() {
    this.nextImpactId = 1;
  }

  /**
   * 指定した物理オブジェクトの影響範囲を返す。
   *
   * target例:
   *
   * {
   *   physical_table_name: "PROJECT.DATASET.SALES",
   *   physical_column_name: "AMOUNT"
   * }
   *
   * physical_column_nameを省略すると、テーブル全体の影響を検索する。
   * field_pathを指定すると、STRUCT等のネスト列を完全一致で検索する。
   */
  resolve(context, target) {
    this.#validateContext(context);
    const normalizedTarget = this.#normalizeTarget(target);

    this.nextImpactId = 1;

    const affectedOutputs = [];

    for (const lineage of context.lineage_resolution.output_lineages) {
      const matchedDependencies = lineage.dependencies.filter((dependency) => {
        return this.#matchesTarget(dependency, normalizedTarget);
      });

      if (matchedDependencies.length === 0) {
        continue;
      }

      affectedOutputs.push(
        this.#createAffectedOutput(lineage, matchedDependencies, context)
      );
    }

    const rootScopeId = context.source_resolution.root_scope_id;
    const rootAffectedOutputs = affectedOutputs.filter((output) => {
      return output.output_scope_id === rootScopeId;
    });

    const result = {
      node_type: "IMPACT_RESOLUTION",
      target: normalizedTarget,
      root_scope_id: rootScopeId,
      impact_status: affectedOutputs.length > 0 ? "IMPACT_FOUND" : "NO_IMPACT",
      affected_outputs: affectedOutputs,
      root_affected_outputs: rootAffectedOutputs,
      affected_output_count: affectedOutputs.length,
      root_affected_output_count: rootAffectedOutputs.length,
      impact_paths: this.#flattenImpactPaths(rootAffectedOutputs)
    };

    context.setImpactResolution(result);

    if (affectedOutputs.length === 0) {
      context.addDiagnostic(
        "INFO",
        "IMPACT_NOT_FOUND",
        "No output column depends on the specified physical target.",
        { target: normalizedTarget }
      );
    }

    return result;
  }

  /**
   * 影響を受ける出力列を1行の情報へまとめる。
   *
   * lineage_pathはLineageResolverが保持した経路をそのまま利用する。
   * これにより、CTEやサブクエリを経由した場合でも途中経路を失わない。
   */
  #createAffectedOutput(lineage, matchedDependencies, context) {
    const uniquePaths = this.#deduplicatePaths(
      matchedDependencies.map((dependency) => dependency.lineage_path)
    );

    return {
      impact_id: this.nextImpactId++,
      output_column_id: lineage.output_column_id,
      output_scope_id: lineage.output_scope_id,
      output_column_seq: lineage.output_column_seq,
      output_column_name: lineage.output_column_name,
      expression_text: lineage.expression_text,
      is_root_output: lineage.output_scope_id === context.source_resolution.root_scope_id,
      lineage_status: lineage.lineage_status,
      matched_dependency_count: matchedDependencies.length,
      matched_dependencies: matchedDependencies.map((dependency) => {
        return {
          physical_table_name: dependency.physical_table_name,
          physical_column_name: dependency.physical_column_name,
          field_path: dependency.field_path,
          lineage_path: dependency.lineage_path
        };
      }),
      impact_paths: uniquePaths,
      start_token_seq: lineage.start_token_seq,
      end_token_seq: lineage.end_token_seq
    };
  }

  /**
   * ルートQueryの出力列について、保存・テーブル化しやすい平坦な行を作る。
   */
  #flattenImpactPaths(rootAffectedOutputs) {
    const rows = [];

    for (const output of rootAffectedOutputs) {
      for (const dependency of output.matched_dependencies) {
        rows.push({
          output_column_id: output.output_column_id,
          output_column_name: output.output_column_name,
          output_scope_id: output.output_scope_id,
          physical_table_name: dependency.physical_table_name,
          physical_column_name: dependency.physical_column_name,
          field_path: dependency.field_path,
          impact_path: dependency.lineage_path
        });
      }
    }

    return rows;
  }

  /**
   * 指定対象とLineage上の物理依存を比較する。
   *
   * - tableは必須で完全一致
   * - columnを省略した場合は、そのtable配下をすべて対象にする
   * - field_path指定時はfield_pathを完全一致で比較する
   */
  #matchesTarget(dependency, target) {
    if (dependency.dependency_type !== "PHYSICAL_COLUMN") {
      return false;
    }

    if (dependency.physical_table_name !== target.physical_table_name) {
      return false;
    }

    if (target.field_path !== null) {
      return this.#normalizeName(dependency.field_path) === target.field_path;
    }

    if (target.physical_column_name === null) {
      return true;
    }

    return dependency.physical_column_name === target.physical_column_name;
  }

  #deduplicatePaths(paths) {
    const result = [];
    const seen = new Set();

    for (const path of paths) {
      const key = JSON.stringify(path);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(path);
    }

    return result;
  }

  #normalizeTarget(target) {
    if (!target || !target.physical_table_name) {
      throw new TypeError(
        "ImpactResolver.resolve: target.physical_table_name is required."
      );
    }

    return {
      physical_table_name: this.#normalizeName(target.physical_table_name),
      physical_column_name: this.#normalizeName(target.physical_column_name),
      field_path: this.#normalizeName(target.field_path)
    };
  }

  #normalizeName(value) {
    return value === null || value === undefined
      ? null
      : String(value).toUpperCase();
  }

  #validateContext(context) {
    if (!context || context.query_ast?.node_type !== "QUERY") {
      throw new TypeError("ImpactResolver.resolve: invalid ResolutionContext.");
    }

    if (context.lineage_resolution?.node_type !== "LINEAGE_RESOLUTION") {
      throw new TypeError(
        "ImpactResolver.resolve: lineage_resolution must be registered first."
      );
    }
  }
}

// ============================================================
// SOURCE: src/lexer.js
// ============================================================
/**
 * SQL文字列を、Parserが扱いやすいToken配列へ変換するLexer。
 *
 * Lexerの責務は「SQLの意味を理解すること」ではなく、SQL文字列を
 * KEYWORD、IDENTIFIER、NUMBER、STRING、SYMBOLなどの最小単位へ分解すること。
 *
 * 例えば次のSQLを受け取った場合、
 *
 *   SELECT SUM(amount) FROM sales
 *
 * おおむね次のToken配列を返す。
 *
 *   SELECT   KEYWORD
 *   SUM      IDENTIFIER
 *   (        SYMBOL
 *   amount   IDENTIFIER
 *   )        SYMBOL
 *   FROM     KEYWORD
 *   sales    IDENTIFIER
 *
 * LexerがTokenへ付与する主な情報:
 *
 * - token_seq:
 *     Parser、Resolver、保存テーブルで共通利用するTokenの論理連番。
 *     JavaScript配列のindexとは異なり、1から始まる。
 *
 * - line_no / column_no:
 *     SQL上でTokenが開始した位置。エラー表示やデバッグに使用する。
 *
 * - normalized_token:
 *     大文字・小文字の違いを吸収して比較するための値。
 *     通常の識別子やKeywordは大文字へ統一する。
 *
 * - token_type:
 *     後続Parserが文字列そのものだけで判断しなくて済むように、
 *     Tokenの種類を明示する。
 *
 * - paren_depth:
 *     関数、サブクエリ、Window句などの括弧の入れ子を識別する。
 *
 * depth仕様:
 *
 *   SUM(amount)
 *
 *   SUM     depth 0
 *   (       depth 0
 *   amount  depth 1
 *   )       depth 0
 *
 * 「括弧そのもの」ではなく「括弧の中身だけ」を1段深くする。
 * そのため、開き括弧は現在depthで保存してからdepthを上げ、
 * 閉じ括弧はdepthを下げてから保存する。
 *
 * @param {string} sqlText Token化するSQL文字列
 * @returns {Array<object>} Lexerが生成したToken配列
 */
function tokenize(sqlText) {
  /*
   * Lexerは文字列を1文字ずつ処理するため、文字列以外を受け取ると
   * 意味のある解析ができない。暗黙変換はせず、呼び出し側の誤りを
   * 早い段階で検出する。
   */
  if (typeof sqlText !== "string") {
    throw new TypeError("tokenize: sqlText must be a string.");
  }

  // 解析結果となるTokenを、SQLに現れた順番で格納する。
  const tokens = [];

  /*
   * Lexerが文字列を左から右へ読むために保持する状態。
   *
   * tokenSeq:
   *   次に発行するtoken_seqの元値。pushToken()で1増やしてから保存する。
   *
   * line / column:
   *   現在indexが指している文字のSQL上の位置。
   *
   * parenDepth:
   *   現在の文字が属する括弧内の深さ。
   *
   * index:
   *   sqlText配列上の現在位置。Lexer内部だけで使用する0始まりの座標。
   */
  let tokenSeq = 0;
  let line = 1;
  let column = 1;
  let parenDepth = 0;
  let index = 0;

  /*
   * Keywordとして分類する予約語一覧。
   *
   * LexerはSQL文法の正当性までは判定しない。
   * このSetは、読み取った単語をKEYWORDとして分類するか、
   * IDENTIFIERとして分類するかを決めるために使用する。
   */
  const KEYWORDS = new Set([
    "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "QUALIFY",
    "ORDER", "LIMIT", "JOIN", "LEFT", "RIGHT", "FULL", "INNER",
    "OUTER", "CROSS", "ON", "USING", "WITH", "RECURSIVE", "AS",
    "UNION", "ALL", "DISTINCT", "AND", "OR", "NOT", "IN", "IS",
    "NULL", "TRUE", "FALSE", "CASE", "WHEN", "THEN", "ELSE", "END",
    "OVER", "PARTITION", "UNNEST", "STRUCT", "ARRAY", "EXCEPT",
    "REPLACE", "INTERSECT", "OFFSET", "ORDINAL", "ASC", "DESC",
    "ROWS", "RANGE", "GROUPS", "NULLS", "FIRST", "LAST", "BETWEEN",
    "PRECEDING", "FOLLOWING", "CURRENT", "ROW", "EXISTS"
  ]);

  /*
   * SQL構造を区切る1文字記号。
   *
   * () と [] はparenDepthを変化させる。
   * カンマ、ドット、セミコロンはToken化するだけでdepthは変えない。
   */
  const SYMBOLS = new Set(["(", ")", ",", ".", ";", "[", "]"]);

  // 単独でも演算子として成立する1文字演算子。
  const SINGLE_OPERATORS = new Set(["=", "+", "-", "*", "/", "%", "<", ">", "!"]);

  /*
   * 2文字で1つの意味を持つ演算子。
   *
   * SINGLE_OPERATORSより先に評価しないと、>= が > と = の2Tokenへ
   * 分割されてしまうため、メインループでは必ずこちらを先に判定する。
   */
  const DOUBLE_OPERATORS = new Set([">=", "<=", "!=", "<>", "||"]);

  /**
   * 解析済みの1Tokenをtokens配列へ追加する。
   *
   * Token生成処理を1か所へ集約する理由:
   *
   * - token_seqの採番方法を全Tokenで統一できる。
   * - line、column、depthの付与漏れを防げる。
   * - 後からToken項目を追加するとき、修正箇所を1か所にできる。
   *
   * @param {string} token SQLに記述されていた元の文字列
   * @param {string} normalizedToken 比較用に正規化した文字列
   * @param {string} tokenType Tokenの分類
   * @param {number} tokenLine Token開始行
   * @param {number} tokenColumn Token開始列
   */
  function pushToken(token, normalizedToken, tokenType, tokenLine, tokenColumn) {
    tokens.push({
      token_seq: ++tokenSeq,
      line_no: tokenLine,
      column_no: tokenColumn,
      token,
      normalized_token: normalizedToken,
      token_type: tokenType,
      paren_depth: parenDepth
    });
  }

  /**
   * 空白文字か判定する。
   *
   * 半角スペースだけでなく、改行やタブも空白として扱うため、\sを使う。
   * 空白はTokenには保存しないが、lineとcolumnは正しく進める。
   */
  function isSpace(character) {
    return /\s/.test(character);
  }

  /**
   * 通常識別子を開始できる文字か判定する。
   *
   * 数字を含めない理由:
   * 数字で始まる文字列は、まず数値リテラルとして処理すべきだから。
   * 数字始まりの識別子は、BigQueryではバッククォートで囲む必要があり、
   * BACKTICK_IDENTIFIERの分岐で別に処理する。
   */
  function isIdentifierStart(character) {
    return /[A-Za-z_]/.test(character);
  }

  /**
   * 識別子の2文字目以降として使用できる文字か判定する。
   *
   * customer1 や _TABLE_SUFFIX のような識別子を扱うため、
   * 開始文字の条件に加えて数字と$を許可する。
   */
  function isIdentifierPart(character) {
    return /[A-Za-z0-9_$]/.test(character);
  }

  /**
   * 数値リテラルの開始文字か判定する。
   *
   * 先頭文字は0〜9だけを許可する。
   * 小数点は、数値の読み取りを開始した後のwhile条件で許可する。
   */
  function isDigit(character) {
    return /[0-9]/.test(character);
  }

  /**
   * 現在の1文字を消費し、次の文字へ進む。
   *
   * indexだけでなくlineとcolumnも同時に更新することで、
   * どの分岐から呼ばれても位置情報を一貫して管理できる。
   *
   * @param {string} character 今回消費する文字
   */
  function advanceCharacter(character) {
    if (character === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }

    index++;
  }

  /*
   * SQL文字列を左から右へ、1文字または複数文字単位で読み取る。
   *
   * 各分岐の末尾にcontinueがあるため、一度分類が確定した文字を
   * 後続の別分岐で二重に評価しない。
   */
  while (index < sqlText.length) {
    // このループで最初に評価する現在位置の文字。
    const character = sqlText[index];

    /*
     * 空白はToken化せず、位置だけ進める。
     * コメントや文字列の中の空白は、それぞれ専用分岐内で処理される。
     */
    if (isSpace(character)) {
      advanceCharacter(character);
      continue;
    }

    /*
     * Tokenの開始位置は、文字を読み進める前に保存する必要がある。
     * 読み取り後のline/columnを使うとToken末尾の位置になってしまう。
     */
    const startLine = line;
    const startColumn = column;

    /*
     * 1行コメントを読み取る。
     *
     * 「--」または「#」を見つけた位置から改行直前までを1つのCOMMENT Token
     * にする。BigQueryは「--」「#」の両方を単一行コメントとして扱う。
     * 改行はこのTokenに含めず、次のメインループで空白として処理する。
     */
    if ((character === "-" && sqlText[index + 1] === "-") ||
        character === "#") {
      let value = "";

      while (index < sqlText.length && sqlText[index] !== "\n") {
        const current = sqlText[index];

        value += current;
        advanceCharacter(current);
      }

      pushToken(value, value, "COMMENT", startLine, startColumn);
      continue;
    }

    /*
     * 複数行コメントを読み取る。
     *
     * 開始記号から終了記号までを、改行を含めて1つのCOMMENT Tokenにする。
     * 終了記号は2文字なので、*を消費した後に/も明示的に消費する。
     */
    if (character === "/" && sqlText[index + 1] === "*") {
      let value = "";

      while (index < sqlText.length) {
        const current = sqlText[index];

        value += current;

        if (current === "*" && sqlText[index + 1] === "/") {
          advanceCharacter(current);

          const closingSlash = sqlText[index];
          value += closingSlash;
          advanceCharacter(closingSlash);
          break;
        }

        advanceCharacter(current);
      }

      pushToken(value, value, "COMMENT", startLine, startColumn);
      continue;
    }

    /*
     * バッククォート識別子を読み取る。
     *
     * `project.dataset.table` のような名前は、内部のドットをSYMBOLへ
     * 分割せず、全体を1つのBACKTICK_IDENTIFIERとして保存する。
     * normalized_tokenからは外側のバッククォートだけを除去する。
     */
    if (character === "`") {
      let value = character;

      advanceCharacter(character);

      while (index < sqlText.length) {
        const current = sqlText[index];

        value += current;
        advanceCharacter(current);

        if (current === "`") {
          break;
        }
      }

      const normalizedValue = value.length >= 2
        ? value.substring(1, value.length - 1)
        : value;

      pushToken(
        value,
        normalizedValue,
        "BACKTICK_IDENTIFIER",
        startLine,
        startColumn
      );

      continue;
    }

    /*
     * 文字列リテラルを読み取る。
     *
     * シングルクォートとダブルクォートの両方を同じ処理で扱うため、
     * 開始時のquoteCharacterを保存し、同じ文字が来るまで読み進める。
     *
     * '' や "" のように引用符が連続する場合はエスケープ表現として扱い、
     * 文字列終了とは判定しない。
     */
    if (character === "'" || character === '"') {
      const quoteCharacter = character;
      let value = character;

      advanceCharacter(character);

      while (index < sqlText.length) {
        const current = sqlText[index];

        value += current;
        advanceCharacter(current);

        if (current === quoteCharacter && sqlText[index] === quoteCharacter) {
          const escapedQuote = sqlText[index];

          value += escapedQuote;
          advanceCharacter(escapedQuote);
          continue;
        }

        if (current === quoteCharacter) {
          break;
        }
      }

      const normalizedValue = value.length >= 2
        ? value.substring(1, value.length - 1)
        : value;

      pushToken(value, normalizedValue, "STRING", startLine, startColumn);
      continue;
    }

    /*
     * 文字列リテラル接頭辞を読み取る。
     *
     * BigQueryは r'...'(raw)、b'...'(bytes)、および rb/br の組み合わせを
     * 文字列リテラルの接頭辞として認める。接頭辞の直後(空白なし)に引用符が
     * 続く場合のみ文字列として扱い、それ以外は通常の識別子として処理する。
     * normalized_tokenは接頭辞と引用符を除いた中身にする。
     */
    {
      const twoChar = sqlText.substr(index, 2).toLowerCase();
      const oneChar = character.toLowerCase();
      let prefixLength = 0;

      if ((twoChar === "rb" || twoChar === "br") &&
          (sqlText[index + 2] === "'" || sqlText[index + 2] === '"')) {
        prefixLength = 2;
      } else if ((oneChar === "r" || oneChar === "b") &&
          (sqlText[index + 1] === "'" || sqlText[index + 1] === '"')) {
        prefixLength = 1;
      }

      if (prefixLength > 0) {
        let value = "";

        for (let offset = 0; offset < prefixLength; offset++) {
          const current = sqlText[index];
          value += current;
          advanceCharacter(current);
        }

        const quoteCharacter = sqlText[index];
        value += quoteCharacter;
        advanceCharacter(quoteCharacter);

        while (index < sqlText.length) {
          const current = sqlText[index];
          value += current;
          advanceCharacter(current);

          if (current === quoteCharacter && sqlText[index] === quoteCharacter) {
            const escapedQuote = sqlText[index];
            value += escapedQuote;
            advanceCharacter(escapedQuote);
            continue;
          }

          if (current === quoteCharacter) {
            break;
          }
        }

        const normalizedValue = value.length >= prefixLength + 2
          ? value.substring(prefixLength + 1, value.length - 1)
          : value;

        pushToken(value, normalizedValue, "STRING", startLine, startColumn);
        continue;
      }
    }

    /*
     * 名前付きクエリパラメータ @name / システム変数 @@name（dbt 由来の @key /
     * @limit など）を 1 つの Token として読み取る。'@' と名前を分けると、名前が
     * 句キーワード（LIMIT / ORDER / WHERE ...）と一致する場合に ClauseParser が
     * その位置を句の開始と誤認してしまう。token_type を PARAMETER にし、
     * normalized も '@' 込み（例: '@LIMIT'）にすることでキーワードと衝突させない。
     */
    if (character === "@") {
      let value = "@";
      advanceCharacter("@");

      if (sqlText[index] === "@") {
        value += "@";
        advanceCharacter("@");
      }

      while (index < sqlText.length && isIdentifierPart(sqlText[index])) {
        value += sqlText[index];
        advanceCharacter(sqlText[index]);
      }

      pushToken(value, value.toUpperCase(), "PARAMETER", startLine, startColumn);
      continue;
    }

    /*
     * 通常識別子またはKeywordを読み取る。
     *
     * 最初の文字が識別子開始条件を満たした後、識別子として継続できる
     * 文字を可能な限りまとめて読み取る。読み取った文字列を大文字化し、
     * KEYWORDSに存在すればKEYWORD、それ以外はIDENTIFIERに分類する。
     */
    if (isIdentifierStart(character)) {
      let value = "";

      while (index < sqlText.length && isIdentifierPart(sqlText[index])) {
        const current = sqlText[index];

        value += current;
        advanceCharacter(current);
      }

      const normalizedValue = value.toUpperCase();
      const tokenType = KEYWORDS.has(normalizedValue) ? "KEYWORD" : "IDENTIFIER";

      pushToken(value, normalizedValue, tokenType, startLine, startColumn);
      continue;
    }

    /*
     * 数値リテラルを読み取る。
     *
     * 最初の文字はisDigit()により必ず0〜9。
     * 2文字目以降は整数と小数をまとめるため、0〜9とドットを許可する。
     *
     * 現時点では12.3.4のような複数ドットの文法エラー判定までは行わない。
     * Lexerの責務をToken分割に留め、必要ならValidation層で検出する。
     */
    if (isDigit(character)) {
      let value = "";

      // Integer part.
      while (index < sqlText.length && /[0-9]/.test(sqlText[index])) {
        value += sqlText[index];
        advanceCharacter(sqlText[index]);
      }

      /*
       * Fractional part. A '.' belongs to the number (123.45, trailing 123.)
       * UNLESS it is immediately followed by an identifier-start character, in
       * which case the '.' is a path separator / field access and the number
       * ends before it. Without this, a dashed table path with a digit-ending
       * segment — e.g. `my-project-123.dataset` — lexed `123.` as one number
       * token (eating the separator) and broke FROM parsing. `123.45` keeps the
       * dot (next char is a digit); `123.` at end / before whitespace also keeps
       * it (unchanged); only `123.<letter>` now splits.
       */
      while (
        sqlText[index] === "." &&
        !/[A-Za-z_`]/.test(sqlText[index + 1] || "")
      ) {
        value += ".";
        advanceCharacter(".");

        while (index < sqlText.length && /[0-9]/.test(sqlText[index])) {
          value += sqlText[index];
          advanceCharacter(sqlText[index]);
        }
      }

      /*
       * 指数表記(例: 1.5e3, 2E-4)を取り込む。eまたはEの直後に符号か数字が
       * 続く場合のみ指数部として扱い、それ以外(例: 1 e AS ...)は別Tokenへ残す。
       */
      if ((sqlText[index] === "e" || sqlText[index] === "E") &&
          /[0-9+\-]/.test(sqlText[index + 1] || "")) {
        value += sqlText[index];
        advanceCharacter(sqlText[index]);

        if (sqlText[index] === "+" || sqlText[index] === "-") {
          value += sqlText[index];
          advanceCharacter(sqlText[index]);
        }

        while (index < sqlText.length && /[0-9]/.test(sqlText[index])) {
          value += sqlText[index];
          advanceCharacter(sqlText[index]);
        }
      }

      pushToken(value, value, "NUMBER", startLine, startColumn);
      continue;
    }

    /*
     * 2文字演算子を先に判定する。
     *
     * ここを1文字演算子より後にすると、>= が > と = に分割される。
     * Lexerでは「より長く一致する候補を先に評価する」のが基本原則。
     */
    const twoCharacters = sqlText.substring(index, index + 2);

    if (DOUBLE_OPERATORS.has(twoCharacters)) {
      pushToken(twoCharacters, twoCharacters, "OPERATOR", startLine, startColumn);

      // 2文字演算子なので、現在文字と次の文字をそれぞれ消費する。
      advanceCharacter(sqlText[index]);
      advanceCharacter(sqlText[index]);
      continue;
    }

    /*
     * 括弧、カンマ、ドットなどの構造記号を処理する。
     *
     * depthの更新順序が重要:
     *
     * - 閉じ括弧:
     *     括弧の外側のdepthで保存したいため、先にdepthを下げる。
     *
     * - 開き括弧:
     *     開き括弧自体は外側のdepthで保存し、その後の中身から深くする。
     *
     * これにより、対応する開き括弧と閉じ括弧が同じdepthになり、
     * TokenReaderで対応括弧を探しやすくなる。
     */
    if (SYMBOLS.has(character)) {
      if (character === ")" || character === "]") {
        parenDepth--;

        /*
         * depthが負になるのは、対応する開き括弧がない閉じ括弧が
         * 出現したことを意味する。黙って0へ補正すると不正SQLを隠すため、
         * 行・列情報を含むSyntaxErrorとして通知する。
         */
        if (parenDepth < 0) {
          throw new SyntaxError(
            `tokenize: unexpected closing symbol "${character}" ` +
            `at line ${startLine}, column ${startColumn}.`
          );
        }
      }

      pushToken(character, character, "SYMBOL", startLine, startColumn);

      if (character === "(" || character === "[") {
        parenDepth++;
      }

      // SYMBOLはすべて1文字なので、共通処理として最後に1文字進める。
      advanceCharacter(character);
      continue;
    }

    // 2文字演算子に該当しなかった1文字演算子をToken化する。
    if (SINGLE_OPERATORS.has(character)) {
      pushToken(character, character, "OPERATOR", startLine, startColumn);
      advanceCharacter(character);
      continue;
    }

    /*
     * どの分類にも該当しない文字も捨てずにUNKNOWNとして保存する。
     *
     * 未対応文字を消してしまうと、Parserの結果がおかしい原因を追えない。
     * UNKNOWNとして残すことで、後続Validationやデバッグで検出できる。
     */
    pushToken(character, character, "UNKNOWN", startLine, startColumn);
    advanceCharacter(character);
  }

  /*
   * SQL末尾まで読んだ時点でdepthが0でなければ、開き括弧が閉じられていない。
   * 不完全なToken列を後続Parserへ渡さず、Lexer段階で明示的に失敗させる。
   */
  if (parenDepth !== 0) {
    throw new SyntaxError(
      `tokenize: unclosed parenthesis or bracket. Remaining depth: ${parenDepth}.`
    );
  }

  return tokens;
}

/*
 * オブジェクト形式でexportすることで、将来Lexerから別の公開関数を
 * 追加してもrequire側の書き方を統一できる。
 */

// ============================================================
// SOURCE: src/limit_parser.js
// ============================================================
/**
 * LIMIT句を、取得件数と開始位置へ分解するParser。
 *
 * BigQueryのGoogleSQLでは、LIMIT句は次の形を取る。
 *
 *   LIMIT count
 *   LIMIT count OFFSET skip_rows
 *
 * countとskip_rowsはINT64の定数式である。LimitParserは値の妥当性や型を
 * 実行せず、Token範囲をExpressionParserへ委譲してASTとして保持する。
 *
 * LimitParserの責務:
 *
 * - ClauseParserが確定したLIMIT Clause本文だけを取り出す。
 * - トップレベルのOFFSETを境界としてcountとskip_rowsを分割する。
 * - 各範囲をExpressionParserへ渡す。
 * - LIMIT固有の構造を、token_seq基準の結果として返す。
 *
 * LIMIT 10, 20のようなカンマ形式はBigQueryのGoogleSQL構文ではないため、
 * 対応せず明確なSyntaxErrorを返す。
 */
class LimitParser {
  /**
   * @param {Array<object>} tokens Lexerが生成したSQL全体のToken配列
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("LimitParser: tokens must be an array.");
    }

    this.tokens = tokens;
    this.expressionParser = new ExpressionParser(tokens);
  }

  /**
   * ClauseParserが返したLIMIT Clauseを解析する。
   *
   * @param {object} limitClause ClauseParserのLIMIT結果
   * @returns {object} LIMIT件数と任意のOFFSET式
   */
  parse(limitClause) {
    this.#validateLimitClause(limitClause);

    /*
     * LIMIT本文だけを取得する。
     *
     * COMMENTは件数やOFFSETの意味を持たないため除外する。
     * 最終セミコロンはSQL文の終端であり、LIMIT式の一部ではないため除外する。
     * filter()は元Token配列を変更せず、新しい配列を返す。
     */
    const bodyTokens = this.tokens.filter((token) => (
      token.token_seq >= limitClause.body_start_seq &&
      token.token_seq <= limitClause.body_end_seq &&
      token.token_type !== "COMMENT" &&
      token.token !== ";"
    ));

    if (bodyTokens.length === 0) {
      throw new SyntaxError("LimitParser: LIMIT Clause body is empty.");
    }

    /*
     * BigQueryではLIMIT count, skip_rows形式を採用しない。
     * 対応外TokenをExpressionParserへ渡して曖昧なエラーにするのではなく、
     * LIMIT構文の入口で意図が分かるエラーを返す。
     */
    const commaToken = bodyTokens.find((token) => token.token === ",");

    if (commaToken) {
      throw new SyntaxError(
        `LimitParser: comma LIMIT syntax is not supported by BigQuery ` +
        `(token_seq ${commaToken.token_seq}). Use LIMIT count OFFSET skip_rows.`
      );
    }

    const baseDepth = bodyTokens[0].paren_depth;
    const offsetIndexes = [];

    /*
     * 関数や括弧式の内部にOFFSETという識別子があっても境界にしないよう、
     * LIMIT本文と同じ括弧深度にあるOFFSETだけを候補にする。
     */
    for (let tokenIndex = 0; tokenIndex < bodyTokens.length; tokenIndex++) {
      const token = bodyTokens[tokenIndex];

      if (
        token.normalized_token === "OFFSET" &&
        token.paren_depth === baseDepth
      ) {
        offsetIndexes.push(tokenIndex);
      }
    }

    if (offsetIndexes.length > 1) {
      throw new SyntaxError("LimitParser: LIMIT Clause contains multiple OFFSET keywords.");
    }

    const offsetIndex = offsetIndexes.length === 1 ? offsetIndexes[0] : -1;
    const countTokens = offsetIndex >= 0
      ? bodyTokens.slice(0, offsetIndex)
      : bodyTokens.slice();
    const offsetTokens = offsetIndex >= 0
      ? bodyTokens.slice(offsetIndex + 1)
      : [];

    if (countTokens.length === 0) {
      throw new SyntaxError("LimitParser: LIMIT count expression is missing.");
    }

    if (offsetIndex >= 0 && offsetTokens.length === 0) {
      throw new SyntaxError("LimitParser: OFFSET expression is missing.");
    }

    const countExpression = this.#parseExpressionRange(countTokens, "count");
    const offsetExpression = offsetTokens.length > 0
      ? this.#parseExpressionRange(offsetTokens, "offset")
      : null;

    return {
      clause_type: "LIMIT",
      clause_start_seq: limitClause.clause_start_seq,
      clause_end_seq: limitClause.clause_end_seq,
      body_start_seq: limitClause.body_start_seq,
      body_end_seq: limitClause.body_end_seq,
      count_expression: countExpression,
      offset_expression: offsetExpression,
      start_token_seq: limitClause.clause_start_seq,
      end_token_seq: bodyTokens[bodyTokens.length - 1].token_seq
    };
  }

  /**
   * Token配列の先頭・末尾token_seqをExpressionParserへ渡す。
   *
   * countとoffsetの文法解析をLimitParser内へ重複実装せず、四則演算や括弧など
   * 既存Expression文法をそのまま再利用するためのメソッド。
   *
   * @param {Array<object>} expressionTokens
   * @param {string} expressionName エラーメッセージ用名称
   * @returns {object}
   */
  #parseExpressionRange(expressionTokens, expressionName) {
    const firstToken = expressionTokens[0];
    const lastToken = expressionTokens[expressionTokens.length - 1];

    try {
      return this.expressionParser.parseExpression(
        firstToken.token_seq,
        lastToken.token_seq
      );
    } catch (error) {
      throw new SyntaxError(
        `LimitParser: invalid ${expressionName} expression. ${error.message}`
      );
    }
  }

  /**
   * 解析入口の引数を検証する。
   *
   * Token範囲だけなら他Clauseも一部解析できてしまうため、Clause種別を先に
   * 確認し、呼び出し側の誤りを早期に検出する。
   *
   * @param {object} limitClause
   */
  #validateLimitClause(limitClause) {
    if (!limitClause || typeof limitClause !== "object") {
      throw new TypeError("LimitParser: limitClause must be an object.");
    }

    if (limitClause.clause_type !== "LIMIT") {
      throw new TypeError(
        `LimitParser: LIMIT Clause was expected, but received ` +
        `"${limitClause.clause_type}".`
      );
    }

    if (!Number.isInteger(limitClause.body_start_seq)) {
      throw new RangeError("LimitParser: body_start_seq must be an integer.");
    }

    if (!Number.isInteger(limitClause.body_end_seq)) {
      throw new RangeError("LimitParser: body_end_seq must be an integer.");
    }

    if (limitClause.body_end_seq < limitClause.body_start_seq) {
      throw new SyntaxError("LimitParser: LIMIT Clause body is empty.");
    }
  }
}

// ============================================================
// SOURCE: src/where_parser.js
// ============================================================
/**
 * WHERE句本文を条件式ASTへ変換するParser。
 *
 * WhereParserの責務:
 *
 * - ClauseParserが検出したWHERE Clauseの本文範囲を受け取る。
 * - WHERE本文が空でないことを検証する。
 * - 条件式の解析をExpressionParserへ委譲する。
 * - WHERE Clause自身の位置情報と、生成されたExpression ASTをまとめて返す。
 *
 * WHERE内のAND、OR、BETWEEN、IN、関数呼び出しなどを
 * WhereParser自身で解析しない理由:
 *
 * それらはすべてExpression文法であり、ExpressionParserがすでに
 * 演算子優先順位を含めて解析する責務を持っているため。
 * WhereParserはClauseとExpressionの橋渡しだけに責務を限定する。
 *
 * 位置情報は外部APIの方針に合わせ、すべてtoken_seqで返す。
 */
class WhereParser {
  /**
   * @param {Array<object>} tokens Lexerが生成したSQL全体のToken配列
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("WhereParser: tokens must be an array.");
    }

    /*
     * ExpressionParserにはSQL全体のToken配列を渡しておく。
     * parseExpression()へWHERE本文のstart/end token_seqを指定することで、
     * 元Token配列をコピー・変更せず、必要範囲だけを解析できる。
     */
    this.tokens = tokens;
    this.expressionParser = new ExpressionParser(tokens);
  }

  /**
   * ClauseParserが返したWHERE Clauseを解析する。
   *
   * @param {object} whereClause ClauseParserのWHERE結果
   * @returns {object} WHERE Clauseと条件式AST
   */
  parse(whereClause) {
    this.#validateWhereClause(whereClause);

    /*
     * WHERE本文全体をExpressionParserへ委譲する。
     * ExpressionParser側でCOMMENT Tokenを解析用配列から除外するため、
     * WhereParserではコメント除去処理を重複実装しない。
     */
    const expression = this.expressionParser.parseExpression(
      whereClause.body_start_seq,
      whereClause.body_end_seq
    );

    return {
      clause_type: "WHERE",
      clause_start_seq: whereClause.clause_start_seq,
      clause_end_seq: whereClause.clause_end_seq,
      body_start_seq: whereClause.body_start_seq,
      body_end_seq: whereClause.body_end_seq,
      expression,
      start_token_seq: whereClause.clause_start_seq,
      end_token_seq: whereClause.body_end_seq
    };
  }

  /**
   * WhereParserへ渡されたClauseが、解析可能なWHERE Clauseか検証する。
   *
   * この検証が必要な理由:
   * Select ClauseやFrom Clauseを誤って渡した場合、本文自体はExpressionとして
   * 部分的に解析できてしまう可能性がある。入口でClause種別と範囲を確認し、
   * 呼び出し側の誤りを早い段階で明確なエラーにする。
   *
   * @param {object} whereClause
   */
  #validateWhereClause(whereClause) {
    if (!whereClause || typeof whereClause !== "object") {
      throw new TypeError("WhereParser: whereClause must be an object.");
    }

    if (whereClause.clause_type !== "WHERE") {
      throw new TypeError(
        `WhereParser: WHERE Clause was expected, but received ` +
        `"${whereClause.clause_type}".`
      );
    }

    if (!Number.isInteger(whereClause.body_start_seq)) {
      throw new RangeError(
        "WhereParser: body_start_seq must be an integer."
      );
    }

    if (!Number.isInteger(whereClause.body_end_seq)) {
      throw new RangeError(
        "WhereParser: body_end_seq must be an integer."
      );
    }

    if (whereClause.body_end_seq < whereClause.body_start_seq) {
      throw new SyntaxError("WhereParser: WHERE Clause body is empty.");
    }
  }
}

// ============================================================
// SOURCE: src/qualify_parser.js
// ============================================================
/**
 * QUALIFY句本文を条件式ASTへ変換するParser。
 *
 * QUALIFYは、ROW_NUMBER()、RANK()などのウィンドウ関数を評価した後に
 * 行を絞り込むBigQueryのClauseである。
 *
 * QualifyParser自身はウィンドウ関数や比較演算子を解析しない。
 * ClauseParserが確定したQUALIFY本文のToken範囲をExpressionParserへ渡し、
 * 返されたASTとClause位置情報をまとめることだけを担当する。
 */
class QualifyParser {
  /**
   * @param {Array<object>} tokens Lexerが生成したSQL全体のToken配列
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("QualifyParser: tokens must be an array.");
    }

    this.tokens = tokens;
    this.expressionParser = new ExpressionParser(tokens);
  }

  /**
   * ClauseParserが返したQUALIFY Clauseを解析する。
   *
   * @param {object} qualifyClause ClauseParserのQUALIFY結果
   * @returns {object} QUALIFY Clauseと条件式AST
   */
  parse(qualifyClause) {
    this.#validateQualifyClause(qualifyClause);

    const expression = this.expressionParser.parseExpression(
      qualifyClause.body_start_seq,
      qualifyClause.body_end_seq
    );

    return {
      clause_type: "QUALIFY",
      clause_start_seq: qualifyClause.clause_start_seq,
      clause_end_seq: qualifyClause.clause_end_seq,
      body_start_seq: qualifyClause.body_start_seq,
      body_end_seq: qualifyClause.body_end_seq,
      expression,
      start_token_seq: qualifyClause.clause_start_seq,
      end_token_seq: qualifyClause.body_end_seq
    };
  }

  /**
   * 解析対象が本文を持つQUALIFY Clauseであることを入口で検証する。
   *
   * ExpressionParserはToken範囲だけ渡されれば式を解析できるため、
   * Clause種別の検証を省くとWHEREやHAVINGを誤って渡しても処理できてしまう。
   * 呼び出し側の誤りを早期発見するため、このクラスで明示的に確認する。
   */
  #validateQualifyClause(qualifyClause) {
    if (!qualifyClause || typeof qualifyClause !== "object") {
      throw new TypeError("QualifyParser: qualifyClause must be an object.");
    }

    if (qualifyClause.clause_type !== "QUALIFY") {
      throw new TypeError(
        `QualifyParser: QUALIFY Clause was expected, but received ` +
        `"${qualifyClause.clause_type}".`
      );
    }

    if (!Number.isInteger(qualifyClause.body_start_seq)) {
      throw new RangeError(
        "QualifyParser: body_start_seq must be an integer."
      );
    }

    if (!Number.isInteger(qualifyClause.body_end_seq)) {
      throw new RangeError(
        "QualifyParser: body_end_seq must be an integer."
      );
    }

    if (qualifyClause.body_end_seq < qualifyClause.body_start_seq) {
      throw new SyntaxError("QualifyParser: QUALIFY Clause body is empty.");
    }
  }
}

// ============================================================
// SOURCE: src/order_by_parser.js
// ============================================================
/**
 * ORDER BY句本文を、並び替え項目の一覧へ変換するParser。
 *
 * OrderByParserの責務:
 *
 * - ClauseParserが確定したORDER_BY Clauseの本文範囲を受け取る。
 * - トップレベルのカンマだけを区切りとして、並び替え項目を分割する。
 * - 各項目の式部分はExpressionParserへ委譲する。
 * - ASC / DESCとNULLS FIRST / NULLS LASTをORDER BY固有の属性として保持する。
 * - 外部へ返す位置情報はすべてtoken_seqで統一する。
 *
 * なぜ方向指定をExpressionParserへ渡さないのか:
 *
 *   ORDER BY amount DESC
 *
 * のDESCはamount式の一部ではなく、ORDER BY項目へ付く属性である。
 * そのため、OrderByParserが末尾の修飾Tokenを取り除いてから、残った範囲だけを
 * ExpressionParserへ渡す。
 */
class OrderByParser {
  /**
   * @param {Array<object>} tokens Lexerが生成したSQL全体のToken配列
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("OrderByParser: tokens must be an array.");
    }

    this.tokens = tokens;
    this.expressionParser = new ExpressionParser(tokens);
  }

  /**
   * ClauseParserが返したORDER_BY Clauseを解析する。
   *
   * @param {object} orderByClause ClauseParserのORDER_BY結果
   * @returns {object} ORDER BY Clauseと並び替え項目一覧
   */
  parse(orderByClause) {
    this.#validateOrderByClause(orderByClause);

    /*
     * ORDER BY本文だけを取り出す。
     *
     * COMMENT Tokenは並び替えの意味を持たないため、解析対象から除外する。
     * 元のthis.tokensは変更せず、filter()が返す新しい配列だけを利用する。
     *
     * JavaScriptメモ
     * ----------------
     * filter()は、条件がtrueになった要素だけを集めた新しい配列を返す。
     */
    const bodyTokens = this.tokens.filter((token) => (
      token.token_seq >= orderByClause.body_start_seq &&
      token.token_seq <= orderByClause.body_end_seq &&
      token.token_type !== "COMMENT"
    ));

    if (bodyTokens.length === 0) {
      throw new SyntaxError("OrderByParser: ORDER BY Clause body is empty.");
    }

    /*
     * 関数や括弧式の内部にあるカンマを誤って項目区切りにしないよう、
     * ORDER BY本文と同じ括弧深度のカンマだけで分割する。
     */
    const itemRanges = this.#splitByTopLevelComma(bodyTokens);

    /*
     * JavaScriptメモ
     * ----------------
     * map()は各Token範囲をORDER BY項目オブジェクトへ変換し、
     * 変換結果から新しい配列を作る。
     */
    const items = itemRanges.map((itemTokens, index) => (
      this.#parseOrderItem(itemTokens, index + 1)
    ));

    return {
      clause_type: "ORDER_BY",
      clause_start_seq: orderByClause.clause_start_seq,
      clause_end_seq: orderByClause.clause_end_seq,
      body_start_seq: orderByClause.body_start_seq,
      body_end_seq: orderByClause.body_end_seq,
      items,
      start_token_seq: orderByClause.clause_start_seq,
      end_token_seq: orderByClause.body_end_seq
    };
  }

  /**
   * ORDER BY本文を、同じ括弧深度にあるカンマで分割する。
   *
   * 例:
   *   customer_id, IF(flag, created_at, updated_at) DESC
   *
   * IF()内部のカンマは括弧深度が深いため、並び替え項目の区切りにはしない。
   *
   * @param {Array<object>} bodyTokens
   * @returns {Array<Array<object>>}
   */
  #splitByTopLevelComma(bodyTokens) {
    const ranges = [];
    let currentRange = [];
    const baseDepth = bodyTokens[0].paren_depth;

    for (const token of bodyTokens) {
      if (token.token === "," && token.paren_depth === baseDepth) {
        if (currentRange.length === 0) {
          throw new SyntaxError(
            `OrderByParser: empty ORDER BY item before token_seq ${token.token_seq}.`
          );
        }

        ranges.push(currentRange);
        currentRange = [];
        continue;
      }

      currentRange.push(token);
    }

    if (currentRange.length === 0) {
      throw new SyntaxError("OrderByParser: ORDER BY Clause ends with a comma.");
    }

    ranges.push(currentRange);
    return ranges;
  }

  /**
   * 1つのORDER BY項目を解析する。
   *
   * 処理順序:
   *
   * 1. 末尾のNULLS FIRST / NULLS LASTを取り除く。
   * 2. 末尾のASC / DESCを取り除く。
   * 3. 残ったToken範囲をExpressionParserへ渡す。
   *
   * 後ろから処理する理由:
   * ORDER BYの修飾子は式の後ろに付くため、末尾から確認すると式本体との境界を
   * 明確に判定できる。
   *
   * @param {Array<object>} itemTokens
   * @param {number} itemSeq
   * @returns {object}
   */
  #parseOrderItem(itemTokens, itemSeq) {
    /*
     * slice()で配列を複製する。
     * pop()で末尾Tokenを取り除いても、呼び出し元のitemTokensを変更しないため。
     */
    const expressionTokens = itemTokens.slice();
    let direction = null;
    let nullsOrder = null;

    /*
     * NULLS FIRST / NULLS LASTは2 Tokenで構成される。
     * 末尾2件を確認し、一致すれば式範囲から取り除く。
     */
    if (expressionTokens.length >= 2) {
      const nullsToken = expressionTokens[expressionTokens.length - 2];
      const orderToken = expressionTokens[expressionTokens.length - 1];

      if (
        nullsToken.normalized_token === "NULLS" &&
        ["FIRST", "LAST"].includes(orderToken.normalized_token)
      ) {
        nullsOrder = orderToken.normalized_token;
        expressionTokens.pop();
        expressionTokens.pop();
      }
    }

    /*
     * NULLS指定を取り除いた後の末尾がASCまたはDESCなら、方向属性として保持する。
     * 指定がない場合はnullを返し、BigQueryの既定動作を後工程で判断できるようにする。
     */
    const possibleDirectionToken = expressionTokens[expressionTokens.length - 1];

    if (
      possibleDirectionToken &&
      ["ASC", "DESC"].includes(possibleDirectionToken.normalized_token)
    ) {
      direction = possibleDirectionToken.normalized_token;
      expressionTokens.pop();
    }

    if (expressionTokens.length === 0) {
      throw new SyntaxError(
        `OrderByParser: ORDER BY item ${itemSeq} does not contain an expression.`
      );
    }

    const firstExpressionToken = expressionTokens[0];
    const lastExpressionToken = expressionTokens[expressionTokens.length - 1];
    const expression = this.expressionParser.parseExpression(
      firstExpressionToken.token_seq,
      lastExpressionToken.token_seq
    );

    return {
      order_item_seq: itemSeq,
      expression,
      direction,
      nulls_order: nullsOrder,
      start_token_seq: itemTokens[0].token_seq,
      end_token_seq: itemTokens[itemTokens.length - 1].token_seq,
      expression_start_seq: firstExpressionToken.token_seq,
      expression_end_seq: lastExpressionToken.token_seq
    };
  }

  /**
   * 解析入口で、ORDER_BY Clauseと本文範囲が正しいことを検証する。
   *
   * Clause種別を確認する理由:
   * Token範囲だけを見れば他Clauseでも一部は解析できてしまうため、呼び出し側の
   * 誤りを早い段階で明確なエラーにする。
   *
   * @param {object} orderByClause
   */
  #validateOrderByClause(orderByClause) {
    if (!orderByClause || typeof orderByClause !== "object") {
      throw new TypeError("OrderByParser: orderByClause must be an object.");
    }

    if (orderByClause.clause_type !== "ORDER_BY") {
      throw new TypeError(
        `OrderByParser: ORDER_BY Clause was expected, but received ` +
        `"${orderByClause.clause_type}".`
      );
    }

    if (!Number.isInteger(orderByClause.body_start_seq)) {
      throw new RangeError(
        "OrderByParser: body_start_seq must be an integer."
      );
    }

    if (!Number.isInteger(orderByClause.body_end_seq)) {
      throw new RangeError(
        "OrderByParser: body_end_seq must be an integer."
      );
    }

    if (orderByClause.body_end_seq < orderByClause.body_start_seq) {
      throw new SyntaxError("OrderByParser: ORDER BY Clause body is empty.");
    }
  }
}

// ============================================================
// SOURCE: src/query_parser.js
// ============================================================
/**
 * 1つのQuery全体を解析し、Clause別Parserの結果を統合するParser。
 *
 * QueryParserの責務:
 *
 * - WITH句のCTE定義を検出する。
 * - CTE内部のQueryを再帰的に解析する。
 * - メインQueryのClause境界をClauseParserで取得する。
 * - 各Clauseを専用Parserへ委譲する。
 * - 各Parserの結果を1つのQuery ASTへまとめる。
 *
 * QueryParser自身はSELECT項目、JOIN条件、WHERE式などの詳細文法を
 * 再実装しない。すでに存在するClause別Parserを呼び分ける
 * オーケストレーターとして動作する。
 *
 * v1の対象は、1つのSELECT Query Blockと、その前に置かれるCTEである。
 * UNION / INTERSECT / EXCEPTによるSet Operationは次の拡張単位とする。
 */
class QueryParser {
  /**
   * @param {Array<object>} tokens Lexerが生成したToken配列
   * @param {object} options 再帰解析時の補助情報
   */
  constructor(tokens, options = {}) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("QueryParser: tokens must be an array.");
    }

    this.tokens = tokens;
    this.isSubquery = Boolean(options.isSubquery);
    this.disableSetOperations = Boolean(options.disableSetOperations);
  }

  /**
   * Query全体を解析する公開入口。
   *
   * 処理順序:
   *
   * 1. WITH句があればCTEを解析する。
   * 2. ClauseParserでメインQueryのClause一覧を取得する。
   * 3. SELECT Clauseが1つ存在することを確認する。
   * 4. Clause種別ごとに専用Parserを呼ぶ。
   * 5. すべての結果をQuery ASTへまとめる。
   *
   * @returns {object}
   */
  parse() {
    const contentTokens = this.#removeCommentTokens(this.tokens);

    if (contentTokens.length === 0) {
      throw new SyntaxError("QueryParser: Query Tokenが空です。");
    }

    /*
     * クエリ全体が余分な括弧で囲まれている（(SELECT ...) 全体が 1 組の括弧）場合は、
     * 外側の括弧を外して再解析する。DAG/JOBS 由来 SQL でしばしば見られる。
     * 先頭が '(' で、その対応する ')' が末尾（末尾 ';' は無視）である場合のみ剥がす。
     * (SELECT ...) UNION ... のように途中で閉じる場合は剥がさない。
     */
    const innerTokens = this.#stripWrappingParentheses(this.tokens);

    if (innerTokens) {
      return new QueryParser(this.#normalizeTokenDepth(innerTokens), {
        isSubquery: this.isSubquery,
        disableSetOperations: this.disableSetOperations
      }).parse();
    }

    /*
     * CREATE [OR REPLACE] [TEMP] TABLE t AS (SELECT ...) / CREATE VIEW v AS
     * (SELECT ...) のように、文の本体が「AS (クエリ)」で括弧に包まれている場合。
     * CREATE ... AS SELECT ...（括弧なし）は ClauseParser が深さ0の SELECT を拾えるが、
     * 括弧付きだと SELECT が深さ1に入り「トップレベルの SELECT が見つからない」になる。
     * 対象テーブル名は解析メタデータ側で与えられるため、前置き（CREATE ... AS）は
     * lineage に寄与しない。括弧内のクエリだけを取り出して再解析する。
     */
    const statementBodyTokens = this.#stripStatementBodyParentheses(this.tokens);

    if (statementBodyTokens) {
      return new QueryParser(this.#normalizeTokenDepth(statementBodyTokens), {
        isSubquery: this.isSubquery,
        disableSetOperations: this.disableSetOperations
      }).parse();
    }

    const cteResult = this.#parseCommonTableExpressions(contentTokens);

    if (!this.disableSetOperations) {
      const mainTokens = contentTokens.slice(cteResult.main_start_index);
      const setOperation = this.#splitSetOperations(mainTokens);

      if (setOperation) {
        const firstQuery = new QueryParser(setOperation.branches[0], {
          isSubquery: this.isSubquery,
          disableSetOperations: true
        }).parse();

        firstQuery.recursive = cteResult.recursive;
        firstQuery.common_table_expressions = cteResult.ctes;
        firstQuery.set_operations = [];

        for (let branchIndex = 1; branchIndex < setOperation.branches.length; branchIndex++) {
          const operation = setOperation.operations[branchIndex - 1];
          const branchQuery = new QueryParser(setOperation.branches[branchIndex], {
            isSubquery: true,
            disableSetOperations: true
          }).parse();

          /* UNIONの出力名は先頭branchから列位置で継承する。 */
          for (let itemIndex = 0; itemIndex < branchQuery.select.length; itemIndex++) {
            const branchItem = branchQuery.select[itemIndex];
            const firstItem = firstQuery.select[itemIndex];
            if (!branchItem.output_alias && firstItem?.output_alias) {
              branchItem.output_alias = firstItem.output_alias;
              branchItem.alias_type = "SET_OPERATION_POSITION";
            }
          }

          firstQuery.set_operations.push({
            node_type: "SET_OPERATION",
            operator: operation.operator,
            modifier: operation.modifier,
            query: branchQuery,
            start_token_seq: operation.start_token_seq,
            end_token_seq: branchQuery.end_token_seq
          });
        }

        firstQuery.start_token_seq = contentTokens[0].token_seq;
        firstQuery.end_token_seq = this.#findLastMeaningfulToken(contentTokens).token_seq;
        return firstQuery;
      }
    }

    const parsedClauses = new ClauseParser(this.tokens).parse();
    const clauses = this.#excludeStatementTerminator(parsedClauses);
    const selectClause = this.#findClause(clauses, "SELECT");

    if (!selectClause) {
      throw new SyntaxError("QueryParser: トップレベルのSELECT Clauseが見つかりません。");
    }

    const select = new SelectParser(this.tokens).parse(selectClause);

    for (const selectItem of select) {
      if (selectItem.wildcard_type) {
        selectItem.expression_ast = null;
        continue;
      }

      try {
        selectItem.expression_ast = new ExpressionParser(this.tokens).parseExpression(
          selectItem.expression_start_seq,
          selectItem.expression_end_seq
        );
      } catch (error) {
        const expressionTokens = this.tokens.filter((token) =>
          token.token_seq >= selectItem.expression_start_seq &&
          token.token_seq <= selectItem.expression_end_seq
        );
        selectItem.expression_ast = createRawExpressionAst(expressionTokens);
        selectItem.expression_parse_fallback = error.message;
      }
    }

    const from = this.#parseOptionalClause(clauses, "FROM", FromParser);
    const where = this.#parseOptionalClause(clauses, "WHERE", WhereParser);
    const groupBy = this.#parseOptionalClause(clauses, "GROUP_BY", GroupByParser);
    const having = this.#parseOptionalClause(clauses, "HAVING", HavingParser);
    const qualify = this.#parseOptionalClause(clauses, "QUALIFY", QualifyParser);
    const orderBy = this.#parseOptionalClause(clauses, "ORDER_BY", OrderByParser);
    const limit = this.#parseOptionalClause(clauses, "LIMIT", LimitParser);

    const firstToken = contentTokens[0];
    const lastToken = this.#findLastMeaningfulToken(contentTokens);

    return {
      node_type: "QUERY",
      recursive: cteResult.recursive,
      common_table_expressions: cteResult.ctes,
      clauses,
      select,
      from,
      where,
      group_by: groupBy,
      having,
      qualify,
      order_by: orderBy,
      limit,
      set_operations: [],
      is_subquery: this.isSubquery,
      start_token_seq: firstToken.token_seq,
      end_token_seq: lastToken.token_seq
    };
  }

  /**
   * SQL末尾のセミコロンを、最後のClause本文から除外する。
   *
   * ClauseParserはToken境界を汎用的に切り出すため、最後のClauseの
   * body_end_seqにセミコロンが含まれる場合がある。Clause別Parserへ渡す前に
   * QueryParserが文終端を除外し、各Parserが式の一部として誤認しないようにする。
   */
  #excludeStatementTerminator(clauses) {
    if (clauses.length === 0) {
      return clauses;
    }

    const adjustedClauses = clauses.map((clause) => ({ ...clause }));
    const lastClause = adjustedClauses[adjustedClauses.length - 1];
    const endToken = this.tokens.find(
      (token) => token.token_seq === lastClause.body_end_seq
    );

    if (!endToken || endToken.token !== ";") {
      return adjustedClauses;
    }

    for (let tokenIndex = this.tokens.length - 1; tokenIndex >= 0; tokenIndex--) {
      const token = this.tokens[tokenIndex];

      if (token.token_seq >= endToken.token_seq || token.token_type === "COMMENT") {
        continue;
      }

      lastClause.body_end_seq = token.token_seq;
      break;
    }

    return adjustedClauses;
  }

  /**
   * WITH句のCTE定義を解析する。
   *
   * 対象例:
   *
   * WITH RECURSIVE
   *   cte_a(id) AS (SELECT ...),
   *   cte_b AS (SELECT ...)
   * SELECT ...
   *
   * CTE本文は括弧内部にあるため、元Tokenではparen_depthが1以上になる。
   * ClauseParserはトップレベルをdepth=0として扱うので、CTE本文だけを
   * 切り出した後、最小depthを0へ補正したコピーを作って再帰解析する。
   * 元Token配列は変更しない。
   *
   * @param {Array<object>} contentTokens COMMENT除去済みToken配列
   * @returns {{recursive: boolean, ctes: Array<object>}}
   */
  #parseCommonTableExpressions(contentTokens) {
    if (contentTokens[0].normalized_token !== "WITH") {
      return { recursive: false, ctes: [], main_start_index: 0 };
    }

    let tokenIndex = 1;
    let recursive = false;
    const ctes = [];

    if (contentTokens[tokenIndex]?.normalized_token === "RECURSIVE") {
      recursive = true;
      tokenIndex++;
    }

    while (tokenIndex < contentTokens.length) {
      const nameToken = contentTokens[tokenIndex];

      if (!this.#isIdentifierLikeToken(nameToken)) {
        throw new SyntaxError(
          `QueryParser: CTE名を期待しましたが "${nameToken?.token ?? "EOF"}" が見つかりました。`
        );
      }

      tokenIndex++;
      const columnNames = [];

      /*
       * CTE名の直後に列名一覧を指定できる。
       *
       *   cte_name(column_a, column_b) AS (...)
       */
      if (contentTokens[tokenIndex]?.token === "(") {
        const closeColumnIndex = this.#findMatchingCloseParenthesis(
          contentTokens,
          tokenIndex
        );

        const columnTokens = contentTokens.slice(tokenIndex + 1, closeColumnIndex);
        const columnGroups = this.#splitByTopLevelComma(columnTokens);

        for (const group of columnGroups) {
          const meaningfulTokens = this.#removeCommentTokens(group);

          if (meaningfulTokens.length !== 1 || !this.#isIdentifierLikeToken(meaningfulTokens[0])) {
            throw new SyntaxError("QueryParser: CTE列名一覧に不正な項目があります。");
          }

          columnNames.push(meaningfulTokens[0].normalized_token);
        }

        tokenIndex = closeColumnIndex + 1;
      }

      const asToken = contentTokens[tokenIndex];

      if (asToken?.normalized_token !== "AS") {
        throw new SyntaxError(
          `QueryParser: CTE定義のASを期待しましたが "${asToken?.token ?? "EOF"}" が見つかりました。`
        );
      }

      tokenIndex++;

      if (contentTokens[tokenIndex]?.token !== "(") {
        throw new SyntaxError("QueryParser: CTE本文の開き括弧がありません。");
      }

      const openParenthesisIndex = tokenIndex;
      const closeParenthesisIndex = this.#findMatchingCloseParenthesis(
        contentTokens,
        openParenthesisIndex
      );
      const innerTokens = contentTokens.slice(
        openParenthesisIndex + 1,
        closeParenthesisIndex
      );

      if (innerTokens.length === 0) {
        throw new SyntaxError(`QueryParser: CTE "${nameToken.token}" の本文が空です。`);
      }

      const normalizedInnerTokens = this.#normalizeTokenDepth(innerTokens);
      const queryAst = new QueryParser(normalizedInnerTokens, {
        isSubquery: true
      }).parse();

      ctes.push({
        node_type: "COMMON_TABLE_EXPRESSION",
        name: nameToken.normalized_token,
        column_names: columnNames,
        query: queryAst,
        start_token_seq: nameToken.token_seq,
        end_token_seq: contentTokens[closeParenthesisIndex].token_seq
      });

      tokenIndex = closeParenthesisIndex + 1;

      if (contentTokens[tokenIndex]?.token === ",") {
        tokenIndex++;
        continue;
      }

      /*
       * カンマがなければCTE一覧は終了し、以降はメインQueryになる。
       */
      break;
    }

    return { recursive, ctes, main_start_index: tokenIndex };
  }

  #splitSetOperations(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) return null;

    const baseDepth = Math.min(...tokens.map((token) => token.paren_depth));
    const branches = [];
    const operations = [];
    let branchStartIndex = 0;

    const setOperators = new Set(["UNION", "INTERSECT", "EXCEPT"]);

    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
      const token = tokens[tokenIndex];

      if (token.paren_depth !== baseDepth ||
          !setOperators.has(token.normalized_token)) {
        continue;
      }

      const nextToken = tokens[tokenIndex + 1];
      const hasModifier = nextToken?.paren_depth === baseDepth &&
        (nextToken.normalized_token === "ALL" ||
         nextToken.normalized_token === "DISTINCT");

      /*
       * INTERSECT / EXCEPT はセット演算では必ず DISTINCT|ALL を伴う。
       * 修飾子が無い EXCEPT は `SELECT * EXCEPT(col)` の列除外構文なので、
       * セット演算として分割しない(UNIONは従来どおり修飾子省略を許容)。
       */
      if (token.normalized_token !== "UNION" && !hasModifier) {
        continue;
      }

      const branch = tokens.slice(branchStartIndex, tokenIndex);
      if (branch.length === 0) {
        throw new SyntaxError("QueryParser: set operation の左辺が空です。");
      }
      branches.push(this.#normalizeTokenDepth(branch));

      let modifier = "DISTINCT";
      let nextIndex = tokenIndex + 1;

      if (hasModifier) {
        modifier = nextToken.normalized_token;
        nextIndex++;
      }

      operations.push({
        operator: token.normalized_token,
        modifier,
        start_token_seq: token.token_seq
      });

      branchStartIndex = nextIndex;
      tokenIndex = nextIndex - 1;
    }

    if (operations.length === 0) return null;

    const finalBranch = tokens.slice(branchStartIndex);
    if (finalBranch.length === 0) throw new SyntaxError("QueryParser: UNION右辺が空です。");
    branches.push(this.#normalizeTokenDepth(finalBranch));

    return { branches, operations };
  }

  /**
   * 任意Clauseを見つけ、対応Parserで解析する。
   * Clauseが存在しない場合はnullを返す。
   *
   * JavaScriptメモ:
   * ParserClassにはクラス自体が渡される。
   * new ParserClass(this.tokens)とすることで、呼び出し側で指定された
   * FromParserやWhereParserなどのインスタンスを生成できる。
   */
  #parseOptionalClause(clauses, clauseType, ParserClass) {
    const clause = this.#findClause(clauses, clauseType);

    if (!clause) {
      return null;
    }

    const parser = new ParserClass(this.tokens);
    return parser.parse(clause);
  }

  #findClause(clauses, clauseType) {
    return clauses.find((clause) => clause.clause_type === clauseType) ?? null;
  }

  /**
   * 指定した開き括弧に対応する閉じ括弧の配列indexを返す。
   * Lexerのdepth規則では開き括弧と閉じ括弧は同じdepthを持ち、
   * 括弧内部だけが1段深くなる。
   */
  #findMatchingCloseParenthesis(tokens, openIndex) {
    const openToken = tokens[openIndex];

    if (!openToken || openToken.token !== "(") {
      throw new TypeError("QueryParser: openIndex must point to an opening parenthesis.");
    }

    for (let tokenIndex = openIndex + 1; tokenIndex < tokens.length; tokenIndex++) {
      const token = tokens[tokenIndex];

      if (token.token === ")" && token.paren_depth === openToken.paren_depth) {
        return tokenIndex;
      }
    }

    throw new SyntaxError(
      `QueryParser: token_seq ${openToken.token_seq} の開き括弧に対応する閉じ括弧がありません。`
    );
  }

  /**
   * CTE列名一覧などを、その階層のカンマだけで分割する。
   */
  #splitByTopLevelComma(tokens) {
    if (tokens.length === 0) {
      return [];
    }

    const baseDepth = Math.min(...tokens.map((token) => token.paren_depth));
    const groups = [];
    let currentGroup = [];

    for (const token of tokens) {
      if (token.token === "," && token.paren_depth === baseDepth) {
        groups.push(currentGroup);
        currentGroup = [];
        continue;
      }

      currentGroup.push(token);
    }

    groups.push(currentGroup);
    return groups;
  }

  /**
   * 部分Query内の最小paren_depthを0へ補正したTokenコピーを返す。
   * token_seq、行番号、列番号などは保持する。
   */
  #normalizeTokenDepth(tokens) {
    const minimumDepth = Math.min(...tokens.map((token) => token.paren_depth));

    return tokens.map((token) => {
      return {
        ...token,
        paren_depth: token.paren_depth - minimumDepth
      };
    });
  }

  #removeCommentTokens(tokens) {
    return tokens.filter((token) => token.token_type !== "COMMENT");
  }

  /**
   * クエリ全体を包む余分な括弧を検出して内側 Token を返す。剥がせない場合は null。
   * 条件：先頭の非コメント Token が '(' で、その対応 ')' が末尾（末尾 ';' は無視）に
   * 一致し、内側が SELECT / WITH / '(' で始まる（＝クエリ）こと。
   */
  #stripWrappingParentheses(tokens) {
    const meaningful = [];

    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
      if (tokens[tokenIndex].token_type !== "COMMENT") {
        meaningful.push(tokenIndex);
      }
    }

    if (meaningful.length < 2) {
      return null;
    }

    const firstIndex = meaningful[0];

    if (tokens[firstIndex].token !== "(") {
      return null;
    }

    let lastMeaningfulPosition = meaningful.length - 1;

    if (tokens[meaningful[lastMeaningfulPosition]].token === ";") {
      lastMeaningfulPosition -= 1;
    }

    if (lastMeaningfulPosition <= 0) {
      return null;
    }

    const lastIndex = meaningful[lastMeaningfulPosition];

    let depth = 0;
    let matchIndex = -1;

    for (const tokenIndex of meaningful) {
      const tokenText = tokens[tokenIndex].token;

      if (tokenText === "(") {
        depth += 1;
      } else if (tokenText === ")") {
        depth -= 1;

        if (depth === 0) {
          matchIndex = tokenIndex;
          break;
        }
      }
    }

    if (matchIndex !== lastIndex) {
      return null;
    }

    const inner = tokens.slice(firstIndex + 1, matchIndex);
    const innerFirst = inner.find((token) => token.token_type !== "COMMENT");

    if (!innerFirst) {
      return null;
    }

    const isQueryStart = innerFirst.token === "(" ||
      ["SELECT", "WITH"].includes(innerFirst.normalized_token);

    if (!isQueryStart) {
      return null;
    }

    return inner;
  }

  /**
   * 文の本体が「AS (クエリ)」で括弧に包まれた形（CREATE ... AS (SELECT ...) /
   * CREATE VIEW ... AS (SELECT ...)）を検出し、括弧内の Token を返す。剥がせない
   * 場合は null。
   *
   * 条件：深さ0の 'AS' の直後（コメントを除く）が深さ0の '(' で、その対応する ')' が
   * 末尾（末尾 ';' は無視）に一致し、内側が SELECT / WITH / '(' で始まる（＝クエリ）こと。
   * WITH t AS (...) SELECT ... のように括弧の後ろに続きがある形や、列別名 AS x は
   * 対象にならない。
   */
  #stripStatementBodyParentheses(tokens) {
    const meaningful = [];

    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
      if (tokens[tokenIndex].token_type !== "COMMENT") {
        meaningful.push(tokenIndex);
      }
    }

    if (meaningful.length < 3) {
      return null;
    }

    let lastMeaningfulPosition = meaningful.length - 1;

    if (tokens[meaningful[lastMeaningfulPosition]].token === ";") {
      lastMeaningfulPosition -= 1;
    }

    if (lastMeaningfulPosition <= 0) {
      return null;
    }

    const lastIndex = meaningful[lastMeaningfulPosition];

    if (tokens[lastIndex].token !== ")") {
      return null;
    }

    /* 末尾 ')' に対応する深さ0の '(' を探し、その直前が深さ0の 'AS' か確認する。 */
    let openPosition = -1;

    for (let position = 0; position <= lastMeaningfulPosition; position++) {
      const tokenIndex = meaningful[position];

      if (
        tokens[tokenIndex].token === "(" &&
        tokens[tokenIndex].paren_depth === 0
      ) {
        openPosition = position;
        break;
      }
    }

    if (openPosition <= 0) {
      return null;
    }

    const openIndex = meaningful[openPosition];
    const beforeOpen = tokens[meaningful[openPosition - 1]];

    if (beforeOpen.normalized_token !== "AS" || beforeOpen.paren_depth !== 0) {
      return null;
    }

    /* '(' の対応する ')' が末尾の ')' でなければ、途中で閉じているため対象外。 */
    let depth = 0;
    let matchIndex = -1;

    for (let position = openPosition; position <= lastMeaningfulPosition; position++) {
      const tokenText = tokens[meaningful[position]].token;

      if (tokenText === "(") {
        depth += 1;
      } else if (tokenText === ")") {
        depth -= 1;

        if (depth === 0) {
          matchIndex = meaningful[position];
          break;
        }
      }
    }

    if (matchIndex !== lastIndex) {
      return null;
    }

    const inner = tokens.slice(openIndex + 1, matchIndex);
    const innerFirst = inner.find((token) => token.token_type !== "COMMENT");

    if (!innerFirst) {
      return null;
    }

    const isQueryStart = innerFirst.token === "(" ||
      ["SELECT", "WITH"].includes(innerFirst.normalized_token);

    if (!isQueryStart) {
      return null;
    }

    return inner;
  }

  #findLastMeaningfulToken(tokens) {
    for (let tokenIndex = tokens.length - 1; tokenIndex >= 0; tokenIndex--) {
      if (tokens[tokenIndex].token !== ";") {
        return tokens[tokenIndex];
      }
    }

    return tokens[tokens.length - 1];
  }

  #isIdentifierLikeToken(token) {
    if (!token) {
      return false;
    }

    return ["IDENTIFIER", "KEYWORD", "BACKTICK_IDENTIFIER"].includes(
      token.token_type
    );
  }
}

// ============================================================
// SOURCE: src/source_resolver.js
// ============================================================
/**
 * QueryParserが生成したQuery ASTから、FROM/JOINソースとaliasの対応関係を作るResolver。
 *
 * SourceResolverの責務:
 *
 * - Queryごとに独立したscopeを作る。
 * - CTE名を、そのQuery scopeから参照できるソースとして登録する。
 * - FROMおよびJOINの物理テーブル、CTE、サブクエリ、UNNESTを分類する。
 * - aliasまたはソース名から、参照先Sourceを検索できる索引を作る。
 * - 相関サブクエリを想定し、見つからないaliasを親scopeへ検索できるようにする。
 *
 * SourceResolverはカラム名を解決しない。
 * 「s.amount」のsがどのSourceを指すかを判断する土台だけを作り、
 * amountの存在確認や物理カラムへの展開は後続のColumnResolverへ委譲する。
 */
class SourceResolver {
  constructor() {
    this.nextScopeId = 1;
    this.nextSourceId = 1;
    this.scopes = [];
  }

  /**
   * Query AST全体を解決する公開入口。
   *
   * 同じResolverインスタンスを再利用しても結果が混ざらないよう、
   * ID採番とscope一覧を毎回初期化する。
   */
  resolve(queryAst) {
    this.#validateQueryAst(queryAst);

    this.nextScopeId = 1;
    this.nextSourceId = 1;
    this.scopes = [];

    const rootScope = this.#resolveQueryScope(queryAst, null, "ROOT_QUERY");

    return {
      node_type: "SOURCE_RESOLUTION",
      root_scope_id: rootScope.scope_id,
      scopes: this.scopes
    };
  }

  /**
   * 指定scopeからaliasまたはソース名を検索する。
   *
   * current scopeで見つからない場合、parent_scope_idを順に辿る。
   * この動作により、将来の相関サブクエリで外側Queryのaliasを参照できる。
   */
  findSource(resolution, scopeId, referenceName) {
    if (!resolution || !Array.isArray(resolution.scopes)) {
      throw new TypeError("SourceResolver.findSource: resolution is invalid.");
    }

    const normalizedName = this.#normalizeName(referenceName);
    let currentScope = resolution.scopes.find((scope) => scope.scope_id === scopeId);

    while (currentScope) {
      const sourceId = currentScope.reference_map[normalizedName];

      if (sourceId !== undefined) {
        return currentScope.sources.find((source) => source.source_id === sourceId) || null;
      }

      currentScope = resolution.scopes.find(
        (scope) => scope.scope_id === currentScope.parent_scope_id
      );
    }

    return null;
  }

  /**
   * 1つのQueryを1つのscopeへ変換する。
   *
   * CTE本文も独立したQueryなので子scopeを持つ。
   * FROMサブクエリが完全なQuery ASTを持つ場合も同じ処理を再利用する。
   */
  #resolveQueryScope(queryAst, parentScopeId, scopeType) {
    const scope = {
      scope_id: this.nextScopeId++,
      scope_type: scopeType,
      parent_scope_id: parentScopeId,
      query_start_token_seq: queryAst.start_token_seq ?? null,
      query_end_token_seq: queryAst.end_token_seq ?? null,
      cte_definitions: [],
      set_operations: [],
      sources: [],
      join_using_columns: [],
      reference_map: Object.create(null)
    };

    this.scopes.push(scope);

    /*
     * CTE名はメインFROMを解析する前に登録する。
     * これにより、FROM customer_summaryのような名前を
     * 物理テーブルではなくCTEとして判定できる。
     */
    const ctes = Array.isArray(queryAst.common_table_expressions)
      ? queryAst.common_table_expressions
      : [];

    for (const cte of ctes) {
      const cteName = this.#normalizeName(cte.name);

      if (scope.cte_definitions.some((item) => item.cte_name === cteName)) {
        throw new SyntaxError(
          `SourceResolver: duplicate CTE name "${cteName}" in scope ${scope.scope_id}.`
        );
      }

      /*
       * WITH RECURSIVEではCTE本文から自分自身を参照できる。
       * 子scopeの採番値は次の#resolveQueryScope呼び出しで確定するため、
       * そのIDを使って定義を先行登録してから本文を解析する。
       */
      let cteDefinition = null;

      if (queryAst.recursive === true) {
        cteDefinition = {
          cte_name: cteName,
          column_names: Array.isArray(cte.column_names) ? [...cte.column_names] : [],
          query_scope_id: this.nextScopeId,
          start_token_seq: cte.start_token_seq,
          end_token_seq: cte.end_token_seq,
          recursive: true
        };

        scope.cte_definitions.push(cteDefinition);
      }

      const cteScope = this.#resolveQueryScope(cte.query, scope.scope_id, "CTE_QUERY");

      if (cteDefinition) {
        cteDefinition.query_scope_id = cteScope.scope_id;
      } else {
        cteDefinition = {
          cte_name: cteName,
          column_names: Array.isArray(cte.column_names) ? [...cte.column_names] : [],
          query_scope_id: cteScope.scope_id,
          start_token_seq: cte.start_token_seq,
          end_token_seq: cte.end_token_seq,
          recursive: false
        };

        scope.cte_definitions.push(cteDefinition);
      }
    }

    if (queryAst.from?.source) {
      this.#registerSource(scope, queryAst.from.source, "FROM", null);
    }

    const joins = Array.isArray(queryAst.from?.joins) ? queryAst.from.joins : [];

    for (const join of joins) {
      this.#registerSource(scope, join.source, "JOIN", join.join_seq);

      /*
       * JOIN ... USING(col) は結合キーcolを1つの論理列へ統合する。
       * 修飾なしのcol参照は曖昧ではないため、USING列名をscopeへ記録し、
       * ColumnResolverが複数候補を曖昧扱いせず確定解決できるようにする。
       */
      const usingColumns = Array.isArray(join.using_columns)
        ? join.using_columns
        : [];

      for (const usingColumn of usingColumns) {
        const normalizedUsingColumn = this.#normalizeName(usingColumn);

        if (
          normalizedUsingColumn &&
          !scope.join_using_columns.includes(normalizedUsingColumn)
        ) {
          scope.join_using_columns.push(normalizedUsingColumn);
        }
      }
    }

    for (const setOperation of queryAst.set_operations || []) {
      if (setOperation.query?.node_type === "QUERY") {
        const setScope = this.#resolveQueryScope(
          setOperation.query,
          scope.scope_id,
          "SET_OPERATION_QUERY"
        );

        if (!Array.isArray(scope.set_operations)) scope.set_operations = [];
        scope.set_operations.push({
          operator: setOperation.operator,
          modifier: setOperation.modifier,
          query_scope_id: setScope.scope_id,
          start_token_seq: setOperation.start_token_seq,
          end_token_seq: setOperation.end_token_seq
        });
      }
    }

    const nestedQueries = [];
    this.#collectExpressionSubqueries(queryAst, nestedQueries);

    for (const nestedQuery of nestedQueries) {
      this.#resolveQueryScope(nestedQuery, scope.scope_id, "EXPRESSION_SUBQUERY");
    }

    return scope;
  }

  #collectExpressionSubqueries(queryAst, result) {
    const expressionNodes = [];

    for (const item of queryAst.select || []) {
      if (item.expression_ast) expressionNodes.push(item.expression_ast);
    }

    for (const join of queryAst.from?.joins || []) {
      if (join.condition) expressionNodes.push(join.condition);
      if (join.source?.source_type === "UNNEST" && join.source.expression) {
        expressionNodes.push(join.source.expression);
      }
    }

    if (queryAst.from?.source?.source_type === "UNNEST" && queryAst.from.source.expression) {
      expressionNodes.push(queryAst.from.source.expression);
    }

    if (queryAst.where?.expression) expressionNodes.push(queryAst.where.expression);
    for (const item of queryAst.group_by?.items || []) if (item.expression) expressionNodes.push(item.expression);
    if (queryAst.having?.expression) expressionNodes.push(queryAst.having.expression);
    if (queryAst.qualify?.expression) expressionNodes.push(queryAst.qualify.expression);
    for (const item of queryAst.order_by?.items || []) if (item.expression) expressionNodes.push(item.expression);

    for (const expressionNode of expressionNodes) {
      this.#collectSubqueriesFromAst(expressionNode, result);
    }
  }

  #collectSubqueriesFromAst(node, result) {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const item of node) this.#collectSubqueriesFromAst(item, result);
      return;
    }

    if (
      (node.node_type === NodeType.SUBQUERY_EXPRESSION ||
       node.node_type === NodeType.ARRAY_SUBQUERY_EXPRESSION) &&
      node.query_ast?.node_type === "QUERY"
    ) {
      result.push(node.query_ast);
      return;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        this.#collectSubqueriesFromAst(value, result);
      }
    }
  }

  /**
   * FromParserのsourceをResolver共通形式へ変換し、scopeへ登録する。
   */
  #registerSource(scope, parsedSource, sourceRole, joinSeq) {
    const sourceType = this.#resolveSourceType(scope, parsedSource);
    const sourceName = parsedSource.name
      ? this.#normalizeName(parsedSource.name)
      : null;
    const alias = parsedSource.alias
      ? this.#normalizeName(parsedSource.alias)
      : this.#deriveDefaultAlias(parsedSource, sourceType);

    const source = {
      source_id: this.nextSourceId++,
      source_seq: scope.sources.length + 1,
      scope_id: scope.scope_id,
      source_role: sourceRole,
      join_seq: joinSeq,
      source_type: sourceType,
      source_name: sourceName,
      source_alias: alias,
      offset_alias: parsedSource.offset_alias ?? null,
      resolved_source_name: sourceName,
      cte_query_scope_id: null,
      subquery_scope_id: null,
      expression: parsedSource.expression ?? null,
      relation_operators: Array.isArray(parsedSource.relation_operators)
        ? parsedSource.relation_operators.map((operator) => ({ ...operator }))
        : [],
      start_token_seq: parsedSource.start_token_seq,
      end_token_seq: parsedSource.end_token_seq
    };

    if (sourceType === "CTE") {
      const definition = this.#findVisibleCteDefinition(scope, sourceName);

      source.cte_query_scope_id = definition.query_scope_id;
    }

    if (sourceType === "SUBQUERY" && parsedSource.query_ast?.node_type === "QUERY") {
      const childScope = this.#resolveQueryScope(
        parsedSource.query_ast,
        scope.scope_id,
        "SUBQUERY"
      );

      source.subquery_scope_id = childScope.scope_id;
    }

    scope.sources.push(source);
    this.#registerReference(scope, source.source_alias, source);

    /*
     * aliasを明示していない場合は、完全名だけでなく末尾名でも参照可能にする。
     * project.dataset.salesなら、SALESをデフォルトaliasとして登録する。
     */
    if (!parsedSource.alias && sourceName) {
      this.#registerReference(scope, sourceName, source, true);
    }

    return source;
  }

  #resolveSourceType(scope, parsedSource) {
    if (parsedSource.source_type === "UNNEST") {
      return "UNNEST";
    }

    if (parsedSource.source_type === "SUBQUERY") {
      return "SUBQUERY";
    }

    const sourceName = this.#normalizeName(parsedSource.name);
    const definition = this.#findVisibleCteDefinition(scope, sourceName);

    return definition ? "CTE" : "PHYSICAL_TABLE";
  }

  /**
   * 現在scopeから親scopeを順に辿り、参照可能なCTE定義を検索する。
   *
   * 非再帰WITHでは、CTE本文から参照できるのは自分より前に定義されたCTEだけである。
   * #resolveQueryScopeはCTEを定義順に処理し、各CTE本文の解析後にその定義を
   * 親scopeへ追加するため、親scopeを検索することでこの可視性規則を満たせる。
   *
   * @param {object} scope 検索開始scope
   * @param {string} cteName 正規化済みCTE名
   * @returns {object|null} CTE定義。見つからない場合はnull
   */
  #findVisibleCteDefinition(scope, cteName) {
    let currentScope = scope;

    while (currentScope) {
      const definition = currentScope.cte_definitions.find(
        (cte) => cte.cte_name === cteName
      );

      if (definition) {
        return definition;
      }

      currentScope = this.scopes.find(
        (item) => item.scope_id === currentScope.parent_scope_id
      );
    }

    return null;
  }

  #deriveDefaultAlias(parsedSource, sourceType) {
    if (sourceType === "PHYSICAL_TABLE" || sourceType === "CTE") {
      const parts = Array.isArray(parsedSource.name_parts)
        ? parsedSource.name_parts
        : String(parsedSource.name || "").split(".");

      return this.#normalizeName(parts[parts.length - 1]);
    }

    return null;
  }

  /**
   * reference_mapはalias検索用の索引。
   * 同一scope内で同じaliasが複数Sourceを指すとカラム解決不能になるため、
   * 曖昧な状態を許さず、この段階で明示的にエラーにする。
   */
  #registerReference(scope, referenceName, source, allowSameSource = false) {
    if (!referenceName) {
      return;
    }

    const normalizedName = this.#normalizeName(referenceName);
    const existingSourceId = scope.reference_map[normalizedName];

    if (existingSourceId !== undefined) {
      if (allowSameSource && existingSourceId === source.source_id) {
        return;
      }

      throw new SyntaxError(
        `SourceResolver: duplicate source reference "${normalizedName}" in scope ${scope.scope_id}.`
      );
    }

    scope.reference_map[normalizedName] = source.source_id;
  }

  #normalizeName(value) {
    if (value === null || value === undefined) {
      return null;
    }

    return String(value).toUpperCase();
  }

  #validateQueryAst(queryAst) {
    if (!queryAst || queryAst.node_type !== "QUERY") {
      throw new TypeError("SourceResolver: queryAst must be a QUERY node.");
    }
  }
}

// ============================================================
// SOURCE: src/output_column_resolver.js
// ============================================================
/**
 * 各Query ScopeのSELECT項目から、そのQueryが外部へ公開する出力列を確定する。
 *
 * OutputColumnResolverの責務:
 *
 * - SELECT項目と出力列名を対応付ける。
 * - 各出力列へExpression ASTを保持する。
 * - CTE列名一覧が指定されている場合、SELECT側の名前を列番号で上書きする。
 * - `*` / `alias.*`を、物理スキーマ展開前のWildcardとして保持する。
 * - 同名出力列や名前を導出できない式を診断情報として記録する。
 *
 * このResolverはWildcardを実カラムへ展開しない。
 * 物理テーブルのスキーマが必要な処理はPhysicalColumnResolverへ委譲する。
 */
class OutputColumnResolver {
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("OutputColumnResolver: tokens must be an array.");
    }

    this.tokens = tokens;
    this.nextOutputColumnId = 1;
    this.queryByScopeId = new Map();
  }

  /**
   * ResolutionContextに登録済みのQuery ASTとSource Resolutionを利用し、
   * Query Scopeごとの出力列一覧を作成する。
   *
   * @param {ResolutionContext} context
   * @returns {object}
   */
  resolve(context) {
    this.#validateContext(context);

    this.nextOutputColumnId = 1;
    this.queryByScopeId = new Map();
    this.#mapQueriesToScopes(
      context.query_ast,
      context.source_resolution
    );

    const scopes = [];

    for (const sourceScope of context.source_resolution.scopes) {
      const queryAst = this.queryByScopeId.get(sourceScope.scope_id);

      if (!queryAst) {
        continue;
      }

      scopes.push(
        this.#resolveScopeOutputColumns(queryAst, sourceScope, context)
      );
    }

    const result = {
      node_type: "OUTPUT_COLUMN_RESOLUTION",
      root_scope_id: context.source_resolution.root_scope_id,
      scopes,
      output_columns: scopes.flatMap((scope) => scope.output_columns)
    };

    context.setOutputColumnResolution(result);
    return result;
  }

  /**
   * Query ASTとSource Scopeをtoken_seq範囲で対応付ける。
   *
   * SourceResolverと同じQueryを参照する必要があるため、
   * start/end token_seqをQueryの安定した識別情報として利用する。
   */
  #mapQueriesToScopes(rootQueryAst, sourceResolution) {
    const queries = [];
    this.#collectQueryAsts(rootQueryAst, queries);

    for (const scope of sourceResolution.scopes) {
      const queryAst = queries.find((query) => {
        return query.start_token_seq === scope.query_start_token_seq &&
          query.end_token_seq === scope.query_end_token_seq;
      });

      if (queryAst) {
        this.queryByScopeId.set(scope.scope_id, queryAst);
      }
    }
  }

  #collectQueryAsts(queryAst, result) {
    result.push(queryAst);

    for (const setOperation of queryAst.set_operations || []) {
      if (setOperation.query?.node_type === "QUERY") {
        this.#collectQueryAsts(setOperation.query, result);
      }
    }

    for (const cte of queryAst.common_table_expressions || []) {
      if (cte.query?.node_type === "QUERY") {
        this.#collectQueryAsts(cte.query, result);
      }
    }

    const sources = [];

    if (queryAst.from?.source) {
      sources.push(queryAst.from.source);
    }

    for (const join of queryAst.from?.joins || []) {
      sources.push(join.source);
    }

    for (const source of sources) {
      if (source.query_ast?.node_type === "QUERY") {
        this.#collectQueryAsts(source.query_ast, result);
      }
    }
    const expressionNodes = [];
    for (const item of queryAst.select || []) {
      if (item.expression_ast) expressionNodes.push(item.expression_ast);
    }
    for (const expressionNode of expressionNodes) {
      this.#collectExpressionSubqueries(expressionNode, result);
    }

  }


  #collectExpressionSubqueries(node, result) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) this.#collectExpressionSubqueries(item, result);
      return;
    }
    if (
      node.node_type === NodeType.SUBQUERY_EXPRESSION &&
      node.query_ast?.node_type === "QUERY"
    ) {
      this.#collectQueryAsts(node.query_ast, result);
      return;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") this.#collectExpressionSubqueries(value, result);
    }
  }

  /**
   * 後続処理が列名で参照するQuery Scopeだけ、無名出力を警告対象にする。
   *
   * EXPRESSION_SUBQUERYは、外側のSELECT項目が公開列名を持つため、
   * 内部SELECTの集約式やSELECT 1自体に列名がなくても問題にならない。
   */
  #requiresResolvableOutputName(scopeType) {
    return scopeType !== "EXPRESSION_SUBQUERY";
  }

  /**
   * 1つのQuery ScopeについてSELECT項目を出力列へ変換する。
   */
  #resolveScopeOutputColumns(queryAst, sourceScope, context) {
    const cteColumnNames = this.#findCteColumnNames(
      context.source_resolution,
      sourceScope.scope_id
    );
    const outputColumns = [];

    for (const selectItem of queryAst.select || []) {
      const expressionAst = selectItem.wildcard_type
        ? null
        : this.#parseSelectItemExpression(selectItem);
      const cteOverrideName = cteColumnNames[selectItem.select_item_seq - 1] || null;
      const outputName = cteOverrideName || selectItem.output_alias || null;
      const outputStatus = this.#determineOutputStatus(selectItem, outputName);

      const outputColumn = {
        output_column_id: this.nextOutputColumnId++,
        output_column_seq: selectItem.select_item_seq,
        scope_id: sourceScope.scope_id,
        output_column_name: outputName,
        original_output_alias: selectItem.output_alias,
        alias_type: selectItem.alias_type,
        name_source: cteOverrideName
          ? "CTE_COLUMN_LIST"
          : selectItem.output_alias
            ? selectItem.alias_type
            : "NONE",
        output_status: outputStatus,
        wildcard_type: selectItem.wildcard_type,
        wildcard_qualifier: selectItem.wildcard_qualifier,
        wildcard_exclusions: selectItem.wildcard_exclusions || [],
        wildcard_replacements: selectItem.wildcard_replacements || [],
        expression: expressionAst,
        expression_text: selectItem.expression,
        start_token_seq: selectItem.item_start_seq,
        end_token_seq: selectItem.item_end_seq
      };

      outputColumns.push(outputColumn);

      if (
        outputStatus === "UNNAMED" &&
        this.#requiresResolvableOutputName(sourceScope.scope_type)
      ) {
        context.addDiagnostic(
          "WARNING",
          "OUTPUT_COLUMN_NAME_UNRESOLVED",
          `Output column ${selectItem.select_item_seq} in scope ` +
          `${sourceScope.scope_id} has no resolvable name.`,
          {
            scope_id: sourceScope.scope_id,
            output_column_seq: selectItem.select_item_seq,
            start_token_seq: selectItem.item_start_seq,
            end_token_seq: selectItem.item_end_seq
          }
        );
      }
    }

    this.#appendPivotGeneratedColumns(queryAst, sourceScope, outputColumns);
    this.#appendUnpivotGeneratedColumns(queryAst, sourceScope, outputColumns);
    this.#addDuplicateNameDiagnostics(outputColumns, sourceScope, context);

    if (cteColumnNames.length > 0 && cteColumnNames.length !== outputColumns.length) {
      context.addDiagnostic(
        "ERROR",
        "CTE_COLUMN_COUNT_MISMATCH",
        `CTE column list has ${cteColumnNames.length} names but query scope ` +
        `${sourceScope.scope_id} exposes ${outputColumns.length} SELECT items.`,
        { scope_id: sourceScope.scope_id }
      );
    }

    return {
      scope_id: sourceScope.scope_id,
      scope_type: sourceScope.scope_type,
      output_columns: outputColumns
    };
  }


  /**
   * SELECT * FROM source PIVOT(...) が生成する列を明示的なOutput Columnとして追加する。
   *
   * PIVOT生成列はSELECTリストに直接現れないため、従来は後続Queryから
   * PC_SALES等を参照した際に同一scopeの列へ戻り、自己循環と誤判定していた。
   * 集計対象列とIN句Aliasの対応を保持し、LineageResolverが入力scopeへ辿れるようにする。
   *
   * BigQueryは集計式にprefixがある場合、次の規則で生成列名を決める。
   *
   *   aggregate_prefix + "_" + pivot_column
   *
   * 例:
   *   SUM(amount) AS sales
   *   IN ('PC' AS pc)
   *   -> SALES_PC
   *
   * prefixがない場合は従来どおりpivot_columnだけを列名とする。
   */
  #appendPivotGeneratedColumns(queryAst, sourceScope, outputColumns) {
    const parsedSource = queryAst.from?.source;
    const resolvedSource = sourceScope.sources?.[0];
    const operators = parsedSource?.relation_operators || [];
    const pivot = operators.find((operator) => operator.operator_type === "PIVOT");

    if (!pivot || !resolvedSource) {
      return;
    }

    const bodyTokens = this.tokens.filter((token) => {
      return token.token_seq >= pivot.body_start_token_seq &&
        token.token_seq <= pivot.body_end_token_seq &&
        token.token_type !== "COMMENT";
    });
    const bodyDepth = bodyTokens.reduce((minimum, token) => {
      return Math.min(minimum, token.paren_depth);
    }, Number.POSITIVE_INFINITY);
    const forIndex = bodyTokens.findIndex((token) => {
      return token.normalized_token === "FOR" &&
        token.paren_depth === bodyDepth;
    });
    const inIndex = bodyTokens.findIndex((token, index) => {
      return index > forIndex &&
        token.normalized_token === "IN" &&
        token.paren_depth === bodyDepth;
    });

    if (forIndex < 0 || inIndex < 0) {
      return;
    }

    const aggregateTokens = bodyTokens.slice(0, forIndex);
    const aggregateSpecifications = this.#parsePivotAggregateSpecifications(
      aggregateTokens,
      bodyDepth
    );
    const pivotColumns = this.#parsePivotColumns(
      bodyTokens,
      inIndex,
      bodyDepth
    );

    if (aggregateSpecifications.length === 0 || pivotColumns.length === 0) {
      return;
    }

    const inputScopeId = resolvedSource.subquery_scope_id ??
      resolvedSource.cte_query_scope_id ?? null;
    let nextSeq = outputColumns.reduce((max, column) => {
      return Math.max(max, column.output_column_seq || 0);
    }, 0) + 1;

    for (const pivotColumn of pivotColumns) {
      for (const aggregate of aggregateSpecifications) {
        const outputName = aggregate.prefix
          ? `${aggregate.prefix}_${pivotColumn.suffix}`
          : pivotColumn.suffix;

        outputColumns.push({
          output_column_id: this.nextOutputColumnId++,
          output_column_seq: nextSeq++,
          scope_id: sourceScope.scope_id,
          output_column_name: outputName,
          original_output_alias: outputName,
          alias_type: "PIVOT_ALIAS",
          name_source: aggregate.prefix
            ? "PIVOT_PREFIX_AND_COLUMN"
            : "PIVOT_COLUMN",
          output_status: "PIVOT_GENERATED",
          wildcard_type: null,
          wildcard_qualifier: null,
          wildcard_exclusions: [],
          wildcard_replacements: [],
          expression: null,
          expression_text: aggregate.tokens.map((token) => token.token).join(""),
          pivot_input_scope_id: inputScopeId,
          pivot_value_column_name: aggregate.value_column_name,
          pivot_aggregate_prefix: aggregate.prefix,
          pivot_column_suffix: pivotColumn.suffix,
          start_token_seq: pivotColumn.name_token.token_seq,
          end_token_seq: pivotColumn.name_token.token_seq
        });
      }
    }
  }

  /**
   * UNPIVOTが生成する値列と名前列をOutput Columnへ登録する。
   *
   * 例:
   *   UNPIVOT (
   *     metric_value FOR metric_name
   *     IN (sales_amount, cost_amount)
   *   )
   *
   *   METRIC_VALUE -> SALES_AMOUNT, COST_AMOUNT
   *   METRIC_NAME  -> SALES_AMOUNT, COST_AMOUNT
   *
   * 複数列UNPIVOTでは、値列とIN句内の入力列を位置で対応付ける。
   * SELECTに生成列が明示されている場合は既存Output ColumnへMetadataを
   * 付与し、SELECT *の場合は公開用の生成列を追加する。複雑な式から
   * 生成列を参照する場合に備え、同一scope内で参照可能な内部列も保持する。
   */
  #appendUnpivotGeneratedColumns(queryAst, sourceScope, outputColumns) {
    const parsedSource = queryAst.from?.source;
    const resolvedSource = sourceScope.sources?.[0];
    const operators = parsedSource?.relation_operators || [];
    const unpivot = operators.find((operator) => {
      return operator.operator_type === "UNPIVOT";
    });

    if (!unpivot || !resolvedSource) {
      return;
    }

    const specifications = this.#parseUnpivotSpecifications(unpivot);

    if (specifications.length === 0) {
      return;
    }

    const inputScopeId = resolvedSource.subquery_scope_id ??
      resolvedSource.cte_query_scope_id ?? null;
    let nextSeq = outputColumns.reduce((max, column) => {
      return Math.max(max, column.output_column_seq || 0);
    }, 0) + 1;

    for (const specification of specifications) {
      const matchingOutputs = outputColumns.filter((outputColumn) => {
        if (outputColumn.wildcard_type) {
          return false;
        }

        const directName = this.#extractSimpleIdentifierName(
          outputColumn.expression
        );
        return directName === specification.generated_column_name;
      });

      if (matchingOutputs.length > 0) {
        for (const outputColumn of matchingOutputs) {
          this.#applyUnpivotMetadata(
            outputColumn,
            specification,
            resolvedSource,
            inputScopeId,
            false
          );
        }
        continue;
      }

      /*
       * SELECT *ではUNPIVOT生成列も外部公開される。
       * また複雑なSELECT式から参照される場合、LineageResolverが
       * 同一scope内の生成列へ接続するため内部Output Columnを必要とする。
       */
      const hasWildcard = outputColumns.some((column) => {
        return column.output_status === "WILDCARD_PENDING";
      });
      const isReferenced = (queryAst.select || []).some((selectItem) => {
        return this.tokens.some((token) => {
          return token.token_seq >= selectItem.expression_start_seq &&
            token.token_seq <= selectItem.expression_end_seq &&
            token.normalized_token === specification.generated_column_name;
        });
      });

      if (!hasWildcard && !isReferenced) {
        continue;
      }

      const outputColumn = {
        output_column_id: this.nextOutputColumnId++,
        output_column_seq: nextSeq++,
        scope_id: sourceScope.scope_id,
        output_column_name: specification.generated_column_name,
        original_output_alias: specification.generated_column_name,
        alias_type: "UNPIVOT_ALIAS",
        name_source: specification.generated_column_type === "NAME"
          ? "UNPIVOT_NAME_COLUMN"
          : "UNPIVOT_VALUE_COLUMN",
        output_status: "UNPIVOT_GENERATED",
        wildcard_type: null,
        wildcard_qualifier: null,
        wildcard_exclusions: [],
        wildcard_replacements: [],
        expression: null,
        expression_text: specification.generated_column_name,
        start_token_seq: specification.name_token.token_seq,
        end_token_seq: specification.name_token.token_seq
      };

      this.#applyUnpivotMetadata(
        outputColumn,
        specification,
        resolvedSource,
        inputScopeId,
        !hasWildcard
      );
      outputColumns.push(outputColumn);
    }
  }

  #applyUnpivotMetadata(
    outputColumn,
    specification,
    resolvedSource,
    inputScopeId,
    internalGenerated
  ) {
    outputColumn.output_status = "UNPIVOT_GENERATED";
    outputColumn.unpivot_generated_column_name =
      specification.generated_column_name;
    outputColumn.unpivot_generated_column_type =
      specification.generated_column_type;
    outputColumn.unpivot_input_column_names =
      [...specification.input_column_names];
    outputColumn.unpivot_all_input_column_names =
      [...specification.all_input_column_names];
    outputColumn.unpivot_source_id = resolvedSource.source_id;
    outputColumn.unpivot_input_scope_id = inputScopeId;
    outputColumn.unpivot_internal_generated = internalGenerated;
  }

  /**
   * UNPIVOT本体を、生成列ごとの入力列一覧へ変換する。
   * 単一列・複数列の両構文を同じMetadata形式へ正規化する。
   */
  #parseUnpivotSpecifications(unpivot) {
    const bodyTokens = this.tokens.filter((token) => {
      return token.token_seq >= unpivot.body_start_token_seq &&
        token.token_seq <= unpivot.body_end_token_seq &&
        token.token_type !== "COMMENT";
    });

    if (bodyTokens.length === 0) {
      return [];
    }

    const bodyDepth = bodyTokens.reduce((minimum, token) => {
      return Math.min(minimum, token.paren_depth);
    }, Number.POSITIVE_INFINITY);
    const forIndex = bodyTokens.findIndex((token) => {
      return token.normalized_token === "FOR" &&
        token.paren_depth === bodyDepth;
    });
    const inIndex = bodyTokens.findIndex((token, index) => {
      return index > forIndex &&
        token.normalized_token === "IN" &&
        token.paren_depth === bodyDepth;
    });

    if (forIndex < 0 || inIndex < 0) {
      return [];
    }

    const valueColumns = this.#parseUnpivotIdentifierSet(
      bodyTokens.slice(0, forIndex),
      bodyDepth
    );
    const nameToken = bodyTokens.slice(forIndex + 1, inIndex).find((token) => {
      return this.#isIdentifierToken(token);
    });
    const inputGroups = this.#parseUnpivotInputGroups(
      bodyTokens,
      inIndex,
      bodyDepth
    );

    if (!nameToken || valueColumns.length === 0 || inputGroups.length === 0) {
      return [];
    }

    const allInputColumnNames = [...new Set(
      inputGroups.flatMap((group) => group.column_names)
    )];
    const specifications = valueColumns.map((valueColumn, valueIndex) => {
      return {
        generated_column_name: valueColumn.name,
        generated_column_type: "VALUE",
        input_column_names: [...new Set(inputGroups.flatMap((group) => {
          return group.column_names[valueIndex]
            ? [group.column_names[valueIndex]]
            : [];
        }))],
        all_input_column_names: allInputColumnNames,
        name_token: valueColumn.token
      };
    });

    specifications.push({
      generated_column_name: this.#normalizeName(nameToken.token),
      generated_column_type: "NAME",
      input_column_names: allInputColumnNames,
      all_input_column_names: allInputColumnNames,
      name_token: nameToken
    });

    return specifications.filter((specification) => {
      return specification.generated_column_name &&
        specification.input_column_names.length > 0;
    });
  }

  #parseUnpivotIdentifierSet(tokens, depth) {
    const meaningfulTokens = tokens.filter((token) => {
      return token.token_type !== "COMMENT";
    });

    if (meaningfulTokens.length === 0) {
      return [];
    }

    const isWrapped = meaningfulTokens[0].token === "(" &&
      meaningfulTokens.at(-1).token === ")";
    const identifierDepth = isWrapped ? depth + 1 : depth;

    return meaningfulTokens.filter((token) => {
      return token.paren_depth === identifierDepth &&
        this.#isIdentifierToken(token);
    }).map((token) => ({
      name: this.#normalizeName(token.token),
      token
    }));
  }

  #parseUnpivotInputGroups(bodyTokens, inIndex, bodyDepth) {
    const openIndex = bodyTokens.findIndex((token, index) => {
      return index > inIndex &&
        token.token === "(" &&
        token.paren_depth === bodyDepth;
    });
    const closeIndex = bodyTokens.findIndex((token, index) => {
      return index > openIndex &&
        token.token === ")" &&
        token.paren_depth === bodyDepth;
    });

    if (openIndex < 0 || closeIndex <= openIndex) {
      return [];
    }

    const itemDepth = bodyDepth + 1;
    const items = this.#splitTokensAtDepth(
      bodyTokens.slice(openIndex + 1, closeIndex),
      itemDepth
    );

    return items.flatMap((itemTokens) => {
      const asIndex = itemTokens.findIndex((token) => {
        return token.normalized_token === "AS" &&
          token.paren_depth === itemDepth;
      });
      const sourceTokens = asIndex >= 0
        ? itemTokens.slice(0, asIndex)
        : itemTokens;
      const isTuple = sourceTokens[0]?.token === "(";
      const columnDepth = isTuple ? itemDepth + 1 : itemDepth;
      const columnNames = sourceTokens.filter((token) => {
        return token.paren_depth === columnDepth &&
          this.#isIdentifierToken(token);
      }).map((token) => this.#normalizeName(token.token));

      return columnNames.length > 0 ? [{ column_names: columnNames }] : [];
    });
  }

  #extractSimpleIdentifierName(expression) {
    if (expression?.node_type !== NodeType.IDENTIFIER_EXPRESSION) {
      return null;
    }

    const parts = Array.isArray(expression.parts)
      ? expression.parts.filter((part) => part !== ".")
      : [];
    const lastPart = parts.at(-1);
    const rawName = parts.length > 0
      ? typeof lastPart === "string"
        ? lastPart
        : lastPart?.normalized_token ?? lastPart?.token
      : expression.name;

    return rawName ? this.#normalizeName(rawName) : null;
  }

  #isIdentifierToken(token) {
    return token &&
      (token.token_type === "IDENTIFIER" || token.token_type === "KEYWORD");
  }

  /**
   * FORより前にある集計式を、PIVOT本体と同じ括弧深度のカンマで分割する。
   * 集計関数の引数カラムと任意prefixをLineage用Metadataとして返す。
   */
  #parsePivotAggregateSpecifications(tokens, bodyDepth) {
    return this.#splitTokensAtDepth(tokens, bodyDepth).flatMap((itemTokens) => {
      const openIndex = itemTokens.findIndex((token) => {
        return token.token === "(" && token.paren_depth === bodyDepth;
      });
      const closeIndex = itemTokens.findIndex((token, index) => {
        return index > openIndex &&
          token.token === ")" &&
          token.paren_depth === bodyDepth;
      });

      if (openIndex < 0 || closeIndex <= openIndex) {
        return [];
      }

      const valueToken = itemTokens
        .slice(openIndex + 1, closeIndex)
        .find((token) => {
          return token.token_type === "IDENTIFIER" ||
            token.token_type === "KEYWORD";
        });

      if (!valueToken) {
        return [];
      }

      const suffixTokens = itemTokens.slice(closeIndex + 1);
      const prefixToken = this.#findOptionalAliasToken(
        suffixTokens,
        bodyDepth
      );

      return [{
        tokens: itemTokens,
        prefix: prefixToken
          ? this.#normalizeName(prefixToken.token)
          : null,
        value_column_name: this.#normalizeName(valueToken.token)
      }];
    });
  }

  /**
   * IN句の各valueから、生成列名のsuffixを取得する。
   * 明示Aliasがない単純な文字列・数値はBigQueryの既定名へ近い形で正規化する。
   */
  #parsePivotColumns(bodyTokens, inIndex, bodyDepth) {
    const openIndex = bodyTokens.findIndex((token, index) => {
      return index > inIndex &&
        token.token === "(" &&
        token.paren_depth === bodyDepth;
    });
    const closeIndex = bodyTokens.findIndex((token, index) => {
      return index > openIndex &&
        token.token === ")" &&
        token.paren_depth === bodyDepth;
    });

    if (openIndex < 0 || closeIndex <= openIndex) {
      return [];
    }

    const itemDepth = bodyDepth + 1;
    const inItems = this.#splitTokensAtDepth(
      bodyTokens.slice(openIndex + 1, closeIndex),
      itemDepth
    );

    return inItems.flatMap((itemTokens) => {
      if (itemTokens.length === 0) {
        return [];
      }

      const aliasToken = this.#findOptionalAliasToken(
        itemTokens.slice(1),
        itemDepth
      );
      const valueToken = itemTokens[0];
      const suffix = aliasToken
        ? this.#normalizeName(aliasToken.token)
        : this.#derivePivotColumnSuffix(valueToken);

      if (!suffix) {
        return [];
      }

      return [{
        suffix,
        name_token: aliasToken || valueToken
      }];
    });
  }

  #splitTokensAtDepth(tokens, depth) {
    const items = [];
    let current = [];

    for (const token of tokens) {
      if (token.token === "," && token.paren_depth === depth) {
        if (current.length > 0) {
          items.push(current);
          current = [];
        }
        continue;
      }
      current.push(token);
    }

    if (current.length > 0) {
      items.push(current);
    }

    return items;
  }

  #findOptionalAliasToken(tokens, depth) {
    const asIndex = tokens.findIndex((token) => {
      return token.normalized_token === "AS" &&
        token.paren_depth === depth;
    });

    if (asIndex >= 0) {
      return tokens[asIndex + 1] || null;
    }

    return tokens.find((token) => {
      return token.paren_depth === depth &&
        (token.token_type === "IDENTIFIER" || token.token_type === "KEYWORD");
    }) || null;
  }

  #derivePivotColumnSuffix(valueToken) {
    if (!valueToken) {
      return null;
    }

    if (valueToken.token_type === "STRING") {
      const unquoted = String(valueToken.token)
        .replace(/^['"]|['"]$/g, "");
      return this.#normalizeName(unquoted.replace(/[^A-Za-z0-9_]/g, "_"));
    }

    if (
      valueToken.token_type === "NUMBER" ||
      valueToken.normalized_token === "TRUE" ||
      valueToken.normalized_token === "FALSE" ||
      valueToken.normalized_token === "NULL"
    ) {
      return this.#normalizeName(
        String(valueToken.token).replace(/[^A-Za-z0-9_]/g, "_")
      );
    }

    return null;
  }

  /**
   * SELECT項目のtoken_seq範囲をExpressionParserへ渡し、ASTを作る。
   *
   * SelectParserは式の境界とaliasを決めることに集中しているため、
   * 式内部のASTはここで既存ExpressionParserを再利用して作成する。
   */
  #parseSelectItemExpression(selectItem) {
    const expressionTokens = this.tokens.filter((token) => {
      return token.token_seq >= selectItem.expression_start_seq &&
        token.token_seq <= selectItem.expression_end_seq &&
        token.token_type !== "COMMENT";
    });

    if (expressionTokens.length === 0) {
      throw new SyntaxError(
        `OutputColumnResolver: SELECT item ${selectItem.select_item_seq} ` +
        "contains no expression tokens."
      );
    }

    try {
      return new ExpressionParser(expressionTokens).parseExpression();
    } catch (error) {
      return createRawExpressionAst(expressionTokens);
    }
  }

  #determineOutputStatus(selectItem, outputName) {
    if (selectItem.wildcard_type) {
      return "WILDCARD_PENDING";
    }

    if (!outputName) {
      return "UNNAMED";
    }

    return "RESOLVED";
  }

  /**
   * CTE名の直後に `(column_a, column_b)` が指定されている場合、
   * その列名一覧はCTE本文Queryの出力名を位置順に上書きする。
   */
  #findCteColumnNames(sourceResolution, queryScopeId) {
    for (const scope of sourceResolution.scopes) {
      const definition = scope.cte_definitions.find(
        (cte) => cte.query_scope_id === queryScopeId
      );

      if (definition) {
        return Array.isArray(definition.column_names)
          ? definition.column_names.map((name) => this.#normalizeName(name))
          : [];
      }
    }

    return [];
  }

  #addDuplicateNameDiagnostics(outputColumns, sourceScope, context) {
    const countByName = new Map();

    for (const outputColumn of outputColumns) {
      if (!outputColumn.output_column_name || outputColumn.wildcard_type) {
        continue;
      }

      const name = this.#normalizeName(outputColumn.output_column_name);
      countByName.set(name, (countByName.get(name) || 0) + 1);
    }

    for (const [name, count] of countByName.entries()) {
      if (count < 2) {
        continue;
      }

      context.addDiagnostic(
        "WARNING",
        "DUPLICATE_OUTPUT_COLUMN_NAME",
        `Output column name "${name}" appears ${count} times in scope ` +
        `${sourceScope.scope_id}.`,
        { scope_id: sourceScope.scope_id, output_column_name: name }
      );
    }
  }

  #validateContext(context) {
    if (!context || context.query_ast?.node_type !== "QUERY") {
      throw new TypeError("OutputColumnResolver.resolve: invalid context.");
    }

    if (!context.source_resolution) {
      throw new TypeError(
        "OutputColumnResolver.resolve: source_resolution is not set."
      );
    }
  }

  #normalizeName(value) {
    return String(value ?? "").toUpperCase();
  }
}

// ============================================================
// SOURCE: src/physical_column_resolver.js
// ============================================================
/**
 * ColumnResolverがSourceまで解決した参照を、物理テーブルの実カラムへ結び付ける。
 *
 * PhysicalColumnResolverの責務:
 *
 * - INFORMATION_SCHEMA.COLUMNS / COLUMN_FIELD_PATHS相当のメタデータを索引化する。
 * - PHYSICAL_TABLEへ向いたカラム参照について、実カラムの存在を確認する。
 * - 非修飾列が複数Source候補を持つ場合、実スキーマを使って候補を絞り込む。
 * - `*` / `alias.*`を、物理テーブルまたは派生Sourceの公開列へ展開する。
 * - CTEやサブクエリの参照は、次のLineageResolverが内部式を辿れるよう
 *   「派生Sourceとして解決済み」の状態で保持する。
 *
 * このResolverは、CTE出力列の式を物理カラムまで再帰展開しない。
 * その処理は次工程のLineageResolverへ委譲する。
 */
class PhysicalColumnResolver {
  /**
   * @param {Array<object>} physicalColumns
   *
   * 1行の例:
   * {
   *   project_id: "project",
   *   dataset_id: "dataset",
   *   table_name: "sales",
   *   column_name: "amount",
   *   field_path: "amount",
   *   ordinal_position: 3,
   *   data_type: "NUMERIC"
   * }
   *
   * table_nameへ`project.dataset.sales`を直接渡す形式にも対応する。
   */
  constructor(physicalColumns) {
    if (!Array.isArray(physicalColumns)) {
      throw new TypeError(
        "PhysicalColumnResolver: physicalColumns must be an array."
      );
    }

    this.physicalColumns = physicalColumns;
    this.tableColumnsByName = new Map();
    this.sourceById = new Map();
    this.outputColumnsByScopeId = new Map();
    this.nextPhysicalReferenceId = 1;
    this.nextExpandedOutputColumnId = 1;
  }

  /**
   * ResolutionContextへ登録済みのSource / Column / Output Columnを利用し、
   * 物理カラム解決結果を作る公開入口。
   */
  resolve(context) {
    this.#validateContext(context);

    this.nextPhysicalReferenceId = 1;
    this.nextExpandedOutputColumnId = 1;
    this.missingWildcardMetadata = new Map();
    this.#buildMetadataIndex();
    this.#buildResolutionIndexes(context);

    const columnReferences = context.column_resolution.column_references.map(
      (reference) => this.#resolveColumnReference(reference, context)
    );
    const unpivotGeneratedColumns =
      this.#resolveUnpivotGeneratedColumns(context);
    const wildcardExpansions = this.#expandOutputWildcards(context);

    const result = {
      node_type: "PHYSICAL_COLUMN_RESOLUTION",
      root_scope_id: context.source_resolution.root_scope_id,
      metadata_table_count: this.tableColumnsByName.size,
      column_references: columnReferences,
      unpivot_generated_columns: unpivotGeneratedColumns,
      wildcard_expansions: wildcardExpansions
    };

    context.setPhysicalColumnResolution(result);
    this.#addDiagnostics(result, context);

    return result;
  }

  /**
   * メタデータをテーブル完全名ごとのMapへ変換する。
   *
   * Resolver本処理で毎回全行を走査しないよう、最初に索引化する。
   * 大量Viewを処理する場合、この前処理が探索コストを抑える。
   */
  #buildMetadataIndex() {
    this.tableColumnsByName = new Map();

    for (const [metadataIndex, rawColumn] of this.physicalColumns.entries()) {
      const column = this.#normalizeMetadataColumn(rawColumn, metadataIndex);
      const tableNames = this.#createTableLookupNames(column);

      for (const tableName of tableNames) {
        if (!this.tableColumnsByName.has(tableName)) {
          this.tableColumnsByName.set(tableName, []);
        }

        this.tableColumnsByName.get(tableName).push(column);
      }
    }

    /*
     * Wildcard展開結果を元テーブルの列順へ揃えるため、
     * ordinal_positionがある場合は昇順に並べる。
     */
    for (const columns of this.tableColumnsByName.values()) {
      columns.sort((left, right) => {
        const leftPosition = left.ordinal_position ?? Number.MAX_SAFE_INTEGER;
        const rightPosition = right.ordinal_position ?? Number.MAX_SAFE_INTEGER;

        return leftPosition - rightPosition;
      });
    }
  }

  #buildResolutionIndexes(context) {
    this.sourceById = new Map();
    this.sourcesByScopeId = new Map();

    for (const scope of context.source_resolution.scopes) {
      this.sourcesByScopeId.set(scope.scope_id, scope.sources);

      for (const source of scope.sources) {
        this.sourceById.set(source.source_id, source);
      }
    }

    this.outputColumnsByScopeId = new Map(
      context.output_column_resolution.scopes.map((scope) => {
        return [scope.scope_id, scope.output_columns];
      })
    );
  }

  #resolveColumnReference(reference, context) {
    if (reference.reference_type === "WILDCARD") {
      return this.#resolveWildcardReference(reference, context);
    }

    /*
     * ワイルドカードテーブルやパーティションの疑似列(_TABLE_SUFFIX 等)は
     * 物理列に対応せず系統も持たない。存在しない列として誤検出しないよう、
     * 依存なしで解決済みとして扱う。
     */
    if (this.#isPseudoColumn(reference.column_name)) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "PSEUDO_COLUMN_RESOLVED",
        sourceId: reference.source_id,
        physicalColumns: []
      });
    }

    /*
     * GROUP BY / HAVING / QUALIFY / ORDER BYから参照されたSELECT出力
     * エイリアスは物理Sourceの列ではない。SELECT式側のLineageが既に
     * 依存列を保持しているため、ここでは正常解決として通過させる。
     */
    if (reference.resolution_status === "SELECT_ALIAS_RESOLVED") {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "SELECT_ALIAS_RESOLVED",
        sourceId: null,
        physicalColumns: []
      });
    }

    const unpivotGeneratedOutput = this.#findUnpivotGeneratedOutput(reference);

    if (unpivotGeneratedOutput) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "UNPIVOT_GENERATED_RESOLVED",
        sourceId: unpivotGeneratedOutput.unpivot_source_id,
        physicalColumns: []
      });
    }

    if (reference.source_type === "PHYSICAL_TABLE" && reference.source_id) {
      return this.#resolveAgainstPhysicalSource(reference, reference.source_id);
    }

    if (
      reference.resolution_status === "AMBIGUOUS" &&
      reference.candidate_source_ids.length > 0
    ) {
      return this.#resolveAmbiguousReference(reference, context);
    }

    if (reference.source_type === "CTE" || reference.source_type === "SUBQUERY") {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "DERIVED_SOURCE_RESOLVED",
        sourceId: reference.source_id,
        physicalColumns: []
      });
    }

    if (reference.source_type === "UNNEST") {
      return this.#resolveCorrelatedUnnestReference(reference, context);
    }

    /*
     * 遅延ディスアンビグエーション。
     *
     * ColumnResolverは物理スキーマを持たず、派生ソース(CTE/サブクエリ)の
     * 公開列を * カスケード越しには把握できないため、JOINを含むスコープで
     * 修飾なし列がどのソース由来か決められず UNRESOLVED_COLUMN のまま
     * 候補ゼロになることがある(例: SELECT aid ... FROM cte c JOIN (..) f)。
     * ここでは PhysicalColumnResolver が計算できる派生列一覧を使い、
     * スコープ内で当該列を公開するソースが1つだけなら解決する。
     */
    if (!reference.qualifier &&
        (reference.resolution_status === "UNRESOLVED_COLUMN" ||
         reference.resolution_status === "AMBIGUOUS")) {
      const recovered = this.#resolveUnqualifiedAgainstScopeSources(
        reference,
        context
      );

      if (recovered) {
        return recovered;
      }
    }

    /*
     * STRUCT フィールドアクセス(例: geo.region)。ColumnResolverは修飾子
     * `geo` をソース別名とみなし、一致するソースが無いと UNRESOLVED_SOURCE に
     * する。ここで `修飾子.列名` を field_path として、スコープ内の物理ソースの
     * メタデータ(COLUMN_FIELD_PATHS由来)に一致するネスト列があれば解決する。
     */
    if (reference.qualifier) {
      const structResolved = this.#resolveStructFieldPathReference(reference);

      if (structResolved) {
        return structResolved;
      }
    }

    return this.#createPhysicalReference(reference, {
      physicalStatus: reference.resolution_status,
      sourceId: reference.source_id,
      physicalColumns: []
    });
  }

  /*
   * `qualifier.column_name`(および `qualifier` が複数階層の場合はそのまま連結)
   * を field_path とみなし、スコープ内の物理ソースから一致するネスト列を探す。
   * 該当ソースが1つなら解決、複数ならAMBIGUOUS、無ければnull。
   */
  #resolveStructFieldPathReference(reference) {
    /*
     * reference_name には書かれたままのフルパスが入る(例:
     * geo.region / device.web_info.browser)。qualifier/column_name は
     * 先頭2要素しか持たないため、深いネストも拾えるフルパスを優先する。
     */
    const fieldPath = this.#normalizeName(
      reference.reference_name ||
      `${reference.qualifier}.${reference.column_name}`
    );

    if (!fieldPath || !fieldPath.includes(".")) {
      return null;
    }

    const sources = this.sourcesByScopeId.get(reference.scope_id) || [];
    const matches = [];

    for (const source of sources) {
      if (source.source_type !== "PHYSICAL_TABLE") {
        continue;
      }

      const columns = this.#getColumnsForSource(source).filter(
        (column) => this.#normalizeName(column.field_path) === fieldPath
      );

      if (columns.length > 0) {
        matches.push({ source, columns });
      }
    }

    if (matches.length === 1) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "PHYSICAL_RESOLVED",
        sourceId: matches[0].source.source_id,
        physicalColumns: matches[0].columns
      });
    }

    if (matches.length > 1) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "PHYSICAL_AMBIGUOUS",
        sourceId: null,
        physicalColumns: matches.flatMap((item) => item.columns),
        candidateSourceIds: matches.map((item) => item.source.source_id)
      });
    }

    return null;
  }


  /**
   * 相関UNNESTの別名参照を、元の物理STRUCT/ARRAYフィールドへ展開する。
   *
   * 例:
   *   LEFT JOIN UNNEST(customer.contacts) AS contact
   *   SELECT contact.contact_value
   *
   * UNNEST式の`customer.contacts`から親Sourceと配列フィールドを特定し、
   * `contact.contact_value`を`customer.contacts.contact_value`として
   * INFORMATION_SCHEMA.COLUMN_FIELD_PATHSへ照合する。
   *
   * 安全性のため、次の条件をすべて満たす場合だけ物理解決する。
   * - UNNEST式が単純な修飾識別子である。
   * - 先頭要素が同一scope内の既存Source aliasを指す。
   * - 親Sourceが物理テーブルである。
   * - 完全なfield_pathがメタデータに存在する。
   */
  #resolveCorrelatedUnnestReference(reference, context) {
    const unnestSource = this.sourceById.get(reference.source_id);
    const expressionParts =
      unnestSource?.expression?.node_type === "IDENTIFIER_EXPRESSION" &&
      Array.isArray(unnestSource.expression.parts)
        ? unnestSource.expression.parts.map((part) => this.#normalizeName(part))
        : [];

    const referenceName = this.#normalizeName(reference.column_name);
    const isWholeValue = unnestSource &&
      referenceName === this.#normalizeName(unnestSource.source_alias);
    const isOffset = unnestSource &&
      unnestSource.offset_alias &&
      referenceName === this.#normalizeName(unnestSource.offset_alias);

    /*
     * WITH OFFSET の列は配列内の位置(整数)で、元列への系統を持たない。
     */
    if (isOffset) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "UNNEST_OFFSET",
        sourceId: reference.source_id,
        physicalColumns: []
      });
    }

    if (expressionParts.length === 0) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "UNNEST_DEFERRED",
        sourceId: reference.source_id,
        physicalColumns: []
      });
    }

    /*
     * 要素値そのもの(素の別名)への参照。
     *   UNNEST(item_id) AS item_id  -> item_id(配列列)の系統
     *   UNNEST(t.items) AS x        -> t.items フィールドの系統
     */
    if (isWholeValue) {
      if (expressionParts.length === 1) {
        return this.#resolveUnnestArrayColumn(
          reference,
          unnestSource,
          expressionParts[0],
          context
        );
      }

      const parentSource = this.#findSiblingSourceByAlias(
        unnestSource,
        expressionParts[0]
      );

      if (parentSource?.source_type === "PHYSICAL_TABLE") {
        const fieldPath = expressionParts.slice(1).join(".");

        return this.#resolveParentFieldPath(reference, parentSource, fieldPath);
      }

      return this.#createPhysicalReference(reference, {
        physicalStatus: "UNNEST_DEFERRED",
        sourceId: reference.source_id,
        physicalColumns: []
      });
    }

    /*
     * 要素内フィールドへの参照。
     *   物理の繰り返しSTRUCT: UNNEST(event_params) [AS ep], ep.key
     *     -> 配列列のfield_path接頭辞 + フィールド名 = event_params.key を解決
     *   相関UNNEST:          UNNEST(customer.contacts) AS c, c.contact_value
     *   定数/派生の配列:      UNNEST(str)（cte1のSTRUCTリテラル配列） -> 定数
     */

    // 要素内のフィールドパス(先頭が要素別名ならそれを除去)。
    const elementAlias = this.#normalizeName(unnestSource.source_alias);
    const referenceParts = this.#normalizeName(
      reference.reference_name || reference.column_name
    ).split(".").filter(Boolean);
    const fieldWithinElement =
      (elementAlias && referenceParts.length > 1 &&
        referenceParts[0] === elementAlias)
        ? referenceParts.slice(1).join(".")
        : referenceParts.join(".");

    // 配列式(UNNESTの引数)の所有ソースと、配列のfield_path接頭辞を求める。
    let arrayOwner = null;
    let arrayPrefix = null;

    if (expressionParts.length >= 2) {
      const aliasedOwner = this.#findSiblingSourceByAlias(
        unnestSource,
        expressionParts[0]
      );

      if (aliasedOwner) {
        arrayOwner = aliasedOwner;
        arrayPrefix = expressionParts.slice(1).join(".");
      }
    }

    if (!arrayOwner) {
      arrayPrefix = expressionParts.join(".");
      const siblings = (this.sourcesByScopeId.get(unnestSource.scope_id) || [])
        .filter((source) => source.source_id !== unnestSource.source_id);

      for (const sibling of siblings) {
        if (sibling.source_type !== "PHYSICAL_TABLE") {
          continue;
        }

        const owns = this.#getColumnsForSource(sibling).some((column) =>
          this.#normalizeName(column.field_path) === arrayPrefix ||
          this.#normalizeName(column.column_name) === arrayPrefix);

        if (owns) {
          arrayOwner = sibling;
          break;
        }
      }
    }

    if (arrayOwner && arrayOwner.source_type === "PHYSICAL_TABLE" &&
        arrayPrefix && fieldWithinElement) {
      const fullFieldPath = `${arrayPrefix}.${fieldWithinElement}`;
      const columns = this.#getColumnsForSource(arrayOwner).filter(
        (column) => this.#normalizeName(column.field_path) === fullFieldPath
      );

      if (columns.length > 0) {
        return this.#createPhysicalReference(reference, {
          physicalStatus: "PHYSICAL_RESOLVED",
          sourceId: arrayOwner.source_id,
          physicalColumns: columns
        });
      }
    }

    /*
     * 物理配列に一致するfield_pathが無い、または配列が派生列/リテラル(STRUCT
     * リテラル配列など)の場合、要素フィールドは上流の物理カラムを持たない定数
     * として扱う(誤ったPARTIALLY_RESOLVEDを出さない)。
     */
    return this.#createPhysicalReference(reference, {
      physicalStatus: "UNNEST_CONSTANT",
      sourceId: reference.source_id,
      physicalColumns: []
    });
  }

  #findSiblingSourceByAlias(unnestSource, alias) {
    return Array.from(this.sourceById.values()).find((source) => {
      return source.scope_id === unnestSource.scope_id &&
        source.source_id !== unnestSource.source_id &&
        source.source_alias === alias;
    }) || null;
  }

  #resolveParentFieldPath(reference, parentSource, fieldPath) {
    const matchingColumns = this.#getColumnsForSource(parentSource).filter(
      (column) => column.field_path === fieldPath
    );

    if (matchingColumns.length === 0) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: this.#hasMetadataForSource(parentSource)
          ? "PHYSICAL_COLUMN_NOT_FOUND"
          : "PHYSICAL_METADATA_NOT_FOUND",
        sourceId: parentSource.source_id,
        physicalColumns: []
      });
    }

    return this.#createPhysicalReference(reference, {
      physicalStatus: "PHYSICAL_RESOLVED",
      sourceId: parentSource.source_id,
      physicalColumns: matchingColumns
    });
  }

  /*
   * UNNEST(<bare_column>) の要素値を、同一スコープの兄弟ソースが公開する
   * その配列列へ結び付ける。物理テーブルなら物理列、派生ソースなら
   * DERIVED_SOURCE_RESOLVED として系統を継ぐ。
   */
  #resolveUnnestArrayColumn(reference, unnestSource, arrayColumnName, context) {
    const siblings = (this.sourcesByScopeId.get(unnestSource.scope_id) || [])
      .filter((source) => source.source_id !== unnestSource.source_id);

    for (const sibling of siblings) {
      if (sibling.source_type === "PHYSICAL_TABLE") {
        const columns = this.#findPhysicalColumns(sibling, arrayColumnName);

        if (columns.length > 0) {
          return this.#createPhysicalReference(reference, {
            physicalStatus: "PHYSICAL_RESOLVED",
            sourceId: sibling.source_id,
            physicalColumns: columns
          });
        }
      } else if ((sibling.source_type === "CTE" ||
          sibling.source_type === "SUBQUERY") && context &&
          this.#derivedSourceExposesColumn(sibling, arrayColumnName, context)) {
        return this.#createPhysicalReference(reference, {
          physicalStatus: "DERIVED_SOURCE_RESOLVED",
          sourceId: sibling.source_id,
          physicalColumns: []
        });
      }
    }

    return this.#createPhysicalReference(reference, {
      physicalStatus: "UNNEST_DEFERRED",
      sourceId: reference.source_id,
      physicalColumns: []
    });
  }

  #resolveAgainstPhysicalSource(reference, sourceId) {
    const source = this.sourceById.get(sourceId);

    /*
     * ソース別名で修飾された STRUCT フィールドアクセス(例: t.geo.region)。
     * reference_name から先頭の別名/テーブル名を取り除いた残りがネストパス
     * (dotを含む)なら、その field_path に厳密一致する列だけへ解決する。
     * こうしないと column_name 一致で geo(トップ)と geo.region の両方が
     * 依存として付いてしまう。
     */
    const accessPath = this.#deriveStructAccessPath(reference, source);
    const matchingColumns = accessPath && accessPath.includes(".")
      ? this.#getColumnsForSource(source).filter(
          (column) => this.#normalizeName(column.field_path) === accessPath
        )
      : this.#findPhysicalColumns(source, reference.column_name);

    return this.#createPhysicalReference(reference, {
      physicalStatus: matchingColumns.length > 0
        ? "PHYSICAL_RESOLVED"
        : this.#hasMetadataForSource(source)
          ? "PHYSICAL_COLUMN_NOT_FOUND"
          : "PHYSICAL_METADATA_NOT_FOUND",
      sourceId,
      physicalColumns: matchingColumns
    });
  }

  /*
   * reference_name から、ソースを指す先頭の別名/テーブル名要素を取り除いた
   * アクセスパスを返す。t.geo.region -> geo.region、geo.region -> geo.region。
   */
  #deriveStructAccessPath(reference, source) {
    const rawName = reference.reference_name || reference.column_name;
    const parts = this.#normalizeName(rawName || "").split(".").filter(Boolean);

    if (parts.length <= 1) {
      return parts.join(".");
    }

    const aliasCandidates = new Set(
      [
        source?.source_alias,
        ...(source?.source_name ? source.source_name.split(".") : [])
      ]
        .filter(Boolean)
        .map((value) => this.#normalizeName(value))
    );

    if (aliasCandidates.has(parts[0])) {
      parts.shift();
    }

    return parts.join(".");
  }

  /**
   * ColumnResolverでは物理スキーマが無いため、非修飾列が複数Sourceに
   * 存在し得る場合はAMBIGUOUSとしていた。
   *
   * ここでは各候補テーブルの実カラムを確認し、列を持つSourceが1件だけなら
   * 曖昧性を解消する。複数テーブルに同名列がある場合は曖昧なまま保持する。
   */
  #resolveAmbiguousReference(reference, context) {
    return this.#disambiguateAcrossSources(
      reference,
      reference.candidate_source_ids,
      context
    );
  }

  /*
   * 修飾なし列を、スコープのFROMソース全体から解決する。
   * ColumnResolverが候補を出せなかった(候補ゼロ)場合の救済に使う。
   */
  #resolveUnqualifiedAgainstScopeSources(reference, context) {
    const sources = this.sourcesByScopeId.get(reference.scope_id) || [];
    const sourceIds = sources.map((source) => source.source_id);

    if (sourceIds.length === 0) {
      return null;
    }

    const resolved = this.#disambiguateAcrossSources(
      reference,
      sourceIds,
      context
    );

    /*
     * スコープ内のどのソースにも当該列が無い場合は解決したことにしない
     * (相関参照など別スコープ由来の可能性を潰さない)。
     */
    if (resolved.physical_resolution_status === "PHYSICAL_RESOLVED" ||
        resolved.physical_resolution_status === "DERIVED_SOURCE_RESOLVED") {
      return resolved;
    }

    return null;
  }

  /*
   * 物理テーブルと派生ソース(CTE/サブクエリ)の両方を対象に、指定列を
   * 公開するソースを探して解決する。該当が1つなら解決、複数ならAMBIGUOUS、
   * 皆無なら COLUMN_NOT_FOUND。
   */
  #disambiguateAcrossSources(reference, candidateSourceIds, context) {
    const physicalMatches = [];
    const derivedMatches = [];
    const unnestCandidates = [];

    for (const sourceId of candidateSourceIds) {
      const source = this.sourceById.get(sourceId);

      if (!source) {
        continue;
      }

      if (source.source_type === "PHYSICAL_TABLE") {
        const columns = this.#findPhysicalColumns(source, reference.column_name);

        if (columns.length > 0) {
          physicalMatches.push({ source, columns });
        }

        continue;
      }

      if (source.source_type === "CTE" || source.source_type === "SUBQUERY") {
        if (this.#derivedSourceExposesColumn(
          source,
          reference.column_name,
          context
        )) {
          derivedMatches.push({ source });
        }

        continue;
      }

      if (source.source_type === "UNNEST") {
        unnestCandidates.push(source);
      }
    }

    const totalMatches = physicalMatches.length + derivedMatches.length;

    if (totalMatches === 1) {
      if (physicalMatches.length === 1) {
        return this.#createPhysicalReference(reference, {
          physicalStatus: "PHYSICAL_RESOLVED",
          sourceId: physicalMatches[0].source.source_id,
          physicalColumns: physicalMatches[0].columns
        });
      }

      return this.#createPhysicalReference(reference, {
        physicalStatus: "DERIVED_SOURCE_RESOLVED",
        sourceId: derivedMatches[0].source.source_id,
        physicalColumns: []
      });
    }

    /*
     * どの物理/派生ソースにも無い修飾なし列で、スコープにUNNESTが1つだけある
     * 場合は、その要素フィールド(例: UNNEST(event_params) の key/value を別名
     * なしで参照)とみなしてUNNEST解決へ委譲する。
     */
    if (totalMatches === 0 && unnestCandidates.length === 1) {
      return this.#resolveCorrelatedUnnestReference(
        { ...reference, source_id: unnestCandidates[0].source_id },
        context
      );
    }

    return this.#createPhysicalReference(reference, {
      physicalStatus: totalMatches > 1
        ? "PHYSICAL_AMBIGUOUS"
        : "PHYSICAL_COLUMN_NOT_FOUND",
      sourceId: null,
      physicalColumns: physicalMatches.flatMap((item) => item.columns),
      candidateSourceIds: [
        ...physicalMatches.map((item) => item.source.source_id),
        ...derivedMatches.map((item) => item.source.source_id)
      ]
    });
  }

  #derivedSourceExposesColumn(source, columnName, context) {
    const scopeId = source.cte_query_scope_id ?? source.subquery_scope_id;

    if (scopeId === null || scopeId === undefined || !context) {
      return false;
    }

    const target = this.#normalizeName(columnName);
    const columns = this.#expandDerivedScopeColumns(scopeId, context, new Set());

    return columns.some((column) => {
      return this.#normalizeName(column.output_column_name) === target;
    });
  }

  #resolveWildcardReference(reference, context) {
    const expandedColumns = this.#expandReferenceWildcard(reference, context);

    return this.#createPhysicalReference(reference, {
      physicalStatus: expandedColumns.length > 0
        ? "WILDCARD_EXPANDED"
        : "WILDCARD_NOT_EXPANDED",
      sourceId: reference.source_id,
      physicalColumns: expandedColumns
    });
  }

  #findUnpivotGeneratedOutput(reference) {
    const generatedName = this.#normalizeName(reference.column_name);
    const outputColumns = this.outputColumnsByScopeId.get(reference.scope_id) || [];

    return outputColumns.find((outputColumn) => {
      return outputColumn.output_status === "UNPIVOT_GENERATED" &&
        this.#normalizeName(outputColumn.unpivot_generated_column_name) ===
          generatedName;
    }) || null;
  }

  /**
   * UNPIVOT生成列が依存する物理入力列を、通常のColumn Referenceとは
   * 分離して解決する。UNPIVOT本体のIN句はSELECT式ではないため、
   * ColumnResolverの参照一覧には現れない。
   */
  #resolveUnpivotGeneratedColumns(context) {
    return context.output_column_resolution.output_columns
      .filter((outputColumn) => {
        return outputColumn.output_status === "UNPIVOT_GENERATED";
      })
      .map((outputColumn) => {
        const source = this.sourceById.get(outputColumn.unpivot_source_id);
        const inputColumnNames = outputColumn.unpivot_input_column_names || [];
        const physicalColumns = [];
        const missingColumnNames = [];

        if (source?.source_type === "PHYSICAL_TABLE") {
          for (const inputColumnName of inputColumnNames) {
            const matches = this.#findPhysicalColumns(source, inputColumnName);

            if (matches.length === 0) {
              missingColumnNames.push(this.#normalizeName(inputColumnName));
            } else {
              physicalColumns.push(...matches);
            }
          }
        }

        let resolutionStatus = "DERIVED_SOURCE_RESOLVED";

        if (source?.source_type === "PHYSICAL_TABLE") {
          resolutionStatus = missingColumnNames.length > 0
            ? this.#hasMetadataForSource(source)
              ? "PHYSICAL_COLUMN_NOT_FOUND"
              : "PHYSICAL_METADATA_NOT_FOUND"
            : "PHYSICAL_RESOLVED";
        }

        return {
          output_column_id: outputColumn.output_column_id,
          scope_id: outputColumn.scope_id,
          output_column_name: outputColumn.output_column_name,
          generated_column_name:
            outputColumn.unpivot_generated_column_name,
          generated_column_type:
            outputColumn.unpivot_generated_column_type,
          source_id: source?.source_id ?? null,
          source_type: source?.source_type ?? null,
          source_name: source?.source_name ?? null,
          input_scope_id: outputColumn.unpivot_input_scope_id ?? null,
          input_column_names: [...inputColumnNames],
          missing_column_names: missingColumnNames,
          physical_resolution_status: resolutionStatus,
          physical_columns: physicalColumns.map((column) => ({
            physical_table_name: column.physical_table_name,
            physical_column_name: column.column_name,
            field_path: column.field_path,
            ordinal_position: column.ordinal_position,
            data_type: column.data_type,
            is_nullable: column.is_nullable
          }))
        };
      });
  }

  /**
   * OutputColumnResolverがWILDCARD_PENDINGとして保持したSELECT項目を、
   * 具体的な出力列一覧へ展開する。
   *
   * 元のOutput Columnは消さず、展開結果を別配列へ返す。
   * これにより「元SQLではWildcardだった」という情報と、実際の公開列一覧の
   * 両方を保持できる。
   */
  #expandOutputWildcards(context) {
    const expansions = [];

    for (const outputColumn of context.output_column_resolution.output_columns) {
      if (outputColumn.output_status !== "WILDCARD_PENDING") {
        continue;
      }

      const reference = context.column_resolution.column_references.find((item) => {
        return item.scope_id === outputColumn.scope_id &&
          item.select_item_seq === outputColumn.output_column_seq &&
          item.reference_type === "WILDCARD";
      });

      if (!reference) {
        continue;
      }

      const expandedColumns = this.#expandReferenceWildcard(reference, context);
      const exclusions = new Set(
        (outputColumn.wildcard_exclusions || []).map((name) => this.#normalizeName(name))
      );
      const unpivotInputColumns = new Set(
        context.output_column_resolution.output_columns
          .filter((column) => {
            return column.scope_id === outputColumn.scope_id &&
              column.output_status === "UNPIVOT_GENERATED";
          })
          .flatMap((column) => column.unpivot_all_input_column_names || [])
          .map((name) => this.#normalizeName(name))
      );
      const visibleColumns = expandedColumns.filter((physicalColumn) => {
        const outputName = physicalColumn.output_column_name ||
          physicalColumn.column_name ||
          physicalColumn.physical_column_name;
        const normalizedOutputName = this.#normalizeName(outputName);
        return !exclusions.has(normalizedOutputName) &&
          !unpivotInputColumns.has(normalizedOutputName);
      });
      const replacements = outputColumn.wildcard_replacements || [];
      const replacementByName = new Map(replacements.map((item) => {
        return [this.#normalizeName(item.output_column_name), item];
      }));
      const wildcardBaseExpression = outputColumn.wildcard_qualifier
        ? `${outputColumn.wildcard_qualifier}.*`
        : "*";
      let wildcardExpression = exclusions.size > 0
        ? `${wildcardBaseExpression} EXCEPT(${[...exclusions].join(", ")})`
        : wildcardBaseExpression;
      if (replacements.length > 0) {
        const replacementText = replacements.map((item) => {
          return `${item.expression} AS ${item.output_column_name}`;
        }).join(", ");
        wildcardExpression += ` REPLACE(${replacementText})`;
      }

      for (const [expandedIndex, physicalColumn] of visibleColumns.entries()) {
        expansions.push({
          expanded_output_column_id: this.nextExpandedOutputColumnId++,
          source_output_column_id: outputColumn.output_column_id,
          scope_id: outputColumn.scope_id,
          select_item_seq: outputColumn.output_column_seq,
          expanded_column_seq: expandedIndex + 1,
          output_column_name: physicalColumn.output_column_name ||
            physicalColumn.column_name,
          source_id: physicalColumn.source_id,
          source_type: physicalColumn.source_type,
          source_name: physicalColumn.source_name,
          physical_table_name: physicalColumn.physical_table_name ?? null,
          physical_column_name: physicalColumn.physical_column_name ??
            physicalColumn.column_name ??
            physicalColumn.output_column_name ??
            null,
          field_path: physicalColumn.field_path ??
            physicalColumn.column_name ??
            physicalColumn.output_column_name ??
            null,
          data_type: physicalColumn.data_type ?? null,
          ordinal_position: physicalColumn.ordinal_position ?? null,
          wildcard_type: outputColumn.wildcard_type,
          wildcard_qualifier: outputColumn.wildcard_qualifier ?? null,
          wildcard_expression: wildcardExpression,
          wildcard_replacement: replacementByName.get(this.#normalizeName(
            physicalColumn.output_column_name || physicalColumn.column_name
          )) || null
        });
      }
    }

    return expansions;
  }

  #expandReferenceWildcard(reference, context) {
    const sourceIds = reference.source_id
      ? [reference.source_id]
      : reference.candidate_source_ids;
    const result = [];

    for (const sourceId of sourceIds) {
      const source = this.sourceById.get(sourceId);

      if (!source) {
        continue;
      }

      if (source.source_type === "PHYSICAL_TABLE") {
        this.#recordMissingWildcardMetadata(source, reference);

        for (const column of this.#getTopLevelColumns(source)) {
          result.push({
            ...column,
            source_id: source.source_id,
            source_type: source.source_type,
            source_name: source.source_name,
            output_column_name: column.column_name
          });
        }
        continue;
      }

      const childScopeId = source.cte_query_scope_id || source.subquery_scope_id;
      const expandedDerivedColumns = this.#expandDerivedScopeColumns(
        childScopeId,
        context,
        new Set()
      );

      for (const derivedColumn of expandedDerivedColumns) {
        result.push({
          ...derivedColumn,
          source_id: source.source_id,
          source_type: source.source_type,
          source_name: source.source_name
        });
      }
    }

    return result;
  }

  #expandDerivedScopeColumns(scopeId, context, visitingScopeIds) {
    if (scopeId === null || scopeId === undefined) {
      return [];
    }

    if (visitingScopeIds.has(scopeId)) {
      return [];
    }

    const nextVisiting = new Set(visitingScopeIds);
    nextVisiting.add(scopeId);
    const outputColumns = this.outputColumnsByScopeId.get(scopeId) || [];
    const result = [];

    for (const outputColumn of outputColumns) {
      if (outputColumn.output_status !== "WILDCARD_PENDING") {
        if (!outputColumn.output_column_name) {
          continue;
        }

        result.push({
          output_column_name: outputColumn.output_column_name,
          physical_table_name: null,
          physical_column_name: null,
          field_path: null,
          data_type: null,
          ordinal_position: outputColumn.output_column_seq
        });
        continue;
      }

      const wildcardReference = context.column_resolution.column_references.find((item) => {
        return item.scope_id === scopeId &&
          item.select_item_seq === outputColumn.output_column_seq &&
          item.reference_type === "WILDCARD";
      });

      if (!wildcardReference) {
        continue;
      }

      const sourceIds = wildcardReference.source_id
        ? [wildcardReference.source_id]
        : wildcardReference.candidate_source_ids;

      /*
       * このWILDCARD_PENDING列自身の EXCEPT(...) を、下位ソースから
       * 展開した列へ適用する。これを行わないと、
       *   x_all AS (SELECT * EXCEPT(col_a) FROM t)
       *   x_some AS (SELECT * FROM x_all)      -- 2段以上の * カスケード
       * のように * が多段で伝播するとき、上流でEXCEPTした列が
       * 下流の再展開で復活してしまう。再帰先も各自のEXCEPTを適用するため、
       * 多段のEXCEPTが正しく合成される。
       */
      const exclusions = new Set(
        (outputColumn.wildcard_exclusions || [])
          .map((name) => this.#normalizeName(name))
      );
      const columnsForThisWildcard = [];

      for (const sourceId of sourceIds) {
        const nestedSource = this.sourceById.get(sourceId);

        if (!nestedSource) {
          continue;
        }

        if (nestedSource.source_type === "PHYSICAL_TABLE") {
          this.#recordMissingWildcardMetadata(nestedSource, wildcardReference);

          for (const column of this.#getTopLevelColumns(nestedSource)) {
            columnsForThisWildcard.push({
              output_column_name: column.column_name,
              physical_table_name: column.physical_table_name,
              physical_column_name: column.column_name,
              field_path: column.field_path,
              data_type: column.data_type,
              ordinal_position: column.ordinal_position
            });
          }
          continue;
        }

        const nestedScopeId = nestedSource.cte_query_scope_id ||
          nestedSource.subquery_scope_id;
        columnsForThisWildcard.push(...this.#expandDerivedScopeColumns(
          nestedScopeId,
          context,
          nextVisiting
        ));
      }

      for (const column of columnsForThisWildcard) {
        if (exclusions.has(this.#normalizeName(column.output_column_name))) {
          continue;
        }

        result.push(column);
      }
    }

    const deduplicated = [];
    const seenNames = new Set();

    for (const column of result) {
      const name = this.#normalizeName(column.output_column_name);

      if (!name || seenNames.has(name)) {
        continue;
      }

      seenNames.add(name);
      deduplicated.push(column);
    }

    return deduplicated;
  }

  #findPhysicalColumns(source, columnName) {
    const tableColumns = this.#getColumnsForSource(source);
    const normalizedColumnName = this.#normalizeName(columnName);

    return tableColumns.filter((column) => {
      return column.column_name === normalizedColumnName ||
        column.field_path === normalizedColumnName;
    });
  }

  #getTopLevelColumns(source) {
    const seenNames = new Set();
    const result = [];

    for (const column of this.#getColumnsForSource(source)) {
      const isTopLevel = !column.field_path ||
        column.field_path === column.column_name ||
        !column.field_path.includes(".");

      if (!isTopLevel || seenNames.has(column.column_name)) {
        continue;
      }

      seenNames.add(column.column_name);
      result.push(column);
    }

    return result;
  }

  #getColumnsForSource(source) {
    if (!source?.source_name) {
      return [];
    }

    const name = this.#normalizeName(source.source_name);
    const exact = this.tableColumnsByName.get(name);

    if (exact) {
      return exact;
    }

    /*
     * ワイルドカードテーブル(例: `project.dataset.events_*`)は、収集済みの
     * シャードテーブル(events_20200101 等)のスキーマから列を引く。各シャードは
     * 同一スキーマ想定なので field_path 単位で重複排除して統合する。
     */
    if (name && name.includes("*")) {
      return this.#getWildcardTableColumns(name);
    }

    return [];
  }

  #getWildcardTableColumns(pattern) {
    const regex = this.#wildcardPatternToRegExp(pattern);
    const seen = new Set();
    const result = [];

    for (const [tableName, columns] of this.tableColumnsByName.entries()) {
      if (!regex.test(tableName)) {
        continue;
      }

      for (const column of columns) {
        const key = `${column.field_path}|${column.column_name}`;

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        result.push(column);
      }
    }

    return result;
  }

  #wildcardPatternToRegExp(pattern) {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");

    return new RegExp(`^${escaped}$`);
  }

  #isPseudoColumn(columnName) {
    const pseudoColumns = new Set([
      "_TABLE_SUFFIX",
      "_TABLE_DATE",
      "_PARTITIONTIME",
      "_PARTITIONDATE",
      "_FILE_NAME"
    ]);

    return pseudoColumns.has(this.#normalizeName(columnName));
  }

  #hasMetadataForSource(source) {
    return this.#getColumnsForSource(source).length > 0;
  }

  /*
   * ワイルドカード(*)の展開先が物理テーブルなのに、その列メタデータが
   * 収集集合に1件も無い場合を記録する。明示列参照は
   * PHYSICAL_METADATA_NOT_FOUND で警告されるが、* 展開は静かに0列になる
   * ため、UNION等では下流で列が原因不明のまま未解決になっていた。
   * source_name単位で重複排除する。
   */
  #recordMissingWildcardMetadata(source, positionReference) {
    if (!source || source.source_type !== "PHYSICAL_TABLE") {
      return;
    }

    if (this.#hasMetadataForSource(source)) {
      return;
    }

    const key = this.#normalizeName(source.source_name);

    if (!key || this.missingWildcardMetadata.has(key)) {
      return;
    }

    this.missingWildcardMetadata.set(key, {
      source_id: source.source_id ?? null,
      source_name: source.source_name ?? null,
      resolved_source_name:
        source.resolved_source_name ?? source.source_name ?? null,
      scope_id: positionReference?.scope_id ?? source.scope_id ?? null,
      start_token_seq:
        positionReference?.start_token_seq ?? source.start_token_seq ?? null,
      end_token_seq:
        positionReference?.end_token_seq ?? source.end_token_seq ?? null
    });
  }

  #createPhysicalReference(reference, details) {
    const source = details.sourceId
      ? this.sourceById.get(details.sourceId)
      : null;

    return {
      physical_reference_id: this.nextPhysicalReferenceId++,
      column_reference_id: reference.column_reference_id,
      scope_id: reference.scope_id,
      clause_type: reference.clause_type,
      select_item_seq: reference.select_item_seq,
      reference_type: reference.reference_type,
      reference_name: reference.reference_name,
      column_name: reference.column_name,
      original_resolution_status: reference.resolution_status,
      physical_resolution_status: details.physicalStatus,
      source_id: source?.source_id ?? details.sourceId ?? null,
      source_type: source?.source_type ?? reference.source_type ?? null,
      source_name: source?.source_name ?? reference.source_name ?? null,
      source_alias: source?.source_alias ?? reference.source_alias ?? null,
      candidate_source_ids: details.candidateSourceIds ??
        reference.candidate_source_ids ?? [],
      physical_columns: details.physicalColumns.map((column) => ({
        physical_table_name: column.physical_table_name ?? null,
        physical_column_name: column.column_name ??
          column.physical_column_name ?? null,
        field_path: column.field_path ?? null,
        ordinal_position: column.ordinal_position ?? null,
        data_type: column.data_type ?? null,
        is_nullable: column.is_nullable ?? null
      })),
      start_token_seq: reference.start_token_seq,
      end_token_seq: reference.end_token_seq
    };
  }

  #normalizeMetadataColumn(rawColumn, metadataIndex) {
    if (!rawColumn || typeof rawColumn !== "object") {
      throw new TypeError(
        `PhysicalColumnResolver: metadata row ${metadataIndex + 1} is invalid.`
      );
    }

    const physicalTableName = this.#derivePhysicalTableName(rawColumn);
    const columnName = this.#normalizeName(rawColumn.column_name);

    if (!physicalTableName || !columnName) {
      throw new TypeError(
        `PhysicalColumnResolver: metadata row ${metadataIndex + 1} requires ` +
        "table_name and column_name."
      );
    }

    return {
      physical_table_name: physicalTableName,
      project_id: this.#normalizeName(rawColumn.project_id),
      dataset_id: this.#normalizeName(rawColumn.dataset_id),
      table_name: this.#normalizeName(rawColumn.table_name),
      column_name: columnName,
      field_path: this.#normalizeName(rawColumn.field_path || columnName),
      ordinal_position: rawColumn.ordinal_position ?? null,
      data_type: rawColumn.data_type ?? null,
      is_nullable: rawColumn.is_nullable ?? null
    };
  }

  #derivePhysicalTableName(rawColumn) {
    const tableName = this.#normalizeName(rawColumn.table_name);
    const projectId = this.#normalizeName(rawColumn.project_id);
    const datasetId = this.#normalizeName(rawColumn.dataset_id);

    if (tableName?.includes(".")) {
      return tableName;
    }

    return [projectId, datasetId, tableName].filter(Boolean).join(".");
  }

  /**
   * SQL側が`dataset.table`や`table`だけで記述される可能性を考慮し、
   * 完全名だけでなく末尾2要素・末尾1要素も索引へ登録する。
   */
  #createTableLookupNames(column) {
    const parts = column.physical_table_name.split(".");
    const names = new Set([column.physical_table_name]);

    if (parts.length >= 2) {
      names.add(parts.slice(-2).join("."));
    }

    names.add(parts[parts.length - 1]);
    return [...names];
  }

  #addDiagnostics(result, context) {
    for (const reference of result.column_references) {
      if (reference.physical_resolution_status === "PHYSICAL_METADATA_NOT_FOUND") {
        context.addDiagnostic(
          "WARNING",
          "PHYSICAL_METADATA_NOT_FOUND",
          `Physical metadata was not found for source "${reference.source_name}".`,
          {
            source_id: reference.source_id,
            source_name: reference.source_name,
            column_reference_id: reference.column_reference_id,
            scope_id: reference.scope_id,
            start_token_seq: reference.start_token_seq,
            end_token_seq: reference.end_token_seq
          }
        );
      }

      if (reference.physical_resolution_status === "PHYSICAL_COLUMN_NOT_FOUND") {
        context.addDiagnostic(
          "ERROR",
          "PHYSICAL_COLUMN_NOT_FOUND",
          `Column "${reference.column_name}" was not found in the candidate ` +
          "physical table metadata.",
          {
            column_reference_id: reference.column_reference_id,
            column_name: reference.column_name,
            scope_id: reference.scope_id,
            start_token_seq: reference.start_token_seq,
            end_token_seq: reference.end_token_seq,
            candidate_source_ids: reference.candidate_source_ids
          }
        );
      }

      if (reference.physical_resolution_status === "PHYSICAL_AMBIGUOUS") {
        context.addDiagnostic(
          "ERROR",
          "PHYSICAL_COLUMN_AMBIGUOUS",
          `Column "${reference.column_name}" exists in multiple physical sources.`,
          {
            column_reference_id: reference.column_reference_id,
            column_name: reference.column_name,
            scope_id: reference.scope_id,
            start_token_seq: reference.start_token_seq,
            end_token_seq: reference.end_token_seq,
            candidate_source_ids: reference.candidate_source_ids
          }
        );
      }
    }

    for (const entry of this.missingWildcardMetadata.values()) {
      const displayName = entry.resolved_source_name || entry.source_name;

      context.addDiagnostic(
        "WARNING",
        "SOURCE_METADATA_NOT_COLLECTED",
        `Columns for source "${displayName}" are not in the collected ` +
        "metadata, so the wildcard (*) over it could not be expanded. Add its " +
        "project/dataset to the metadata collection (source_project_filters / " +
        "dataset include-exclude filters), then re-run.",
        {
          source_id: entry.source_id,
          source_name: entry.source_name,
          resolved_source_name: entry.resolved_source_name,
          scope_id: entry.scope_id,
          start_token_seq: entry.start_token_seq,
          end_token_seq: entry.end_token_seq
        }
      );
    }

    for (const generatedColumn of result.unpivot_generated_columns || []) {
      if (
        generatedColumn.physical_resolution_status ===
        "PHYSICAL_METADATA_NOT_FOUND"
      ) {
        context.addDiagnostic(
          "WARNING",
          "PHYSICAL_METADATA_NOT_FOUND",
          `Physical metadata was not found for UNPIVOT source ` +
          `"${generatedColumn.source_name}".`,
          {
            source_id: generatedColumn.source_id,
            source_name: generatedColumn.source_name,
            scope_id: generatedColumn.scope_id,
            output_column_name: generatedColumn.output_column_name
          }
        );
      }

      if (
        generatedColumn.physical_resolution_status ===
        "PHYSICAL_COLUMN_NOT_FOUND"
      ) {
        context.addDiagnostic(
          "ERROR",
          "PHYSICAL_COLUMN_NOT_FOUND",
          `UNPIVOT input column(s) ` +
          `"${generatedColumn.missing_column_names.join(", ")}" were not ` +
          "found in the candidate physical table metadata.",
          {
            source_id: generatedColumn.source_id,
            source_name: generatedColumn.source_name,
            scope_id: generatedColumn.scope_id,
            output_column_name: generatedColumn.output_column_name,
            column_names: generatedColumn.missing_column_names
          }
        );
      }
    }
  }

  #validateContext(context) {
    if (!context || context.query_ast?.node_type !== "QUERY") {
      throw new TypeError("PhysicalColumnResolver.resolve: invalid context.");
    }

    const requiredProperties = [
      "source_resolution",
      "column_resolution",
      "output_column_resolution"
    ];

    for (const propertyName of requiredProperties) {
      if (!context[propertyName]) {
        throw new TypeError(
          `PhysicalColumnResolver.resolve: ${propertyName} is not set.`
        );
      }
    }
  }

  #normalizeName(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return String(value).replace(/^`|`$/g, "").toUpperCase();
  }
}

// ============================================================
// SOURCE: src/lineage_resolver.js
// ============================================================
/**
 * Queryの出力列から、最終的な物理テーブル・物理カラムまで依存関係を辿る。
 *
 * LineageResolverの責務:
 *
 * - OutputColumnResolverが作成した出力列と、そのSELECT式内のColumn参照を結び付ける。
 * - 物理カラム参照はLineageの終点として登録する。
 * - CTE / FROMサブクエリの参照は、対象Query Scopeの出力列へ移動して再帰展開する。
 * - 複数段CTEでも、最終的な物理カラムへ到達するまで経路を保持する。
 * - 循環参照、未解決参照、曖昧参照を診断情報として残す。
 *
 * このResolverはSQLを再解析しない。
 * Parserと前段Resolverが作成した情報を結び付けることだけに集中する。
 */
class LineageResolver {
  constructor() {
    this.scopeById = new Map();
    this.sourceById = new Map();
    this.outputColumnsByScopeId = new Map();
    this.physicalReferenceByColumnReferenceId = new Map();
    this.referencesByOutputKey = new Map();
    this.referencesByScopeId = new Map();
    this.wildcardExpansionsByScopeAndName = new Map();
    this.unpivotGeneratedByOutputColumnId = new Map();
    this.nextLineageId = 1;
    this.context = null;
  }

  /**
   * ResolutionContextへ登録済みの結果を利用して、出力列Lineageを作成する。
   */
  resolve(context) {
    this.#validateContext(context);

    this.context = context;
    this.nextLineageId = 1;
    this.#buildIndexes(context);

    const outputLineages = [];

    for (const outputColumn of context.output_column_resolution.output_columns) {
      outputLineages.push(this.#resolveOutputColumn(outputColumn, [], new Set()));
    }

    /*
     * SELECT *はOutputColumnResolverでは元のWildcard項目を1件のまま保持し、
     * PhysicalColumnResolverのwildcard_expansionsで公開列一覧へ展開される。
     *
     * Lineageの利用者が通常のSELECT列と同じ形で参照できるよう、ここで
     * 展開列ごとの独立したOutput Lineageへ昇格する。元Wildcard Lineageも
     * SQL構造の監査情報として残す。
     */
    outputLineages.push(...this.#resolveExpandedWildcardOutputs(context));

    const rootOutputLineages = outputLineages.filter((lineage) => {
      return lineage.output_scope_id === context.source_resolution.root_scope_id;
    });

    const result = {
      node_type: "LINEAGE_RESOLUTION",
      root_scope_id: context.source_resolution.root_scope_id,
      output_lineages: outputLineages,
      root_output_lineages: rootOutputLineages,
      physical_dependencies: this.#flattenPhysicalDependencies(rootOutputLineages)
    };

    context.setLineageResolution(result);
    this.#addDiagnostics(result, context);

    return result;
  }

  #resolveExpandedWildcardOutputs(context) {
    const lineages = [];

    for (const expansion of context.physical_column_resolution.wildcard_expansions) {
      const outputName = this.#normalizeName(expansion.output_column_name);
      const lineagePath = [
        `SCOPE_${expansion.scope_id}.${outputName}`,
        `WILDCARD_EXPANSION:${expansion.select_item_seq}.${expansion.expanded_column_seq}`
      ];
      let dependencies = [];

      if (expansion.wildcard_replacement) {
        const replacement = expansion.wildcard_replacement;
        const references = (this.referencesByScopeId.get(expansion.scope_id) || []).filter((reference) => {
          return reference.clause_type === "SELECT" &&
            reference.select_item_seq === expansion.select_item_seq &&
            reference.start_token_seq >= replacement.expression_start_seq &&
            reference.end_token_seq <= replacement.expression_end_seq;
        });
        for (const reference of references) {
          dependencies.push(...this.#resolveReference(reference, lineagePath, new Set()));
        }
      } else if (expansion.physical_table_name && expansion.physical_column_name) {
        dependencies.push({
          dependency_type: "PHYSICAL_COLUMN",
          dependency_status: "RESOLVED",
          physical_table_name: expansion.physical_table_name,
          physical_column_name: expansion.physical_column_name,
          field_path: expansion.field_path,
          source_reference_name: expansion.wildcard_expression || "*",
          lineage_path: [
            ...lineagePath,
            `${expansion.physical_table_name}.${expansion.field_path || expansion.physical_column_name}`
          ]
        });
      } else {
        const source = this.sourceById.get(expansion.source_id);
        const childScopeId = source?.cte_query_scope_id ??
          source?.subquery_scope_id ??
          this.#findVisibleCteDefinition(source?.scope_id, source?.source_name)?.query_scope_id ??
          null;

        if (childScopeId !== null) {
          const childOutput = this.#findOutputColumn(childScopeId, outputName);

          if (childOutput) {
            const nestedLineage = this.#resolveOutputColumn(
              childOutput,
              lineagePath,
              new Set()
            );
            dependencies.push(...nestedLineage.dependencies.map((dependency) => ({
              ...dependency,
              via_wildcard_scope_id: expansion.scope_id,
              via_derived_scope_id: childScopeId,
              via_derived_output_column_name: childOutput.output_column_name
            })));
          } else {
            const syntheticReference = {
              reference_name: outputName,
              column_name: outputName,
              field_path: null,
              scope_id: expansion.scope_id
            };
            dependencies.push(...this.#resolveDerivedWildcardColumn(
              childScopeId,
              outputName,
              syntheticReference,
              lineagePath,
              new Set()
            ));
          }
        }
      }

      dependencies = this.#deduplicateDependencies(dependencies);

      lineages.push({
        lineage_id: this.nextLineageId++,
        output_column_id: `WILDCARD_${expansion.expanded_output_column_id}`,
        output_scope_id: expansion.scope_id,
        output_column_seq: expansion.select_item_seq,
        expanded_column_seq: expansion.expanded_column_seq,
        output_column_name: outputName,
        expression_text: expansion.wildcard_expression || "*",
        lineage_status: dependencies.length === 0
          ? "UNRESOLVED"
          : dependencies.some((dependency) => dependency.dependency_status !== "RESOLVED")
            ? "PARTIALLY_RESOLVED"
            : "RESOLVED",
        dependencies,
        lineage_path: lineagePath,
        start_token_seq: null,
        end_token_seq: null,
        expanded_from_wildcard: true,
        source_output_column_id: expansion.source_output_column_id
      });
    }

    return lineages;
  }

  #buildIndexes(context) {
    this.scopeById = new Map();
    this.sourceById = new Map();
    this.outputColumnsByScopeId = new Map();
    this.physicalReferenceByColumnReferenceId = new Map();
    this.referencesByOutputKey = new Map();
    this.referencesByScopeId = new Map();
    this.wildcardExpansionsByScopeAndName = new Map();
    this.unpivotGeneratedByOutputColumnId = new Map();
    this.recursiveScopeIds = new Set();

    for (const scope of context.source_resolution.scopes) {
      this.scopeById.set(scope.scope_id, scope);

      for (const source of scope.sources) {
        this.sourceById.set(source.source_id, source);
      }

      /*
       * WITH RECURSIVE の CTE 本文scopeを記録する。再帰項が自分自身を参照して
       * 再入した場合、それは正当な再帰なので false CYCLE_DETECTED にしない。
       */
      for (const cteDefinition of scope.cte_definitions || []) {
        if (cteDefinition.recursive === true &&
            cteDefinition.query_scope_id !== null &&
            cteDefinition.query_scope_id !== undefined) {
          this.recursiveScopeIds.add(cteDefinition.query_scope_id);
        }
      }
    }

    for (const scope of context.output_column_resolution.scopes) {
      this.outputColumnsByScopeId.set(scope.scope_id, scope.output_columns);
    }

    for (const physicalReference of context.physical_column_resolution.column_references) {
      this.physicalReferenceByColumnReferenceId.set(
        physicalReference.column_reference_id,
        physicalReference
      );
    }

    for (const expansion of context.physical_column_resolution.wildcard_expansions) {
      const key = this.#createWildcardExpansionKey(
        expansion.scope_id,
        expansion.output_column_name
      );

      if (!this.wildcardExpansionsByScopeAndName.has(key)) {
        this.wildcardExpansionsByScopeAndName.set(key, []);
      }

      this.wildcardExpansionsByScopeAndName.get(key).push(expansion);
    }

    for (
      const generatedColumn of
      context.physical_column_resolution.unpivot_generated_columns || []
    ) {
      this.unpivotGeneratedByOutputColumnId.set(
        generatedColumn.output_column_id,
        generatedColumn
      );
    }

    /*
     * SELECT項目ごとにColumn参照をまとめる。
     * OutputColumnのoutput_column_seqとColumnResolverのselect_item_seqが対応する。
     */
    for (const reference of context.column_resolution.column_references) {
      if (!this.referencesByScopeId.has(reference.scope_id)) {
        this.referencesByScopeId.set(reference.scope_id, []);
      }

      this.referencesByScopeId.get(reference.scope_id).push(reference);

      if (reference.clause_type !== "SELECT" || reference.select_item_seq === null) {
        continue;
      }

      const key = this.#createOutputKey(reference.scope_id, reference.select_item_seq);

      if (!this.referencesByOutputKey.has(key)) {
        this.referencesByOutputKey.set(key, []);
      }

      this.referencesByOutputKey.get(key).push(reference);
    }
  }

  #resolveOutputColumn(outputColumn, parentPath, visitingOutputIds) {
    const pathEntry = this.#createOutputPathEntry(outputColumn);
    const lineagePath = [...parentPath, pathEntry];

    if (visitingOutputIds.has(outputColumn.output_column_id)) {
      /*
       * WITH RECURSIVE の再帰項が同一CTEの出力へ再入するのは正当な再帰であり、
       * エラーではない。再帰項は新しい物理ソースを足さず、系統はベース項が
       * 供給するため、ここは依存なし(NO_COLUMN_DEPENDENCY)で終端する。
       * 非再帰スコープでの再入は従来どおり CYCLE_DETECTED とする。
       */
      const isRecursiveSelfReference =
        this.recursiveScopeIds.has(outputColumn.scope_id);

      return {
        lineage_id: this.nextLineageId++,
        output_column_id: outputColumn.output_column_id,
        output_scope_id: outputColumn.scope_id,
        output_column_name: outputColumn.output_column_name,
        lineage_status: isRecursiveSelfReference
          ? "NO_COLUMN_DEPENDENCY"
          : "CYCLE_DETECTED",
        dependencies: [],
        lineage_path: lineagePath
      };
    }

    const nextVisiting = new Set(visitingOutputIds);
    nextVisiting.add(outputColumn.output_column_id);

    if (outputColumn.output_status === "WILDCARD_PENDING") {
      return this.#resolveWildcardOutput(outputColumn, lineagePath);
    }

    if (outputColumn.output_status === "PIVOT_GENERATED") {
      return this.#resolvePivotGeneratedOutput(
        outputColumn,
        lineagePath,
        nextVisiting
      );
    }

    if (outputColumn.output_status === "UNPIVOT_GENERATED") {
      return this.#resolveUnpivotGeneratedOutput(
        outputColumn,
        lineagePath,
        nextVisiting
      );
    }

    const key = this.#createOutputKey(
      outputColumn.scope_id,
      outputColumn.output_column_seq
    );
    const references = this.referencesByOutputKey.get(key) || [];
    const dependencies = [];

    for (const reference of references) {
      dependencies.push(
        ...this.#resolveReference(reference, lineagePath, nextVisiting)
      );
    }

    /*
     * ARRAY(SELECT ... FROM UNNEST(array_column)) の内側Queryは、
     * ColumnResolver上では独立したEXPRESSION_SUBQUERYスコープになる。
     * そのままでは親SELECT項目の参照一覧へ依存が戻らないため、
     * UNNEST元の配列列を親スコープで再解決し、配列を生成した物理列へ伝播する。
     */
    dependencies.push(
      ...this.#resolveExpressionSubqueryDependencies(
        outputColumn,
        lineagePath,
        nextVisiting
      )
    );

    /*
     * UNION / UNION ALL / UNION DISTINCTの公開列名は先頭branchから継承するが、
     * リネージは同じ列位置にある全branchの依存を持つ必要がある。
     * SourceResolverが保持するset_operationsの子scopeを列位置で対応付け、
     * 各branchのOutputColumnを再帰解決して依存集合へ統合する。
     */
    dependencies.push(
      ...this.#resolveSetOperationDependencies(
        outputColumn,
        lineagePath,
        nextVisiting
      )
    );

    const uniqueDependencies = this.#deduplicateDependencies(dependencies);

    return {
      lineage_id: this.nextLineageId++,
      output_column_id: outputColumn.output_column_id,
      output_scope_id: outputColumn.scope_id,
      output_column_seq: outputColumn.output_column_seq,
      output_column_name: outputColumn.output_column_name,
      expression_text: outputColumn.expression_text,
      lineage_status: this.#determineLineageStatus(references, uniqueDependencies),
      dependencies: uniqueDependencies,
      lineage_path: lineagePath,
      start_token_seq: outputColumn.start_token_seq,
      end_token_seq: outputColumn.end_token_seq
    };
  }


  #resolveSetOperationDependencies(
    outputColumn,
    lineagePath,
    visitingOutputIds
  ) {
    const scope = this.scopeById.get(outputColumn.scope_id);
    const setOperations = Array.isArray(scope?.set_operations)
      ? scope.set_operations
      : [];

    if (setOperations.length === 0) {
      return [];
    }

    const dependencies = [];

    for (const setOperation of setOperations) {
      const branchOutputs = this.outputColumnsByScopeId.get(
        setOperation.query_scope_id
      ) || [];
      const branchOutput = branchOutputs.find((candidate) => {
        return candidate.output_column_seq === outputColumn.output_column_seq;
      });

      if (!branchOutput) {
        continue;
      }

      const branchLineage = this.#resolveOutputColumn(
        branchOutput,
        lineagePath,
        visitingOutputIds
      );

      dependencies.push(...branchLineage.dependencies.map((dependency) => ({
        ...dependency,
        via_set_operation: setOperation.operator,
        via_set_operation_modifier: setOperation.modifier,
        via_set_operation_scope_id: setOperation.query_scope_id,
        via_set_operation_column_seq: outputColumn.output_column_seq
      })));
    }

    return this.#deduplicateDependencies(dependencies);
  }


  #resolveExpressionSubqueryDependencies(
    outputColumn,
    lineagePath,
    visitingOutputIds
  ) {
    const subqueryNodes = [];
    this.#collectExpressionSubqueryNodes(outputColumn.expression, subqueryNodes);

    if (subqueryNodes.length === 0) {
      return [];
    }

    const dependencies = [];

    for (const subqueryNode of subqueryNodes) {
      const queryAst = subqueryNode.query_ast;
      const childScope = Array.from(this.scopeById.values()).find((scope) => {
        return scope.query_start_token_seq === queryAst.start_token_seq &&
          scope.query_end_token_seq === queryAst.end_token_seq;
      });

      if (!childScope) {
        continue;
      }

      /*
       * Scalar Subqueryは子Queryの先頭出力列を1つの値として親式へ返す。
       * 子スコープ側のOutputColumnは既に通常のLineageとして解決できるため、
       * その依存関係を親SELECT項目へ伝播する。
       *
       * ARRAY Subqueryは複数行を配列化するため、ここでは従来どおり
       * UNNEST元コレクションを経由する専用処理へ任せる。
       */
      if (subqueryNode.node_type === NodeType.SUBQUERY_EXPRESSION) {
        const childOutputs = this.outputColumnsByScopeId.get(childScope.scope_id) || [];
        const scalarOutput = childOutputs.find((candidate) => {
          return candidate.output_column_seq === 1;
        });

        if (scalarOutput) {
          const scalarLineage = this.#resolveOutputColumn(
            scalarOutput,
            lineagePath,
            visitingOutputIds
          );

          dependencies.push(...scalarLineage.dependencies.map((dependency) => ({
            ...dependency,
            via_expression_subquery_scope_id: childScope.scope_id,
            via_scalar_subquery_output_column_name:
              scalarOutput.output_column_name ?? null
          })));
        }

        dependencies.push(
          ...this.#resolveCorrelatedSubqueryDependencies(
            childScope,
            lineagePath,
            visitingOutputIds
          )
        );
      }

      const unnestSources = (childScope.sources || []).filter((source) => {
        return source.source_type === "UNNEST" && source.expression;
      });

      for (const unnestSource of unnestSources) {
        const collectionName = this.#extractSimpleIdentifierName(
          unnestSource.expression
        );

        if (!collectionName) {
          continue;
        }

        const parentScope = this.scopeById.get(childScope.parent_scope_id);
        const candidates = [];

        for (const source of parentScope?.sources || []) {
          const sourceScopeId = source.cte_query_scope_id ??
            source.subquery_scope_id ??
            this.#findVisibleCteDefinition(
              source.scope_id,
              source.source_name
            )?.query_scope_id ?? null;

          if (sourceScopeId === null) {
            continue;
          }

          const targetOutput = this.#findOutputColumn(
            sourceScopeId,
            collectionName
          );

          if (targetOutput) {
            candidates.push(targetOutput);
          }
        }

        if (candidates.length !== 1) {
          continue;
        }

        const nestedLineage = this.#resolveOutputColumn(
          candidates[0],
          lineagePath,
          visitingOutputIds
        );

        dependencies.push(...nestedLineage.dependencies.map((dependency) => ({
          ...dependency,
          via_expression_subquery_scope_id: childScope.scope_id,
          via_unnest_collection_name: collectionName
        })));
      }
    }

    return this.#deduplicateDependencies(dependencies);
  }

  #resolveCorrelatedSubqueryDependencies(
    childScope,
    lineagePath,
    visitingOutputIds
  ) {
    const references = this.referencesByScopeId.get(childScope.scope_id) || [];
    const predicateReferences = references.filter((reference) => {
      return reference.clause_type !== "SELECT";
    });

    /*
     * 相関Subqueryでは、子QueryのWHERE / JOIN / HAVING等に
     * 親QueryのSourceを参照するColumnReferenceが含まれる。
     * 外側参照が1つもなければ通常のScalar Subqueryなので、
     * 条件列を出力リネージへ追加しない。
     */
    const hasOuterReference = predicateReferences.some((reference) => {
      const source = this.sourceById.get(reference.source_id);

      if (!source) {
        return false;
      }

      return this.#isAncestorScope(source.scope_id, childScope.scope_id);
    });

    if (!hasOuterReference) {
      return [];
    }

    const dependencies = [];

    /*
     * 相関条件は内側列と外側列の双方で結果行を決定する。
     * そのため外側参照だけでなく、同じ子Scopeの条件句に現れる
     * 全ColumnReferenceを親SELECT項目の依存関係へ統合する。
     */
    for (const reference of predicateReferences) {
      dependencies.push(
        ...this.#resolveReference(reference, lineagePath, visitingOutputIds)
          .map((dependency) => ({
            ...dependency,
            via_correlated_subquery_scope_id: childScope.scope_id,
            via_correlated_clause_type: reference.clause_type
          }))
      );
    }

    /*
     * EXISTS / Scalar Subqueryの条件内に、さらに相関Subqueryが入れ子に
     * なる場合がある。最内層の条件列も外側SELECT値の成立条件となるため、
     * 直接の子Scopeを再帰的に解決して依存関係へ伝播する。
     */
    const nestedScopes = Array.from(this.scopeById.values()).filter((scope) => {
      return scope.parent_scope_id === childScope.scope_id;
    });

    for (const nestedScope of nestedScopes) {
      dependencies.push(
        ...this.#resolveCorrelatedSubqueryDependencies(
          nestedScope,
          lineagePath,
          visitingOutputIds
        ).map((dependency) => ({
          ...dependency,
          via_nested_correlated_subquery_scope_id: nestedScope.scope_id
        }))
      );
    }

    return this.#deduplicateDependencies(dependencies);
  }

  #isAncestorScope(ancestorScopeId, childScopeId) {
    if (ancestorScopeId === null || ancestorScopeId === undefined) {
      return false;
    }

    let currentScope = this.scopeById.get(childScopeId);

    while (currentScope?.parent_scope_id !== null &&
           currentScope?.parent_scope_id !== undefined) {
      if (currentScope.parent_scope_id === ancestorScopeId) {
        return true;
      }

      currentScope = this.scopeById.get(currentScope.parent_scope_id);
    }

    return false;
  }

  #collectExpressionSubqueryNodes(node, result) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.#collectExpressionSubqueryNodes(item, result);
      }
      return;
    }

    if (
      (node.node_type === NodeType.SUBQUERY_EXPRESSION ||
       node.node_type === NodeType.ARRAY_SUBQUERY_EXPRESSION) &&
      node.query_ast?.node_type === "QUERY"
    ) {
      result.push(node);
      return;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        this.#collectExpressionSubqueryNodes(value, result);
      }
    }
  }

  #extractSimpleIdentifierName(expression) {
    if (expression?.node_type !== NodeType.IDENTIFIER_EXPRESSION) {
      return null;
    }

    const parts = Array.isArray(expression.parts)
      ? expression.parts.filter((part) => part !== ".")
      : [];

    const lastPart = parts.at(-1);
    const rawName = parts.length > 0
      ? typeof lastPart === "string"
        ? lastPart
        : lastPart?.normalized_token ?? lastPart?.token
      : expression.name;

    return rawName ? this.#normalizeName(rawName) : null;
  }


  #resolvePivotGeneratedOutput(outputColumn, lineagePath, visitingOutputIds) {
    const inputScopeId = outputColumn.pivot_input_scope_id;
    const targetOutput = this.#findOutputColumn(
      inputScopeId,
      outputColumn.pivot_value_column_name
    );

    if (!targetOutput) {
      return {
        lineage_id: this.nextLineageId++,
        output_column_id: outputColumn.output_column_id,
        output_scope_id: outputColumn.scope_id,
        output_column_seq: outputColumn.output_column_seq,
        output_column_name: outputColumn.output_column_name,
        expression_text: outputColumn.expression_text,
        lineage_status: "UNRESOLVED",
        dependencies: [],
        lineage_path: lineagePath,
        start_token_seq: outputColumn.start_token_seq,
        end_token_seq: outputColumn.end_token_seq
      };
    }

    const nestedLineage = this.#resolveOutputColumn(
      targetOutput,
      lineagePath,
      visitingOutputIds
    );

    return {
      lineage_id: this.nextLineageId++,
      output_column_id: outputColumn.output_column_id,
      output_scope_id: outputColumn.scope_id,
      output_column_seq: outputColumn.output_column_seq,
      output_column_name: outputColumn.output_column_name,
      expression_text: outputColumn.expression_text,
      lineage_status: nestedLineage.lineage_status,
      dependencies: nestedLineage.dependencies.map((dependency) => ({
        ...dependency,
        via_pivot_scope_id: outputColumn.scope_id,
        via_pivot_output_column_name: outputColumn.output_column_name,
        via_pivot_value_column_name: outputColumn.pivot_value_column_name
      })),
      lineage_path: lineagePath,
      start_token_seq: outputColumn.start_token_seq,
      end_token_seq: outputColumn.end_token_seq
    };
  }

  #resolveUnpivotGeneratedOutput(
    outputColumn,
    lineagePath,
    visitingOutputIds
  ) {
    const generatedColumn = this.unpivotGeneratedByOutputColumnId.get(
      outputColumn.output_column_id
    );
    const dependencies = [];

    if (outputColumn.unpivot_input_scope_id !== null) {
      for (const inputColumnName of outputColumn.unpivot_input_column_names || []) {
        const targetOutput = this.#findOutputColumn(
          outputColumn.unpivot_input_scope_id,
          inputColumnName
        );

        if (!targetOutput) {
          dependencies.push({
            dependency_type: "UNRESOLVED_COLUMN",
            dependency_status: "DERIVED_OUTPUT_COLUMN_NOT_FOUND",
            source_reference_name: inputColumnName,
            scope_id: outputColumn.unpivot_input_scope_id,
            column_name: inputColumnName,
            lineage_path: [
              ...lineagePath,
              `UNRESOLVED:${inputColumnName}`
            ]
          });
          continue;
        }

        const nestedLineage = this.#resolveOutputColumn(
          targetOutput,
          lineagePath,
          visitingOutputIds
        );
        dependencies.push(...nestedLineage.dependencies.map((dependency) => ({
          ...dependency,
          via_unpivot_scope_id: outputColumn.scope_id,
          via_unpivot_output_column_name: outputColumn.output_column_name,
          via_unpivot_generated_column_name:
            outputColumn.unpivot_generated_column_name,
          via_unpivot_input_column_name: inputColumnName
        })));
      }
    } else if (generatedColumn) {
      dependencies.push(...generatedColumn.physical_columns.map((column) => ({
        dependency_type: "PHYSICAL_COLUMN",
        dependency_status: "RESOLVED",
        physical_table_name: column.physical_table_name,
        physical_column_name: column.physical_column_name,
        field_path: column.field_path,
        source_reference_name:
          outputColumn.unpivot_generated_column_name,
        via_unpivot_scope_id: outputColumn.scope_id,
        via_unpivot_output_column_name: outputColumn.output_column_name,
        via_unpivot_generated_column_name:
          outputColumn.unpivot_generated_column_name,
        lineage_path: [
          ...lineagePath,
          `${column.physical_table_name}.` +
            `${column.field_path || column.physical_column_name}`
        ]
      })));
    }

    const uniqueDependencies = this.#deduplicateDependencies(dependencies);
    const hasUnresolved = uniqueDependencies.some((dependency) => {
      return dependency.dependency_status !== "RESOLVED";
    });

    return {
      lineage_id: this.nextLineageId++,
      output_column_id: outputColumn.output_column_id,
      output_scope_id: outputColumn.scope_id,
      output_column_seq: outputColumn.output_column_seq,
      output_column_name: outputColumn.output_column_name,
      expression_text: outputColumn.expression_text,
      lineage_status: uniqueDependencies.length === 0
        ? "UNRESOLVED"
        : hasUnresolved
          ? "PARTIALLY_RESOLVED"
          : "RESOLVED",
      dependencies: uniqueDependencies,
      lineage_path: lineagePath,
      start_token_seq: outputColumn.start_token_seq,
      end_token_seq: outputColumn.end_token_seq
    };
  }

  #resolveReference(reference, parentPath, visitingOutputIds) {
    const physicalReference = this.physicalReferenceByColumnReferenceId.get(
      reference.column_reference_id
    );

    if (!physicalReference) {
      return [this.#createUnresolvedDependency(reference, parentPath, "PHYSICAL_REFERENCE_MISSING")];
    }

    if (physicalReference.physical_resolution_status === "PHYSICAL_RESOLVED") {
      return physicalReference.physical_columns.map((column) => {
        return {
          dependency_type: "PHYSICAL_COLUMN",
          dependency_status: "RESOLVED",
          physical_table_name: column.physical_table_name,
          physical_column_name: column.physical_column_name,
          field_path: column.field_path,
          source_reference_name: reference.reference_name,
          lineage_path: [
            ...parentPath,
            `${column.physical_table_name}.${column.field_path || column.physical_column_name}`
          ]
        };
      });
    }

    /*
     * 「解決済みだが物理カラム依存を持たない」参照は、派生スコープ探索より先に
     * 確定させる。定数(STRUCTリテラル配列のUNNESTフィールド)、UNNESTの
     * WITH OFFSET列、疑似列(_TABLE_SUFFIX等)が該当する。上流の物理カラムが無い
     * ので、未解決ではなく定数依存(RESOLVED)として扱い、物理エッジは持たない。
     */
    const noPhysicalDependencyStatuses = new Set([
      "PSEUDO_COLUMN_RESOLVED",
      "UNNEST_OFFSET",
      "UNNEST_CONSTANT"
    ]);

    if (noPhysicalDependencyStatuses.has(
      physicalReference.physical_resolution_status
    )) {
      return [{
        dependency_type: "CONSTANT",
        dependency_status: "RESOLVED",
        source_reference_name: reference.reference_name,
        lineage_path: [
          ...parentPath,
          `CONSTANT:${this.#normalizeName(reference.reference_name)}`
        ]
      }];
    }

    /*
     * PIVOTと同じQuery ScopeのSELECT項目から、PIVOT生成列を明示参照する
     * ケースを先に解決する。
     *
     * 例:
     *   SELECT COALESCE(sales_pc, 0)
     *   FROM source
     *   PIVOT(SUM(amount) AS sales FOR category IN ('PC' AS pc))
     *
     * ColumnResolver実行時点ではsales_pcがSELECTリスト由来の列ではないため、
     * source_idを確定できない。OutputColumnResolverが追加した
     * PIVOT_GENERATED列へ同一scope内で接続する。
     */
    const localPivotOutput = (
      this.outputColumnsByScopeId.get(reference.scope_id) || []
    ).find((outputColumn) => {
      return outputColumn.output_status === "PIVOT_GENERATED" &&
        outputColumn.output_column_name ===
          this.#normalizeName(reference.column_name);
    });

    if (localPivotOutput) {
      const pivotLineage = this.#resolveOutputColumn(
        localPivotOutput,
        parentPath,
        visitingOutputIds
      );

      return pivotLineage.dependencies.map((dependency) => ({
        ...dependency,
        via_derived_scope_id: reference.scope_id,
        via_derived_output_column_name: localPivotOutput.output_column_name
      }));
    }

    const localUnpivotOutput = (
      this.outputColumnsByScopeId.get(reference.scope_id) || []
    ).find((outputColumn) => {
      return outputColumn.output_status === "UNPIVOT_GENERATED" &&
        this.#normalizeName(outputColumn.unpivot_generated_column_name) ===
          this.#normalizeName(reference.column_name);
    });

    if (localUnpivotOutput) {
      const unpivotLineage = this.#resolveOutputColumn(
        localUnpivotOutput,
        parentPath,
        visitingOutputIds
      );

      return unpivotLineage.dependencies.map((dependency) => ({
        ...dependency,
        via_derived_scope_id: reference.scope_id,
        via_derived_output_column_name:
          localUnpivotOutput.output_column_name
      }));
    }

    let derivedScopeId = this.#findDerivedSourceScope(reference, physicalReference);

    /*
     * 派生Source自身の公開scopeが、それを参照している現在scopeと一致することは
     * 非再帰クエリでは有り得ない。一致した場合はソース解決の取り違えなので、
     * 自己循環(false CYCLE_DETECTED)を避けるため無効化して下の補正へ回す。
     * これは特に同一CTEの自己JOIN(table_a x LEFT JOIN table_a y)で発生する。
     */
    if (derivedScopeId === reference.scope_id) {
      derivedScopeId = null;
    }

    /*
     * 派生scopeが決まらない/取り違えた場合の補正。
     * 1) 参照が修飾されているなら、その別名を持つローカル派生Sourceの公開scopeを使う
     *    (自己JOIN: y.col は y 別名の table_a scope へ)。
     * 2) 修飾が無い/一致しない場合は、ローカル派生Sourceが1つだけ、または全て同じ
     *    子scope(=同一CTEの自己JOIN)を指すときにその子scopeを使う。PIVOT生成列を
     *    外側で列挙するケースもここで解決する。
     */
    if (derivedScopeId === null) {
      const currentScope = this.scopeById.get(reference.scope_id);
      const localDerivedSources = (currentScope?.sources || []).filter((source) => {
        const childScopeId = source.cte_query_scope_id ?? source.subquery_scope_id ?? null;
        return childScopeId !== null && childScopeId !== reference.scope_id;
      });

      let chosenSource = null;

      if (reference.qualifier) {
        const normalizedQualifier = this.#normalizeName(reference.qualifier);
        chosenSource = localDerivedSources.find((source) => {
          return this.#normalizeName(source.source_alias) === normalizedQualifier;
        }) || null;
      }

      if (!chosenSource) {
        const distinctChildScopes = new Set(localDerivedSources.map((source) => {
          return source.cte_query_scope_id ?? source.subquery_scope_id;
        }));

        if (localDerivedSources.length === 1 || distinctChildScopes.size === 1) {
          chosenSource = localDerivedSources[0];
        }
      }

      if (chosenSource) {
        derivedScopeId = chosenSource.cte_query_scope_id ??
          chosenSource.subquery_scope_id ?? null;
      }
    }

    if (derivedScopeId !== null) {
      const targetOutput = this.#findOutputColumn(
        derivedScopeId,
        reference.column_name
      );

      if (!targetOutput) {
        const wildcardDependencies = this.#resolveDerivedWildcardColumn(
          derivedScopeId,
          reference.column_name,
          reference,
          parentPath,
          visitingOutputIds
        );

        if (wildcardDependencies.length > 0) {
          return wildcardDependencies;
        }

        return [this.#createUnresolvedDependency(
          reference,
          parentPath,
          "DERIVED_OUTPUT_COLUMN_NOT_FOUND"
        )];
      }

      let effectiveTargetOutput = targetOutput;
      if (reference.field_path) {
        const fieldTarget = this.#findStructFieldOutput(targetOutput, reference.field_path);
        if (fieldTarget) effectiveTargetOutput = fieldTarget;
      }

      const nestedLineage = this.#resolveOutputColumn(
        effectiveTargetOutput,
        parentPath,
        visitingOutputIds
      );

      if (nestedLineage.lineage_status === "CYCLE_DETECTED") {
        return [{
          dependency_type: "DERIVED_COLUMN",
          dependency_status: "CYCLE_DETECTED",
          source_reference_name: reference.reference_name,
          derived_scope_id: derivedScopeId,
          derived_output_column_name: effectiveTargetOutput.output_column_name,
          lineage_path: nestedLineage.lineage_path
        }];
      }

      if (nestedLineage.lineage_status === "NO_COLUMN_DEPENDENCY") {
        return [this.#createNoColumnDependency(
          reference,
          parentPath,
          derivedScopeId,
          effectiveTargetOutput.output_column_name
        )];
      }

      return nestedLineage.dependencies.map((dependency) => {
        return {
          ...dependency,
          dependency_type: dependency.dependency_type === "PHYSICAL_COLUMN"
            ? "PHYSICAL_COLUMN"
            : dependency.dependency_type,
          via_derived_scope_id: derivedScopeId,
          via_derived_output_column_name: effectiveTargetOutput.output_column_name
        };
      });
    }

    return [this.#createUnresolvedDependency(
      reference,
      parentPath,
      physicalReference.physical_resolution_status
    )];
  }

  /**
   * CTE / サブクエリ参照が指すQuery Scopeを返す。
   *
   * 既存SourceResolverでは、CTE本文から先に定義された兄弟CTEを参照した場合、
   * 物理テーブル候補として保持されることがある。そのためsource_typeだけでなく、
   * 親ScopeのCTE定義も検索して補正する。
   */
  #findStructFieldOutput(outputColumn, fieldPath) {
    const expression = outputColumn?.expression;
    if (!expression || expression.node_type !== NodeType.SUBQUERY_EXPRESSION || !expression.query_ast) {
      return null;
    }

    const childScope = Array.from(this.scopeById.values()).find((scope) => {
      return scope.query_start_token_seq === expression.query_ast.start_token_seq &&
        scope.query_end_token_seq === expression.query_ast.end_token_seq;
    });
    if (!childScope) return null;

    const fieldName = this.#normalizeName(String(fieldPath).split(".")[0]);
    return this.#findOutputColumn(childScope.scope_id, fieldName);
  }

  #findDerivedSourceScope(reference, physicalReference) {
    const source = this.sourceById.get(physicalReference.source_id || reference.source_id);

    if (!source) {
      return null;
    }

    if (source.source_type === "CTE" && source.cte_query_scope_id !== null) {
      return source.cte_query_scope_id;
    }

    if (source.source_type === "SUBQUERY" && source.subquery_scope_id !== null) {
      return source.subquery_scope_id;
    }

    const cteDefinition = this.#findVisibleCteDefinition(
      source.scope_id,
      source.source_name
    );

    return cteDefinition ? cteDefinition.query_scope_id : null;
  }

  #findVisibleCteDefinition(scopeId, sourceName) {
    const normalizedSourceName = this.#normalizeName(sourceName);
    let currentScope = this.scopeById.get(scopeId);

    while (currentScope) {
      const definition = currentScope.cte_definitions.find((cte) => {
        return cte.cte_name === normalizedSourceName;
      });

      if (definition) {
        return definition;
      }

      currentScope = currentScope.parent_scope_id === null
        ? null
        : this.scopeById.get(currentScope.parent_scope_id);
    }

    return null;
  }

  #findOutputColumn(scopeId, columnName) {
    const outputColumns = this.outputColumnsByScopeId.get(scopeId) || [];
    const normalizedColumnName = this.#normalizeName(columnName);

    return outputColumns.find((outputColumn) => {
      return this.#normalizeName(outputColumn.output_column_name) === normalizedColumnName;
    }) || null;
  }

  #resolveWildcardOutput(outputColumn, parentPath) {
    const expansions = this.context.physical_column_resolution.wildcard_expansions.filter(
      (item) => item.scope_id === outputColumn.scope_id &&
        item.select_item_seq === outputColumn.output_column_seq
    );

    const dependencies = expansions.map((item) => {
      return {
        dependency_type: "PHYSICAL_COLUMN",
        dependency_status: "RESOLVED",
        physical_table_name: item.physical_table_name,
        physical_column_name: item.physical_column_name,
        field_path: item.field_path,
        source_reference_name: outputColumn.wildcard_qualifier || "*",
        lineage_path: [
          ...parentPath,
          `${item.physical_table_name}.${item.field_path || item.physical_column_name}`
        ]
      };
    });

    return {
      lineage_id: this.nextLineageId++,
      output_column_id: outputColumn.output_column_id,
      output_scope_id: outputColumn.scope_id,
      output_column_seq: outputColumn.output_column_seq,
      output_column_name: outputColumn.output_column_name,
      expression_text: outputColumn.expression_text,
      lineage_status: dependencies.length > 0 ? "RESOLVED" : "UNRESOLVED",
      dependencies,
      lineage_path: parentPath,
      start_token_seq: outputColumn.start_token_seq,
      end_token_seq: outputColumn.end_token_seq
    };
  }

  #resolveDerivedWildcardColumn(
    derivedScopeId,
    columnName,
    reference,
    parentPath,
    visitingOutputIds
  ) {
    const key = this.#createWildcardExpansionKey(derivedScopeId, columnName);
    const expansions = this.wildcardExpansionsByScopeAndName.get(key) || [];
    const dependencies = [];

    for (const expansion of expansions) {
      if (expansion.physical_table_name && expansion.physical_column_name) {
        dependencies.push({
          dependency_type: "PHYSICAL_COLUMN",
          dependency_status: "RESOLVED",
          physical_table_name: expansion.physical_table_name,
          physical_column_name: expansion.physical_column_name,
          field_path: expansion.field_path,
          source_reference_name: reference.reference_name,
          lineage_path: [
            ...parentPath,
            `${expansion.physical_table_name}.${expansion.field_path || expansion.physical_column_name}`
          ]
        });
        continue;
      }

      const source = this.sourceById.get(expansion.source_id);
      const childScopeId = source?.cte_query_scope_id || source?.subquery_scope_id ||
        this.#findVisibleCteDefinition(source?.scope_id, source?.source_name)?.query_scope_id || null;

      if (childScopeId === null) {
        continue;
      }

      const childOutput = this.#findOutputColumn(childScopeId, columnName);

      if (childOutput) {
        let effectiveChildOutput = childOutput;

        /*
         * SELECT *を介してSTRUCT列が継承された場合もfield_pathを失わない。
         * 例: pure_struct_txns.* -> structured_txns.txn_info.detail_amount
         */
        if (reference.field_path) {
          const fieldOutput = this.#findStructFieldOutput(
            childOutput,
            reference.field_path
          );

          if (fieldOutput) {
            effectiveChildOutput = fieldOutput;
          }
        }

        const nestedLineage = this.#resolveOutputColumn(
          effectiveChildOutput,
          parentPath,
          visitingOutputIds
        );
        if (nestedLineage.lineage_status === "NO_COLUMN_DEPENDENCY") {
          dependencies.push(this.#createNoColumnDependency(
            reference,
            parentPath,
            childScopeId,
            effectiveChildOutput.output_column_name,
            derivedScopeId
          ));
          continue;
        }

        dependencies.push(...nestedLineage.dependencies.map((dependency) => ({
          ...dependency,
          via_derived_scope_id: childScopeId,
          via_derived_output_column_name: effectiveChildOutput.output_column_name,
          via_wildcard_scope_id: derivedScopeId
        })));
        continue;
      }

      dependencies.push(...this.#resolveDerivedWildcardColumn(
        childScopeId,
        columnName,
        reference,
        parentPath,
        visitingOutputIds
      ));
    }

    return this.#deduplicateDependencies(dependencies);
  }

  #createWildcardExpansionKey(scopeId, columnName) {
    return `${scopeId}:${this.#normalizeName(columnName)}`;
  }

  #createNoColumnDependency(
    reference,
    parentPath,
    derivedScopeId,
    outputColumnName,
    wildcardScopeId = null
  ) {
    const dependency = {
      dependency_type: "DERIVED_NO_COLUMN_DEPENDENCY",
      dependency_status: "RESOLVED",
      source_reference_name: reference.reference_name,
      derived_scope_id: derivedScopeId,
      derived_output_column_name: outputColumnName,
      lineage_path: [
        ...parentPath,
        `SCOPE_${derivedScopeId}.${outputColumnName}:NO_COLUMN_DEPENDENCY`
      ]
    };

    if (wildcardScopeId !== null) {
      dependency.via_wildcard_scope_id = wildcardScopeId;
    }

    return dependency;
  }

  #createUnresolvedDependency(reference, parentPath, status) {
    return {
      dependency_type: "UNRESOLVED_COLUMN",
      dependency_status: status,
      source_reference_name: reference.reference_name,
      scope_id: reference.scope_id,
      column_name: reference.column_name,
      lineage_path: [...parentPath, `UNRESOLVED:${reference.reference_name}`]
    };
  }

  #determineLineageStatus(references, dependencies) {
    /*
     * ARRAY subqueryなど、親SELECT項目には直接ColumnReferenceが無くても、
     * 式サブクエリから物理依存が伝播する場合がある。
     */
    if (references.length === 0 && dependencies.length === 0) {
      return "NO_COLUMN_DEPENDENCY";
    }

    if (dependencies.length === 0) {
      return "UNRESOLVED";
    }

    if (dependencies.some((dependency) => dependency.dependency_status !== "RESOLVED")) {
      return "PARTIALLY_RESOLVED";
    }

    return "RESOLVED";
  }

  #deduplicateDependencies(dependencies) {
    const result = [];
    const seen = new Set();

    for (const dependency of dependencies) {
      const key = dependency.dependency_type === "PHYSICAL_COLUMN"
        ? `${dependency.physical_table_name}|${dependency.field_path || dependency.physical_column_name}`
        : `${dependency.dependency_type}|${dependency.dependency_status}|` +
          `${dependency.source_reference_name}|${dependency.derived_scope_id ?? ""}|` +
          `${dependency.derived_output_column_name ?? ""}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(dependency);
    }

    return result;
  }

  #flattenPhysicalDependencies(rootOutputLineages) {
    const rows = [];

    for (const lineage of rootOutputLineages) {
      for (const dependency of lineage.dependencies) {
        if (dependency.dependency_type !== "PHYSICAL_COLUMN") {
          continue;
        }

        rows.push({
          output_column_id: lineage.output_column_id,
          output_column_name: lineage.output_column_name,
          output_scope_id: lineage.output_scope_id,
          physical_table_name: dependency.physical_table_name,
          physical_column_name: dependency.physical_column_name,
          field_path: dependency.field_path,
          lineage_path: dependency.lineage_path
        });
      }
    }

    return rows;
  }

  #addDiagnostics(result, context) {
    for (const lineage of result.output_lineages) {
      if (lineage.lineage_status === "RESOLVED" ||
          lineage.lineage_status === "NO_COLUMN_DEPENDENCY") {
        continue;
      }

      if (lineage.lineage_status !== "CYCLE_DETECTED" &&
          this.#hasUnderlyingError(lineage, context)) {
        continue;
      }

      const unresolvedDependencies =
        this.#summarizeUnresolvedDependencies(lineage);
      const location = this.#resolveDiagnosticLocation(
        lineage,
        unresolvedDependencies
      );
      const scopeType = this.#lookupScopeType(lineage.output_scope_id);

      context.addDiagnostic(
        lineage.lineage_status === "CYCLE_DETECTED" ? "ERROR" : "WARNING",
        `LINEAGE_${lineage.lineage_status}`,
        this.#buildLineageDiagnosticMessage(lineage, unresolvedDependencies),
        {
          output_column_id: lineage.output_column_id,
          output_column_name: lineage.output_column_name,
          scope_id: lineage.output_scope_id,
          scope_type: scopeType,
          expression_text: lineage.expression_text ?? null,
          expanded_from_wildcard: Boolean(lineage.expanded_from_wildcard),
          start_token_seq: location.start_token_seq,
          end_token_seq: location.end_token_seq,
          /*
           * ワイルドカード展開列など自身のTokenを持たない出力に対して、
           * どの根拠でSQL位置を推定したかを示す。
           *   OUTPUT_COLUMN        … 出力列自身のToken範囲
           *   UNRESOLVED_BRANCH_SCOPE … 未解決依存が属する派生/分岐スコープ
           *   OUTPUT_SCOPE         … 出力スコープ全体(例: SET_OPERATION_QUERY)
           *   UNLOCATED            … 位置を推定できず
           */
          location_basis: location.basis,
          unresolved_dependency_count: unresolvedDependencies.length,
          unresolved_dependencies: unresolvedDependencies
        }
      );
    }
  }

  /*
   * 未解決(RESOLVED以外)の依存を、運用担当者がSQL上の該当箇所を
   * 追跡できる形へ要約する。SET_OPERATION(UNION等)や派生列では
   * via_*_scope_id が「どの分岐/サブクエリ由来か」を示す。
   */
  #summarizeUnresolvedDependencies(lineage) {
    const summaries = [];

    for (const dependency of lineage.dependencies ?? []) {
      if (dependency.dependency_status === "RESOLVED") {
        continue;
      }

      const branchScopeId = this.#pickBranchScopeId(dependency);

      summaries.push({
        dependency_type: dependency.dependency_type ?? null,
        dependency_status: dependency.dependency_status ?? null,
        source_reference_name: dependency.source_reference_name ?? null,
        column_name: dependency.column_name ?? null,
        via_wildcard_scope_id: dependency.via_wildcard_scope_id ?? null,
        via_derived_scope_id: dependency.via_derived_scope_id ?? null,
        via_derived_output_column_name:
          dependency.via_derived_output_column_name ?? null,
        branch_scope_id: branchScopeId,
        branch_scope_type: this.#lookupScopeType(branchScopeId)
      });
    }

    return summaries;
  }

  #pickBranchScopeId(dependency) {
    const candidates = [
      dependency.via_derived_scope_id,
      dependency.derived_scope_id,
      dependency.via_wildcard_scope_id,
      dependency.via_expression_subquery_scope_id,
      dependency.via_pivot_scope_id,
      dependency.via_unpivot_scope_id
    ];

    for (const candidate of candidates) {
      if (candidate !== null && candidate !== undefined) {
        return candidate;
      }
    }

    return null;
  }

  /*
   * 診断のSQL位置を決める。合成された出力(ワイルドカード展開など)は
   * 自身のToken範囲を持たないため、未解決依存の分岐スコープ→出力
   * スコープの順にフォールバックしてline/column/sql_fragmentを埋める。
   */
  #resolveDiagnosticLocation(lineage, unresolvedDependencies) {
    if (lineage.start_token_seq !== null &&
        lineage.start_token_seq !== undefined) {
      return {
        start_token_seq: lineage.start_token_seq,
        end_token_seq: lineage.end_token_seq ?? lineage.start_token_seq,
        basis: "OUTPUT_COLUMN"
      };
    }

    for (const dependency of unresolvedDependencies) {
      const branchRange = this.#lookupScopeTokenRange(dependency.branch_scope_id);

      if (branchRange) {
        return { ...branchRange, basis: "UNRESOLVED_BRANCH_SCOPE" };
      }
    }

    const scopeRange = this.#lookupScopeTokenRange(lineage.output_scope_id);

    if (scopeRange) {
      return { ...scopeRange, basis: "OUTPUT_SCOPE" };
    }

    return { start_token_seq: null, end_token_seq: null, basis: "UNLOCATED" };
  }

  #lookupScopeTokenRange(scopeId) {
    if (scopeId === null || scopeId === undefined) {
      return null;
    }

    const scope = this.scopeById.get(scopeId);

    if (!scope) {
      return null;
    }

    const start = scope.query_start_token_seq;

    if (start === null || start === undefined) {
      return null;
    }

    return {
      start_token_seq: start,
      end_token_seq: scope.query_end_token_seq ?? start
    };
  }

  #lookupScopeType(scopeId) {
    if (scopeId === null || scopeId === undefined) {
      return null;
    }

    return this.scopeById.get(scopeId)?.scope_type ?? null;
  }

  #buildLineageDiagnosticMessage(lineage, unresolvedDependencies) {
    const base =
      `Lineage for output column ${lineage.output_column_name || "<unnamed>"} ` +
      `in scope ${lineage.output_scope_id} is ${lineage.lineage_status}.`;

    if (unresolvedDependencies.length === 0) {
      return base;
    }

    const detail = unresolvedDependencies
      .slice(0, 5)
      .map((dependency) => {
        const name = dependency.via_derived_output_column_name ||
          dependency.source_reference_name ||
          dependency.column_name ||
          "<expression>";
        const scopePart = dependency.branch_scope_id !== null &&
          dependency.branch_scope_id !== undefined
          ? ` @scope ${dependency.branch_scope_id}` +
            (dependency.branch_scope_type
              ? ` (${dependency.branch_scope_type})`
              : "")
          : "";

        return `${name}${scopePart} [${dependency.dependency_status}]`;
      })
      .join(", ");

    const suffix = unresolvedDependencies.length > 5
      ? `, +${unresolvedDependencies.length - 5} more`
      : "";

    return `${base} Unresolved: ${detail}${suffix}.`;
  }

  #hasUnderlyingError(lineage, context) {
    const dependencyNames = new Set();

    for (const dependency of lineage.dependencies ?? []) {
      if (dependency.dependency_status === "RESOLVED") {
        continue;
      }

      const values = [
        dependency.column_name,
        dependency.source_reference_name
      ];

      for (const value of values) {
        const normalized = this.#normalizeName(value);

        if (normalized) {
          dependencyNames.add(normalized);
        }
      }
    }

    return (context.diagnostics ?? []).some((diagnostic) => {
      if (diagnostic.severity !== "ERROR") {
        return false;
      }

      if (diagnostic.scope_id !== null &&
          diagnostic.scope_id !== undefined &&
          diagnostic.scope_id !== lineage.output_scope_id) {
        return false;
      }

      const referencedName = this.#normalizeName(
        diagnostic.referenced_column_name ?? diagnostic.column_name
      );

      return referencedName && dependencyNames.has(referencedName);
    });
  }

  #createOutputPathEntry(outputColumn) {
    return `SCOPE_${outputColumn.scope_id}.${outputColumn.output_column_name || "<UNNAMED>"}`;
  }

  #createOutputKey(scopeId, outputColumnSeq) {
    return `${scopeId}:${outputColumnSeq}`;
  }

  #normalizeName(value) {
    return value === null || value === undefined
      ? null
      : String(value).toUpperCase();
  }

  #validateContext(context) {
    if (!context || context.query_ast?.node_type !== "QUERY") {
      throw new TypeError("LineageResolver.resolve: invalid ResolutionContext.");
    }

    const requiredResults = [
      ["source_resolution", "SOURCE_RESOLUTION"],
      ["column_resolution", "COLUMN_RESOLUTION"],
      ["output_column_resolution", "OUTPUT_COLUMN_RESOLUTION"],
      ["physical_column_resolution", "PHYSICAL_COLUMN_RESOLUTION"]
    ];

    for (const [propertyName, nodeType] of requiredResults) {
      if (context[propertyName]?.node_type !== nodeType) {
        throw new TypeError(
          `LineageResolver.resolve: ${propertyName} must be registered first.`
        );
      }
    }
  }
}

// ============================================================
// SOURCE: src/diagnostic_engine.js
// ============================================================
/**
 * 診断ポリシーと運用向け調査情報の生成を一元管理する。
 *
 * Resolverは「何が起きたか」をdetailsとして渡し、このクラスが
 * severity/code/messageとSQL位置情報を共通形式へ整える。
 * 修正候補や自動修正は責務に含めない。
 */
class DiagnosticEngine {
  constructor(tokens, queryAst, sqlText = "") {
    this.tokens = Array.isArray(tokens) ? tokens : [];
    this.queryAst = queryAst ?? null;
    this.sqlText = typeof sqlText === "string" ? sqlText : "";
    this.diagnostics = [];
  }

  report(severity, code, message, details = {}) {
    const allowedSeverities = ["INFO", "WARNING", "ERROR"];

    if (!allowedSeverities.includes(severity)) {
      throw new TypeError(
        `DiagnosticEngine.report: unsupported severity "${severity}".`
      );
    }

    const startTokenSeq = details.start_token_seq ?? details.token_seq ?? null;
    const endTokenSeq = details.end_token_seq ?? startTokenSeq;
    const startToken = this.#findToken(startTokenSeq);
    const sqlFragment = details.sql_fragment ?? this.#createSqlFragment(
      startTokenSeq,
      endTokenSeq
    );
    const sqlContext = details.sql_context ?? this.#createSqlContext(
      startTokenSeq,
      endTokenSeq
    );

    const diagnostic = {
      diagnostic_seq: this.diagnostics.length + 1,
      severity,
      code,
      message,
      node_id: details.node_id ?? details.column_reference_id ??
        details.output_column_id ?? null,
      node_type: details.node_type ?? this.#inferNodeType(code),
      scope_id: details.scope_id ?? null,
      scope_type: details.scope_type ?? null,
      output_column_name: details.output_column_name ?? null,
      referenced_column_name: details.referenced_column_name ??
        details.column_name ?? null,
      start_token_seq: startTokenSeq,
      end_token_seq: endTokenSeq,
      line_number: details.line_number ?? startToken?.line_no ?? null,
      column_number: details.column_number ?? startToken?.column_no ?? null,
      sql_fragment: sqlFragment,
      sql_context: sqlContext,
      original_sql: this.sqlText || null,
      ...details
    };

    this.diagnostics.push(diagnostic);
    return diagnostic;
  }

  getDiagnostics() {
    return this.diagnostics.map((item) => ({ ...item }));
  }

  getErrorNodes() {
    return this.diagnostics
      .filter((item) => item.severity === "ERROR")
      .map((item) => ({ ...item }));
  }

  #findToken(tokenSeq) {
    if (tokenSeq === null || tokenSeq === undefined) {
      return null;
    }

    return this.tokens.find((token) => token.token_seq === tokenSeq) ?? null;
  }

  #createSqlFragment(startTokenSeq, endTokenSeq) {
    if (startTokenSeq === null || startTokenSeq === undefined) {
      return null;
    }

    return this.#joinTokens(startTokenSeq, endTokenSeq);
  }

  #createSqlContext(startTokenSeq, endTokenSeq) {
    if (startTokenSeq === null || startTokenSeq === undefined) {
      return null;
    }

    const astRange = this.#findAstContextRange(
      this.queryAst,
      startTokenSeq,
      endTokenSeq ?? startTokenSeq
    );

    if (astRange) {
      return this.#joinTokens(astRange.start_token_seq, astRange.end_token_seq);
    }

    const contextStart = Math.max(1, startTokenSeq - 8);
    const contextEnd = (endTokenSeq ?? startTokenSeq) + 8;
    return this.#joinTokens(contextStart, contextEnd);
  }

  /**
   * 診断対象Tokenを含むSELECT項目をASTから探す。
   *
   * 単純な前後Token数ではなくSELECT項目単位で切り出すことで、
   * SQLのどの出力式で問題が起きたかを運用担当者が読み取りやすくする。
   * CTE、サブクエリ、Set Operationも再帰的に探索する。
   */
  #findAstContextRange(node, startTokenSeq, endTokenSeq) {
    if (!node || typeof node !== "object") {
      return null;
    }

    if (node.node_type === "QUERY" && Array.isArray(node.select)) {
      for (const selectItem of node.select) {
        const itemStart = selectItem.item_start_seq ??
          selectItem.expression_start_seq ?? null;
        const itemEnd = selectItem.item_end_seq ??
          selectItem.expression_end_seq ?? null;

        if (
          Number.isInteger(itemStart) &&
          Number.isInteger(itemEnd) &&
          itemStart <= startTokenSeq &&
          itemEnd >= endTokenSeq
        ) {
          return {
            start_token_seq: itemStart,
            end_token_seq: itemEnd
          };
        }
      }
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = this.#findAstContextRange(
            item,
            startTokenSeq,
            endTokenSeq
          );

          if (found) {
            return found;
          }
        }
        continue;
      }

      if (value && typeof value === "object") {
        const found = this.#findAstContextRange(
          value,
          startTokenSeq,
          endTokenSeq
        );

        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  #joinTokens(startTokenSeq, endTokenSeq) {
    const values = this.tokens
      .filter((token) => {
        return token.token_seq >= startTokenSeq &&
          token.token_seq <= endTokenSeq;
      })
      .map((token) => token.token)
      .filter((value) => value !== null && value !== undefined);

    return values.length > 0 ? values.join(" ") : null;
  }

  #inferNodeType(code) {
    if (code.includes("OUTPUT_COLUMN")) {
      return "OUTPUT_COLUMN";
    }

    if (code.includes("COLUMN")) {
      return "COLUMN_REFERENCE";
    }

    if (code.includes("LINEAGE")) {
      return "OUTPUT_LINEAGE";
    }

    return "ENGINE_DIAGNOSTIC";
  }
}

// ============================================================
// SOURCE: src/resolution_context.js
// ============================================================
/**
 * Parserと各Resolverの結果を、1回の解析単位としてまとめて保持するContext。
 *
 * ResolutionContextを導入する理由:
 *
 * - Resolverが増えるたびに、引数として複数の結果オブジェクトを渡し続ける
 *   状態を避ける。
 * - Query Scope、Source、Column、Output Column、診断情報を同じ解析単位で
 *   参照できるようにする。
 * - 既存Resolverの戻り値形式は維持し、段階的に共通Contextへ移行できるようにする。
 *
 * 現段階では「情報を保持する器」に責務を限定する。
 * SQL解析や名前解決そのものは、各Parser / Resolverが担当する。
 */
class ResolutionContext {
  /**
   * @param {Array<object>} tokens Lexerが生成したToken配列
   * @param {object} queryAst QueryParserが生成したQuery AST
   */
  constructor(tokens, queryAst, sqlText = "") {
    if (!Array.isArray(tokens)) {
      throw new TypeError("ResolutionContext: tokens must be an array.");
    }

    if (!queryAst || queryAst.node_type !== "QUERY") {
      throw new TypeError("ResolutionContext: queryAst must be a QUERY node.");
    }

    this.tokens = tokens;
    this.query_ast = queryAst;
    this.source_resolution = null;
    this.column_resolution = null;
    this.output_column_resolution = null;
    this.physical_column_resolution = null;
    this.lineage_resolution = null;
    this.impact_resolution = null;
    this.diagnostic_engine = new DiagnosticEngine(tokens, queryAst, sqlText);
    this.diagnostics = this.diagnostic_engine.diagnostics;
  }

  /**
   * SourceResolverの結果をContextへ登録する。
   *
   * return thisはメソッドチェーンを必須にするためではなく、
   * 呼び出し側が必要なら連続して設定できる余地を残すために返している。
   */
  setSourceResolution(sourceResolution) {
    if (!sourceResolution || sourceResolution.node_type !== "SOURCE_RESOLUTION") {
      throw new TypeError(
        "ResolutionContext.setSourceResolution: invalid source resolution."
      );
    }

    this.source_resolution = sourceResolution;
    return this;
  }

  /**
   * ColumnResolverの結果をContextへ登録する。
   */
  setColumnResolution(columnResolution) {
    if (!columnResolution || columnResolution.node_type !== "COLUMN_RESOLUTION") {
      throw new TypeError(
        "ResolutionContext.setColumnResolution: invalid column resolution."
      );
    }

    this.column_resolution = columnResolution;
    return this;
  }

  /**
   * OutputColumnResolverの結果をContextへ登録する。
   */
  setOutputColumnResolution(outputColumnResolution) {
    if (
      !outputColumnResolution ||
      outputColumnResolution.node_type !== "OUTPUT_COLUMN_RESOLUTION"
    ) {
      throw new TypeError(
        "ResolutionContext.setOutputColumnResolution: invalid output column resolution."
      );
    }

    this.output_column_resolution = outputColumnResolution;
    return this;
  }


  /**
   * PhysicalColumnResolverの結果をContextへ登録する。
   */
  setPhysicalColumnResolution(physicalColumnResolution) {
    if (
      !physicalColumnResolution ||
      physicalColumnResolution.node_type !== "PHYSICAL_COLUMN_RESOLUTION"
    ) {
      throw new TypeError(
        "ResolutionContext.setPhysicalColumnResolution: invalid physical column resolution."
      );
    }

    this.physical_column_resolution = physicalColumnResolution;
    return this;
  }


  /**
   * LineageResolverの結果をContextへ登録する。
   */
  setLineageResolution(lineageResolution) {
    if (!lineageResolution || lineageResolution.node_type !== "LINEAGE_RESOLUTION") {
      throw new TypeError(
        "ResolutionContext.setLineageResolution: invalid lineage resolution."
      );
    }

    this.lineage_resolution = lineageResolution;
    return this;
  }


  /**
   * ImpactResolverの結果をContextへ登録する。
   */
  setImpactResolution(impactResolution) {
    if (!impactResolution || impactResolution.node_type !== "IMPACT_RESOLUTION") {
      throw new TypeError(
        "ResolutionContext.setImpactResolution: invalid impact resolution."
      );
    }

    this.impact_resolution = impactResolution;
    return this;
  }

  /**
   * Resolverが検出した警告・エラー候補を共通形式で追加する。
   *
   * 解析を直ちに中断すべきSyntaxErrorとは分け、
   * 重複出力名や未確定出力名のような「結果は返せるが注意が必要」な情報を
   * 診断一覧として保持する。
   */
  addDiagnostic(severity, code, message, details = {}) {
    const enrichedDetails = this.#enrichDiagnosticDetails(details);
    this.diagnostic_engine.report(severity, code, message, enrichedDetails);
    return this;
  }

  /**
   * Resolverから渡された事実へ、Contextが保持するScope・Source情報を補完する。
   *
   * Resolver自身に表示用ロジックを持たせず、Diagnostic Engineへ渡す直前の
   * 共通窓口で補完することで、すべての診断形式を一貫させる。
   */
  #enrichDiagnosticDetails(details) {
    const enriched = { ...details };
    const scopes = this.source_resolution?.scopes ?? [];
    const scope = scopes.find((item) => item.scope_id === enriched.scope_id);

    if (enriched.scope_type === undefined || enriched.scope_type === null) {
      enriched.scope_type = scope?.scope_type ?? null;
    }

    const sourceIds = enriched.candidate_source_ids ?? [];
    const sourceById = new Map();

    for (const currentScope of scopes) {
      for (const source of currentScope.sources ?? []) {
        sourceById.set(source.source_id, source);
      }
    }

    const candidateSources = sourceIds
      .map((sourceId) => sourceById.get(sourceId))
      .filter(Boolean);

    if (enriched.candidate_source_names === undefined) {
      enriched.candidate_source_names = candidateSources.map((source) => {
        return source.resolved_source_name ?? source.source_name ?? null;
      }).filter(Boolean);
    }

    if (enriched.candidate_source_name === undefined) {
      enriched.candidate_source_name =
        enriched.candidate_source_names.length === 1
          ? enriched.candidate_source_names[0]
          : null;
    }

    if (enriched.resolved_source_name === undefined) {
      const sourceId = enriched.source_id ??
        (sourceIds.length === 1 ? sourceIds[0] : null);
      const source = sourceById.get(sourceId);
      enriched.resolved_source_name = source?.resolved_source_name ??
        source?.source_name ?? null;
    }

    return enriched;
  }

  getErrorNodes() {
    return this.diagnostic_engine.getErrorNodes();
  }

  /**
   * 外部へ渡しやすいプレーンオブジェクト形式を返す。
   *
   * Contextクラスのメソッドを外部保存形式へ混ぜず、
   * BigQuery UDFやJSON化でも扱いやすい構造にする。
   */
  toObject() {
    return {
      node_type: "RESOLUTION_CONTEXT",
      query_ast: this.query_ast,
      source_resolution: this.source_resolution,
      column_resolution: this.column_resolution,
      output_column_resolution: this.output_column_resolution,
      physical_column_resolution: this.physical_column_resolution,
      lineage_resolution: this.lineage_resolution,
      impact_resolution: this.impact_resolution,
      diagnostics: [...this.diagnostics]
    };
  }
}

// ============================================================
// SOURCE: src/lineage_engine.js
// ============================================================
/**
 * SQL文字列から物理カラムLineageまでを一括実行する統合クラス。
 *
 * LineageEngineを用意する理由:
 *
 * - 利用側がParser / Resolverの正しい呼び出し順を意識しなくてよい。
 * - 各工程の結果をResolutionContextへ確実に登録できる。
 * - Node.js、BigQuery UDF、バッチ処理など、異なる実行環境から
 *   同じ公開APIを利用できる。
 * - strict / non-strictのエラー処理を一か所へ集約できる。
 * - BigQueryの中間テーブルへ保存しやすい平坦な行配列を生成できる。
 *
 * このクラス自身はSQL文法や名前解決を実装しない。
 * 各Parser / Resolverを決められた順序で呼ぶオーケストレーターである。
 */
class LineageEngine {
  /**
   * @param {object} options
   * @param {Array<object>} options.physicalColumns 物理カラムメタデータ
   * @param {boolean} options.strictMode trueならERROR診断または工程例外で停止する
   */
  constructor(options = {}) {
    const physicalColumns = options.physicalColumns ?? [];

    if (!Array.isArray(physicalColumns)) {
      throw new TypeError(
        "LineageEngine: options.physicalColumns must be an array."
      );
    }

    this.physicalColumns = physicalColumns;
    this.strictMode = options.strictMode !== false;
  }

  /**
   * SQLを解析し、Parser / Resolverの結果をまとめて返す公開入口。
   *
   * @param {string} sqlText
   * @param {object} options
   * @param {object|null} options.impactTarget ImpactResolverへ渡す物理対象
   * @returns {object}
   */
  analyze(sqlText, options = {}) {
    if (typeof sqlText !== "string") {
      throw new TypeError("LineageEngine.analyze: sqlText must be a string.");
    }

    const state = {
      tokens: [],
      queryAst: null,
      context: null,
      failedStage: null,
      caughtError: null
    };

    try {
      state.failedStage = "LEXER";
      state.tokens = tokenize(sqlText);

      state.failedStage = "QUERY_PARSER";
      state.queryAst = new QueryParser(state.tokens).parse();
      state.context = new ResolutionContext(state.tokens, state.queryAst, sqlText);

      state.failedStage = "SOURCE_RESOLVER";
      const sourceResolution = new SourceResolver().resolve(state.queryAst);
      state.context.setSourceResolution(sourceResolution);

      state.failedStage = "COLUMN_RESOLVER";
      const columnResolution = new ColumnResolver(state.tokens).resolve(
        state.queryAst,
        sourceResolution
      );
      state.context.setColumnResolution(columnResolution);

      state.failedStage = "OUTPUT_COLUMN_RESOLVER";
      new OutputColumnResolver(state.tokens).resolve(state.context);

      state.failedStage = "PHYSICAL_COLUMN_RESOLVER";
      new PhysicalColumnResolver(this.physicalColumns).resolve(state.context);

      state.failedStage = "LINEAGE_RESOLVER";
      new LineageResolver().resolve(state.context);

      if (options.impactTarget) {
        state.failedStage = "IMPACT_RESOLVER";
        new ImpactResolver().resolve(state.context, options.impactTarget);
      }

      state.failedStage = null;
    } catch (error) {
      state.caughtError = error;

      if (this.strictMode) {
        throw this.#createStageError(state.failedStage, error);
      }

      this.#recordCaughtError(state);
    }

    if (this.strictMode && state.context) {
      this.#throwForErrorDiagnostics(state.context);
    }

    return this.#createResult(sqlText, state);
  }

  /**
   * strictMode=falseで工程例外が起きた場合、解析済みのContextがあれば
   * diagnosticsへ登録する。QueryParser以前の失敗ではContextを作れないため、
   * 後で返却結果のengine_diagnosticsへ格納する。
   */
  #recordCaughtError(state) {
    if (!state.context) {
      return;
    }

    state.context.addDiagnostic(
      "ERROR",
      "ENGINE_STAGE_FAILED",
      state.caughtError.message,
      {
        stage: state.failedStage,
        error_name: state.caughtError.name
      }
    );
  }

  /**
   * Resolverが結果を返しつつERROR診断を残した場合、strictModeでは例外化する。
   * SyntaxErrorだけでなく、CTE列数不一致などの意味的な不整合も
   * 呼び出し側が見落とさないようにする。
   */
  #throwForErrorDiagnostics(context) {
    const errors = context.diagnostics.filter((item) => item.severity === "ERROR");

    if (errors.length === 0) {
      return;
    }

    const error = new Error(
      `LineageEngine: ${errors.length} error diagnostic(s) were reported.`
    );

    error.name = "LineageEngineDiagnosticError";
    error.diagnostics = errors;
    throw error;
  }

  #createStageError(stage, originalError) {
    const error = new Error(
      `LineageEngine: stage ${stage ?? "UNKNOWN"} failed: ${originalError.message}`
    );

    error.name = "LineageEngineStageError";
    error.stage = stage;
    error.cause = originalError;
    return error;
  }

  #createResult(sqlText, state) {
    const contextObject = state.context ? state.context.toObject() : null;
    const engineDiagnostics = [];

    if (state.caughtError && !state.context) {
      engineDiagnostics.push(
        this.#createCaughtErrorDiagnostic(state)
      );
    }

    const diagnostics = contextObject
      ? contextObject.diagnostics
      : engineDiagnostics;

    return {
      node_type: "LINEAGE_ENGINE_RESULT",
      analysis_status: this.#determineAnalysisStatus(state, diagnostics),
      strict_mode: this.strictMode,
      sql_text: sqlText,
      failed_stage: state.caughtError ? state.failedStage : null,
      tokens: state.tokens,
      query_ast: state.queryAst,
      resolutions: {
        sources: contextObject?.source_resolution ?? null,
        columns: contextObject?.column_resolution ?? null,
        output_columns: contextObject?.output_column_resolution ?? null,
        physical_columns: contextObject?.physical_column_resolution ?? null
      },
      lineage: contextObject?.lineage_resolution ?? null,
      impact: contextObject?.impact_resolution ?? null,
      diagnostics,
      error_nodes: diagnostics.filter((item) => item.severity === "ERROR"),
      tables: this.#createTableRows(state.context)
    };
  }


  /**
   * Parser / Resolver例外を、BigQueryへ保存可能な診断行へ変換する。
   *
   * Parser側がparser_tokenを付与している場合は、そのTokenを基準に
   * 前後5Tokenを保持する。未対応の例外でもメッセージと工程名は必ず返す。
   */
  #createCaughtErrorDiagnostic(state) {
    const error = state.caughtError;
    const token = error?.parser_token ?? null;
    const parserStage = error?.parser_stage ?? this.#inferParserStage(error);
    const contextTokens = token
      ? this.#createTokenContext(state.tokens, token.token_seq, 5)
      : [];

    return {
      diagnostic_seq: 1,
      severity: "ERROR",
      code: "ENGINE_STAGE_FAILED",
      message: error?.message ?? "Unknown engine error.",
      stage: state.failedStage,
      parser_stage: parserStage,
      error_name: error?.name ?? "Error",
      token_seq: token?.token_seq ?? null,
      line_no: token?.line_no ?? null,
      column_no: token?.column_no ?? null,
      token: token?.token ?? null,
      normalized_token: token?.normalized_token ?? null,
      token_type: token?.token_type ?? null,
      context_tokens: contextTokens
    };
  }

  #inferParserStage(error) {
    const message = error?.message ?? "";
    const match = message.match(/^([A-Za-z][A-Za-z0-9_]*Parser):/);
    return match ? match[1] : null;
  }

  #createTokenContext(tokens, tokenSeq, radius) {
    const tokenIndex = tokens.findIndex((item) => item.token_seq === tokenSeq);

    if (tokenIndex < 0) {
      return [];
    }

    const startIndex = Math.max(0, tokenIndex - radius);
    const endIndex = Math.min(tokens.length, tokenIndex + radius + 1);

    return tokens.slice(startIndex, endIndex).map((item) => ({
      token_seq: item.token_seq,
      line_no: item.line_no,
      column_no: item.column_no,
      token: item.token,
      normalized_token: item.normalized_token,
      token_type: item.token_type,
      is_error_token: item.token_seq === tokenSeq
    }));
  }

  #determineAnalysisStatus(state, diagnostics) {
    if (state.caughtError) {
      return "PARTIAL_FAILURE";
    }

    if (diagnostics.some((item) => item.severity === "ERROR")) {
      return "COMPLETED_WITH_ERRORS";
    }

    if (diagnostics.some((item) => item.severity === "WARNING")) {
      return "COMPLETED_WITH_WARNINGS";
    }

    return "COMPLETED";
  }

  /**
   * BigQueryの中間テーブルへ保存しやすい行配列を作る。
   *
   * JavaScriptメモ:
   * optional chaining（?.）とnull合体演算子（??）を使い、
   * non-strictモードで途中工程が未実行でも空配列を返せるようにしている。
   */
  #createTableRows(context) {
    if (!context) {
      return this.#createEmptyTables();
    }

    const sourceScopes = context.source_resolution?.scopes ?? [];
    const outputScopes = context.output_column_resolution?.scopes ?? [];

    return {
      tokens: context.tokens.map((token) => ({ ...token })),
      query_scopes: sourceScopes.map((scope) => ({
        scope_id: scope.scope_id,
        scope_type: scope.scope_type,
        parent_scope_id: scope.parent_scope_id,
        query_start_token_seq: scope.query_start_token_seq,
        query_end_token_seq: scope.query_end_token_seq
      })),
      sources: sourceScopes.flatMap((scope) => {
        return scope.sources.map((source) => ({ ...source }));
      }),
      cte_definitions: sourceScopes.flatMap((scope) => {
        return scope.cte_definitions.map((cte) => ({
          scope_id: scope.scope_id,
          ...cte
        }));
      }),
      column_references:
        context.column_resolution?.column_references.map((item) => ({ ...item })) ?? [],
      output_columns: outputScopes.flatMap((scope) => {
        return scope.output_columns.map((item) => ({ ...item }));
      }),
      physical_column_references:
        context.physical_column_resolution?.column_references.map((item) => ({ ...item })) ?? [],
      wildcard_expansions:
        context.physical_column_resolution?.wildcard_expansions.map((item) => ({ ...item })) ?? [],
      output_lineages:
        context.lineage_resolution?.output_lineages.map((item) => ({ ...item })) ?? [],
      lineage_paths:
        context.lineage_resolution?.physical_dependencies.map((item) => ({ ...item })) ?? [],
      impact_paths:
        context.impact_resolution?.impact_paths.map((item) => ({ ...item })) ?? [],
      diagnostics: context.diagnostics.map((item) => ({ ...item }))
    };
  }

  #createEmptyTables() {
    return {
      tokens: [],
      query_scopes: [],
      sources: [],
      cte_definitions: [],
      column_references: [],
      output_columns: [],
      physical_column_references: [],
      wildcard_expansions: [],
      output_lineages: [],
      lineage_paths: [],
      impact_paths: [],
      diagnostics: []
    };
  }
}


/**
 * BigQuery UDFとNode.js bundle testが共有する公開入口。
 *
 * JSON文字列を引数・戻り値に使う理由:
 * - BigQueryの複雑なSTRUCT定義とASTの変化を切り離す。
 * - Parser拡張時にCREATE FUNCTIONのRETURNS型を毎回変更しなくてよい。
 * - SQL側でJSON_QUERY_ARRAY等を使って必要な行配列を展開できる。
 */

function compactBigQueryExport(exportedTables) {
  const analyses = exportedTables.analyses ?? [];

  for (const analysis of analyses) {
    analysis.query_ast_json = null;
  }

  const duplicateJsonFields = {
    sources: ["expression_json", "source_json"],
    cte_definitions: ["cte_json"],
    column_references: ["reference_json"],
    output_columns: ["expression_json", "output_column_json"],
    physical_column_references: ["reference_json"],
    wildcard_expansions: ["expansion_json"],
    output_lineages: ["output_lineage_json"],
    lineage_paths: ["lineage_path_json"],
    impact_paths: ["impact_path_json"],
    diagnostics: ["diagnostic_json"]
  };

  for (const [tableName, fieldNames] of Object.entries(duplicateJsonFields)) {
    const rows = exportedTables[tableName] ?? [];

    for (const row of rows) {
      for (const fieldName of fieldNames) {
        row[fieldName] = null;
      }
    }
  }
}

/**
 * SQL内で直接参照される物理Table / View名だけを返す軽量な公開入口。
 *
 * 日次Pipelineは、この結果を使って INFORMATION_SCHEMA のMetadataを
 * 対象Sourceに限定してから通常のLineage解析を呼び出す。全Target Datasetの
 * Metadataを一つのJSON配列に集約しないため、BigQuery Scriptの1 MiB式上限を
 * 回避できる。
 *
 * CTE、FROM Subquery、UNNESTは物理Tableではないため返さない。一方、それらの
 * 内部Queryが参照する物理Tableは SourceResolver の各scopeから収集する。
 */
function discoverPhysicalSourcesForBigQuery(sqlText) {
  if (typeof sqlText !== "string") {
    throw new TypeError(
      "discoverPhysicalSourcesForBigQuery: sqlText must be a string."
    );
  }

  const tokens = tokenize(sqlText);
  const queryAst = new QueryParser(tokens).parse();
  const sourceResolution = new SourceResolver().resolve(queryAst);
  const sourceTables = [];
  const seen = new Set();

  for (const scope of sourceResolution.scopes ?? []) {
    for (const source of scope.sources ?? []) {
      if (source.source_type !== "PHYSICAL_TABLE" || !source.source_name) {
        continue;
      }

      const sourceName = String(source.source_name).toLowerCase();

      if (!seen.has(sourceName)) {
        seen.add(sourceName);
        sourceTables.push(sourceName);
      }
    }
  }

  return {
    analysis: {
      analysis_status: "COMPLETED",
      source_discovery_only: true
    },
    source_tables: sourceTables
  };
}

/**
 * SQLの構造フィンガープリント（正準化文字列）を返す。
 *
 * リテラルだけが異なる構造的に同一のSQL（例: WHERE dt = '2024-01-01' と
 * WHERE dt = '2024-01-02'）を1つにまとめて扱えるよう、字句解析した上で
 * STRING / NUMBER リテラルをプレースホルダ「?」へ置換し、コメントを除去し、
 * 残りのTokenを単一スペースで連結した正準文字列を返す。識別子・キーワード・
 * 演算子・記号は保持するため、構造（参照Table/列や結合・句の形）が異なるSQLは
 * 別のフィンガープリントになる。DATE '...' のような型付きリテラルは後続の
 * STRING が「?」になるため DATE ? へ畳まれる。
 *
 * 呼び出し側（03パイプライン）はこの文字列を TO_HEX(SHA256(...)) でハッシュ化し、
 * statement_type = 'SELECT' のジョブをフィンガープリント単位でまとめ、最新の
 * destination を代表として解析する。
 *
 * 字句解析に失敗した場合は原文を「RAW:」接頭辞付きで返す。これにより解析不能な
 * SQLが誤って別のSQLとまとめられること（false merge）を防ぐ。
 */
function fingerprintSqlForBigQuery(sqlText) {
  if (typeof sqlText !== "string") {
    throw new TypeError(
      "fingerprintSqlForBigQuery: sqlText must be a string."
    );
  }

  try {
    const tokens = tokenize(sqlText);
    const parts = [];

    for (const token of tokens) {
      if (token.token_type === "COMMENT") {
        continue;
      }

      if (token.token_type === "STRING" || token.token_type === "NUMBER") {
        parts.push("?");
        continue;
      }

      /*
       * normalized_tokenはKEYWORD/IDENTIFIERを大文字化し、BACKTICK_IDENTIFIERの
       * 外側バッククォートを除去済みなので、大文字小文字やクォートの差を吸収できる。
       */
      const normalized = token.normalized_token != null
        ? token.normalized_token
        : token.token;

      parts.push(normalized);
    }

    return parts.join(" ");
  } catch (error) {
    return "RAW:" + sqlText;
  }
}

function analyzeLineageForBigQuery(
  sqlText,
  physicalColumnsJson,
  optionsJson,
  exportMetadataJson
) {
  const physicalColumns = physicalColumnsJson
    ? JSON.parse(physicalColumnsJson)
    : [];

  const options = optionsJson
    ? JSON.parse(optionsJson)
    : {};

  if (options.source_discovery_only === true) {
    try {
      return JSON.stringify(discoverPhysicalSourcesForBigQuery(sqlText));
    } catch (error) {
      return JSON.stringify({
        analysis: {
          analysis_status: "PARTIAL_FAILURE",
          source_discovery_only: true,
          failed_stage: "SOURCE_DISCOVERY"
        },
        source_tables: [],
        error: {
          name: error?.name ?? "Error",
          message: error?.message ?? "Unknown source discovery error."
        }
      });
    }
  }

  const exportMetadata = exportMetadataJson
    ? JSON.parse(exportMetadataJson)
    : null;

  const engine = new LineageEngine({
    physicalColumns,
    strictMode: options.strict_mode !== false
  });

  const engineResult = engine.analyze(sqlText, {
    impactTarget: options.impact_target ?? null
  });

  if (!exportMetadata) {
    return JSON.stringify(engineResult);
  }

  const exportedTables = new BigQueryExporter(exportMetadata, {
    runtime_compact: options.compact_export === true
  }).export(engineResult);

  /*
   * BigQuery scripting evaluates a scalar expression with a 1 MiB limit.
   * Complex views can exceed that limit when the exported payload contains both
   * normalized columns and duplicate debug JSON copies of the same rows.
   * compact_export defaults to true for BigQuery export calls and removes only
   * those duplicate JSON copies. Structured table columns remain unchanged.
   */
  const compactExport = options.compact_export === true;

  // v1.3.2: compact fields are omitted while rows are built.
  // No post-build mutation is required here.

  const analysis = exportedTables.analyses[0] ?? null;

  /*
   * v1.2 JSON contract
   *
   * analysis: 1回の解析を表す単数オブジェクト
   * exported_tables: BigQueryへ展開する複数行の配列群
   *
   * analysesをexported_tablesから除外することで、
   * analysis / analysesの意味の曖昧さをなくす。
   */
  const { analyses, ...tableRows } = exportedTables;

  return JSON.stringify({
    analysis,
    exported_tables: tableRows
  });
}

/* Node.jsでbundleを直接テストする場合だけ公開する。 */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    analyzeLineageForBigQuery,
    discoverPhysicalSourcesForBigQuery,
    fingerprintSqlForBigQuery,
    LineageEngine,
    BigQueryExporter
  };
}
