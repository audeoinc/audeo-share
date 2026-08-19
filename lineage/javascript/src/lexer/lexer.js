/**
 * SQL文字列を、Parserが扱いやすいToken配列へ変換するLexer。
 *
 * Lexerの責務は「SQLの意味を理解すること」ではなく、SQL文字列を
 * KEYWORD、IDENTIFIER、NUMBER、STRING、SYMBOLなどの最小単位へ分解すること。
 *
 * 例えば次のSQLを受け取った場合、
 *
 *   SELECT SUM(amount) FROM sales
 *
 * おおむね次のToken配列を返す。
 *
 *   SELECT   KEYWORD
 *   SUM      IDENTIFIER
 *   (        SYMBOL
 *   amount   IDENTIFIER
 *   )        SYMBOL
 *   FROM     KEYWORD
 *   sales    IDENTIFIER
 *
 * LexerがTokenへ付与する主な情報:
 *
 * - token_seq:
 *     Parser、Resolver、保存テーブルで共通利用するTokenの論理連番。
 *     JavaScript配列のindexとは異なり、1から始まる。
 *
 * - line_no / column_no:
 *     SQL上でTokenが開始した位置。エラー表示やデバッグに使用する。
 *
 * - normalized_token:
 *     大文字・小文字の違いを吸収して比較するための値。
 *     通常の識別子やKeywordは大文字へ統一する。
 *
 * - token_type:
 *     後続Parserが文字列そのものだけで判断しなくて済むように、
 *     Tokenの種類を明示する。
 *
 * - paren_depth:
 *     関数、サブクエリ、Window句などの括弧の入れ子を識別する。
 *
 * depth仕様:
 *
 *   SUM(amount)
 *
 *   SUM     depth 0
 *   (       depth 0
 *   amount  depth 1
 *   )       depth 0
 *
 * 「括弧そのもの」ではなく「括弧の中身だけ」を1段深くする。
 * そのため、開き括弧は現在depthで保存してからdepthを上げ、
 * 閉じ括弧はdepthを下げてから保存する。
 *
 * @param {string} sqlText Token化するSQL文字列
 * @returns {Array<object>} Lexerが生成したToken配列
 */
