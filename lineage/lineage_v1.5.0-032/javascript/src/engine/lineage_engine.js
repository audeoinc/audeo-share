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
