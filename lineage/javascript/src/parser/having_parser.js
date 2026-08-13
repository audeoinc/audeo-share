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