function tokenize(sqlText) {
  /*
   * Lexerは文字列を1文字ずつ処理するため、文字列以外を受け取ると
   * 意味のある解析ができない。暗黙変換はせず、呼び出し側の誤りを
   * 早い段階で検出する。
   */
  if (typeof sqlText !== "string") {
    throw new TypeError("tokenize: sqlText must be a string.");
  }

  // 解析結果となるTokenを、SQLに現れた順番で格納する。
  const tokens = [];

  /*
   * Lexerが文字列を左から右へ読むために保持する状態。
   *
   * tokenSeq:
   *   次に発行するtoken_seqの元値。pushToken()で1増やしてから保存する。
   *
   * line / column:
   *   現在indexが指している文字のSQL上の位置。
   *
   * parenDepth:
   *   現在の文字が属する括弧内の深さ。
   *
   * index:
   *   sqlText配列上の現在位置。Lexer内部だけで使用する0始まりの座標。
   */
  let tokenSeq = 0;
  let line = 1;
  let column = 1;
  let parenDepth = 0;
  let index = 0;

  /*
   * Keywordとして分類する予約語一覧。
   *
   * LexerはSQL文法の正当性までは判定しない。
   * このSetは、読み取った単語をKEYWORDとして分類するか、
   * IDENTIFIERとして分類するかを決めるために使用する。
   */
  const KEYWORDS = new Set([
    "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "QUALIFY",
    "ORDER", "LIMIT", "JOIN", "LEFT", "RIGHT", "FULL", "INNER",
    "OUTER", "CROSS", "ON", "USING", "WITH", "RECURSIVE", "AS",
    "UNION", "ALL", "DISTINCT", "AND", "OR", "NOT", "IN", "IS",
    "NULL", "TRUE", "FALSE", "CASE", "WHEN", "THEN", "ELSE", "END",
    "OVER", "PARTITION", "UNNEST", "STRUCT", "ARRAY", "EXCEPT",
    "REPLACE", "INTERSECT", "OFFSET", "ORDINAL", "ASC", "DESC",
    "ROWS", "RANGE", "GROUPS", "NULLS", "FIRST", "LAST", "BETWEEN",
    "PRECEDING", "FOLLOWING", "CURRENT", "ROW", "EXISTS"
  ]);

  /*
   * SQL構造を区切る1文字記号。
   *
   * () と [] はparenDepthを変化させる。
   * カンマ、ドット、セミコロンはToken化するだけでdepthは変えない。
   */
  const SYMBOLS = new Set(["(", ")", ",", ".", ";", "[", "]"]);

  // 単独でも演算子として成立する1文字演算子。
  const SINGLE_OPERATORS = new Set(["=", "+", "-", "*", "/", "%", "<", ">", "!"]);

  /*
   * 2文字で1つの意味を持つ演算子。
   *
   * SINGLE_OPERATORSより先に評価しないと、>= が > と = の2Tokenへ
   * 分割されてしまうため、メインループでは必ずこちらを先に判定する。
   */
  const DOUBLE_OPERATORS = new Set([">=", "<=", "!=", "<>", "||"]);

  /**
   * 解析済みの1Tokenをtokens配列へ追加する。
   *
   * Token生成処理を1か所へ集約する理由:
   *
   * - token_seqの採番方法を全Tokenで統一できる。
   * - line、column、depthの付与漏れを防げる。
   * - 後からToken項目を追加するとき、修正箇所を1か所にできる。
   *
   * @param {string} token SQLに記述されていた元の文字列
   * @param {string} normalizedToken 比較用に正規化した文字列
   * @param {string} tokenType Tokenの分類
   * @param {number} tokenLine Token開始行
   * @param {number} tokenColumn Token開始列
   */
  function pushToken(token, normalizedToken, tokenType, tokenLine, tokenColumn) {
    tokens.push({
      token_seq: ++tokenSeq,
      line_no: tokenLine,
      column_no: tokenColumn,
      token,
      normalized_token: normalizedToken,
      token_type: tokenType,
      paren_depth: parenDepth
    });
  }

  /**
   * 空白文字か判定する。
   *
   * 半角スペースだけでなく、改行やタブも空白として扱うため、\sを使う。
   * 空白はTokenには保存しないが、lineとcolumnは正しく進める。
   */
  function isSpace(character) {
    return /\s/.test(character);
  }

  /**
   * 通常識別子を開始できる文字か判定する。
   *
   * 数字を含めない理由:
   * 数字で始まる文字列は、まず数値リテラルとして処理すべきだから。
   * 数字始まりの識別子は、BigQueryではバッククォートで囲む必要があり、
   * BACKTICK_IDENTIFIERの分岐で別に処理する。
   */
  function isIdentifierStart(character) {
    return /[A-Za-z_]/.test(character);
  }

  /**
   * 識別子の2文字目以降として使用できる文字か判定する。
   *
   * customer1 や _TABLE_SUFFIX のような識別子を扱うため、
   * 開始文字の条件に加えて数字と$を許可する。
   */
  function isIdentifierPart(character) {
    return /[A-Za-z0-9_$]/.test(character);
  }

  /**
   * 数値リテラルの開始文字か判定する。
   *
   * 先頭文字は0〜9だけを許可する。
   * 小数点は、数値の読み取りを開始した後のwhile条件で許可する。
   */
  function isDigit(character) {
    return /[0-9]/.test(character);
  }

  /**
   * 現在の1文字を消費し、次の文字へ進む。
   *
   * indexだけでなくlineとcolumnも同時に更新することで、
   * どの分岐から呼ばれても位置情報を一貫して管理できる。
   *
   * @param {string} character 今回消費する文字
   */
  function advanceCharacter(character) {
    if (character === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }

    index++;
  }

  /*
   * SQL文字列を左から右へ、1文字または複数文字単位で読み取る。
   *
   * 各分岐の末尾にcontinueがあるため、一度分類が確定した文字を
   * 後続の別分岐で二重に評価しない。
   */
  while (index < sqlText.length) {
    // このループで最初に評価する現在位置の文字。
    const character = sqlText[index];

    /*
     * 空白はToken化せず、位置だけ進める。
     * コメントや文字列の中の空白は、それぞれ専用分岐内で処理される。
     */
    if (isSpace(character)) {
      advanceCharacter(character);
      continue;
    }

    /*
     * Tokenの開始位置は、文字を読み進める前に保存する必要がある。
     * 読み取り後のline/columnを使うとToken末尾の位置になってしまう。
     */
    const startLine = line;
    const startColumn = column;

    /*
     * 1行コメントを読み取る。
     *
     * 「--」または「#」を見つけた位置から改行直前までを1つのCOMMENT Token
     * にする。BigQueryは「--」「#」の両方を単一行コメントとして扱う。
     * 改行はこのTokenに含めず、次のメインループで空白として処理する。
     */
    if ((character === "-" && sqlText[index + 1] === "-") ||
        character === "#") {
      let value = "";

      while (index < sqlText.length && sqlText[index] !== "\n") {
        const current = sqlText[index];

        value += current;
        advanceCharacter(current);
      }

      pushToken(value, value, "COMMENT", startLine, startColumn);
      continue;
    }

    /*
     * 複数行コメントを読み取る。
     *
     * 開始記号から終了記号までを、改行を含めて1つのCOMMENT Tokenにする。
     * 終了記号は2文字なので、*を消費した後に/も明示的に消費する。
     */
    if (character === "/" && sqlText[index + 1] === "*") {
      let value = "";

      while (index < sqlText.length) {
        const current = sqlText[index];

        value += current;

        if (current === "*" && sqlText[index + 1] === "/") {
          advanceCharacter(current);

          const closingSlash = sqlText[index];
          value += closingSlash;
          advanceCharacter(closingSlash);
          break;
        }

        advanceCharacter(current);
      }

      pushToken(value, value, "COMMENT", startLine, startColumn);
      continue;
    }

    /*
     * バッククォート識別子を読み取る。
     *
     * `project.dataset.table` のような名前は、内部のドットをSYMBOLへ
     * 分割せず、全体を1つのBACKTICK_IDENTIFIERとして保存する。
     * normalized_tokenからは外側のバッククォートだけを除去する。
     */
    if (character === "`") {
      let value = character;

      advanceCharacter(character);

      while (index < sqlText.length) {
        const current = sqlText[index];

        value += current;
        advanceCharacter(current);

        if (current === "`") {
          break;
        }
      }

      const normalizedValue = value.length >= 2
        ? value.substring(1, value.length - 1)
        : value;

      pushToken(
        value,
        normalizedValue,
        "BACKTICK_IDENTIFIER",
        startLine,
        startColumn
      );

      continue;
    }

    /*
     * 文字列リテラルを読み取る。
     *
     * シングルクォートとダブルクォートの両方を同じ処理で扱うため、
     * 開始時のquoteCharacterを保存し、同じ文字が来るまで読み進める。
     *
     * '' や "" のように引用符が連続する場合はエスケープ表現として扱い、
     * 文字列終了とは判定しない。
     */
    if (character === "'" || character === '"') {
      const quoteCharacter = character;
      let value = character;

      advanceCharacter(character);

      while (index < sqlText.length) {
        const current = sqlText[index];

        value += current;
        advanceCharacter(current);

        if (current === quoteCharacter && sqlText[index] === quoteCharacter) {
          const escapedQuote = sqlText[index];

          value += escapedQuote;
          advanceCharacter(escapedQuote);
          continue;
        }

        if (current === quoteCharacter) {
          break;
        }
      }

      const normalizedValue = value.length >= 2
        ? value.substring(1, value.length - 1)
        : value;

      pushToken(value, normalizedValue, "STRING", startLine, startColumn);
      continue;
    }

    /*
     * 文字列リテラル接頭辞を読み取る。
     *
     * BigQueryは r'...'(raw)、b'...'(bytes)、および rb/br の組み合わせを
     * 文字列リテラルの接頭辞として認める。接頭辞の直後(空白なし)に引用符が
     * 続く場合のみ文字列として扱い、それ以外は通常の識別子として処理する。
     * normalized_tokenは接頭辞と引用符を除いた中身にする。
     */
    {
      const twoChar = sqlText.substr(index, 2).toLowerCase();
      const oneChar = character.toLowerCase();
      let prefixLength = 0;

      if ((twoChar === "rb" || twoChar === "br") &&
          (sqlText[index + 2] === "'" || sqlText[index + 2] === '"')) {
        prefixLength = 2;
      } else if ((oneChar === "r" || oneChar === "b") &&
          (sqlText[index + 1] === "'" || sqlText[index + 1] === '"')) {
        prefixLength = 1;
      }

      if (prefixLength > 0) {
        let value = "";

        for (let offset = 0; offset < prefixLength; offset++) {
          const current = sqlText[index];
          value += current;
          advanceCharacter(current);
        }

        const quoteCharacter = sqlText[index];
        value += quoteCharacter;
        advanceCharacter(quoteCharacter);

        while (index < sqlText.length) {
          const current = sqlText[index];
          value += current;
          advanceCharacter(current);

          if (current === quoteCharacter && sqlText[index] === quoteCharacter) {
            const escapedQuote = sqlText[index];
            value += escapedQuote;
            advanceCharacter(escapedQuote);
            continue;
          }

          if (current === quoteCharacter) {
            break;
          }
        }

        const normalizedValue = value.length >= prefixLength + 2
          ? value.substring(prefixLength + 1, value.length - 1)
          : value;

        pushToken(value, normalizedValue, "STRING", startLine, startColumn);
        continue;
      }
    }

    /*
     * 名前付きクエリパラメータ @name / システム変数 @@name（dbt 由来の @key /
     * @limit など）を 1 つの Token として読み取る。'@' と名前を分けると、名前が
     * 句キーワード（LIMIT / ORDER / WHERE ...）と一致する場合に ClauseParser が
     * その位置を句の開始と誤認してしまう。token_type を PARAMETER にし、
     * normalized も '@' 込み（例: '@LIMIT'）にすることでキーワードと衝突させない。
     */
    if (character === "@") {
      let value = "@";
      advanceCharacter("@");

      if (sqlText[index] === "@") {
        value += "@";
        advanceCharacter("@");
      }

      while (index < sqlText.length && isIdentifierPart(sqlText[index])) {
        value += sqlText[index];
        advanceCharacter(sqlText[index]);
      }

      pushToken(value, value.toUpperCase(), "PARAMETER", startLine, startColumn);
      continue;
    }

    /*
     * 位置パラメータ '?'（positional query parameter）。名前を持たないため
     * 識別子として解決できないが、値は DAG / クライアントが別途バインドする。
     * 名前付き @name と同じく 1 つの PARAMETER Token として扱い、式の中では
     * 不透明な値（系統を持たない）とする。これをしないと '?' が未知文字として
     * 解析失敗（PARTIAL_FAILURE）になり、「未解決」と「パラメータ」の区別が
     * つかなくなる。
     */
    if (character === "?") {
      advanceCharacter("?");
      pushToken("?", "?", "PARAMETER", startLine, startColumn);
      continue;
    }

    /*
     * 通常識別子またはKeywordを読み取る。
     *
     * 最初の文字が識別子開始条件を満たした後、識別子として継続できる
     * 文字を可能な限りまとめて読み取る。読み取った文字列を大文字化し、
     * KEYWORDSに存在すればKEYWORD、それ以外はIDENTIFIERに分類する。
     */
    if (isIdentifierStart(character)) {
      let value = "";

      while (index < sqlText.length && isIdentifierPart(sqlText[index])) {
        const current = sqlText[index];

        value += current;
        advanceCharacter(current);
      }

      const normalizedValue = value.toUpperCase();
      const tokenType = KEYWORDS.has(normalizedValue) ? "KEYWORD" : "IDENTIFIER";

      pushToken(value, normalizedValue, tokenType, startLine, startColumn);
      continue;
    }

    /*
     * 数値リテラルを読み取る。
     *
     * 最初の文字はisDigit()により必ず0〜9。
     * 2文字目以降は整数と小数をまとめるため、0〜9とドットを許可する。
     *
     * 現時点では12.3.4のような複数ドットの文法エラー判定までは行わない。
     * Lexerの責務をToken分割に留め、必要ならValidation層で検出する。
     */
    if (isDigit(character)) {
      let value = "";

      // Integer part.
      while (index < sqlText.length && /[0-9]/.test(sqlText[index])) {
        value += sqlText[index];
        advanceCharacter(sqlText[index]);
      }

      /*
       * Fractional part. A '.' belongs to the number (123.45, trailing 123.)
       * UNLESS it is immediately followed by an identifier-start character, in
       * which case the '.' is a path separator / field access and the number
       * ends before it. Without this, a dashed table path with a digit-ending
       * segment — e.g. `my-project-123.dataset` — lexed `123.` as one number
       * token (eating the separator) and broke FROM parsing. `123.45` keeps the
       * dot (next char is a digit); `123.` at end / before whitespace also keeps
       * it (unchanged); only `123.<letter>` now splits.
       */
      while (
        sqlText[index] === "." &&
        !/[A-Za-z_`]/.test(sqlText[index + 1] || "")
      ) {
        value += ".";
        advanceCharacter(".");

        while (index < sqlText.length && /[0-9]/.test(sqlText[index])) {
          value += sqlText[index];
          advanceCharacter(sqlText[index]);
        }
      }

      /*
       * 指数表記(例: 1.5e3, 2E-4)を取り込む。eまたはEの直後に符号か数字が
       * 続く場合のみ指数部として扱い、それ以外(例: 1 e AS ...)は別Tokenへ残す。
       */
      if ((sqlText[index] === "e" || sqlText[index] === "E") &&
          /[0-9+\-]/.test(sqlText[index + 1] || "")) {
        value += sqlText[index];
        advanceCharacter(sqlText[index]);

        if (sqlText[index] === "+" || sqlText[index] === "-") {
          value += sqlText[index];
          advanceCharacter(sqlText[index]);
        }

        while (index < sqlText.length && /[0-9]/.test(sqlText[index])) {
          value += sqlText[index];
          advanceCharacter(sqlText[index]);
        }
      }

      pushToken(value, value, "NUMBER", startLine, startColumn);
      continue;
    }

    /*
     * 2文字演算子を先に判定する。
     *
     * ここを1文字演算子より後にすると、>= が > と = に分割される。
     * Lexerでは「より長く一致する候補を先に評価する」のが基本原則。
     */
    const twoCharacters = sqlText.substring(index, index + 2);

    if (DOUBLE_OPERATORS.has(twoCharacters)) {
      pushToken(twoCharacters, twoCharacters, "OPERATOR", startLine, startColumn);

      // 2文字演算子なので、現在文字と次の文字をそれぞれ消費する。
      advanceCharacter(sqlText[index]);
      advanceCharacter(sqlText[index]);
      continue;
    }

    /*
     * 括弧、カンマ、ドットなどの構造記号を処理する。
     *
     * depthの更新順序が重要:
     *
     * - 閉じ括弧:
     *     括弧の外側のdepthで保存したいため、先にdepthを下げる。
     *
     * - 開き括弧:
     *     開き括弧自体は外側のdepthで保存し、その後の中身から深くする。
     *
     * これにより、対応する開き括弧と閉じ括弧が同じdepthになり、
     * TokenReaderで対応括弧を探しやすくなる。
     */
    if (SYMBOLS.has(character)) {
      if (character === ")" || character === "]") {
        parenDepth--;

        /*
         * depthが負になるのは、対応する開き括弧がない閉じ括弧が
         * 出現したことを意味する。黙って0へ補正すると不正SQLを隠すため、
         * 行・列情報を含むSyntaxErrorとして通知する。
         */
        if (parenDepth < 0) {
          throw new SyntaxError(
            `tokenize: unexpected closing symbol "${character}" ` +
            `at line ${startLine}, column ${startColumn}.`
          );
        }
      }

      pushToken(character, character, "SYMBOL", startLine, startColumn);

      if (character === "(" || character === "[") {
        parenDepth++;
      }

      // SYMBOLはすべて1文字なので、共通処理として最後に1文字進める。
      advanceCharacter(character);
      continue;
    }

    // 2文字演算子に該当しなかった1文字演算子をToken化する。
    if (SINGLE_OPERATORS.has(character)) {
      pushToken(character, character, "OPERATOR", startLine, startColumn);
      advanceCharacter(character);
      continue;
    }

    /*
     * どの分類にも該当しない文字も捨てずにUNKNOWNとして保存する。
     *
     * 未対応文字を消してしまうと、Parserの結果がおかしい原因を追えない。
     * UNKNOWNとして残すことで、後続Validationやデバッグで検出できる。
     */
    pushToken(character, character, "UNKNOWN", startLine, startColumn);
    advanceCharacter(character);
  }

  /*
   * SQL末尾まで読んだ時点でdepthが0でなければ、開き括弧が閉じられていない。
   * 不完全なToken列を後続Parserへ渡さず、Lexer段階で明示的に失敗させる。
   */
  if (parenDepth !== 0) {
    throw new SyntaxError(
      `tokenize: unclosed parenthesis or bracket. Remaining depth: ${parenDepth}.`
    );
  }

  return tokens;
}

/*
 * オブジェクト形式でexportすることで、将来Lexerから別の公開関数を
 * 追加してもrequire側の書き方を統一できる。
 */
