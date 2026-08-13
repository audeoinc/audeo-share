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
