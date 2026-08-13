/**
 * Clause Parserが抽出したSELECT句本文を、SELECT項目単位へ分解する。
 *
 * このParserの責務:
 *
 * 1. SELECT句本文だけをToken配列から取り出す。
 * 2. SELECT句と同じ階層にあるカンマで項目を分割する。
 * 3. 各項目から明示的・暗黙的な出力aliasを分離する。
 * 4. 単純カラムやWildcardの出力情報を整理する。
 * 5. 後続のExpression Parserが解析できるよう、式のtoken_seq範囲を返す。
 *
 * このParserが行わないこと:
 *
 * - 式の内部構造の解析
 * - カラムがどのテーブルに属するかの解決
 * - Wildcardの物理カラム展開
 *
 * これらは後続のExpression ParserやResolverの責務とする。
 */
class SelectParser {
  /**
   * @param {Array<object>} tokens Lexerが生成した全Token
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("SelectParser: tokens must be an array.");
    }

    this.tokens = tokens;
    this.reader = new TokenReader(tokens);
  }

  /**
   * SELECT Clauseを解析し、SELECT項目一覧を返す。
   *
   * selectClauseにはClauseParserが返したSELECT Clauseを渡す。
   * body_start_seqとbody_end_seqがSELECT本文の範囲を表すため、
   * SelectParser自身がSQL全体からSELECTやFROMを探し直す必要はない。
   *
   * @param {object} selectClause ClauseParserが返したSELECT Clause
   * @returns {Array<object>}
   */
  parse(selectClause) {
    this.#validateSelectClause(selectClause);

    const selectTokens = this.reader.sliceByTokenSeq(
      selectClause.body_start_seq,
      selectClause.body_end_seq
    );

    const contentTokens = this.#removeSelectModifiers(selectTokens);
    const itemTokenGroups = this.#splitTopLevelByComma(
      contentTokens,
      selectClause.paren_depth
    );

