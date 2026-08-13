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
