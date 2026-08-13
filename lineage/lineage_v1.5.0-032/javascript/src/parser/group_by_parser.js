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
