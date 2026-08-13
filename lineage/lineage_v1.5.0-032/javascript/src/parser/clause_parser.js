/**
 * Lexerが生成したToken配列から、SQLのClause境界を抽出するParser。
 *
 * Clause Parserの責務:
 *
 * - SELECT、FROM、WHEREなどのClause開始位置を見つける。
 * - GROUP BY、ORDER BYのような複数TokenのClause名を1つにまとめる。
 * - 各Clauseの本文がどのtoken_seqからどこまでかを確定する。
 *
 * この段階では、SELECT項目やFROMのテーブル名など、Clause本文の
 * 詳細な意味解析は行わない。それらは後続のSelect Parser、From Parserへ
 * 委譲する。
 *
 * 基本版の対象Clause:
 *
 * - SELECT
 * - FROM
 * - WHERE
 * - GROUP BY
 * - HAVING
 * - QUALIFY
 * - ORDER BY
 * - LIMIT
 *
 * 返却する位置情報はすべてtoken_seq。
 * JavaScript配列のindexはTokenReaderやこのクラス内部の走査だけで使用し、
 * 後続Parserへは公開しない。
 *
 * @example
 * SELECT customer_id FROM sales WHERE amount > 0
 *
 * おおむね次の結果を返す。
 *
 * {
 *   clause_seq: 1,
 *   clause_type: "SELECT",
 *   clause_start_seq: 1,
 *   clause_end_seq: 1,
 *   body_start_seq: 2,
 *   body_end_seq: 2,
 *   paren_depth: 0
 * }
 */
