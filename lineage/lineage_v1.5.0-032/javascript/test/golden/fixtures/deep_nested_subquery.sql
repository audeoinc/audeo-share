SELECT customer_id, adjusted_total
FROM (
  SELECT customer_id, order_total * 1.1 AS adjusted_total
  FROM (
    SELECT customer_id, order_total
    FROM (
      SELECT customer_id, order_total
      FROM `PROJECT_ID.DATASET.ORDERS`
    ) AS n1
  ) AS n2
) AS n3
