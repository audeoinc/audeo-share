SELECT
  customer_id,
  STRUCT(order_id AS id, purchase_date AS purchased_at) AS order_info
FROM `PROJECT_ID.DATASET.CUSTOMER_PURCHASE_HISTORY`
