/**
 * AST Nodeの種類を一元管理する定数オブジェクト。
 *
 * JavaScriptでは存在しないプロパティ参照はundefinedになるため、
 * AstFactoryはNode生成時にnode_typeを必ず検証する。
 */
const NodeType = Object.freeze({
  ARITHMETIC_EXPRESSION: "ARITHMETIC_EXPRESSION",
  LOGICAL_EXPRESSION: "LOGICAL_EXPRESSION",
  COMPARISON_EXPRESSION: "COMPARISON_EXPRESSION",
  CONCATENATION_EXPRESSION: "CONCATENATION_EXPRESSION",
  UNARY_EXPRESSION: "UNARY_EXPRESSION",
  BETWEEN_EXPRESSION: "BETWEEN_EXPRESSION",
  IN_EXPRESSION: "IN_EXPRESSION",
  IS_EXPRESSION: "IS_EXPRESSION",
  DISTINCT_FROM_EXPRESSION: "DISTINCT_FROM_EXPRESSION",
  IDENTIFIER_EXPRESSION: "IDENTIFIER_EXPRESSION",
  WILDCARD_EXPRESSION: "WILDCARD_EXPRESSION",
  LITERAL_EXPRESSION: "LITERAL_EXPRESSION",
  FUNCTION_CALL_EXPRESSION: "FUNCTION_CALL_EXPRESSION",
  PARENTHESIZED_EXPRESSION: "PARENTHESIZED_EXPRESSION",
  EXPRESSION_LIST: "EXPRESSION_LIST",
  SUBQUERY_EXPRESSION: "SUBQUERY_EXPRESSION",
  ARRAY_SUBQUERY_EXPRESSION: "ARRAY_SUBQUERY_EXPRESSION",
  RAW_EXPRESSION: "RAW_EXPRESSION",
  CASE_EXPRESSION: "CASE_EXPRESSION",
  CASE_WHEN_CLAUSE: "CASE_WHEN_CLAUSE",
  EXISTS_EXPRESSION: "EXISTS_EXPRESSION",
  WINDOW_EXPRESSION: "WINDOW_EXPRESSION",
  WINDOW_SPECIFICATION: "WINDOW_SPECIFICATION",
  WINDOW_ORDER_ITEM: "WINDOW_ORDER_ITEM"
});

/**
 * AST Node生成と入力検証だけを担当するFactory。
 *
 * ParserからNode生成を分離する理由:
 * - ParserはSQL文法を読む処理へ集中できる。
 * - AST形式を変更するときの修正箇所を集約できる。
 * - 壊れたNodeを生成時点で検出できる。
 */