    return itemTokenGroups.map((itemTokens, itemIndex) => {
      return this.#parseSelectItem(itemTokens, itemIndex + 1);
    });
  }

  /**
   * ClauseParserから渡された値がSELECT Clauseとして利用可能か確認する。
   *
   * 早い段階で明確な例外を出すことで、SelectParser内部の別処理で
   * null参照や不自然な空配列が発生し、原因が分かりにくくなるのを防ぐ。
   *
   * @param {object} selectClause
   */
  #validateSelectClause(selectClause) {
    if (!selectClause || typeof selectClause !== "object") {
      throw new TypeError("SelectParser.parse: selectClause must be an object.");
    }

    if (selectClause.clause_type !== "SELECT") {
      throw new TypeError(
        `SelectParser.parse: clause_type must be SELECT, but received ` +
        `${String(selectClause.clause_type)}.`
      );
    }

    if (
      !Number.isInteger(selectClause.body_start_seq) ||
      !Number.isInteger(selectClause.body_end_seq)
    ) {
      throw new TypeError(
        "SelectParser.parse: SELECT body token sequences must be integers."
      );
    }

    if (!Number.isInteger(selectClause.paren_depth)) {
      throw new TypeError(
        "SelectParser.parse: selectClause.paren_depth must be an integer."
      );
    }
  }

  /**
   * SELECT本文の先頭にあるSELECT修飾子を取り除く。
   *
   * 例えば次のDISTINCTはSELECT項目ではない。
   *
   *   SELECT DISTINCT customer_id, amount
   *          ^^^^^^^^
   *
   * これを残したままにすると、最初の項目が
   * "DISTINCT customer_id"という式として扱われてしまう。
   *
   * DISTINCT、ALL、AS STRUCT、AS VALUEを対象とする。
   * これらはSELECT項目そのものではなく、SELECT全体の出力形式を指定する。
   *
   * COMMENTは修飾子判定を妨げないが、元のToken列には残す。
   * そのため修飾子直前までのCOMMENTも合わせて除外する。
   *
   * @param {Array<object>} tokens SELECT本文Token
   * @returns {Array<object>}
   */
  #removeSelectModifiers(tokens) {
    let firstContentIndex = 0;

    while (
      firstContentIndex < tokens.length &&
      tokens[firstContentIndex].token_type === "COMMENT"
    ) {
      firstContentIndex++;
    }

    const firstContentToken = tokens[firstContentIndex];

    // Only a KEYWORD DISTINCT/ALL is the SELECT set-quantifier. A string literal
    // whose contents happen to spell ALL/DISTINCT (e.g. SELECT 'ALL' AS col1)
    // shares the normalized_token but is token_type STRING, and must NOT be
    // stripped — doing so left the item with no expression.
    if (
      firstContentToken &&
      firstContentToken.token_type === "KEYWORD" &&
      ["DISTINCT", "ALL"].includes(firstContentToken.normalized_token)
    ) {
      return tokens.slice(firstContentIndex + 1);
    }

    const secondContentIndex = this.#findNextNonCommentIndex(
      tokens,
      firstContentIndex + 1
    );

    const secondContentToken = secondContentIndex >= 0
      ? tokens[secondContentIndex]
      : null;

    // As above, only a KEYWORD AS introduces AS STRUCT / AS VALUE; a string
    // literal 'AS' (token_type STRING) must not be treated as the modifier.
    if (
      firstContentToken?.token_type === "KEYWORD" &&
      firstContentToken?.normalized_token === "AS" &&
      ["STRUCT", "VALUE"].includes(secondContentToken?.normalized_token)
    ) {
      return tokens.slice(secondContentIndex + 1);
    }

    return tokens;
  }


  /**
   * 指定位置以降で最初の非COMMENT Tokenの配列indexを返す。
   *
   * SELECT AS STRUCT / AS VALUEでは、ASとSTRUCT/VALUEの間に
   * コメントが挟まる可能性があるため、単純なindex + 1ではなく
   * 次の実内容Tokenを探す必要がある。
   *
   * @param {Array<object>} tokens
   * @param {number} startIndex
   * @returns {number}
   */
  #findNextNonCommentIndex(tokens, startIndex) {
    for (let tokenIndex = startIndex; tokenIndex < tokens.length; tokenIndex++) {
      if (tokens[tokenIndex].token_type !== "COMMENT") {
        return tokenIndex;
      }
    }

    return -1;
  }

  /**
   * SELECT本文を、SELECT項目ごとのToken配列へ分割する。
   *
   * 単純にすべてのカンマで分割してはいけない。
   * 関数引数やSTRUCT内部にもカンマが存在するためである。
   *
   *   SELECT IF(a > 0, b, c), customer_id
   *                         ^ ここだけが項目区切り
   *
   * Clauseと同じparen_depthのカンマだけを項目区切りとして扱う。
   * 括弧内部のカンマはより深いparen_depthを持つため分割されない。
   *
   * @param {Array<object>} tokens SELECT本文Token
   * @param {number} itemDepth SELECT項目区切りが存在するdepth
   * @returns {Array<Array<object>>}
   */
  #splitTopLevelByComma(tokens, itemDepth) {
    const result = [];
    let currentItem = [];
    let angleDepth = 0;
    let previousMeaningful = null;

    for (const token of tokens) {
      /*
       * 型パラメータの山括弧 STRUCT<...> / ARRAY<...> 内部のカンマは項目区切りに
       * しない。paren_depth は () / [] しか数えないため、山括弧の深さを別に追う。
       * '<' が型を開くのは STRUCT / ARRAY（またはネスト型を閉じた '>'）の直後だけで、
       * 値の比較 a < b では加算しないため通常の比較には影響しない。
       */
      if (
        token.token === "<" &&
        previousMeaningful &&
        (["STRUCT", "ARRAY"].includes(previousMeaningful.normalized_token) ||
          previousMeaningful.token === ">")
      ) {
        angleDepth += 1;
      } else if (token.token === ">" && angleDepth > 0) {
        angleDepth -= 1;
      }

      if (
        token.token === "," &&
        token.paren_depth === itemDepth &&
        angleDepth === 0
      ) {
        const trimmedItem = this.#removeCommentTokens(currentItem);

        if (trimmedItem.length === 0) {
          throw new SyntaxError(
            `SelectParser: empty SELECT item before token_seq ${token.token_seq}.`
          );
        }

        result.push(trimmedItem);
        currentItem = [];

        if (token.token_type !== "COMMENT") {
          previousMeaningful = token;
        }

        continue;
      }

      currentItem.push(token);

      if (token.token_type !== "COMMENT") {
        previousMeaningful = token;
      }
    }

    const lastItem = this.#removeCommentTokens(currentItem);

    if (lastItem.length > 0) {
      result.push(lastItem);
    }

    /*
     * BigQueryではSELECTリスト末尾のカンマが許容される。
     *
     *   SELECT
     *     column_a,
     *     column_b,
     *   FROM table_name
     *
     * 最後のカンマより後ろにSELECT項目がない場合でも、
     * それを空項目や構文エラーとして扱わない。
     */

    if (result.length === 0) {
      throw new SyntaxError("SelectParser: SELECT clause contains no items.");
    }

    return result;
  }

  /**
   * 1つのSELECT項目を解析する。
   *
   * ここでは主に「式」と「出力alias」を分離する。
   * 式そのものをASTへ変換する処理はExpression Parserへ委譲する。
   *
   * @param {Array<object>} itemTokens 1項目分のToken
   * @param {number} selectItemSeq SELECT項目の連番
   * @returns {object}
   */
  #parseSelectItem(itemTokens, selectItemSeq) {
    const aliasResult = this.#parseAlias(itemTokens);
    const wildcardResult = this.#parseWildcard(aliasResult.expression_tokens);
    const expressionTokens = aliasResult.expression_tokens;

    if (expressionTokens.length === 0) {
      throw new SyntaxError(
        `SelectParser: SELECT item ${selectItemSeq} has no expression.`
      );
    }

    return {
      select_item_seq: selectItemSeq,
      item_start_seq: itemTokens[0].token_seq,
      item_end_seq: itemTokens[itemTokens.length - 1].token_seq,
      expression_start_seq: expressionTokens[0].token_seq,
      expression_end_seq: expressionTokens[expressionTokens.length - 1].token_seq,
      expression: this.#tokensToText(expressionTokens),
      output_alias: aliasResult.output_alias,
      alias_type: aliasResult.alias_type,
      wildcard_type: wildcardResult.wildcard_type,
      wildcard_qualifier: wildcardResult.wildcard_qualifier,
      wildcard_exclusions: wildcardResult.wildcard_exclusions || [],
      wildcard_replacements: wildcardResult.wildcard_replacements || []
    };
  }

  /**
   * SELECT項目からaliasを判定し、式部分とalias部分を分離する。
   *
   * 判定順序には意味がある。
   *
   * 1. 明示的alias: expression AS alias
   * 2. 暗黙alias:   expression alias
   * 3. 単純カラムから出力名を導出
   * 4. aliasなし
   *
   * 明示的なASを最優先にすることで、式中の末尾Identifierを誤って
   * 暗黙aliasと解釈する可能性を減らす。
   *
   * @param {Array<object>} itemTokens
   * @returns {object}
   */
  #parseAlias(itemTokens) {
    const explicitAlias = this.#findExplicitAlias(itemTokens);

    if (explicitAlias) {
      return explicitAlias;
    }

    const implicitAlias = this.#findImplicitAlias(itemTokens);

    if (implicitAlias) {
      return implicitAlias;
    }

    const derivedAlias = this.#deriveColumnAlias(itemTokens);

    if (derivedAlias) {
      return derivedAlias;
    }

    return {
      expression_tokens: itemTokens,
      output_alias: null,
      alias_type: "NONE"
    };
  }

  /**
   * トップレベルのASを右側から探し、明示的aliasを抽出する。
   *
   * 右側から探す理由:
   * SELECT項目のaliasは通常末尾にあり、式内部のCAST(... AS TYPE)にある
   * ASを誤って出力aliasとして扱わないためである。
   * CAST内部のASは項目より深いparen_depthなので対象外となる。
   *
   * ASの後ろには非COMMENT Tokenが1つだけ存在することを要求する。
   * 余分なTokenがあれば曖昧なSQLを黙って受け入れずSyntaxErrorにする。
   *
   * @param {Array<object>} itemTokens
   * @returns {object|null}
   */
  #findExplicitAlias(itemTokens) {
    const itemDepth = itemTokens[0].paren_depth;

    for (let tokenIndex = itemTokens.length - 1; tokenIndex >= 0; tokenIndex--) {
      const currentToken = itemTokens[tokenIndex];

      if (
        currentToken.normalized_token !== "AS" ||
        currentToken.paren_depth !== itemDepth
      ) {
        continue;
      }

      const aliasTokens = this.#removeCommentTokens(itemTokens.slice(tokenIndex + 1));

      if (aliasTokens.length !== 1 || !this.#isAliasToken(aliasTokens[0])) {
        throw new SyntaxError(
          `SelectParser: invalid explicit alias after token_seq ` +
          `${currentToken.token_seq}.`
        );
      }

      const expressionTokens = this.#removeCommentTokens(
        itemTokens.slice(0, tokenIndex)
      );

      return {
        expression_tokens: expressionTokens,
        output_alias: aliasTokens[0].normalized_token,
        alias_type: "EXPLICIT_AS"
      };
    }

    return null;
  }

  /**
   * ASを省略した暗黙aliasを判定する。
   *
   *   SUM(amount) total_amount
   *               ^^^^^^^^^^^^
   *
   * 最後のTokenがIdentifierであり、その直前のTokenが式の終端として
   * 自然な場合だけaliasとみなす。
   *
   * 例えば「a + b」のbをaliasと誤認しないよう、直前が演算子なら
   * 暗黙aliasとして扱わない。
   *
   * @param {Array<object>} itemTokens
   * @returns {object|null}
   */
  #findImplicitAlias(itemTokens) {
    const significantTokens = itemTokens.filter(
      (token) => token.token_type !== "COMMENT"
    );

    if (significantTokens.length < 2) {
      return null;
    }

    const aliasToken = significantTokens[significantTokens.length - 1];
    const previousToken = significantTokens[significantTokens.length - 2];

    if (!this.#isAliasToken(aliasToken)) {
      return null;
    }

    if (!this.#canEndExpression(previousToken)) {
      return null;
    }

    const aliasIndex = itemTokens.indexOf(aliasToken);
    const expressionTokens = this.#removeCommentTokens(itemTokens.slice(0, aliasIndex));

    return {
      expression_tokens: expressionTokens,
      output_alias: aliasToken.normalized_token,
      alias_type: "IMPLICIT"
    };
  }

  /**
   * aliasが省略された単純カラム参照から、出力列名を導出する。
   *
   *   customer_id   -> CUSTOMER_ID
   *   c.customer_id -> CUSTOMER_ID
   *
   * 計算式や関数は出力名を安全に導出できないため対象外とする。
   *
   * @param {Array<object>} itemTokens
   * @returns {object|null}
   */
  #deriveColumnAlias(itemTokens) {
    const significantTokens = itemTokens.filter(
      (token) => token.token_type !== "COMMENT"
    );

    if (significantTokens.length === 1 && this.#isColumnNameToken(significantTokens[0])) {
      return {
        expression_tokens: itemTokens,
        output_alias: significantTokens[0].normalized_token,
        alias_type: "DERIVED_COLUMN"
      };
    }

    if (significantTokens.length >= 3) {
      const columnToken = significantTokens[significantTokens.length - 1];
      const dotToken = significantTokens[significantTokens.length - 2];

      if (dotToken.token === "." && this.#isColumnNameToken(columnToken)) {
        return {
          expression_tokens: itemTokens,
          output_alias: columnToken.normalized_token,
          alias_type: "DERIVED_COLUMN"
        };
      }
    }

    return null;
  }

  /**
   * Wildcard表現を分類する。
   *
   *   *       -> ALL
   *   sales.* -> QUALIFIED
   *
   * Wildcardの展開自体にはテーブルスキーマが必要なため、ここでは
   * 種別と修飾子だけを記録し、Physical Resolverへ引き渡す。
   *
   * @param {Array<object>} expressionTokens
   * @returns {object}
   */
  #parseWildcard(expressionTokens) {
    const significantTokens = expressionTokens.filter(
      (token) => token.token_type !== "COMMENT"
    );

    const exclusions = [];
    const replacements = [];
    let wildcardEndIndex = significantTokens.length;
    const exceptIndex = significantTokens.findIndex(
      (token) => token.normalized_token === "EXCEPT"
    );
    const replaceIndex = significantTokens.findIndex(
      (token) => token.normalized_token === "REPLACE"
    );

    for (const index of [exceptIndex, replaceIndex]) {
      if (index >= 0 && index < wildcardEndIndex) wildcardEndIndex = index;
    }

    if (exceptIndex >= 0) {
      const exceptEnd = replaceIndex > exceptIndex ? replaceIndex : significantTokens.length;
      for (let index = exceptIndex + 1; index < exceptEnd; index++) {
        const token = significantTokens[index];
        if (["IDENTIFIER", "BACKTICK_IDENTIFIER"].includes(token.token_type)) {
          exclusions.push(token.normalized_token);
        }
      }
    }

    if (replaceIndex >= 0) {
      const openIndex = significantTokens.findIndex((token, index) => {
        return index > replaceIndex && token.token === "(";
      });
      const closeIndex = significantTokens.map((token) => token.token).lastIndexOf(")");

      if (openIndex >= 0 && closeIndex > openIndex) {
        const body = significantTokens.slice(openIndex + 1, closeIndex);
        const groups = [];
        let current = [];
        const baseDepth = body.length > 0 ? body[0].paren_depth : 0;

        for (const token of body) {
          if (token.token === "," && token.paren_depth === baseDepth) {
            if (current.length > 0) groups.push(current);
            current = [];
          } else {
            current.push(token);
          }
        }
        if (current.length > 0) groups.push(current);

        for (const group of groups) {
          let asIndex = -1;
          const groupDepth = group.length > 0 ? group[0].paren_depth : 0;
          for (let index = group.length - 1; index >= 0; index--) {
            if (group[index].normalized_token === "AS" && group[index].paren_depth === groupDepth) {
              asIndex = index;
              break;
            }
          }
          if (asIndex <= 0 || asIndex >= group.length - 1) continue;
          const aliasToken = group[asIndex + 1];
          const expressionPart = group.slice(0, asIndex);
          if (!this.#isIdentifierToken(aliasToken) || expressionPart.length === 0) continue;
          replacements.push({
            output_column_name: aliasToken.normalized_token,
            expression: this.#tokensToText(expressionPart),
            expression_start_seq: expressionPart[0].token_seq,
            expression_end_seq: expressionPart[expressionPart.length - 1].token_seq
          });
        }
      }
    }

    const wildcardTokens = significantTokens.slice(0, wildcardEndIndex);

    if (wildcardTokens.length === 1 && wildcardTokens[0].token === "*") {
      return {
        wildcard_type: "ALL",
        wildcard_qualifier: null,
        wildcard_exclusions: exclusions,
        wildcard_replacements: replacements
      };
    }

    if (wildcardTokens.length >= 3) {
      const wildcardToken = wildcardTokens[wildcardTokens.length - 1];
      const dotToken = wildcardTokens[wildcardTokens.length - 2];
      const qualifierToken = wildcardTokens[wildcardTokens.length - 3];
      if (wildcardToken.token === "*" && dotToken.token === "." && this.#isIdentifierToken(qualifierToken)) {
        return {
          wildcard_type: "QUALIFIED",
          wildcard_qualifier: qualifierToken.normalized_token,
          wildcard_exclusions: exclusions,
          wildcard_replacements: replacements
        };
      }
    }

    return {
      wildcard_type: null,
      wildcard_qualifier: null,
      wildcard_exclusions: [],
      wildcard_replacements: []
    };
  }

  /**
   * Tokenがalias名として利用可能な識別子か判定する。
   *
   * 通常識別子とバッククォート識別子を許可する。
   * Keywordを無条件に許可するとSQL構造との区別が曖昧になるため、
   * Keywordをaliasにする場合はバッククォートで囲むことを前提とする。
   *
   * @param {object} token
   * @returns {boolean}
   */
  #isAliasToken(token) {
    return this.#isIdentifierToken(token);
  }

  /**
   * Tokenが通常またはバッククォート識別子か判定する。
   *
   * @param {object} token
   * @returns {boolean}
   */
  #isIdentifierToken(token) {
    return ["IDENTIFIER", "BACKTICK_IDENTIFIER"].includes(token.token_type);
  }

  /**
   * SELECT項目の暗黙出力列名として使える「列名Token」か判定する。
   *
   * `#isIdentifierToken` は IDENTIFIER / BACKTICK のみを名前として扱うが、
   * BigQueryでは `OFFSET`（`UNNEST(arr) WITH OFFSET AS offset` の別名）のように、
   * キーワードでも識別子（列名）として使える語がある。ExpressionParser は
   * これらを IDENTIFIER_EXPRESSION として解決するため、出力名の導出も同じ基準に
   * 合わせる。真に予約された語（NULL/TRUE/FALSE や論理・句キーワード）は
   * 列名にならないため除外し、無名（UNNAMED）のままにする。
   */
  #isColumnNameToken(token) {
    if (["IDENTIFIER", "BACKTICK_IDENTIFIER"].includes(token.token_type)) {
      return true;
    }

    if (token.token_type !== "KEYWORD") {
      return false;
    }

    const reserved = [
      "AND", "OR", "NOT", "IN", "BETWEEN", "IS", "LIKE", "NULL", "TRUE", "FALSE",
      "CASE", "WHEN", "THEN", "ELSE", "END", "EXISTS",
      "OVER", "PARTITION", "ORDER", "BY", "ROWS", "RANGE", "GROUPS",
      "ASC", "DESC", "NULLS", "FIRST", "LAST"
    ];

    return !reserved.includes(token.normalized_token);
  }

  /**
   * 指定Tokenの直後に暗黙aliasを置けるか判定する。
   *
   * 式の末尾として自然なものだけを許可する。
   * これにより「a + b」のbをaliasと誤認することを防ぐ。
   *
   * @param {object} token
   * @returns {boolean}
   */
  #canEndExpression(token) {
    if (["IDENTIFIER", "BACKTICK_IDENTIFIER", "NUMBER", "STRING"].includes(token.token_type)) {
      return true;
    }

    if (token.token === ")" || token.token === "]") {
      return true;
    }

    if (["END", "NULL", "TRUE", "FALSE"].includes(token.normalized_token)) {
      return true;
    }

    return false;
  }

  /**
   * Token配列の先頭と末尾にあるCOMMENT Tokenを除外する。
   *
   * 項目内部のCOMMENTは式の位置情報や再構成に必要なため残す。
   * 先頭・末尾COMMENTだけを除外することで、expression_start_seqと
   * expression_end_seqが実際の式を指すようにする。
   *
   * @param {Array<object>} tokens
   * @returns {Array<object>}
   */
  #removeCommentTokens(tokens) {
    let startIndex = 0;
    let endIndex = tokens.length - 1;

    while (startIndex <= endIndex && tokens[startIndex].token_type === "COMMENT") {
      startIndex++;
    }

    while (endIndex >= startIndex && tokens[endIndex].token_type === "COMMENT") {
      endIndex--;
    }

    return tokens.slice(startIndex, endIndex + 1);
  }

  /**
   * Token配列を確認用のSQL断片へ戻す。
   *
   * Lexerは空白Tokenを保持しないため、完全な原文復元ではない。
   * この文字列は解析結果の確認・ログ・デバッグ用途であり、
   * SQL再実行用の厳密な再構築を目的としない。
   *
   * @param {Array<object>} tokens
   * @returns {string}
   */
  #tokensToText(tokens) {
    let sqlText = "";
    let previousToken = null;

    for (const currentToken of tokens) {
      if (previousToken && this.#requiresTokenSeparator(previousToken, currentToken)) {
        sqlText += " ";
      }

      sqlText += currentToken.token;
      previousToken = currentToken;
    }

    return sqlText;
  }

  /**
   * 空白Tokenを保持しないLexerのToken列から、単語同士の境界だけを復元する。
   *
   * 例:
   *   DISTINCT + order_id -> DISTINCT order_id
   *   CASE + WHEN         -> CASE WHEN
   *   cs + . + amount     -> cs.amount
   *   SUM + (             -> SUM(
   *
   * 演算子の前後やカンマ後の整形までは行わない。expressionはSQL再生成用ではなく、
   * ログ・確認用途の読みやすいSQL断片として扱う。
   *
   * @param {object} previousToken
   * @param {object} currentToken
   * @returns {boolean}
   */
  #requiresTokenSeparator(previousToken, currentToken) {
    const wordTokenTypes = new Set([
      "KEYWORD",
      "IDENTIFIER",
      "BACKTICK_IDENTIFIER",
      "NUMBER",
      "STRING"
    ]);

    return wordTokenTypes.has(previousToken.token_type)
      && wordTokenTypes.has(currentToken.token_type);
  }
}
