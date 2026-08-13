SELECT
  order_id,
  unit_price * quantity * (1 - discount_rate) AS net_amount
FROM `PROJECT_ID.DATASET.CUSTOMER_PURCHASE_HISTORY`
