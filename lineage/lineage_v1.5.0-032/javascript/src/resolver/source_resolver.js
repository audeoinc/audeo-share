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
