/**
 * LIMIT句を、取得件数と開始位置へ分解するParser。
 *
 * BigQueryのGoogleSQLでは、LIMIT句は次の形を取る。
 *
 *   LIMIT count
 *   LIMIT count OFFSET skip_rows
 *
 * countとskip_rowsはINT64の定数式である。LimitParserは値の妥当性や型を
 * 実行せず、Token範囲をExpressionParserへ委譲してASTとして保持する。
 *
 * LimitParserの責務:
 *
 * - ClauseParserが確定したLIMIT Clause本文だけを取り出す。
 * - トップレベルのOFFSETを境界としてcountとskip_rowsを分割する。
 * - 各範囲をExpressionParserへ渡す。
 * - LIMIT固有の構造を、token_seq基準の結果として返す。
 *
 * LIMIT 10, 20のようなカンマ形式はBigQueryのGoogleSQL構文ではないため、
 * 対応せず明確なSyntaxErrorを返す。
 */
class LimitParser {
  /**
   * @param {Array<object>} tokens Lexerが生成したSQL全体のToken配列
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("LimitParser: tokens must be an array.");
    }

    this.tokens = tokens;
    this.expressionParser = new ExpressionParser(tokens);
  }

  /**
   * ClauseParserが返したLIMIT Clauseを解析する。
   *
   * @param {object} limitClause ClauseParserのLIMIT結果
   * @returns {object} LIMIT件数と任意のOFFSET式
   */
  parse(limitClause) {
    this.#validateLimitClause(limitClause);

    /*
     * LIMIT本文だけを取得する。
     *
     * COMMENTは件数やOFFSETの意味を持たないため除外する。
     * 最終セミコロンはSQL文の終端であり、LIMIT式の一部ではないため除外する。
     * filter()は元Token配列を変更せず、新しい配列を返す。
     */
    const bodyTokens = this.tokens.filter((token) => (
      token.token_seq >= limitClause.body_start_seq &&
      token.token_seq <= limitClause.body_end_seq &&
      token.token_type !== "COMMENT" &&
      token.token !== ";"
    ));

    if (bodyTokens.length === 0) {
      throw new SyntaxError("LimitParser: LIMIT Clause body is empty.");
    }

    /*
     * BigQueryではLIMIT count, skip_rows形式を採用しない。
     * 対応外TokenをExpressionParserへ渡して曖昧なエラーにするのではなく、
     * LIMIT構文の入口で意図が分かるエラーを返す。
     */
    const commaToken = bodyTokens.find((token) => token.token === ",");

    if (commaToken) {
      throw new SyntaxError(
        `LimitParser: comma LIMIT syntax is not supported by BigQuery ` +
        `(token_seq ${commaToken.token_seq}). Use LIMIT count OFFSET skip_rows.`
      );
    }

    const baseDepth = bodyTokens[0].paren_depth;
    const offsetIndexes = [];

    /*
     * 関数や括弧式の内部にOFFSETという識別子があっても境界にしないよう、
     * LIMIT本文と同じ括弧深度にあるOFFSETだけを候補にする。
     */
    for (let tokenIndex = 0; tokenIndex < bodyTokens.length; tokenIndex++) {
      const token = bodyTokens[tokenIndex];

      if (
        token.normalized_token === "OFFSET" &&
        token.paren_depth === baseDepth
      ) {
        offsetIndexes.push(tokenIndex);
      }
    }

    if (offsetIndexes.length > 1) {
      throw new SyntaxError("LimitParser: LIMIT Clause contains multiple OFFSET keywords.");
    }

    const offsetIndex = offsetIndexes.length === 1 ? offsetIndexes[0] : -1;
    const countTokens = offsetIndex >= 0
      ? bodyTokens.slice(0, offsetIndex)
      : bodyTokens.slice();
    const offsetTokens = offsetIndex >= 0
      ? bodyTokens.slice(offsetIndex + 1)
      : [];

    if (countTokens.length === 0) {
      throw new SyntaxError("LimitParser: LIMIT count expression is missing.");
    }

    if (offsetIndex >= 0 && offsetTokens.length === 0) {
      throw new SyntaxError("LimitParser: OFFSET expression is missing.");
    }

    const countExpression = this.#parseExpressionRange(countTokens, "count");
    const offsetExpression = offsetTokens.length > 0
      ? this.#parseExpressionRange(offsetTokens, "offset")
      : null;

    return {
      clause_type: "LIMIT",
      clause_start_seq: limitClause.clause_start_seq,
      clause_end_seq: limitClause.clause_end_seq,
      body_start_seq: limitClause.body_start_seq,
      body_end_seq: limitClause.body_end_seq,
      count_expression: countExpression,
      offset_expression: offsetExpression,
      start_token_seq: limitClause.clause_start_seq,
      end_token_seq: bodyTokens[bodyTokens.length - 1].token_seq
    };
  }

  /**
   * Token配列の先頭・末尾token_seqをExpressionParserへ渡す。
   *
   * countとoffsetの文法解析をLimitParser内へ重複実装せず、四則演算や括弧など
   * 既存Expression文法をそのまま再利用するためのメソッド。
   *
   * @param {Array<object>} expressionTokens
   * @param {string} expressionName エラーメッセージ用名称
   * @returns {object}
   */
  #parseExpressionRange(expressionTokens, expressionName) {
    const firstToken = expressionTokens[0];
    const lastToken = expressionTokens[expressionTokens.length - 1];

    try {
      return this.expressionParser.parseExpression(
        firstToken.token_seq,
        lastToken.token_seq
      );
    } catch (error) {
      throw new SyntaxError(
        `LimitParser: invalid ${expressionName} expression. ${error.message}`
      );
    }
  }

  /**
   * 解析入口の引数を検証する。
   *
   * Token範囲だけなら他Clauseも一部解析できてしまうため、Clause種別を先に
   * 確認し、呼び出し側の誤りを早期に検出する。
   *
   * @param {object} limitClause
   */
  #validateLimitClause(limitClause) {
    if (!limitClause || typeof limitClause !== "object") {
      throw new TypeError("LimitParser: limitClause must be an object.");
    }

    if (limitClause.clause_type !== "LIMIT") {
      throw new TypeError(
        `LimitParser: LIMIT Clause was expected, but received ` +
        `"${limitClause.clause_type}".`
      );
    }

    if (!Number.isInteger(limitClause.body_start_seq)) {
      throw new RangeError("LimitParser: body_start_seq must be an integer.");
    }

    if (!Number.isInteger(limitClause.body_end_seq)) {
      throw new RangeError("LimitParser: body_end_seq must be an integer.");
    }

    if (limitClause.body_end_seq < limitClause.body_start_seq) {
      throw new SyntaxError("LimitParser: LIMIT Clause body is empty.");
    }
  }
}
