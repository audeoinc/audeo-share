/**
 * SQL式を演算子優先順位付きASTへ変換する再帰下降Parser。
 *
 * Public APIはparseExpression()のみ。privateメソッドの呼び出し階層が
 * SQL演算子の優先順位を表す。
 */
class ExpressionParser {
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("ExpressionParser: tokens must be an array.");
    }

    this.sourceTokens = tokens;
    this.tokens = [];
    this.index = 0;
  }

  parseExpression(startTokenSeq = null, endTokenSeq = null) {
    const expressionTokens = this.#selectExpressionTokens(startTokenSeq, endTokenSeq);

    /* 元Token配列は変更せず、Expression解析用配列だけからコメントを除く。 */
    this.tokens = this.#removeCommentTokens(expressionTokens);
    this.index = 0;

    if (this.tokens.length === 0) {
      throw new SyntaxError("ExpressionParser: expression contains no tokens.");
    }

    const expressionNode = this.#parseOrExpression();

    if (!this.#isEnd()) {
      const token = this.#current();
      throw new SyntaxError(
        `ExpressionParser: unexpected token "${token.token}" at token_seq ${token.token_seq}.`
      );
    }

    return expressionNode;
  }

  #parseOrExpression() {
    let leftNode = this.#parseAndExpression();

    while (this.#matches("OR")) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseAndExpression();
      leftNode = AstFactory.createBinary(
        NodeType.LOGICAL_EXPRESSION,
        operatorToken.normalized_token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseAndExpression() {
    let leftNode = this.#parseNotExpression();

    while (this.#matches("AND")) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseNotExpression();
      leftNode = AstFactory.createBinary(
        NodeType.LOGICAL_EXPRESSION,
        operatorToken.normalized_token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseNotExpression() {
    if (this.#matches("NOT") && this.#peek(1)?.normalized_token === "EXISTS") {
      const notToken = this.#consume();
      return this.#parseExistsExpression(true, notToken.token_seq);
    }

    if (this.#matches("NOT")) {
      const operatorToken = this.#consume();
      const operandNode = this.#parseNotExpression();
      return AstFactory.createUnary(
        operatorToken.normalized_token,
        operatorToken.token_seq,
        operandNode
      );
    }

    return this.#parseComparisonExpression();
  }

  #parseComparisonExpression() {
    const leftNode = this.#parseConcatenationExpression();

    if (this.#matchesAny(["=", "!=", "<>", "<", "<=", ">", ">="])) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseConcatenationExpression();
      return AstFactory.createBinary(
        NodeType.COMPARISON_EXPRESSION,
        operatorToken.normalized_token,
        leftNode,
        rightNode
      );
    }

    if (this.#matches("IN")) {
      this.#consume();
      return this.#parseInExpression(leftNode, false);
    }

    if (this.#matches("BETWEEN")) {
      this.#consume();
      return this.#parseBetweenExpression(leftNode, false);
    }

    if (this.#matches("IS")) {
      this.#consume();
      return this.#parseIsExpression(leftNode);
    }

    if (this.#matches("LIKE")) {
      return this.#parseLikeExpression(leftNode, false);
    }

    if (this.#matches("NOT")) {
      const markedIndex = this.index;
      this.#consume();

      if (this.#matches("IN")) {
        this.#consume();
        return this.#parseInExpression(leftNode, true);
      }

      if (this.#matches("BETWEEN")) {
        this.#consume();
        return this.#parseBetweenExpression(leftNode, true);
      }

      if (this.#matches("LIKE")) {
        return this.#parseLikeExpression(leftNode, true);
      }

      this.index = markedIndex;
    }

    return leftNode;
  }

  /*
   * `expr [NOT] LIKE pattern` を解析する。
   *
   * BigQueryの数量子付き `LIKE ANY|SOME|ALL (...)` にも対応する。数量子形は
   * パターン集合をINと同じ括弧内式リストとして取り込み、lineage上は左辺と
   * 各パターン式の依存を保持できれば十分なのでIN式として表現する。
   * 通常形は比較式(COMPARISON_EXPRESSION)として表現する。
   */
  #parseLikeExpression(leftNode, isNegated) {
    const operatorToken = this.#consume();
    const operatorText = isNegated ? "NOT LIKE" : operatorToken.normalized_token;

    if (this.#matchesAny(["ANY", "SOME", "ALL"])) {
      this.#consume();
      return this.#parseInExpression(leftNode, isNegated);
    }

    const rightNode = this.#parseConcatenationExpression();

    return AstFactory.createBinary(
      NodeType.COMPARISON_EXPRESSION,
      operatorText,
      leftNode,
      rightNode
    );
  }

  #parseConcatenationExpression() {
    let leftNode = this.#parseAdditiveExpression();

    while (this.#matches("||", false)) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseAdditiveExpression();
      leftNode = AstFactory.createBinary(
        NodeType.CONCATENATION_EXPRESSION,
        operatorToken.token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseAdditiveExpression() {
    let leftNode = this.#parseMultiplicativeExpression();

    while (this.#matchesAny(["+", "-"], false)) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseMultiplicativeExpression();
      leftNode = AstFactory.createBinary(
        NodeType.ARITHMETIC_EXPRESSION,
        operatorToken.token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseMultiplicativeExpression() {
    let leftNode = this.#parseUnaryExpression();

    while (this.#matchesAny(["*", "/", "%"], false)) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseUnaryExpression();
      leftNode = AstFactory.createBinary(
        NodeType.ARITHMETIC_EXPRESSION,
        operatorToken.token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseUnaryExpression() {
    if (this.#matchesAny(["+", "-"], false)) {
      const operatorToken = this.#consume();
      const operandNode = this.#parseUnaryExpression();
      return AstFactory.createUnary(operatorToken.token, operatorToken.token_seq, operandNode);
    }

    return this.#parsePostfixExpression();
  }

  /**
   * Primary Expressionの直後に続く後置構文を解析する。
   *
   * 現在はウィンドウ関数のOVER句を対象とする。
   * 関数呼び出しを先にPrimaryとして作成し、その後ろのOVERを結び付ける。
   */
  #parsePostfixExpression() {
    let expressionNode = this.#parsePrimaryExpression();

    while (true) {
      if (this.#matches("OVER")) {
        expressionNode = this.#parseWindowExpression(expressionNode);
        continue;
      }

      // Array element access: base[OFFSET(n)] / [SAFE_OFFSET(n)] /
      // [ORDINAL(n)] / [SAFE_ORDINAL(n)] / [expr]. A '[' here is postfix
      // (subscript); a leading '[' (array literal) is handled in the primary.
      if (this.#matches("[", false)) {
        expressionNode = this.#parseArraySubscript(expressionNode);
        continue;
      }

      // Field access on a completed value expression: fn(...).field,
      // (expr).field, arr[i].field. This '.' follows a call / parenthesized /
      // subscript result, NOT an identifier chain (a.b.c is fully consumed by
      // #parseIdentifierOrFunctionCall before it returns, so its '.' never
      // reaches here). Guard on an identifier after the dot so a stray '.' still
      // falls through unchanged.
      if (this.#matches(".", false)) {
        const afterDot = this.#peek(1);

        if (afterDot && (this.#isIdentifierToken(afterDot) || afterDot.token === "*")) {
          expressionNode = this.#parseFieldAccess(expressionNode);
          continue;
        }
      }

      break;
    }

    return expressionNode;
  }

  /**
   * 後置の配列添字アクセス base[...] を解析する。
   *
   * BigQueryの位置指定 OFFSET / SAFE_OFFSET / ORDINAL / SAFE_ORDINAL は、位置を
   * 表すだけでlineageを持たないため、その引数（添字式）だけを残す。要素値の
   * lineageは配列式（base）の元列に由来する。baseと添字式の両方を子に持つ合成
   * 呼び出しノードにして、依存収集が両者を辿れるようにする。
   */
  #parseArraySubscript(baseNode) {
    const openBracket = this.#expect("[", false);
    let indexNode;

    if (this.#matchesAny(["OFFSET", "ORDINAL", "SAFE_OFFSET", "SAFE_ORDINAL"])) {
      this.#consume();
      this.#expect("(", false);
      indexNode = this.#parseOrExpression();
      this.#expect(")", false);
    } else {
      indexNode = this.#parseOrExpression();
    }

    const closeBracket = this.#expect("]", false);

    const nameToken = {
      token_seq: baseNode.start_token_seq,
      token: "[",
      normalized_token: "["
    };

    return AstFactory.createFunctionCall(
      [nameToken],
      [baseNode, indexNode],
      openBracket,
      closeBracket
    );
  }

  /**
   * 完了済みの値式（関数呼び出し / 括弧式 / 添字アクセスの結果）に続く後置の
   * フィールドアクセス base.field を解析する。
   *
   * ここでの '.' は「値」に対するフィールド選択であり、識別子チェーン a.b.c
   * （#parseIdentifierOrFunctionCall が先に消費する）とは異なる。関数の戻り値
   * などの不透明/派生値の STRUCT フィールドを指すため、末尾フィールド名は物理列
   * として解決せず lineage を持たない。base（関数なら引数）の lineage だけを
   * 残す。位置キーワードを非計上にした配列添字 base[...] と同じ設計。
   * 例：myfn('key', event_params).string_value → 依存は event_params のみ、
   * .string_value は非計上（かつては RAW_EXPRESSION に退避して string_value を
   * 裸の列として誤解決し PHYSICAL_COLUMN_NOT_FOUND を出していた）。
   */
  #parseFieldAccess(baseNode) {
    const dotToken = this.#expect(".", false);
    const fieldToken = this.#consume();

    const nameToken = {
      token_seq: baseNode.start_token_seq,
      token: ".",
      normalized_token: "."
    };

    return AstFactory.createFunctionCall(
      [nameToken],
      [baseNode],
      dotToken,
      fieldToken
    );
  }

  #parsePrimaryExpression() {
    const token = this.#current();

    if (!token) {
      throw new SyntaxError("ExpressionParser: expression ended unexpectedly.");
    }

    if (token.normalized_token === "CASE") {
      return this.#parseCaseExpression();
    }

    if (token.normalized_token === "EXISTS") {
      return this.#parseExistsExpression(false, token.token_seq);
    }

    if (token.token === "(") {
      return this.#parseParenthesizedExpression();
    }

    if (token.token === "[") {
      return this.#parseArrayLiteral();
    }

    if (this.#isTypedLiteralPrefix(token)) {
      return this.#parseTypedLiteral();
    }

    if (token.normalized_token === "INTERVAL") {
      return this.#parseIntervalExpression();
    }

    if (this.#isLiteralToken(token)) {
      return this.#parseLiteral();
    }

    // Typed STRUCT constructor STRUCT<field type, ...>(v1, v2, ...). The angle-
    // bracket type list is not a comparison; skip it and keep the value lineage.
    if (
      token.normalized_token === "STRUCT" &&
      this.#peek(1) &&
      this.#peek(1).token === "<"
    ) {
      return this.#parseTypedStruct();
    }

    // Typed ARRAY constructor ARRAY<element type>[e1, e2, ...] (or ARRAY<...>(
    // SELECT ...)). The angle-bracket type is skipped; the element/subquery
    // lineage is kept.
    if (
      token.normalized_token === "ARRAY" &&
      this.#peek(1) &&
      this.#peek(1).token === "<"
    ) {
      return this.#parseTypedArray();
    }

    if (this.#isIdentifierToken(token) || token.token === "*") {
      return this.#parseIdentifierOrFunctionCall();
    }

    // BigQuery named query parameter @name (and @@system_variable), e.g. the
    // dbt-style @key / @limit placeholders in JOBS-collected SQL. The lexer emits
    // the whole thing as one PARAMETER token. A parameter is an external scalar
    // value, not a table column, so it carries no lineage (treated as a literal).
    if (token.token_type === "PARAMETER") {
      this.#consume();
      return AstFactory.createLiteral(token, "PARAMETER", null);
    }

    throw new SyntaxError(
      `ExpressionParser: token "${token.token}" cannot start an expression ` +
      `(token_seq ${token.token_seq}).`
    );
  }

  /**
   * 名前付きクエリパラメータ @name / システム変数 @@name を解析する。
   *
   * パラメータは外部から与えられるスカラー値であってテーブル列ではないため、
   * lineage を持たない。リテラル同様に LITERAL_EXPRESSION として扱い、列参照を
   * 生成しない。Lexer は '@' を単独 Token として返し、名前がそれに続く
   * （@@ の場合は '@' が 2 つ）。
   */
  /**
   * EXTRACT の先頭に置かれるデートパートを読み飛ばす（lineage を持たない）。
   * 単一のパート Token（MONTH / WEEK / DATE / DAYOFWEEK / ISOWEEK ...）に加え、
   * WEEK(<WEEKDAY>) の括弧付き形も消費する。
   */
  #consumeDatePart() {
    this.#consume();

    if (this.#matches("(", false)) {
      this.#consume();

      while (!this.#isEnd() && !this.#matches(")", false)) {
        this.#consume();
      }

      this.#expect(")", false);
    }
  }

  /**
   * 型付き STRUCT コンストラクタ STRUCT<field type, ...>(v1, v2, ...) を解析する。
   * 山括弧の型パラメータ（`<` ... `>`、ネスト可）は列参照を持たないため読み飛ばし、
   * 値リスト (v1, v2, ...) の各要素を lineage 付きで EXPRESSION_LIST として返す。
   */
  #parseTypedStruct() {
    this.#consume();
    this.#skipAngleBracketType();

    const openToken = this.#expect("(", false);
    const items = [];

    if (!this.#matches(")", false)) {
      while (true) {
        items.push(this.#parseOrExpression());

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    const closeToken = this.#expect(")", false);
    return AstFactory.createExpressionList(items, openToken, closeToken);
  }

  /**
   * 型付き ARRAY コンストラクタ ARRAY<element type>[e1, e2, ...] を解析する。
   * 山括弧の型を読み飛ばし、要素配列リテラル（または ARRAY<...>(SELECT ...)）の
   * lineage を保持する。
   */
  #parseTypedArray() {
    this.#consume();
    this.#skipAngleBracketType();

    if (this.#matches("[", false)) {
      return this.#parseArrayLiteral();
    }

    const openToken = this.#expect("(", false);
    return this.#parseRawSubquery(openToken, "ARRAY");
  }

  /**
   * 山括弧の型パラメータ `<` ... `>`（ネスト可）を読み飛ばす。開き山括弧に
   * 位置している前提で呼ぶ。型パラメータは列参照を持たない。
   */
  #skipAngleBracketType() {
    this.#expect("<", false);

    let angleDepth = 1;

    while (!this.#isEnd() && angleDepth > 0) {
      const typeToken = this.#consume();

      if (typeToken.token === "<") {
        angleDepth += 1;
      } else if (typeToken.token === ">") {
        angleDepth -= 1;
      }
    }
  }

  /**
   * 関数呼び出しに続くOVER句を解析する。
   *
   * 対象例:
   *   ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC)
   *
   * OVERは通常の二項演算子ではなく、直前の関数呼び出しへ
   * Window Specificationを付加する後置構文として扱う。
   */
  #parseWindowExpression(functionNode) {
    if (functionNode.node_type !== NodeType.FUNCTION_CALL_EXPRESSION) {
      throw new SyntaxError(
        "ExpressionParser: OVER must follow a function call."
      );
    }

    const overToken = this.#expect("OVER");

    /*
     * BigQueryではOVER named_windowの形式も利用できる。
     * 括弧がなければWindow名を識別子として保持する。
     */
    if (!this.#matches("(", false)) {
      const windowName = this.#parseIdentifierOrFunctionCall();

      if (windowName.node_type !== NodeType.IDENTIFIER_EXPRESSION) {
        throw new SyntaxError(
          "ExpressionParser: a window name was expected after OVER."
        );
      }

      const specification = AstFactory.createWindowSpecification(
        null,
        null,
        [],
        [],
        [],
        windowName
      );

      return AstFactory.createWindowExpression(
        functionNode,
        specification,
        overToken.token_seq
      );
    }

    const openToken = this.#expect("(", false);
    const partitionBy = [];
    const orderBy = [];
    const frameTokens = [];

    if (this.#matches("PARTITION")) {
      this.#consume();
      this.#expect("BY");

      while (true) {
        partitionBy.push(
          this.#parseWindowSubExpression(["ORDER", "ROWS", "RANGE", "GROUPS"], [",", ")"])
        );

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    if (this.#matches("ORDER")) {
      this.#consume();
      this.#expect("BY");

      while (true) {
        orderBy.push(this.#parseWindowOrderItem());

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    /*
     * ROWS / RANGE / GROUPSのFrame句は、v1では意味解析せずToken情報を保持する。
     * Window境界を失わないため、閉じ括弧までのTokenを保存する。
     */
    if (this.#matchesAny(["ROWS", "RANGE", "GROUPS"])) {
      while (!this.#isEnd() && !this.#matches(")", false)) {
        const token = this.#consume();
        frameTokens.push({
          token_seq: token.token_seq,
          token: token.token,
          normalized_token: token.normalized_token
        });
      }
    }

    const closeToken = this.#expect(")", false);
    const specification = AstFactory.createWindowSpecification(
      openToken,
      closeToken,
      partitionBy,
      orderBy,
      frameTokens
    );

    return AstFactory.createWindowExpression(
      functionNode,
      specification,
      overToken.token_seq
    );
  }

  /**
   * Window内ORDER BYの1項目を解析する。
   *
   * 通常Expressionに加えて、ASC/DESCとNULLS FIRST/LASTを属性として保持する。
   */
  #parseWindowOrderItem() {
    const expressionNode = this.#parseWindowSubExpression(
      ["ASC", "DESC", "NULLS", "ROWS", "RANGE", "GROUPS"],
      [",", ")"]
    );
    let direction = null;
    let nullsOrder = null;

    if (this.#matchesAny(["ASC", "DESC"])) {
      direction = this.#consume().normalized_token;
    }

    if (this.#matches("NULLS")) {
      this.#consume();

      if (!this.#matchesAny(["FIRST", "LAST"])) {
        throw new SyntaxError(
          "ExpressionParser: NULLS must be followed by FIRST or LAST."
        );
      }

      nullsOrder = this.#consume().normalized_token;
    }

    return AstFactory.createWindowOrderItem(
      expressionNode,
      direction,
      nullsOrder
    );
  }

  /**
   * Window Specification内の1つの式だけを切り出して解析する。
   *
   * 親ExpressionParserの現在位置を維持しながら、区切りToken直前までを
   * 子ExpressionParserへ渡す。これによりPARTITION BYやORDER BY内部でも、
   * 通常の関数・算術式・CASE式を再利用できる。
   */
  #parseWindowSubExpression(stopKeywords, stopTokens) {
    const startIndex = this.index;
    let nestedDepth = 0;

    while (!this.#isEnd()) {
      const token = this.#current();

      if (token.token === "(") {
        nestedDepth++;
        this.index++;
        continue;
      }

      if (token.token === ")") {
        /*
         * 深さ0の ")" だけがWindow Specificationやサブ式の終端になりうる。
         * 内側の関数呼び出し（例: SAFE_CAST(...)）を閉じる ")" は深さ1以上で
         * 現れるため、ここで終端と誤認せずに深さを戻して読み進める。
         */
        if (nestedDepth === 0 && stopTokens.includes(")")) {
          break;
        }

        nestedDepth--;
        this.index++;
        continue;
      }

      if (nestedDepth === 0) {
        if (stopTokens.includes(token.token)) {
          break;
        }

        if (stopKeywords.includes(token.normalized_token)) {
          break;
        }
      }

      this.index++;
    }

    const expressionTokens = this.tokens.slice(startIndex, this.index);

    if (expressionTokens.length === 0) {
      const currentToken = this.#current();
      throw new SyntaxError(
        `ExpressionParser: window expression was expected before ` +
        `"${currentToken ? currentToken.token : "EOF"}".`
      );
    }

    try {
      return new ExpressionParser(expressionTokens).parseExpression();
    } catch (error) {
      return createRawExpressionAst(expressionTokens);
    }
  }

  #parseCaseExpression() {
    const caseToken = this.#expect("CASE");
    let caseOperand = null;
    const whenClauses = [];
    let elseExpression = null;

    /* CASE直後がWHENでなければ、単純CASEの比較対象を解析する。 */
    if (!this.#matches("WHEN")) {
      caseOperand = this.#parseOrExpression();
    }

    while (this.#matches("WHEN")) {
      const whenToken = this.#consume();
      const conditionNode = this.#parseOrExpression();
      this.#expect("THEN");
      const resultNode = this.#parseOrExpression();
      whenClauses.push(
        AstFactory.createCaseWhen(conditionNode, resultNode, whenToken.token_seq)
      );
    }

    if (whenClauses.length === 0) {
      throw new SyntaxError("ExpressionParser: CASE requires at least one WHEN clause.");
    }

    if (this.#matches("ELSE")) {
      this.#consume();
      elseExpression = this.#parseOrExpression();
    }

    const endToken = this.#expect("END");
    return AstFactory.createCase(
      caseToken,
      caseOperand,
      whenClauses,
      elseExpression,
      endToken
    );
  }

  #parseExistsExpression(negated, startTokenSeq) {
    const existsToken = this.#expect("EXISTS");
    const openToken = this.#expect("(", false);

    if (!this.#matches("SELECT") && !this.#matches("WITH")) {
      throw new SyntaxError("ExpressionParser: EXISTS must contain a subquery.");
    }

    const subqueryNode = this.#parseRawSubquery(openToken);
    return AstFactory.createExists(
      negated ? startTokenSeq : existsToken.token_seq,
      subqueryNode,
      negated
    );
  }

  #parseIdentifierOrFunctionCall() {
    const nameTokens = [];
    const firstToken = this.#consume();
    nameTokens.push(firstToken);

    while (this.#matches(".", false)) {
      const dotToken = this.#consume();
      const nextToken = this.#current();

      if (!nextToken || (!this.#isIdentifierToken(nextToken) && nextToken.token !== "*")) {
        throw new SyntaxError(
          `ExpressionParser: identifier expected after token_seq ${dotToken.token_seq}.`
        );
      }

      nameTokens.push(dotToken);
      nameTokens.push(this.#consume());
    }

    if (this.#matches("(", false)) {
      return this.#parseFunctionCall(nameTokens);
    }

    if (nameTokens.at(-1).token === "*") {
      return AstFactory.createWildcard(nameTokens);
    }

    return AstFactory.createIdentifier(nameTokens);
  }

  #parseFunctionCall(nameTokens) {
    const openToken = this.#expect("(", false);
    const functionName = nameTokens
      .filter((token) => token.token !== ".")
      .map((token) => token.normalized_token)
      .join(".");

    /*
     * ARRAY(SELECT ...)は通常の関数引数ではない。
     * 括弧内を独立したQueryとして解析し、ARRAY_SUBQUERY_EXPRESSIONを返す。
     */
    if (
      functionName === "ARRAY" &&
      (this.#matches("SELECT") || this.#matches("WITH"))
    ) {
      return this.#parseRawSubquery(openToken, "ARRAY");
    }

    /*
     * CAST(expr AS type) / SAFE_CAST(expr AS type)。
     * 引数は「値式 AS 型」であり、通常の関数引数リストではない。
     * 値式だけを子Nodeに持つFUNCTION_CALLとして構築し、型指定Tokenは
     * lineageに寄与しないため読み飛ばす。型指定は精度付き型 NUMERIC(10, 2)、
     * 山括弧パラメータ ARRAY<INT64> / STRUCT<a INT64, b STRING>、末尾の
     * FORMAT 'pattern' 句を含みうる。CASTを閉じる ")" は括弧深さで判定する。
     */
    if (functionName === "CAST" || functionName === "SAFE_CAST") {
      const valueNode = this.#parseOrExpression();
      this.#expect("AS");

      let typeParenDepth = 0;
      while (!this.#isEnd()) {
        if (this.#matches("(", false)) {
          typeParenDepth += 1;
          this.#consume();
          continue;
        }
        if (this.#matches(")", false)) {
          if (typeParenDepth === 0) {
            break;
          }
          typeParenDepth -= 1;
          this.#consume();
          continue;
        }
        this.#consume();
      }

      const castCloseToken = this.#expect(")", false);
      return AstFactory.createFunctionCall(
        nameTokens,
        [valueNode],
        openToken,
        castCloseToken,
        null
      );
    }

    /*
     * EXTRACT(part FROM expr [AT TIME ZONE tz]) は通常の引数リストではない。
     * part はデートパート（MONTH / WEEK / DATE / ISOWEEK ... あるいは
     * WEEK(<WEEKDAY>)）で列参照ではないため lineage を持たない。ソース式
     * (expr) と、あれば時間帯式 (tz) だけを子として保持する。
     */
    if (functionName === "EXTRACT") {
      this.#consumeDatePart();
      this.#expect("FROM");

      const extractChildren = [this.#parseOrExpression()];

      if (this.#matches("AT")) {
        this.#consume();
        this.#expect("TIME");
        this.#expect("ZONE");
        extractChildren.push(this.#parseOrExpression());
      }

      const extractCloseToken = this.#expect(")", false);
      return AstFactory.createFunctionCall(
        nameTokens,
        extractChildren,
        openToken,
        extractCloseToken,
        null
      );
    }

    /*
     * WEEK(<WEEKDAY>) はスカラー関数ではなくデートパート（DATE_TRUNC 等の粒度
     * 指定に現れる）。WEEKDAY（MONDAY 等）は列ではないため lineage を持たない。
     */
    if (functionName === "WEEK") {
      while (!this.#isEnd() && !this.#matches(")", false)) {
        this.#consume();
      }

      const weekCloseToken = this.#expect(")", false);
      return AstFactory.createLiteral(weekCloseToken, "DATE_PART", null);
    }

    const argumentsList = [];
    let argumentModifier = null;

    /*
     * COUNT(DISTINCT column) など、関数引数の先頭に置かれる修飾子を扱う。
     * DISTINCT自体は列参照ではないため、引数ASTとは分離して保持する。
     */
    if (this.#matches("DISTINCT")) {
      argumentModifier = this.#consume().normalized_token;
    }

    if (!this.#matches(")", false)) {
      while (true) {
        argumentsList.push(this.#parseOrExpression());

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    /*
     * 集約/ナビゲーション関数の引数末尾に付く修飾句を消費する。
     *   ARRAY_AGG(x IGNORE NULLS ORDER BY ts LIMIT 5)
     *   FIRST_VALUE(x RESPECT NULLS)
     *   STRING_AGG(x, ',' ORDER BY y)
     * NULL処理(IGNORE|RESPECT NULLS)とLIMITは列系統に寄与しない。ORDER BY /
     * HAVING MAX|MIN の式は依存として引数リストへ取り込む。
     */
    this.#consumeFunctionArgumentSuffixes(argumentsList);

    const closeToken = this.#expect(")", false);
    return AstFactory.createFunctionCall(
      nameTokens,
      argumentsList,
      openToken,
      closeToken,
      argumentModifier
    );
  }

  #consumeFunctionArgumentSuffixes(argumentsList) {
    while (!this.#isEnd() && !this.#matches(")", false)) {
      if (this.#matches("IGNORE") || this.#matches("RESPECT")) {
        this.#consume();

        if (this.#matches("NULLS")) {
          this.#consume();
        }

        continue;
      }

      if (this.#matches("ORDER")) {
        this.#consume();
        this.#expect("BY");

        while (true) {
          argumentsList.push(this.#parseOrExpression());

          if (this.#matchesAny(["ASC", "DESC"])) {
            this.#consume();
          }

          if (this.#matches("NULLS")) {
            this.#consume();

            if (this.#matchesAny(["FIRST", "LAST"])) {
              this.#consume();
            }
          }

          if (!this.#matches(",", false)) {
            break;
          }

          this.#consume();
        }

        continue;
      }

      if (this.#matches("LIMIT")) {
        this.#consume();
        this.#parseOrExpression();
        continue;
      }

      if (this.#matches("HAVING")) {
        this.#consume();

        if (this.#matchesAny(["MAX", "MIN"])) {
          this.#consume();
        }

        argumentsList.push(this.#parseOrExpression());
        continue;
      }

      break;
    }
  }

  #parseParenthesizedExpression() {
    const openToken = this.#expect("(", false);

    if (this.#matches("SELECT") || this.#matches("WITH")) {
      return this.#parseRawSubquery(openToken);
    }

    const expressionNode = this.#parseOrExpression();

    /*
     * カンマが続く場合はタプル / STRUCT の行値。例：(a, b) IN (...) の左辺や、
     * 型付き STRUCT 配列リテラルの各行 (v1, v2)。各要素の lineage を保持するため
     * EXPRESSION_LIST として返す。
     */
    if (this.#matches(",", false)) {
      const items = [expressionNode];

      while (this.#matches(",", false)) {
        this.#consume();
        items.push(this.#parseOrExpression());
      }

      const listCloseToken = this.#expect(")", false);
      return AstFactory.createExpressionList(items, openToken, listCloseToken);
    }

    const closeToken = this.#expect(")", false);
    return AstFactory.createParenthesized(expressionNode, openToken, closeToken);
  }

  /*
   * 配列リテラル [e1, e2, ...] を解析する。要素式の列依存を保持できるよう
   * EXPRESSION_LIST ノードとして返す(UNNEST([...]) や SELECT [...] で使用)。
   */
  #parseArrayLiteral() {
    const openToken = this.#expect("[", false);
    const items = [];

    if (!this.#matches("]", false)) {
      while (true) {
        items.push(this.#parseOrExpression());

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    const closeToken = this.#expect("]", false);

    return AstFactory.createExpressionList(items, openToken, closeToken);
  }

  #parseInExpression(leftNode, negated) {
    /*
     * `x IN UNNEST(array_expr)` 形式。配列式の依存を保持する。
     */
    if (this.#matches("UNNEST")) {
      this.#consume();
      const unnestOpen = this.#expect("(", false);
      const arrayNode = this.#parseOrExpression();
      const unnestClose = this.#expect(")", false);
      const unnestValues = AstFactory.createExpressionList(
        [arrayNode],
        unnestOpen,
        unnestClose
      );

      return AstFactory.createIn(leftNode, unnestValues, negated);
    }

    const openToken = this.#expect("(", false);

    if (this.#matches("SELECT") || this.#matches("WITH")) {
      return AstFactory.createIn(leftNode, this.#parseRawSubquery(openToken), negated);
    }

    const values = [];

    if (!this.#matches(")", false)) {
      while (true) {
        values.push(this.#parseOrExpression());

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    const closeToken = this.#expect(")", false);
    const valuesNode = AstFactory.createExpressionList(values, openToken, closeToken);
    return AstFactory.createIn(leftNode, valuesNode, negated);
  }

  #parseBetweenExpression(leftNode, negated) {
    const lowerNode = this.#parseConcatenationExpression();
    this.#expect("AND");
    const upperNode = this.#parseConcatenationExpression();
    return AstFactory.createBetween(leftNode, lowerNode, upperNode, negated);
  }

  #parseIsExpression(leftNode) {
    let negated = false;

    if (this.#matches("NOT")) {
      this.#consume();
      negated = true;
    }

    if (this.#matches("DISTINCT")) {
      this.#consume();
      this.#expect("FROM");
      const rightNode = this.#parseConcatenationExpression();
      return AstFactory.createDistinctFrom(leftNode, rightNode, negated);
    }

    const testToken = this.#current();

    if (!testToken || !["NULL", "TRUE", "FALSE"].includes(testToken.normalized_token)) {
      throw new SyntaxError(
        "ExpressionParser: IS must be followed by NULL, TRUE, FALSE, or [NOT] DISTINCT FROM."
      );
    }

    this.#consume();
    return AstFactory.createIs(leftNode, testToken.normalized_token, negated, testToken.token_seq);
  }

  #parseLiteral() {
    const token = this.#consume();
    let literalType = token.token_type;
    let value = token.token;

    if (["NULL", "TRUE", "FALSE"].includes(token.normalized_token)) {
      literalType = token.normalized_token;
      value = token.normalized_token;
    }

    return AstFactory.createLiteral(token, literalType, value);
  }

  /*
   * 型付きリテラル(DATE '2020-01-01' / TIMESTAMP '...' / NUMERIC '1.5' 等)か
   * どうかを判定する。型キーワードの直後が文字列リテラルの場合のみ真。
   * DATE(...) のような関数呼び出しと区別するため、次Tokenが "(" の場合は
   * 型付きリテラルとしない。
   */
  #isTypedLiteralPrefix(token) {
    const typedLiteralKeywords = new Set([
      "DATE", "DATETIME", "TIME", "TIMESTAMP",
      "NUMERIC", "BIGNUMERIC", "DECIMAL", "BIGDECIMAL",
      "BYTES", "JSON", "RANGE"
    ]);

    return typedLiteralKeywords.has(token.normalized_token) &&
      this.#peek(1)?.token_type === "STRING";
  }

  #parseTypedLiteral() {
    const typeToken = this.#consume();
    const literalToken = this.#consume();

    return AstFactory.createLiteral(
      literalToken,
      typeToken.normalized_token,
      literalToken.token
    );
  }

  /*
   * INTERVAL 式を解析する。
   *
   * 対応形:
   *   INTERVAL 1 DAY
   *   INTERVAL '1' DAY
   *   INTERVAL col HOUR            -- 値が列参照なら依存として保持される
   *   INTERVAL n * 2 DAY           -- 値が算術式でも可
   *   INTERVAL '1:2:3' HOUR TO SECOND
   *
   * lineage上は値部の依存を保持できれば十分なため、値部の式ノードを返し、
   * 後続の単位(および TO 単位)は消費して構文を成立させる。
   *
   * 値部は加減算・乗除算を含む式（int64式）を取り得る。単項精度だけで解析すると
   * `INTERVAL n * 2 DAY` のように演算子の後ろへ続く単位を取りこぼし、
   * 関数引数内では「expected ) but found <part>」、素の式では単位の誤解決を招く。
   * 日付単位(DAY等)は裸のキーワードで演算子ではないため、加減算精度で解析しても
   * 必ず単位の手前で停止し、過剰消費しない。
   */
  #parseIntervalExpression() {
    this.#consume();

    const valueNode = this.#parseAdditiveExpression();

    if (this.#current() && this.#isIdentifierToken(this.#current())) {
      this.#consume();

      if (this.#matches("TO") && this.#peek(1) &&
          this.#isIdentifierToken(this.#peek(1))) {
        this.#consume();
        this.#consume();
      }
    }

    return valueNode;
  }

  #parseRawSubquery(openToken, subqueryKind = "SCALAR") {
    const startIndex = this.index;
    let nestedDepth = 0;

    while (!this.#isEnd()) {
      const token = this.#current();

      if (token.token === "(") {
        nestedDepth++;
      } else if (token.token === ")") {
        if (nestedDepth === 0) {
          const closeToken = this.#consume();
          const subqueryTokens = this.tokens.slice(startIndex, this.index - 1);
          const normalizedTokens = this.#normalizeSubqueryDepth(subqueryTokens);
          const queryAst = new QueryParser(normalizedTokens, {
            isSubquery: true
          }).parse();

          return AstFactory.createSubquery(
            openToken,
            closeToken,
            subqueryTokens,
            queryAst,
            subqueryKind
          );
        }

        nestedDepth--;
      }

      this.#consume();
    }

    throw new SyntaxError(
      `ExpressionParser: subquery beginning at token_seq ${openToken.token_seq} has no closing parenthesis.`
    );
  }

  #normalizeSubqueryDepth(subqueryTokens) {
    if (subqueryTokens.length === 0) {
      return [];
    }

    const minimumDepth = Math.min(...subqueryTokens.map((token) => token.paren_depth));

    return subqueryTokens.map((token) => ({
      ...token,
      paren_depth: token.paren_depth - minimumDepth
    }));
  }

  #selectExpressionTokens(startTokenSeq, endTokenSeq) {
    if (startTokenSeq === null && endTokenSeq === null) {
      return this.sourceTokens.slice();
    }

    if (!Number.isInteger(startTokenSeq) || !Number.isInteger(endTokenSeq)) {
      throw new TypeError(
        "ExpressionParser.parseExpression: token sequences must both be integers."
      );
    }

    if (endTokenSeq < startTokenSeq) {
      throw new RangeError(
        "ExpressionParser.parseExpression: endTokenSeq is before startTokenSeq."
      );
    }

    return this.sourceTokens.filter((token) => {
      return token.token_seq >= startTokenSeq && token.token_seq <= endTokenSeq;
    });
  }

  #removeCommentTokens(tokens) {
    return tokens.filter((token) => token.token_type !== "COMMENT");
  }

  #isLiteralToken(token) {
    return token.token_type === "NUMBER" ||
      token.token_type === "STRING" ||
      ["NULL", "TRUE", "FALSE"].includes(token.normalized_token);
  }

  #isIdentifierToken(token) {
    const reserved = [
      "AND", "OR", "NOT", "IN", "BETWEEN", "IS", "LIKE", "NULL", "TRUE", "FALSE",
      "CASE", "WHEN", "THEN", "ELSE", "END", "EXISTS",
      "OVER", "PARTITION", "ORDER", "BY", "ROWS", "RANGE", "GROUPS",
      "ASC", "DESC", "NULLS", "FIRST", "LAST"
    ];

    return token.token_type === "IDENTIFIER" ||
      token.token_type === "BACKTICK_IDENTIFIER" ||
      (token.token_type === "KEYWORD" && !reserved.includes(token.normalized_token));
  }

  #current() {
    return this.tokens[this.index] || null;
  }

  #peek(offset = 0) {
    return this.tokens[this.index + offset] || null;
  }

  #consume() {
    const token = this.#current();
    if (token) this.index++;
    return token;
  }

  #isEnd() {
    return this.index >= this.tokens.length;
  }

  #matches(value, normalized = true) {
    const token = this.#current();
    if (!token) return false;

    const actualValue = normalized ? token.normalized_token : token.token;
    const expectedValue = normalized ? String(value).toUpperCase() : String(value);
    return actualValue === expectedValue;
  }

  #matchesAny(values, normalized = true) {
    return values.some((value) => this.#matches(value, normalized));
  }

  #expect(value, normalized = true) {
    if (!this.#matches(value, normalized)) {
      const token = this.#current();
      const actualValue = token ? token.token : "EOF";
      throw new SyntaxError(
        `ExpressionParser: expected "${value}", but found "${actualValue}".`
      );
    }

    return this.#consume();
  }
}