class ClauseParser {
  /**
   * Clause Parserを初期化する。
   *
   * Token配列を直接走査する処理と、現在位置を進める処理を分離するため、
   * TokenReaderを内部に持つ。ClauseParser自身がindex管理を重複実装せず、
   * Readerのcurrent()、advance()、matches()などを利用する。
   *
   * @param {Array<object>} tokens Lexerが生成したToken配列
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("ClauseParser: tokens must be an array.");
    }

    /*
     * this.tokens:
     *   Clause本文の終了位置を求めるとき、Token全体を前後に確認するために使う。
     *
     * this.reader:
     *   メイン解析で現在位置を左から右へ進めるために使う。
     */
    this.tokens = tokens;
    this.reader = new TokenReader(tokens);
  }

  /**
   * Token配列を先頭から走査し、トップレベルClause一覧を返す。
   *
   * 処理の流れ:
   *
   * 1. Readerを先頭へ戻す。
   * 2. COMMENTと括弧内部のTokenをClause候補から除外する。
   * 3. 現在TokenがClause開始か#matchClause()で判定する。
   * 4. Clause開始・本文開始情報を一旦保存する。
   * 5. 全Clause検出後、次のClause位置を使って本文終了位置を設定する。
   *
   * 本文終了位置を後から設定する理由:
   * 現在Clauseを発見した時点では、次のClauseがどこに現れるかまだ
   * 分からないため。まず開始位置だけ集め、2回目の処理で境界を確定する。
   *
   * @returns {Array<object>} 検出したClause一覧
   */
  parse() {
    const clauses = [];

    // 同じParserインスタンスでparse()を再実行しても先頭から解析できるようにする。
    this.reader.reset();

    while (!this.reader.isEnd()) {
      const currentToken = this.reader.current();

      /*
       * COMMENT内のSELECTやFROMという文字列をClauseと誤認しないため、
       * COMMENT Tokenは判定対象から除外する。
       */
      if (currentToken.token_type === "COMMENT") {
        this.reader.advance();
        continue;
      }

      /*
       * この基本版ではSQL全体のトップレベルClauseだけを抽出する。
       *
       * 例:
       *
       * SELECT (SELECT x FROM inner_table) FROM outer_table
       *
       * 内側SELECT/FROMはparen_depthが1以上になるため除外し、
       * 外側SELECT/FROMだけをClauseとして返す。
       * サブクエリ解析は後続のQuery Parserへ委譲する。
       */
      if (currentToken.paren_depth !== 0) {
        this.reader.advance();
        continue;
      }

      // 現在位置が対応対象のClause開始か判定する。
      const clauseMatch = this.#matchClause();

      /*
       * Clauseではない通常Tokenなら、1Token進めて次を確認する。
       * 位置を進めないと同じTokenを評価し続けて無限ループになる。
       */
      if (!clauseMatch) {
        this.reader.advance();
        continue;
      }

      /*
       * Clauseを発見した時点ではbody_end_seqだけ未確定。
       * 次のClause開始位置が必要なので、parse()後半の#setBodyEndSeq()で設定する。
       */
      clauses.push({
        clause_seq: clauses.length + 1,
        clause_type: clauseMatch.clause_type,
        clause_start_seq: currentToken.token_seq,
        clause_end_seq: clauseMatch.clause_end_seq,
        body_start_seq: clauseMatch.body_start_seq,
        body_end_seq: null,
        paren_depth: currentToken.paren_depth
      });

      /*
       * Clause名を構成するTokenをまとめて消費する。
       *
       * SELECTなら1Token、GROUP BYならコメントを含めてBYまで進める。
       * ここで適切に進めることで、BYを単独Tokenとして再評価しない。
       */
      this.reader.advance(clauseMatch.token_count);
    }

    // すべてのClause開始位置が揃った後、各本文の終了位置を確定する。
    this.#setBodyEndSeq(clauses);

    return clauses;
  }


  /**
   * 現在位置のFROMが、Clause開始ではなく
   * IS [NOT] DISTINCT FROM演算子の一部か判定する。
   *
   * ClauseParserはトップレベルKeywordを走査するため、単純にFROMだけを見ると、
   * WHERE old_value IS DISTINCT FROM new_value
   * のFROMまで新しいFROM Clauseとして誤認してしまう。
   *
   * 現在Tokenより前の非COMMENT Tokenを確認し、
   *
   * - IS DISTINCT FROM
   * - IS NOT DISTINCT FROM
   *
   * の並びならClause開始ではないと判断する。
   *
   * @returns {boolean}
   */
  #isDistinctFromOperator() {
    const currentToken = this.reader.current();
    const currentIndex = this.tokens.findIndex(
      (token) => token.token_seq === currentToken.token_seq
    );
    const previousKeywords = [];

    for (let tokenIndex = currentIndex - 1; tokenIndex >= 0; tokenIndex--) {
      const token = this.tokens[tokenIndex];

      if (token.token_type === "COMMENT") {
        continue;
      }

      previousKeywords.unshift(token.normalized_token);

      if (previousKeywords.length === 3) {
        break;
      }
    }

    const lastTwo = previousKeywords.slice(-2).join(" ");
    const lastThree = previousKeywords.slice(-3).join(" ");

    return lastTwo === "IS DISTINCT" || lastThree === "IS NOT DISTINCT";
  }

  /**
   * 現在Reader位置が、対応対象のClause開始Tokenか判定する。
   *
   * このメソッドが必要な理由:
   * parse()本体に全Keyword判定を直接書くと、走査処理とClause定義が混ざり、
   * Clause追加時の修正範囲が広くなる。判定をprivateメソッドへ分離することで、
   * parse()は「走査」、このメソッドは「Clause種類の識別」に専念できる。
   *
   * 1 Token Clauseは#createSingleTokenClause()、2 Token Clauseは
   * #createTwoTokenClause()へ処理を委譲し、戻り値の形式を統一する。
   *
   * @returns {object|null} Clause情報。Clause開始でなければnull
   */
  #matchClause() {
    if (this.reader.matches("SELECT")) {
      return this.#createSingleTokenClause("SELECT");
    }

    if (this.reader.matches("FROM") && !this.#isDistinctFromOperator()) {
      return this.#createSingleTokenClause("FROM");
    }

    if (this.reader.matches("WHERE")) {
      return this.#createSingleTokenClause("WHERE");
    }

    if (this.reader.matches("HAVING")) {
      return this.#createSingleTokenClause("HAVING");
    }

    if (this.reader.matches("QUALIFY")) {
      return this.#createSingleTokenClause("QUALIFY");
    }

    if (this.reader.matches("WINDOW")) {
      return this.#createSingleTokenClause("WINDOW");
    }

    if (this.reader.matches("LIMIT")) {
      return this.#createSingleTokenClause("LIMIT");
    }

    /*
     * GROUP単独ではClause確定にできない。
     * 次の非COMMENT TokenがBYの場合だけGROUP_BYとして返す。
     */
    if (this.reader.matches("GROUP")) {
      return this.#createTwoTokenClause("GROUP_BY", "BY");
    }

    /*
     * ORDERも同様に、次の非COMMENT TokenがBYの場合だけORDER_BYとする。
     */
    if (this.reader.matches("ORDER")) {
      return this.#createTwoTokenClause("ORDER_BY", "BY");
    }

    return null;
  }

  /**
   * SELECTやFROMなど、1 Tokenで名前が完成するClause情報を作る。
   *
   * このメソッドが必要な理由:
   * 1 Token Clauseごとにclause_end_seqやbody_start_seqの計算を重複して
   * 書かず、同じ規則を必ず適用するため。
   *
   * Clause本文は、Clause Keywordの次にある最初の非COMMENT Tokenから始まる。
   * Keyword直後がSQL末尾なら本文は存在しないためnullを返す。
   *
   * @param {string} clauseType 正規化したClause種別
   * @returns {object} parse()が利用するClause一致情報
   */
  #createSingleTokenClause(clauseType) {
    const currentToken = this.reader.current();
    const nextToken = this.reader.peekNonComment(1);

    return {
      clause_type: clauseType,
      clause_end_seq: currentToken.token_seq,
      body_start_seq: nextToken ? nextToken.token_seq : null,
      token_count: 1
    };
  }

  /**
   * GROUP BYやORDER BYなど、2つのKeywordで名前が完成するClause情報を作る。
   *
   * COMMENTを無視して次Keywordを確認する理由:
   *
   *   GROUP
   *   -- comment
   *   BY customer_id
   *
   * のようなSQLでもGROUP BYとして認識できるようにするため。
   *
   * token_countには現在位置からBYまでに存在する全Token数を設定する。
   * コメントTokenもReader配列上には存在するため、それを含めて進めないと
   * Reader位置がBYより前に残ってしまう。
   *
   * @param {string} clauseType 正規化したClause種別
   * @param {string} secondKeyword Clause名の2番目のKeyword
   * @returns {object|null} 一致情報。2番目のKeywordがなければnull
   */
  #createTwoTokenClause(clauseType, secondKeyword) {
    const secondToken = this.reader.peekNonComment(1);

    if (!secondToken || secondToken.normalized_token !== secondKeyword) {
      return null;
    }

    /*
     * peekNonComment()はTokenを返すが、Readerを進めるには現在位置からの
     * offsetが必要。そのためtoken_seqを基準にoffsetを求める。
     */
    const secondTokenOffset = this.#findOffsetByTokenSeq(secondToken.token_seq);
    const bodyStartToken = this.reader.peekNonComment(secondTokenOffset + 1);

    return {
      clause_type: clauseType,
      clause_end_seq: secondToken.token_seq,
      body_start_seq: bodyStartToken ? bodyStartToken.token_seq : null,
      token_count: secondTokenOffset + 1
    };
  }

  /**
   * 各Clause本文の終了token_seqを確定する。
   *
   * 境界規則:
   *
   * - 次のClauseがある場合:
   *     次Clause開始直前の非COMMENT Tokenまで。
   *
   * - 最後のClauseの場合:
   *     SQL末尾の非COMMENT Tokenまで。
   *
   * COMMENTを本文終了にしない理由:
   * 後続Parserがbody_end_seqを使って式を切り出す際、末尾コメントではなく
   * 実際のSQL要素までを本文範囲として扱いやすくするため。
   *
   * @param {Array<object>} clauses parse()が検出したClause一覧
   */
  #setBodyEndSeq(clauses) {
    for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex++) {
      const currentClause = clauses[clauseIndex];
      const nextClause = clauses[clauseIndex + 1];

      // Clause Keywordの後にTokenがなければ、本文開始・終了ともnullのままにする。
      if (currentClause.body_start_seq === null) {
        currentClause.body_end_seq = null;
        continue;
      }

      if (nextClause) {
        currentClause.body_end_seq = this.#findPreviousNonCommentTokenSeq(
          nextClause.clause_start_seq
        );

        continue;
      }

      currentClause.body_end_seq = this.#findLastNonCommentTokenSeq();
    }
  }

  /**
   * 現在Reader位置から、指定token_seqまでの配列offsetを求める。
   *
   * このメソッドが必要な理由:
   * TokenReaderの外部座標はtoken_seqで統一している一方、peek(offset)や
   * advance(count)は「現在位置から何Token離れているか」を必要とするため。
   * indexそのものを外部へ公開せず、ClauseParser内部で一時的にoffsetへ変換する。
   *
   * @param {number} tokenSeq 探すTokenのtoken_seq
   * @returns {number} 現在位置を0とした相対offset
   */
  #findOffsetByTokenSeq(tokenSeq) {
    let offset = 0;

    while (true) {
      const targetToken = this.reader.peek(offset);

      /*
       * 呼び出し元が渡したtoken_seqは直前のpeekNonComment()で得たものなので
       * 通常は必ず見つかる。見つからない場合は内部整合性が崩れているため、
       * nullで続行せずRangeErrorとして検出する。
       */
      if (!targetToken) {
        throw new RangeError(
          `ClauseParser: token_seq ${tokenSeq} was not found after the current position.`
        );
      }

      if (targetToken.token_seq === tokenSeq) {
        return offset;
      }

      offset++;
    }
  }

  /**
   * 指定token_seqより前にある最後の非COMMENT Tokenのtoken_seqを返す。
   *
   * 次Clause開始位置から単純に1を引かない理由:
   * token_seqの直前にCOMMENT Tokenがある場合、本文終了位置がコメントに
   * なってしまうため。Token配列を先頭から確認し、最後の有効Tokenを保持する。
   *
   * @param {number} tokenSeq 次Clauseの開始token_seq
   * @returns {number|null} 直前の非COMMENT Tokenのtoken_seq
   */
  #findPreviousNonCommentTokenSeq(tokenSeq) {
    let previousTokenSeq = null;

    for (const token of this.tokens) {
      if (token.token_seq >= tokenSeq) {
        break;
      }

      if (token.token_type !== "COMMENT") {
        previousTokenSeq = token.token_seq;
      }
    }

    return previousTokenSeq;
  }

  /**
   * SQL全体の末尾にある非COMMENT Tokenのtoken_seqを返す。
   *
   * 最後のClauseには次Clauseがないため、本文終了位置を決めるには
   * SQL末尾側から最初に見つかる有効Tokenを探す必要がある。
   * 後ろから検索することで、末尾コメントを効率的に飛ばせる。
   *
   * @returns {number|null} 最後の非COMMENT Tokenのtoken_seq
   */
  #findLastNonCommentTokenSeq() {
    for (let tokenIndex = this.tokens.length - 1; tokenIndex >= 0; tokenIndex--) {
      const currentToken = this.tokens[tokenIndex];

      if (currentToken.token_type !== "COMMENT") {
        return currentToken.token_seq;
      }
    }

    // TokenがすべてCOMMENT、または空配列の場合。
    return null;
  }
}


