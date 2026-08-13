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
