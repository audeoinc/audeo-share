# Parser Regression Tests

## 1. 目的

Lexer、Parser、Resolver、Exporterの変更によって、すでに解決できている物理カラムLineageが壊れないことを保証します。

## 2. 現在の資産

- Golden fixture: 48ケース
- SQL fixtureと期待JSONの1対1構成
- production-scale semantic fixture
- 性能回帰契約
- 過去リリース別回帰スクリプト
- BigQuery Persistent UDF smoke test

## 3. Golden Test

各ケースは次の組み合わせです。

```text
test/golden/fixtures/<case>.sql
test/golden/expected/<case>.json
```

期待JSONは、目的、coverage、物理カラムメタデータ、出力カラム、期待依存、期待status、warning・error件数を保持します。

## 4. 主なカバレッジ

- basic expression
- CASE
- JOIN・集約
- CTEおよび多段CTE
- correlated subquery
- scalar subquery
- UNION ALL・UNION DISTINCT
- QUALIFY・window function
- ARRAY・UNNEST
- STRUCT output・field path
- PIVOT、aggregate prefix、複数aggregate
- UNPIVOT生成列、複数列UNPIVOT、INCLUDE / EXCLUDE NULLS
- `SELECT *`
- `alias.*`
- `SELECT * EXCEPT`
- `SELECT * REPLACE`
- production-style ETL・data mart・reporting view

## 5. 実行入口

```bash
cd javascript
npm test
```

`npm test`は次を順番に行います。

1. 24ソースからbundleを再生成
2. 再生成bundleと確定legacy bundleの動作同一性確認
3. 48 Goldenケースと性能回帰契約の実行

## 6. fixture追加ルール

1. 一つの論点に絞った最小SQLを追加する。
2. 必要なphysical columnsだけを期待JSONに定義する。
3. 物理依存を完全一致で定義する。
4. warningを許容する場合は理由を記録する。
5. 既存Goldenを更新する場合は、仕様変更か不具合修正かをCHANGELOGに記録する。
6. 大規模・複合ケースだけでなく、原因を切り分けられる小規模ケースも維持する。

## 7. 品質ゲート

- 全GoldenケースPASS
- bundle同一性PASS
- 性能契約PASS
- 新規未説明WARNINGなし
- fixtureとexpectedのファイル対応漏れなし