/**
 * 未対応のBigQuery固有構文を、解析全体を停止させず保持するための暫定AST。
 * 識別子参照だけは子Nodeとして保持し、ColumnResolverの汎用走査で回収する。
 */
function createRawExpressionAst(tokens) {
  const content = (tokens || []).filter((token) => token.token_type !== "COMMENT");
  const children = [];
  const ignoredWords = new Set([
    "ARRAY", "STRUCT", "STRING", "DATE", "DATETIME", "TIMESTAMP", "TIME",
    "INT64", "INTEGER", "FLOAT64", "NUMERIC", "BIGNUMERIC", "BOOL", "BOOLEAN",
    "BYTES", "JSON", "GEOGRAPHY", "AS", "ORDER", "BY", "LIMIT", "ASC", "DESC",
    "EXCEPT", "REPLACE", "DISTINCT", "NULLS", "FIRST", "LAST"
  ]);

  for (let index = 0; index < content.length; index++) {
    const token = content[index];
    if (!["IDENTIFIER", "BACKTICK_IDENTIFIER"].includes(token.token_type)) continue;
    if (ignoredWords.has(token.normalized_token)) continue;
    if (content[index - 1]?.normalized_token === "AS") continue;

    /* 関数名は列参照ではない。名前空間付き関数も直後の(で判定する。 */
    let functionEndIndex = index;
    while (
      content[functionEndIndex + 1]?.token === "." &&
      ["IDENTIFIER", "BACKTICK_IDENTIFIER"].includes(content[functionEndIndex + 2]?.token_type)
    ) {
      functionEndIndex += 2;
    }
    if (content[functionEndIndex + 1]?.token === "(") {
      index = functionEndIndex;
      continue;
    }

    const nameTokens = [token];
    while (
      content[index + 1]?.token === "." &&
      ["IDENTIFIER", "BACKTICK_IDENTIFIER"].includes(content[index + 2]?.token_type)
    ) {
      nameTokens.push(content[index + 1], content[index + 2]);
      index += 2;
    }
    children.push(AstFactory.createIdentifier(nameTokens));
  }

  return {
    node_type: NodeType.RAW_EXPRESSION,
    start_token_seq: content[0]?.token_seq ?? null,
    end_token_seq: content.at(-1)?.token_seq ?? null,
    raw_text: content.map((token) => token.token).join(""),
    children
  };
}
