SELECT c.* REPLACE(UPPER(c.name) AS name), o.order_total
FROM `PROJECT_ID.DATASET.CUSTOMERS` c
JOIN `PROJECT_ID.DATASET.ORDERS` o ON c.customer_id = o.customer_id
