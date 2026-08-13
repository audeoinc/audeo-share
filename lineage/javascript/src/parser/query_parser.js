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