class AstFactory {
  static createBinary(nodeType, operator, leftNode, rightNode) {
    AstFactory.#validateNodeType(nodeType);
    AstFactory.#validateAstNode(leftNode, "leftNode");
    AstFactory.#validateAstNode(rightNode, "rightNode");

    return AstFactory.#createNode(nodeType, leftNode.start_token_seq, rightNode.end_token_seq, {
      operator,
      left: leftNode,
      right: rightNode
    });
  }

  static createUnary(operator, operatorTokenSeq, operandNode) {
    AstFactory.#validateAstNode(operandNode, "operandNode");

    return AstFactory.#createNode(
      NodeType.UNARY_EXPRESSION,
      operatorTokenSeq,
      operandNode.end_token_seq,
      { operator, operand: operandNode }
    );
  }

  static createBetween(expressionNode, lowerNode, upperNode, negated) {
    AstFactory.#validateAstNode(expressionNode, "expressionNode");
    AstFactory.#validateAstNode(lowerNode, "lowerNode");
    AstFactory.#validateAstNode(upperNode, "upperNode");

    return AstFactory.#createNode(
      NodeType.BETWEEN_EXPRESSION,
      expressionNode.start_token_seq,
      upperNode.end_token_seq,
      {
        expression: expressionNode,
        lower_bound: lowerNode,
        upper_bound: upperNode,
        negated: Boolean(negated)
      }
    );
  }

  static createIn(expressionNode, valuesNode, negated) {
    AstFactory.#validateAstNode(expressionNode, "expressionNode");
    AstFactory.#validateAstNode(valuesNode, "valuesNode");

    return AstFactory.#createNode(
      NodeType.IN_EXPRESSION,
      expressionNode.start_token_seq,
      valuesNode.end_token_seq,
      { expression: expressionNode, values: valuesNode, negated: Boolean(negated) }
    );
  }

  static createIs(expressionNode, test, negated, endTokenSeq) {
    AstFactory.#validateAstNode(expressionNode, "expressionNode");

    return AstFactory.#createNode(
      NodeType.IS_EXPRESSION,
      expressionNode.start_token_seq,
      endTokenSeq,
      { expression: expressionNode, test, negated: Boolean(negated) }
    );
  }

  static createDistinctFrom(leftNode, rightNode, negated) {
    AstFactory.#validateAstNode(leftNode, "leftNode");
    AstFactory.#validateAstNode(rightNode, "rightNode");

    return AstFactory.#createNode(
      NodeType.DISTINCT_FROM_EXPRESSION,
      leftNode.start_token_seq,
      rightNode.end_token_seq,
      { left: leftNode, right: rightNode, negated: Boolean(negated) }
    );
  }

  static createIdentifier(nameTokens) {
    if (!Array.isArray(nameTokens) || nameTokens.length === 0) {
      throw new TypeError("AstFactory.createIdentifier: nameTokens is required.");
    }

    const name = nameTokens.map((token) => token.token).join("");
    const parts = nameTokens
      .filter((token) => token.token !== ".")
      .map((token) => token.normalized_token);

    return AstFactory.#createNode(
      NodeType.IDENTIFIER_EXPRESSION,
      nameTokens[0].token_seq,
      nameTokens[nameTokens.length - 1].token_seq,
      { name, parts }
    );
  }

  static createWildcard(nameTokens) {
    const lastToken = nameTokens[nameTokens.length - 1];
    const qualifierTokens = nameTokens.slice(0, -2);

    return AstFactory.#createNode(
      NodeType.WILDCARD_EXPRESSION,
      nameTokens[0].token_seq,
      lastToken.token_seq,
      {
        qualifier: qualifierTokens.length > 0
          ? qualifierTokens.map((token) => token.token).join("")
          : null
      }
    );
  }

  static createLiteral(token, literalType, value) {
    return AstFactory.#createNode(
      NodeType.LITERAL_EXPRESSION,
      token.token_seq,
      token.token_seq,
      { literal_type: literalType, value }
    );
  }

  static createFunctionCall(nameTokens, argumentsList, openToken, closeToken, argumentModifier = null) {
    AstFactory.#validateAstNodeList(argumentsList, "argumentsList");

    return AstFactory.#createNode(
      NodeType.FUNCTION_CALL_EXPRESSION,
      nameTokens[0].token_seq,
      closeToken.token_seq,
      {
        function_name: nameTokens.map((token) => token.token).join(""),
        function_name_parts: nameTokens
          .filter((token) => token.token !== ".")
          .map((token) => token.normalized_token),
        arguments: argumentsList,
        argument_modifier: argumentModifier,
        open_parenthesis_seq: openToken.token_seq,
        close_parenthesis_seq: closeToken.token_seq
      }
    );
  }

  static createParenthesized(expressionNode, openToken, closeToken) {
    AstFactory.#validateAstNode(expressionNode, "expressionNode");

    return AstFactory.#createNode(
      NodeType.PARENTHESIZED_EXPRESSION,
      openToken.token_seq,
      closeToken.token_seq,
      { expression: expressionNode }
    );
  }

  static createExpressionList(items, openToken, closeToken) {
    AstFactory.#validateAstNodeList(items, "items");

    return AstFactory.#createNode(
      NodeType.EXPRESSION_LIST,
      openToken.token_seq,
      closeToken.token_seq,
      { items }
    );
  }

  static createSubquery(openToken, closeToken, subqueryTokens, queryAst, subqueryKind = "SCALAR") {
    const nodeType = subqueryKind === "ARRAY"
      ? NodeType.ARRAY_SUBQUERY_EXPRESSION
      : NodeType.SUBQUERY_EXPRESSION;

    return AstFactory.#createNode(
      nodeType,
      openToken.token_seq,
      closeToken.token_seq,
      {
        subquery_kind: subqueryKind,
        query_start_token_seq: subqueryTokens[0]?.token_seq || null,
        query_end_token_seq: subqueryTokens.at(-1)?.token_seq || null,
        query_text: subqueryTokens.map((token) => token.token).join(""),
        query_ast: queryAst
      }
    );
  }

  static createCaseWhen(conditionNode, resultNode, whenTokenSeq) {
    AstFactory.#validateAstNode(conditionNode, "conditionNode");
    AstFactory.#validateAstNode(resultNode, "resultNode");

    return AstFactory.#createNode(
      NodeType.CASE_WHEN_CLAUSE,
      whenTokenSeq,
      resultNode.end_token_seq,
      { condition: conditionNode, result: resultNode }
    );
  }

  static createCase(caseToken, caseOperand, whenClauses, elseExpression, endToken) {
    if (caseOperand !== null) {
      AstFactory.#validateAstNode(caseOperand, "caseOperand");
    }

    AstFactory.#validateAstNodeList(whenClauses, "whenClauses");

    if (elseExpression !== null) {
      AstFactory.#validateAstNode(elseExpression, "elseExpression");
    }

    return AstFactory.#createNode(
      NodeType.CASE_EXPRESSION,
      caseToken.token_seq,
      endToken.token_seq,
      {
        case_operand: caseOperand,
        when_clauses: whenClauses,
        else_expression: elseExpression
      }
    );
  }

  static createExists(existsTokenSeq, subqueryNode, negated) {
    AstFactory.#validateAstNode(subqueryNode, "subqueryNode");

    return AstFactory.#createNode(
      NodeType.EXISTS_EXPRESSION,
      existsTokenSeq,
      subqueryNode.end_token_seq,
      { subquery: subqueryNode, negated: Boolean(negated) }
    );
  }


  static createWindowExpression(functionNode, windowSpecification, overTokenSeq) {
    AstFactory.#validateAstNode(functionNode, "functionNode");
    AstFactory.#validateAstNode(windowSpecification, "windowSpecification");

    return AstFactory.#createNode(
      NodeType.WINDOW_EXPRESSION,
      functionNode.start_token_seq,
      windowSpecification.end_token_seq,
      {
        function: functionNode,
        over_token_seq: overTokenSeq,
        window: windowSpecification
      }
    );
  }

  static createWindowSpecification(openToken, closeToken, partitionBy, orderBy, frameTokens, windowName = null) {
    AstFactory.#validateAstNodeList(partitionBy, "partitionBy");
    AstFactory.#validateAstNodeList(orderBy, "orderBy");

    const startTokenSeq = openToken ? openToken.token_seq : windowName.start_token_seq;
    const endTokenSeq = closeToken ? closeToken.token_seq : windowName.end_token_seq;

    return AstFactory.#createNode(
      NodeType.WINDOW_SPECIFICATION,
      startTokenSeq,
      endTokenSeq,
      {
        window_name: windowName ? windowName.name : null,
        partition_by: partitionBy,
        order_by: orderBy,
        frame_tokens: frameTokens
      }
    );
  }

  static createWindowOrderItem(expressionNode, direction, nullsOrder) {
    AstFactory.#validateAstNode(expressionNode, "expressionNode");

    return AstFactory.#createNode(
      NodeType.WINDOW_ORDER_ITEM,
      expressionNode.start_token_seq,
      expressionNode.end_token_seq,
      { expression: expressionNode, direction, nulls_order: nullsOrder }
    );
  }

  static #createNode(nodeType, startTokenSeq, endTokenSeq, properties) {
    AstFactory.#validateNodeType(nodeType);

    if (!Number.isInteger(startTokenSeq) || !Number.isInteger(endTokenSeq)) {
      throw new TypeError("AstFactory: token_seq range must contain integers.");
    }

    return {
      node_type: nodeType,
      start_token_seq: startTokenSeq,
      end_token_seq: endTokenSeq,
      ...properties
    };
  }

  static #validateNodeType(nodeType) {
    if (!nodeType || !Object.values(NodeType).includes(nodeType)) {
      throw new TypeError(`AstFactory: invalid nodeType "${nodeType}".`);
    }
  }

  static #validateAstNode(node, argumentName) {
    if (!node || typeof node !== "object") {
      throw new TypeError(`AstFactory: ${argumentName} must be an AST Node.`);
    }

    AstFactory.#validateNodeType(node.node_type);

    if (!Number.isInteger(node.start_token_seq) || !Number.isInteger(node.end_token_seq)) {
      throw new TypeError(`AstFactory: ${argumentName} has an invalid token_seq range.`);
    }
  }

  static #validateAstNodeList(nodes, argumentName) {
    if (!Array.isArray(nodes)) {
      throw new TypeError(`AstFactory: ${argumentName} must be an array.`);
    }

    for (const node of nodes) {
      AstFactory.#validateAstNode(node, argumentName);
    }
  }
}
