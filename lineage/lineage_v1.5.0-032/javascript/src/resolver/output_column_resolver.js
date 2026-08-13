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
