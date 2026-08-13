WITH grouped AS (
  SELECT customer_id,
         ARRAY_AGG(STRUCT(order_id, purchase_date) ORDER BY purchase_date DESC) AS order_chain
  FROM `PROJECT_ID.DATASET.CUSTOMER_PURCHASE_HISTORY`
  GROUP BY customer_id
)
SELECT
  customer_id,
  ARRAY(SELECT AS STRUCT x.order_id, x.purchase_date FROM UNNEST(order_chain) x LIMIT 3) AS recent_chain
FROM grouped
