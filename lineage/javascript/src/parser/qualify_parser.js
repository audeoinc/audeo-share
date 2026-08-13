/**
 * QUALIFY句本文を条件式ASTへ変換するParser。
 *
 * QUALIFYは、ROW_NUMBER()、RANK()などのウィンドウ関数を評価した後に
 * 行を絞り込むBigQueryのClauseである。
 *
 * QualifyParser自身はウィンドウ関数や比較演算子を解析しない。
 * ClauseParserが確定したQUALIFY本文のToken範囲をExpressionParserへ渡し、
 * 返されたASTとClause位置情報をまとめることだけを担当する。
 */
class QualifyParser {
  /**
   * @param {Array<object>} tokens Lexerが生成したSQL全体のToken配列
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("QualifyParser: tokens must be an array.");
    }

    this.tokens = tokens;
    this.expressionParser = new ExpressionParser(tokens);
  }

  /**
   * ClauseParserが返したQUALIFY Clauseを解析する。
   *
   * @param {object} qualifyClause ClauseParserのQUALIFY結果
   * @returns {object} QUALIFY Clauseと条件式AST
   */
  parse(qualifyClause) {
    this.#validateQualifyClause(qualifyClause);

    const expression = this.expressionParser.parseExpression(
      qualifyClause.body_start_seq,
      qualifyClause.body_end_seq
    );

    return {
      clause_type: "QUALIFY",
      clause_start_seq: qualifyClause.clause_start_seq,
      clause_end_seq: qualifyClause.clause_end_seq,
      body_start_seq: qualifyClause.body_start_seq,
      body_end_seq: qualifyClause.body_end_seq,
      expression,
      start_token_seq: qualifyClause.clause_start_seq,
      end_token_seq: qualifyClause.body_end_seq
    };
  }

  /**
   * 解析対象が本文を持つQUALIFY Clauseであることを入口で検証する。
   *
   * ExpressionParserはToken範囲だけ渡されれば式を解析できるため、
   * Clause種別の検証を省くとWHEREやHAVINGを誤って渡しても処理できてしまう。
   * 呼び出し側の誤りを早期発見するため、このクラスで明示的に確認する。
   */
  #validateQualifyClause(qualifyClause) {
    if (!qualifyClause || typeof qualifyClause !== "object") {
      throw new TypeError("QualifyParser: qualifyClause must be an object.");
    }

    if (qualifyClause.clause_type !== "QUALIFY") {
      throw new TypeError(
        `QualifyParser: QUALIFY Clause was expected, but received ` +
        `"${qualifyClause.clause_type}".`
      );
    }

    if (!Number.isInteger(qualifyClause.body_start_seq)) {
      throw new RangeError(
        "QualifyParser: body_start_seq must be an integer."
      );
    }

    if (!Number.isInteger(qualifyClause.body_end_seq)) {
      throw new RangeError(
        "QualifyParser: body_end_seq must be an integer."
      );
    }

    if (qualifyClause.body_end_seq < qualifyClause.body_start_seq) {
      throw new SyntaxError("QualifyParser: QUALIFY Clause body is empty.");
    }
  }
}
