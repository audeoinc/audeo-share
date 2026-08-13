/**
 * Lexerが生成したToken配列を読み取るための補助クラス。
 *
 * 設計方針:
 *
 * - TokenReader内部のポインタ操作には配列indexを使う。
 * - 外部へ公開する位置情報にはtoken_seqを使う。
 * - Token配列自体は変更しない。
 */
class TokenReader {
  constructor(tokens, startTokenSeq = null) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("TokenReader: tokens must be an array.");
    }

    this.tokens = tokens;
    this.index = 0;

    if (startTokenSeq !== null) {
      this.moveToTokenSeq(startTokenSeq);
    }
  }

  get length() {
    return this.tokens.length;
  }

  /**
   * 現在Tokenのtoken_seqを返す。
   * EOFの場合はnullを返す。
   */
  get positionTokenSeq() {
    const currentToken = this.current();

    return currentToken ? currentToken.token_seq : null;
  }

  hasCurrent() {
    return this.index >= 0 && this.index < this.tokens.length;
  }

  isEnd() {
    return this.index >= this.tokens.length;
  }

  current() {
    return this.tokens[this.index] || null;
  }

  peek(offset = 0) {
    if (!Number.isInteger(offset)) {
      throw new TypeError("TokenReader.peek: offset must be an integer.");
    }

    const targetIndex = this.index + offset;

    return this.tokens[targetIndex] || null;
  }

  previous() {
    return this.peek(-1);
  }

  nextToken() {
    return this.peek(1);
  }

  consume() {
    const currentToken = this.current();

    if (this.hasCurrent()) {
      this.index++;
    }

    return currentToken;
  }

  advance(count = 1) {
    if (!Number.isInteger(count) || count < 0) {
      throw new TypeError(
        "TokenReader.advance: count must be a non-negative integer."
      );
    }

    const targetIndex = this.index + count;

    if (targetIndex > this.tokens.length) {
      throw new RangeError(
        `TokenReader.advance: cannot advance from index ${this.index} by ${count}. ` +
        `Target index ${targetIndex} exceeds EOF (${this.tokens.length}).`
      );
    }

    this.index = targetIndex;

    return this;
  }

  rewind(count = 1) {
    if (!Number.isInteger(count) || count < 0) {
      throw new TypeError(
        "TokenReader.rewind: count must be a non-negative integer."
      );
    }

    const targetIndex = this.index - count;

    if (targetIndex < 0) {
      throw new RangeError(
        `TokenReader.rewind: cannot rewind from index ${this.index} by ${count}. ` +
        `Target index ${targetIndex} is before the beginning of the token array.`
      );
    }

    this.index = targetIndex;

    return this;
  }

  reset() {
    this.index = 0;

    return this;
  }

  /**
   * 現在位置をtoken_seqとして保存する。
   * EOFの場合はnullを返す。
   */
  mark() {
    const currentToken = this.current();

    return currentToken ? currentToken.token_seq : null;
  }

  /**
   * mark()で保存したtoken_seqへ戻る。
   * nullの場合はEOFへ移動する。
   */
  restore(markedTokenSeq) {
    if (markedTokenSeq === null) {
      this.index = this.tokens.length;
      return this;
    }

    return this.moveToTokenSeq(markedTokenSeq);
  }

  /**
   * 指定token_seqへ移動する。
   */
  moveToTokenSeq(tokenSeq) {
    if (!Number.isInteger(tokenSeq)) {
      throw new TypeError(
        "TokenReader.moveToTokenSeq: tokenSeq must be an integer."
      );
    }

    const targetIndex = this.#findIndexByTokenSeq(tokenSeq);

    if (targetIndex < 0) {
      throw new RangeError(
        `TokenReader.moveToTokenSeq: token_seq ${tokenSeq} was not found.`
      );
    }

    this.index = targetIndex;

    return this;
  }

  matches(value, normalized = true) {
    const currentToken = this.current();

    if (!currentToken) {
      return false;
    }

    const actualValue = normalized
      ? currentToken.normalized_token
      : currentToken.token;

    const expectedValue = normalized
      ? String(value).toUpperCase()
      : String(value);

    return actualValue === expectedValue;
  }

  matchesType(tokenType) {
    const currentToken = this.current();

    return currentToken !== null && currentToken.token_type === tokenType;
  }

  matchesAny(values, normalized = true) {
    if (!Array.isArray(values)) {
      throw new TypeError("TokenReader.matchesAny: values must be an array.");
    }

    return values.some((value) => this.matches(value, normalized));
  }

  consumeIf(value, normalized = true) {
    if (!this.matches(value, normalized)) {
      return null;
    }

    return this.consume();
  }

  consumeTypeIf(tokenType) {
    if (!this.matchesType(tokenType)) {
      return null;
    }

    return this.consume();
  }

  skipComments() {
    while (this.hasCurrent() && this.matchesType("COMMENT")) {
      this.advance();
    }

    return this;
  }

  /**
   * 現在位置以降で最初の非COMMENT Tokenを返す。
   *
   * 現在位置は変更しない。
   * 位置情報が必要な場合は返却Tokenのtoken_seqを利用する。
   */
  peekNonComment(startOffset = 0) {
    if (!Number.isInteger(startOffset) || startOffset < 0) {
      throw new TypeError(
        "TokenReader.peekNonComment: startOffset must be a non-negative integer."
      );
    }

    let targetIndex = this.index + startOffset;

    while (targetIndex < this.tokens.length) {
      const targetToken = this.tokens[targetIndex];

      if (targetToken.token_type !== "COMMENT") {
        return targetToken;
      }

      targetIndex++;
    }

    return null;
  }

  /**
   * 指定token_seqの開き括弧に対応する閉じ括弧Tokenを返す。
   */
  findMatchingCloseParenthesis(openTokenSeq) {
    const openIndex = this.#findIndexByTokenSeq(openTokenSeq);
    const openToken = openIndex >= 0 ? this.tokens[openIndex] : null;

    if (!openToken || openToken.token !== "(") {
      return null;
    }

    const targetDepth = openToken.paren_depth;

    for (
      let tokenIndex = openIndex + 1;
      tokenIndex < this.tokens.length;
      tokenIndex++
    ) {
      const currentToken = this.tokens[tokenIndex];

      if (
        currentToken.token === ")" &&
        currentToken.paren_depth === targetDepth
      ) {
        return currentToken;
      }
    }

    return null;
  }

  /**
   * 指定token_seqの開き角括弧に対応する閉じ角括弧Tokenを返す。
   */
  findMatchingCloseBracket(openTokenSeq) {
    const openIndex = this.#findIndexByTokenSeq(openTokenSeq);
    const openToken = openIndex >= 0 ? this.tokens[openIndex] : null;

    if (!openToken || openToken.token !== "[") {
      return null;
    }

    const targetDepth = openToken.paren_depth;

    for (
      let tokenIndex = openIndex + 1;
      tokenIndex < this.tokens.length;
      tokenIndex++
    ) {
      const currentToken = this.tokens[tokenIndex];

      if (
        currentToken.token === "]" &&
        currentToken.paren_depth === targetDepth
      ) {
        return currentToken;
      }
    }

    return null;
  }

  /**
   * token_seqの範囲でTokenを切り出す。
   *
   * startTokenSeqとendTokenSeqの両方を含む。
   */
  sliceByTokenSeq(startTokenSeq, endTokenSeq) {
    if (!Number.isInteger(startTokenSeq) || !Number.isInteger(endTokenSeq)) {
      throw new TypeError(
        "TokenReader.sliceByTokenSeq: token sequences must be integers."
      );
    }

    if (endTokenSeq < startTokenSeq) {
      throw new RangeError(
        `TokenReader.sliceByTokenSeq: endTokenSeq ${endTokenSeq} ` +
        `is smaller than startTokenSeq ${startTokenSeq}.`
      );
    }

    return this.tokens.filter(
      (token) =>
        token.token_seq >= startTokenSeq &&
        token.token_seq <= endTokenSeq
    );
  }

  /**
   * 指定文字列に一致する最初のTokenを前方検索する。
   *
   * startTokenSeqを省略した場合は現在位置から検索する。
   */
  findForward(value, options = {}) {
    const {
      startTokenSeq = this.positionTokenSeq,
      normalized = true,
      targetDepth = null,
      skipComments = true
    } = options;

    let startIndex = this.index;

    if (startTokenSeq !== null) {
      startIndex = this.#findIndexByTokenSeq(startTokenSeq);

      if (startIndex < 0) {
        throw new RangeError(
          `TokenReader.findForward: startTokenSeq ${startTokenSeq} was not found.`
        );
      }
    }

    const expectedValue = normalized
      ? String(value).toUpperCase()
      : String(value);

    for (
      let tokenIndex = startIndex;
      tokenIndex < this.tokens.length;
      tokenIndex++
    ) {
      const currentToken = this.tokens[tokenIndex];

      if (skipComments && currentToken.token_type === "COMMENT") {
        continue;
      }

      if (targetDepth !== null && currentToken.paren_depth !== targetDepth) {
        continue;
      }

      const actualValue = normalized
        ? currentToken.normalized_token
        : currentToken.token;

      if (actualValue === expectedValue) {
        return currentToken;
      }
    }

    return null;
  }

  clone(startTokenSeq = this.positionTokenSeq) {
    return new TokenReader(this.tokens, startTokenSeq);
  }

  /**
   * TokenReader内部専用。
   *
   * token_seqから配列indexへ変換する。
   * Parserなど外部からは利用しない。
   */
  #findIndexByTokenSeq(tokenSeq) {
    return this.tokens.findIndex((token) => token.token_seq === tokenSeq);
  }
}
