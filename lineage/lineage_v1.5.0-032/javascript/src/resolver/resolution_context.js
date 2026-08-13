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
