# Supported SQL Coverage

本一覧は、同梱Golden regressionで実際に検証されている範囲を示します。BigQuery SQLの全構文を保証するものではありません。

## Regression verified

- 列参照、算術式、関数呼出し
- CASE expression
- JOIN、GROUP BY、aggregate
- CTE、多段CTE、深いCTE chain
- scalar subquery
- correlated subquery、EXISTS
- anonymous nested subquery
- UNION ALL、UNION DISTINCT、3 branch UNION
- QUALIFY、window functions
- ARRAY、ARRAY_AGG、UNNEST
- STRUCT output、STRUCT field lineage
- PIVOT generated columns
- PIVOT aggregate prefix、複数aggregate、同一scope内の生成列参照
- UNPIVOT generated value/name columns
- 単一列・複数列UNPIVOT、INCLUDE NULLS / EXCLUDE NULLS
- `SELECT *`
- `SELECT alias.*`
- `SELECT * EXCEPT(...)`
- `SELECT * REPLACE(...)`
- production-style ETL、incremental load、data mart、reporting view

## Partial or guarded behavior

BigQuery固有式のうちExpressionParserで完全構造化しないものは、RAW_EXPRESSIONとして保持し、識別子を回収してLineage継続を試みます。完全対応の判断は個別fixtureと期待結果を基準にします。

## Not guaranteed

- 実行時に参照先が決定する完全動的SQL
- `EXECUTE IMMEDIATE`で生成されるSQL本文の完全追跡
- BigQuery MLのMODEL依存
- Stored Procedure内部の制御フロー全体
- 外部システムで組み立てられ、ジョブqueryへ完全なSQLが残らない処理
- Golden fixtureが存在しない構文の完全性
