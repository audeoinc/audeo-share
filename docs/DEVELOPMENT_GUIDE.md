# Development Guide

## 1. 変更単位

- SQL制御変更
- Parser構文対応
- Resolver解決変更
- Repository schema変更
- 運用設定変更

変更内容に応じて、サンプル、回帰試験、設計書、CHANGELOGを同時更新します。

## 2. JavaScript規約

- JavaScriptで統一する。
- 一つの`const`宣言は一行を基本とする。
- `for...of`を使用可能とする。
- メソッドチェーンを必要以上に長くしない。
- `return this`は許容する。
- 条件式が複雑な場合は意味のある変数へ分解する。
- ParserはAST nodeを直接生成せずAstFactoryを使用する。
- コメント除去メソッド名は`removeCommentTokens()`とする。
- コメント除去は当面SelectParser内に保持する。

## 3. SQL規約

- BigQuery Standard SQL
- インデント2スペース
- project.dataset.objectを完全修飾
- `INFORMATION_SCHEMA`は適切なregionまたはdatasetスコープ
- 再実行性を維持
- DELETE前に新解析結果をstaging
- 動的SQLの値は可能な限り`USING`
- 処理ブロックに目的と失敗時動作をコメント

## 4. Parser機能追加

1. 失敗または未対応SQLを最小化したfixtureにする。
2. Lexer Token期待値を追加する。
3. Parser AST期待値を追加する。
4. Resolver dependency期待値を追加する。
5. BigQuery UDF smoke testを追加する。
6. 総合試験への影響を確認する。
7. UDF DesignとCHANGELOGを更新する。

## 5. Repository schema変更

- setup SQLを更新
- migration方針を記述
- pipelineを更新
- validationを更新
- integration testを更新
- ER図とSystem Designを更新
- 後方互換性を記録

## 6. 完了条件

コードだけでなく、SQL、期待結果、実行結果、設計文書、運用影響が揃った状態を完了とします。
