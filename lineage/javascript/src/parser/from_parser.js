/**
 * FROM句をテーブルソースとJOINへ分解するParser。
 *
 * FromParserの責務:
 *
 * - FROM直後の主ソースを解析する。
 * - JOIN種別とJOIN先ソースを解析する。
 * - ON条件をExpressionParserへ渡す。
 * - USING列を一覧化する。
 * - UNNESTとサブクエリを通常テーブルとは別のsource_typeで表現する。
 *
 * FromParserは、ON条件の演算子優先順位や関数呼び出しを自分では解析しない。
 * 式の意味解析をExpressionParserへ委譲することで、FROM/JOIN文法だけに責務を絞る。
 *
 * 位置情報はすべてtoken_seqで返す。配列indexはこのクラス内部だけで使用する。
 */
class FromParser {
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("FromParser: tokens must be an array.");
    }

    this.sourceTokens = tokens;
    this.tokens = [];
    this.reader = null;
    this.expressionParser = new ExpressionParser(tokens);
  }

  /**
   * ClauseParserが返したFROM Clauseを解析する。
   *
   * @param {object} fromClause ClauseParserのFROM結果
   * @returns {object} FROM構造
   */
  parse(fromClause) {
    this.#validateFromClause(fromClause);

    /*
     * 元Token配列は保持したまま、FROM本文範囲だけを切り出す。
     * コメントは文法判定に不要なので、解析用配列からのみ除外する。
     */
    this.tokens = this.sourceTokens.filter((token) =>
      token.token_seq >= fromClause.body_start_seq &&
      token.token_seq <= fromClause.body_end_seq &&
      token.token_type !== "COMMENT"
    );

    if (this.tokens.length === 0) {
      throw new SyntaxError("FromParser: FROM Clause contains no source tokens.");
    }

    this.reader = new TokenReader(this.tokens);

    const source = this.#parseSource();
    this.#parseRelationOperators(source);
    const joins = [];

    while (!this.reader.isEnd()) {
      /*
       * 旧式のカンマ区切りFROMは、意味上CROSS JOINと同じ扱いにする。
       * ただし元SQLの表現を失わないようjoin_syntaxをCOMMAとして保持する。
       */
      if (this.reader.matches(",", false)) {
        const commaToken = this.reader.consume();
        const commaSource = this.#parseSource();

        joins.push({
          join_seq: joins.length + 1,
          join_type: "CROSS",
          join_syntax: "COMMA",
          join_start_seq: commaToken.token_seq,
          source: commaSource,
          condition_type: null,
          condition: null,
          using_columns: [],
          end_token_seq: commaSource.end_token_seq
        });

        continue;
      }

      const visibleSourceNames = this.#collectVisibleSourceNames(source, joins);
      joins.push(this.#parseJoin(joins.length + 1, visibleSourceNames));
    }

    return {
      from_start_seq: fromClause.clause_start_seq,
      body_start_seq: fromClause.body_start_seq,
      body_end_seq: fromClause.body_end_seq,
      source,
      joins
    };
  }

  /**
   * 現在位置から1つのFROM/JOINソースを解析する。
   *
   * ソースの候補:
   *
   * - 通常テーブル
   * - UNNEST(...)
   * - (SELECT ...)形式のサブクエリ
   */
  #parseSource() {
    const currentToken = this.reader.current();

    if (!currentToken) {
      throw new SyntaxError("FromParser: source token was not found.");
    }

    if (currentToken.normalized_token === "UNNEST") {
      return this.#parseUnnestSource();
    }

    if (currentToken.token === "(") {
      return this.#parseSubquerySource();
    }

    return this.#parseTableSource();
  }

  /**
   * project.dataset.tableのようなドット区切りテーブル名を解析する。
   */
  #parseTableSource() {
    const startToken = this.reader.current();
    const nameParts = [];

    if (!this.#isNameToken(startToken)) {
      throw new SyntaxError(
        `FromParser: table name was expected, but found "${startToken.token}".`
      );
    }

    nameParts.push(this.#consumeHyphenatedNamePart());

    while (this.reader.matches(".", false)) {
      this.reader.consume();

      const partToken = this.reader.current();

      if (!this.#isNameToken(partToken)) {
        throw new SyntaxError("FromParser: identifier was expected after '.'.");
      }

      nameParts.push(this.#consumeHyphenatedNamePart());
    }

    /*
     * FROM 位置で名前の直後に "(" が来る場合、これはテーブル値関数(TVF)呼び出し
     * である(例: EXTERNAL_QUERY('connection', '''SELECT ...''') AS a、
     * dataset.my_tvf(x) など)。EXTERNAL_QUERY のようなフェデレーテッドクエリや
     * TVF の出力は BigQuery 物理テーブルではなく、その列は物理系統を持たない。
     * 中身は解析せず、対応する ")" まで読み飛ばして不透明ソース(TABLE_FUNCTION)
     * として扱う。これがないと JOIN 解析器が "(" を見て「JOIN を期待」で失敗する。
     */
    if (this.reader.matches("(", false)) {
      return this.#parseTableFunctionSource(startToken, nameParts);
    }

    /*
     * TABLESAMPLE SYSTEM (n PERCENT) はサンプリング指定で列系統に影響しない。
     * 別名の前後どちらにも書けるため、両位置で読み飛ばす。
     */
    this.#skipTableSampleClause();
    const aliasInfo = this.#parseAlias();
    this.#skipTableSampleClause();
    const endToken = aliasInfo.alias_token || this.reader.previous();

    return {
      source_type: "TABLE",
      name: nameParts.join("."),
      name_parts: nameParts,
      alias: aliasInfo.alias,
      alias_type: aliasInfo.alias_type,
      start_token_seq: startToken.token_seq,
      end_token_seq: endToken.token_seq
    };
  }

  /**
   * name(...) 形式のテーブル値関数(EXTERNAL_QUERY など)を不透明ソースとして
   * 解析する。括弧内部は解析対象にせず、対応する ")" まで読み飛ばし、任意の
   * 別名を取り込む。TABLE_FUNCTION ソースは派生ソース(CTE/サブクエリ)と同様、
   * 物理列を持たない。列参照は解決されるが系統も診断も生まない。
   */
  #parseTableFunctionSource(startToken, nameParts) {
    const openToken = this.#consumeExpected("(", false);
    const closeToken = this.#findMatchingCloseParenthesis(openToken);

    this.reader.moveToTokenSeq(closeToken.token_seq);
    this.reader.consume();

    this.#skipTableSampleClause();
    const aliasInfo = this.#parseAlias();
    this.#skipTableSampleClause();
    const endToken = aliasInfo.alias_token || closeToken;

    return {
      source_type: "TABLE_FUNCTION",
      name: nameParts.join("."),
      name_parts: nameParts,
      alias: aliasInfo.alias,
      alias_type: aliasInfo.alias_type,
      start_token_seq: startToken.token_seq,
      end_token_seq: endToken.token_seq
    };
  }

  /**
   * テーブルパスの1パートを読む。BigQuery は未クォートのテーブルパスに
   * ハイフンを許容する（特にダッシュ付きプロジェクトID `my-project-123`）。
   * Lexer は `my-project` を `my` `-` `project` に分割するため、テーブル名
   * 位置では後続の `- <識別子|数値>` を同一パートへ連結する。FROM のテーブル名
   * 位置に現れる `-` は減算ではありえず、名前の一部としてのみ意味を持つ。
   */
  #consumeHyphenatedNamePart() {
    let part = this.reader.consume().normalized_token;

    while (this.reader.matches("-", false)) {
      this.reader.consume();

      const nextToken = this.reader.current();
      const isNamePart = nextToken &&
        (this.#isNameToken(nextToken) || nextToken.token_type === "NUMBER");

      if (!isNamePart) {
        throw new SyntaxError(
          "FromParser: identifier or number was expected after '-' in a table name."
        );
      }

      part += "-" + this.reader.consume().normalized_token;
    }

    return part;
  }

  /*
   * TABLESAMPLE [method] ( ... ) を読み飛ばす。存在しなければ何もしない。
   */
  #skipTableSampleClause() {
    if (!this.reader.matches("TABLESAMPLE")) {
      return;
    }

    this.reader.consume();

    if (this.reader.hasCurrent() && !this.reader.matches("(", false)) {
      this.reader.consume();
    }

    if (this.reader.matches("(", false)) {
      let depth = 0;

      while (this.reader.hasCurrent()) {
        const token = this.reader.consume();

        if (token.token === "(") {
          depth++;
        } else if (token.token === ")") {
          depth--;

          if (depth === 0) {
            break;
          }
        }
      }
    }
  }

  /**
   * UNNEST(expression) [AS] aliasを解析する。
   *
   * 括弧内部は通常のExpressionなのでExpressionParserへ委譲する。
   */
  #parseUnnestSource() {
    const unnestToken = this.#consumeExpected("UNNEST");
    const openToken = this.#consumeExpected("(", false);
    const closeToken = this.#findMatchingCloseParenthesis(openToken);

    const expressionStartToken = this.reader.current();
    const expressionEndToken = this.#previousNonCommentToken(closeToken.token_seq);

    if (!expressionStartToken || !expressionEndToken) {
      throw new SyntaxError("FromParser: UNNEST expression is empty.");
    }

    const expression = this.expressionParser.parseExpression(
      expressionStartToken.token_seq,
      expressionEndToken.token_seq
    );

    this.reader.moveToTokenSeq(closeToken.token_seq);
    this.reader.consume();

    const aliasInfo = this.#parseAlias();
    let endToken = aliasInfo.alias_token || closeToken;

    /*
     * UNNEST(...) [AS value] WITH OFFSET [AS offset] のオフセット句を取り込む。
     * offset列は配列インデックスで物理列を持たないため、Token範囲の
     * 終端更新のみ行い、構文を成立させる。
     */
    let offsetAlias = null;

    if (this.reader.matches("WITH") &&
        this.reader.nextToken()?.normalized_token === "OFFSET") {
      this.reader.consume();
      const offsetToken = this.reader.consume();
      endToken = offsetToken;

      const offsetAliasInfo = this.#parseAlias();

      if (offsetAliasInfo.alias_token) {
        offsetAlias = offsetAliasInfo.alias;
        endToken = offsetAliasInfo.alias_token;
      }
    }

    return {
      source_type: "UNNEST",
      expression,
      alias: aliasInfo.alias,
      alias_type: aliasInfo.alias_type,
      offset_alias: offsetAlias,
      start_token_seq: unnestToken.token_seq,
      end_token_seq: endToken.token_seq
    };
  }

  /**
   * (SELECT ...) [AS] alias形式のサブクエリを解析する。
   *
   * v1ではToken範囲だけでなく、Clause一覧とSELECT項目概要も保持する。
   * FROM内部など、より深い再帰解析は後続Query Parserへ拡張できる。
   */
  #parseSubquerySource() {
    const openToken = this.#consumeExpected("(", false);
    const closeToken = this.#findMatchingCloseParenthesis(openToken);
    const innerTokens = this.sourceTokens
      .filter((token) =>
        token.token_seq > openToken.token_seq && token.token_seq < closeToken.token_seq
      )
      .map((token) => ({
        ...token,
        /*
         * ClauseParserは解析対象Queryのトップレベルをdepth=0として扱う。
         * FROMサブクエリ内Tokenは元SQL上ではdepth=1以上なので、
         * サブクエリ開始括弧の深さを差し引いたコピーを作る。
         * 元Token配列自体は変更しない。
         */
        paren_depth: token.paren_depth - 1
      }));

    const firstInnerToken = innerTokens.find((token) => token.token_type !== "COMMENT");

    /*
     * A parenthesized FROM source is any query, which QueryParser below handles:
     * a plain SELECT, a WITH (CTE) query, or a set operation whose first branch is
     * itself parenthesized ('('). Only these can start a query, so reject anything
     * else (e.g. a bare table name belongs to the non-subquery source path).
     */
    const queryStarters = new Set(["SELECT", "WITH", "("]);

    if (!firstInnerToken || !queryStarters.has(firstInnerToken.normalized_token)) {
      throw new SyntaxError(
        "FromParser: parenthesized FROM source must be a query (SELECT, WITH, or a parenthesized set operation)."
      );
    }

    /*
     * FROMサブクエリを完全なQUERY ASTとして再帰解析する。
     *
     * 旧実装はclauses/select_itemsだけを保持していたため、
     * SourceResolverがQUERYノードとして認識できず、subquery_scope_idを
     * 設定できなかった。QueryParserへ委譲することでFROM/JOIN/WHERE、
     * 出力列、さらに入れ子サブクエリまで通常Queryと同じ形で保持する。
     */
    const queryAst = new QueryParser(innerTokens, {
      isSubquery: true
    }).parse();

    this.reader.moveToTokenSeq(closeToken.token_seq);
    this.reader.consume();

    const aliasInfo = this.#parseAlias();
    const endToken = aliasInfo.alias_token || closeToken;

    return {
      source_type: "SUBQUERY",
      query_start_token_seq: firstInnerToken.token_seq,
      query_end_token_seq: this.#previousNonCommentToken(closeToken.token_seq).token_seq,
      query_ast: queryAst,
      alias: aliasInfo.alias,
      alias_type: aliasInfo.alias_type,
      start_token_seq: openToken.token_seq,
      end_token_seq: endToken.token_seq
    };
  }

  /**
   * FROMソース直後のPIVOT / UNPIVOT演算子を解析する。
   *
   * BigQueryではPIVOTとUNPIVOTは独立したJOINではなく、直前の
   * from_itemへ適用される後置演算子である。旧実装はPIVOTを暗黙Alias、
   * 続く開き括弧をJOIN開始と解釈していたため、ここで明示的に消費する。
   *
   * v1.4.0-003では内部式の意味解析は行わず、トークン範囲を保持する。
   * Resolverが必要とする詳細ASTは後続版で段階的に追加する。
   */
  #parseRelationOperators(source) {
    const operators = [];

    while (
      this.reader.matches("PIVOT") ||
      this.reader.matches("UNPIVOT")
    ) {
      const operatorToken = this.reader.consume();
      let nullHandling = null;

      /*
       * UNPIVOTは演算子名と本体括弧の間に
       * INCLUDE NULLS / EXCLUDE NULLSを指定できる。
       * 生成列のLineage自体には影響しないが、構文として正しく消費し、
       * 後続Resolverが監査情報として参照できるよう保持する。
       */
      if (
        operatorToken.normalized_token === "UNPIVOT" &&
        (this.reader.matches("INCLUDE") || this.reader.matches("EXCLUDE"))
      ) {
        nullHandling = this.reader.consume().normalized_token;
        this.#consumeExpected("NULLS");
      }

      const openToken = this.#consumeExpected("(", false);
      const closeToken = this.#findMatchingCloseParenthesis(openToken);

      operators.push({
        operator_type: operatorToken.normalized_token,
        null_handling: nullHandling,
        start_token_seq: operatorToken.token_seq,
        body_start_token_seq: openToken.token_seq + 1,
        body_end_token_seq: closeToken.token_seq - 1,
        end_token_seq: closeToken.token_seq
      });

      this.reader.moveToTokenSeq(closeToken.token_seq);
      this.reader.consume();
    }

    if (operators.length > 0) {
      source.relation_operators = operators;
      source.end_token_seq = operators[operators.length - 1].end_token_seq;
    }
  }

  /**
   * JOIN種別、JOIN先、ON/USING条件を解析する。
   */
  #parseJoin(joinSeq, visibleSourceNames) {
    const joinStartToken = this.reader.current();
    const joinType = this.#parseJoinType();
    const source = this.#parseSource();
    this.#parseRelationOperators(source);

    let conditionType = null;
    let condition = null;
    let usingColumns = [];
    let endTokenSeq = source.end_token_seq;

    if (this.reader.matches("ON")) {
      conditionType = "ON";
      this.reader.consume();

      const conditionRange = this.#findJoinConditionRange();
      condition = this.expressionParser.parseExpression(
        conditionRange.start_token_seq,
        conditionRange.end_token_seq
      );
      endTokenSeq = conditionRange.end_token_seq;

      this.#moveAfterTokenSeq(conditionRange.end_token_seq);
    } else if (this.reader.matches("USING")) {
      conditionType = "USING";
      const usingResult = this.#parseUsingColumns();
      usingColumns = usingResult.columns;
      endTokenSeq = usingResult.end_token_seq;
    } else if (joinType !== "CROSS") {
      /*
       * UNNESTを右辺に取るJOINは、BigQueryではON/USINGを省略できる
       * (相関UNNEST: LEFT/INNER JOIN UNNEST(t.arr) / UNNEST(arr) など)。
       * 配列が可視ソースを明示参照していなくても(素の列名やCTE列でも)有効なため、
       * UNNESTソースなら条件省略を一律で許可する。UNNEST以外の通常JOINは
       * 従来どおりON/USINGを必須とする。
       */
      if (source.source_type !== "UNNEST") {
        throw new SyntaxError(
          `FromParser: ${joinType} JOIN requires ON or USING condition.`
        );
      }
    }

    return {
      join_seq: joinSeq,
      join_type: joinType,
      join_syntax: "JOIN",
      join_start_seq: joinStartToken.token_seq,
      source,
      condition_type: conditionType,
      condition,
      using_columns: usingColumns,
      end_token_seq: endTokenSeq
    };
  }


  /**
   * 現在までにFROMへ登録されたソース名・別名を収集する。
   * 条件省略を許可する相関UNNESTの判定だけに使用する。
   */
  #collectVisibleSourceNames(source, joins) {
    const names = new Set();
    const sources = [source, ...joins.map((join) => join.source)];

    for (const currentSource of sources) {
      if (!currentSource) continue;
      if (currentSource.alias) names.add(currentSource.alias);

      if (currentSource.name_parts?.length > 0) {
        names.add(currentSource.name_parts[currentSource.name_parts.length - 1]);
      }
    }

    return names;
  }

  /**
   * UNNEST式が左側ですでに可視なソースを参照しているか判定する。
   * 例: UNNEST(customer.contacts) は customer を参照するため相関UNNEST。
   */
  #referencesVisibleSource(node, visibleSourceNames) {
    if (!node || !(visibleSourceNames instanceof Set)) return false;

    if (Array.isArray(node)) {
      return node.some((item) =>
        this.#referencesVisibleSource(item, visibleSourceNames)
      );
    }

    if (typeof node !== "object") return false;

    if (
      node.node_type === NodeType.IDENTIFIER_EXPRESSION &&
      Array.isArray(node.parts) &&
      node.parts.length >= 2 &&
      visibleSourceNames.has(node.parts[0])
    ) {
      return true;
    }

    for (const value of Object.values(node)) {
      if (this.#referencesVisibleSource(value, visibleSourceNames)) return true;
    }

    return false;
  }

  /**
   * JOIN、INNER JOIN、LEFT [OUTER] JOINなどを正規化する。
   */
  #parseJoinType() {
    if (this.reader.matches("JOIN")) {
      this.reader.consume();
      return "INNER";
    }

    const joinTypeToken = this.reader.current();
    const allowedTypes = ["INNER", "LEFT", "RIGHT", "FULL", "CROSS"];

    if (!joinTypeToken || !allowedTypes.includes(joinTypeToken.normalized_token)) {
      const actual = joinTypeToken ? joinTypeToken.token : "EOF";
      const error = new SyntaxError(
        `FromParser: JOIN was expected, but found "${actual}".`
      );
      error.parser_stage = "FromParser";
      error.parser_token = joinTypeToken ?? null;
      throw error;
    }

    const joinType = this.reader.consume().normalized_token;

    if (this.reader.matches("OUTER")) {
      this.reader.consume();
    }

    this.#consumeExpected("JOIN");

    return joinType;
  }

  /**
   * USING (column1, column2)を解析する。
   */
  #parseUsingColumns() {
    this.#consumeExpected("USING");
    this.#consumeExpected("(", false);

    const columns = [];

    while (!this.reader.matches(")", false)) {
      const columnToken = this.reader.current();

      if (!this.#isNameToken(columnToken)) {
        throw new SyntaxError("FromParser: column name was expected in USING.");
      }

      columns.push(columnToken.normalized_token);
      this.reader.consume();

      if (this.reader.matches(",", false)) {
        this.reader.consume();
        continue;
      }

      break;
    }

    const closeToken = this.#consumeExpected(")", false);

    return {
      columns,
      end_token_seq: closeToken.token_seq
    };
  }

  /**
   * ON条件の開始から、次のJOINまたはカンマ直前までを求める。
   * 括弧内部のJOINキーワードは条件境界として扱わない。
   */
  #findJoinConditionRange() {
    const startToken = this.reader.current();

    if (!startToken) {
      throw new SyntaxError("FromParser: ON condition is empty.");
    }

    const baseDepth = startToken.paren_depth;
    let endToken = null;
    let offset = 0;

    while (true) {
      const token = this.reader.peek(offset);

      if (!token) {
        break;
      }

      if (token.paren_depth === baseDepth && this.#isJoinBoundaryAtOffset(offset)) {
        break;
      }

      endToken = token;
      offset++;
    }

    if (!endToken) {
      throw new SyntaxError("FromParser: ON condition is empty.");
    }

    return {
      start_token_seq: startToken.token_seq,
      end_token_seq: endToken.token_seq
    };
  }

  #isJoinBoundaryAtOffset(offset) {
    const token = this.reader.peek(offset);

    if (!token) return true;
    if (token.token === ",") return true;
    if (token.normalized_token === "JOIN") return true;

    return ["INNER", "LEFT", "RIGHT", "FULL", "CROSS"].includes(
      token.normalized_token
    );
  }

  /**
   * AS aliasまたは暗黙aliasを解析する。
   * JOIN/ON/USINGなど、次の文法開始キーワードはaliasとして扱わない。
   */
  #parseAlias() {
    if (this.reader.matches("AS")) {
      this.reader.consume();
      const aliasToken = this.reader.current();

      if (!this.#isNameToken(aliasToken)) {
        throw new SyntaxError("FromParser: alias was expected after AS.");
      }

      this.reader.consume();

      return {
        alias: aliasToken.normalized_token,
        alias_type: "EXPLICIT_AS",
        alias_token: aliasToken
      };
    }

    const aliasToken = this.reader.current();

    if (this.#canBeImplicitAlias(aliasToken)) {
      this.reader.consume();

      return {
        alias: aliasToken.normalized_token,
        alias_type: "IMPLICIT",
        alias_token: aliasToken
      };
    }

    return {
      alias: null,
      alias_type: null,
      alias_token: null
    };
  }

  #canBeImplicitAlias(token) {
    if (!this.#isNameToken(token)) return false;

    const reserved = [
      "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "OUTER",
      "ON", "USING", "PIVOT", "UNPIVOT",
      "WHERE", "GROUP", "HAVING", "QUALIFY", "ORDER", "LIMIT",
      "WITH", "WINDOW", "UNION", "INTERSECT", "EXCEPT", "TABLESAMPLE"
    ];

    return !reserved.includes(token.normalized_token);
  }

  #isNameToken(token) {
    /*
     * BigQueryのバッククォート付き識別子も名前Tokenとして扱う。
     *
     * Lexerは `project.dataset.table` を内部のドットで分割せず、
     * 1つのBACKTICK_IDENTIFIERとして返す。そのためFromParser側では、
     * IDENTIFIER/KEYWORDと同様にテーブル名・別名・USING列として
     * 受け入れる必要がある。
     */
    return token !== null && [
      "IDENTIFIER",
      "KEYWORD",
      "BACKTICK_IDENTIFIER"
    ].includes(token.token_type);
  }

  #findMatchingCloseParenthesis(openToken) {
    const closeToken = this.sourceTokens.find((token) =>
      token.token === ")" &&
      token.token_seq > openToken.token_seq &&
      token.paren_depth === openToken.paren_depth
    );

    if (!closeToken) {
      throw new SyntaxError("FromParser: matching ')' was not found.");
    }

    return closeToken;
  }

  #previousNonCommentToken(tokenSeq) {
    for (let index = this.sourceTokens.length - 1; index >= 0; index--) {
      const token = this.sourceTokens[index];

      if (token.token_seq < tokenSeq && token.token_type !== "COMMENT") {
        return token;
      }
    }

    return null;
  }

  #moveAfterTokenSeq(tokenSeq) {
    const nextToken = this.tokens.find((token) => token.token_seq > tokenSeq);

    if (nextToken) {
      this.reader.moveToTokenSeq(nextToken.token_seq);
    } else {
      this.reader.reset();
      this.reader.advance(this.reader.length);
    }
  }

  #consumeExpected(value, normalized = true) {
    if (!this.reader.matches(value, normalized)) {
      const token = this.reader.current();
      const actual = token ? token.token : "EOF";
      throw new SyntaxError(
        `FromParser: expected "${value}", but found "${actual}".`
      );
    }

    return this.reader.consume();
  }

  #validateFromClause(fromClause) {
    if (!fromClause || fromClause.clause_type !== "FROM") {
      throw new TypeError("FromParser.parse: a FROM Clause is required.");
    }

    if (!Number.isInteger(fromClause.body_start_seq) ||
        !Number.isInteger(fromClause.body_end_seq)) {
      throw new TypeError(
        "FromParser.parse: FROM Clause token ranges must be integers."
      );
    }
  }
}
