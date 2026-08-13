/**
 * WHERE句本文を条件式ASTへ変換するParser。
 *
 * WhereParserの責務:
 *
 * - ClauseParserが検出したWHERE Clauseの本文範囲を受け取る。
 * - WHERE本文が空でないことを検証する。
 * - 条件式の解析をExpressionParserへ委譲する。
 * - WHERE Clause自身の位置情報と、生成されたExpression ASTをまとめて返す。
 *
 * WHERE内のAND、OR、BETWEEN、IN、関数呼び出しなどを
 * WhereParser自身で解析しない理由:
 *
 * それらはすべてExpression文法であり、ExpressionParserがすでに
 * 演算子優先順位を含めて解析する責務を持っているため。
 * WhereParserはClauseとExpressionの橋渡しだけに責務を限定する。
 *
 * 位置情報は外部APIの方針に合わせ、すべてtoken_seqで返す。
 */
class WhereParser {
  /**
   * @param {Array<object>} tokens Lexerが生成したSQL全体のToken配列
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("WhereParser: tokens must be an array.");
    }

    /*
     * ExpressionParserにはSQL全体のToken配列を渡しておく。
     * parseExpression()へWHERE本文のstart/end token_seqを指定することで、
     * 元Token配列をコピー・変更せず、必要範囲だけを解析できる。
     */
    this.tokens = tokens;
    this.expressionParser = new ExpressionParser(tokens);
  }

  /**
   * ClauseParserが返したWHERE Clauseを解析する。
   *
   * @param {object} whereClause ClauseParserのWHERE結果
   * @returns {object} WHERE Clauseと条件式AST
   */
  parse(whereClause) {
    this.#validateWhereClause(whereClause);

    /*
     * WHERE本文全体をExpressionParserへ委譲する。
     * ExpressionParser側でCOMMENT Tokenを解析用配列から除外するため、
     * WhereParserではコメント除去処理を重複実装しない。
     */
    const expression = this.expressionParser.parseExpression(
      whereClause.body_start_seq,
      whereClause.body_end_seq
    );

    return {
      clause_type: "WHERE",
      clause_start_seq: whereClause.clause_start_seq,
      clause_end_seq: whereClause.clause_end_seq,
      body_start_seq: whereClause.body_start_seq,
      body_end_seq: whereClause.body_end_seq,
      expression,
      start_token_seq: whereClause.clause_start_seq,
      end_token_seq: whereClause.body_end_seq
    };
  }

  /**
   * WhereParserへ渡されたClauseが、解析可能なWHERE Clauseか検証する。
   *
   * この検証が必要な理由:
   * Select ClauseやFrom Clauseを誤って渡した場合、本文自体はExpressionとして
   * 部分的に解析できてしまう可能性がある。入口でClause種別と範囲を確認し、
   * 呼び出し側の誤りを早い段階で明確なエラーにする。
   *
   * @param {object} whereClause
   */
  #validateWhereClause(whereClause) {
    if (!whereClause || typeof whereClause !== "object") {
      throw new TypeError("WhereParser: whereClause must be an object.");
    }

    if (whereClause.clause_type !== "WHERE") {
      throw new TypeError(
        `WhereParser: WHERE Clause was expected, but received ` +
        `"${whereClause.clause_type}".`
      );
    }

    if (!Number.isInteger(whereClause.body_start_seq)) {
      throw new RangeError(
        "WhereParser: body_start_seq must be an integer."
      );
    }

    if (!Number.isInteger(whereClause.body_end_seq)) {
      throw new RangeError(
        "WhereParser: body_end_seq must be an integer."
      );
    }

    if (whereClause.body_end_seq < whereClause.body_start_seq) {
      throw new SyntaxError("WhereParser: WHERE Clause body is empty.");
    }
  }
}
