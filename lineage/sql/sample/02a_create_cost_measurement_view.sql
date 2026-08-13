-- ============================================================================
-- 02a_create_cost_measurement_view.sql
-- Long-form sample View for lineage cost and performance measurement
-- ============================================================================
-- Prerequisite:
--   Run sql/sample/02_setup_sample_environment.sql first.
--
-- Design:
--   Keep the View definition near 500 lines while keeping compact UDF output
--   below the BigQuery scripting variable limit. The SQL exercises CTEs,
--   joins, nested fields, CASE, aggregate functions, ARRAY<STRUCT>,
--   window functions, QUALIFY, PIVOT, UNION ALL, and
--   customer-level pre-aggregation joined into the final query.
-- ============================================================================
SET @@location = 'asia-northeast1';

CREATE OR REPLACE VIEW
  `project_id.dataset.v_customer_sales_cost_sample`
AS
WITH
customer_base AS (
  SELECT
    customer.customer_id,
    customer.customer_name,
    customer.customer_segment,
    customer.registered_date,
    customer.address.prefecture AS customer_prefecture,
    customer.address.city AS customer_city,
    CASE
      WHEN customer.customer_segment = 'ENTERPRISE' THEN 4
      WHEN customer.customer_segment = 'MID_MARKET' THEN 3
      WHEN customer.customer_segment = 'SMB' THEN 2
      ELSE 1 END AS segment_priority
  FROM `project_id.dataset.customers` AS customer
),

product_base AS (
  SELECT
    product.product_id,
    product.product_name,
    product.category,
    product.unit_price AS master_unit_price,
    product.attributes.brand AS product_brand,
    product.attributes.color AS product_color,
    CASE
      WHEN product.unit_price >= 50000 THEN 'HIGH'
      WHEN product.unit_price >= 20000 THEN 'MEDIUM'
      ELSE 'LOW' END AS master_price_band
  FROM `project_id.dataset.products` AS product
),

order_line AS (
  SELECT
    orders.order_id,
    orders.customer_id,
    orders.order_date,
    DATE_TRUNC(
      orders.order_date,
      MONTH
    ) AS order_month,
    orders.order_status,
    orders.sales_channel,
    orders.shipping_address.prefecture AS shipping_prefecture,
    items.line_number,
    items.product_id,
    product.product_name,
    product.category,
    product.product_brand,
    product.master_price_band,
    items.quantity,
    items.unit_price,
    COALESCE(
      items.discount_amount,
      0
    ) AS discount_amount,
    COALESCE(
      items.tax_amount,
      0
    ) AS tax_amount,
    items.quantity
      * items.unit_price AS gross_line_amount,
    items.quantity
      * items.unit_price
      - COALESCE(
          items.discount_amount,
          0
        )
      + COALESCE(
          items.tax_amount,
          0
        ) AS billed_line_amount,
    DENSE_RANK() OVER (
      PARTITION BY orders.order_id
      ORDER BY (
          items.quantity
          * items.unit_price
          - COALESCE(
              items.discount_amount,
              0
            )
          + COALESCE(
              items.tax_amount,
              0
            )
        ) DESC,
        items.line_number
    ) AS line_amount_rank
  FROM `project_id.dataset.sales_orders` AS orders
  JOIN `project_id.dataset.sales_order_items` AS items
    ON items.order_id = orders.order_id
  JOIN
    product_base AS product
    ON product.product_id = items.product_id
  WHERE TRUE
    AND orders.order_status
      IS NOT NULL
),

order_summary AS (
  SELECT
    order_id,
    customer_id,
    order_date,
    order_month,
    order_status,
    sales_channel,
    shipping_prefecture,
    COUNT(*) AS line_count,
    SUM(quantity) AS total_quantity,
    SUM(gross_line_amount) AS gross_order_amount,
    SUM(discount_amount) AS order_discount_amount,
    SUM(billed_line_amount) AS billed_order_amount,
    ARRAY_AGG(
      STRUCT(
        product_id AS product_id,
        product_name AS product_name,
        category AS category,
        quantity AS quantity,
        billed_line_amount AS billed_line_amount
      )
      ORDER BY line_number
    ) AS order_lines
  FROM order_line
  GROUP BY order_id,
    customer_id,
    order_date,
    order_month,
    order_status,
    sales_channel,
    shipping_prefecture
),

customer_aggregate AS (
  SELECT
    customer_id,
    COUNT(*) AS lifetime_order_count,
    COUNTIF(order_status = 'COMPLETED') AS completed_order_count,
    COUNTIF(sales_channel = 'WEB') AS web_order_count,
    COUNTIF(sales_channel = 'SALES') AS sales_assisted_order_count,
    SUM(total_quantity) AS lifetime_quantity,
    SUM(gross_order_amount) AS lifetime_gross_amount,
    SUM(order_discount_amount) AS lifetime_discount_amount,
    SUM(billed_order_amount) AS lifetime_billed_amount,
    AVG(billed_order_amount) AS average_order_amount,
    MAX(billed_order_amount) AS maximum_order_amount,
    MIN(order_date) AS first_order_date,
    MAX(order_date) AS latest_order_date,
    DATE_DIFF(
      CURRENT_DATE('Asia/Tokyo'),
      MAX(order_date),
      DAY
    ) AS days_since_latest_order,
    SAFE_DIVIDE(
      SUM(order_discount_amount),
      NULLIF(
        SUM(gross_order_amount),
        0
      )
    ) AS lifetime_discount_rate
  FROM order_summary
  GROUP BY customer_id
),

customer_monthly AS (
  SELECT
    customer_id,
    order_month,
    COUNT(*) AS monthly_order_count,
    SUM(total_quantity) AS monthly_quantity,
    SUM(billed_order_amount) AS monthly_billed_amount,
    LAG(
      SUM(billed_order_amount)
    ) OVER (
      PARTITION BY customer_id
      ORDER BY order_month
    ) AS previous_month_billed_amount,
    SUM(
      SUM(billed_order_amount)
    ) OVER (
      PARTITION BY customer_id
      ORDER BY order_month
      ROWS BETWEEN
        UNBOUNDED PRECEDING
        AND CURRENT ROW
    ) AS cumulative_billed_amount
  FROM order_summary
  GROUP BY customer_id,
    order_month
),

customer_order_extrema AS (
  SELECT
    customer_id,
    MAX(
      billed_order_amount
    ) AS joined_maximum_order_amount
  FROM order_summary
  GROUP BY customer_id
),

customer_month_history AS (
  SELECT
    customer_id,
    ARRAY_AGG(
      STRUCT(
        order_month AS order_month,
        monthly_order_count AS monthly_order_count,
        monthly_quantity AS monthly_quantity,
        monthly_billed_amount AS monthly_billed_amount,
        previous_month_billed_amount AS previous_month_billed_amount,
        cumulative_billed_amount AS cumulative_billed_amount
      )
      ORDER BY order_month DESC
      LIMIT 12
    ) AS recent_month_history
  FROM customer_monthly
  GROUP BY customer_id
),

customer_product AS (
  SELECT
    customer_id,
    product_id,
    product_name,
    category,
    COUNT(
      DISTINCT order_id
    ) AS product_order_count,
    SUM(quantity) AS product_quantity,
    SUM(billed_line_amount) AS product_billed_amount
  FROM order_line
  GROUP BY customer_id,
    product_id,
    product_name,
    category
),

top_product AS (
  SELECT
    customer_id,
    product_id AS top_product_id,
    product_name AS top_product_name,
    category AS top_product_category,
    product_billed_amount AS top_product_billed_amount
  FROM customer_product
  QUALIFY ROW_NUMBER() OVER (
      PARTITION BY customer_id
      ORDER BY product_billed_amount DESC,
        product_id
    ) = 1
),

customer_category AS (
  SELECT
    customer_id,
    CASE
      WHEN category = 'SUBSCRIPTION' THEN 'SUBSCRIPTION'
      WHEN category = 'SERVICE' THEN 'SERVICE'
      ELSE 'OTHER' END AS normalized_category,
    SUM(billed_line_amount) AS category_billed_amount
  FROM order_line
  GROUP BY customer_id,
    normalized_category
),

category_pivot AS (
  SELECT
    customer_id,
    COALESCE(
      sales_subscription,
      0
    ) AS subscription_sales_amount,
    COALESCE(
      sales_service,
      0
    ) AS service_sales_amount,
    COALESCE(
      sales_other,
      0
    ) AS other_sales_amount
  FROM customer_category
  PIVOT (
    SUM(category_billed_amount) AS sales
    FOR normalized_category
    IN (
      'SUBSCRIPTION' AS subscription,
      'SERVICE' AS service,
      'OTHER' AS other
    )
  )
),

customer_label_source AS (
  SELECT
    customer_id,
    'REGISTERED'
      AS customer_label
  FROM customer_base

  UNION ALL

  SELECT
    customer_id,
    'HAS_ORDER'
      AS customer_label
  FROM customer_aggregate
  WHERE lifetime_order_count > 0

  UNION ALL

  SELECT
    customer_id,
    'HIGH_VALUE'
      AS customer_label
  FROM customer_aggregate
  WHERE lifetime_billed_amount
      >= 100000
),

customer_labels AS (
  SELECT
    customer_id,
    COUNT(*) AS customer_label_count,
    ARRAY_AGG(
      customer_label
      ORDER BY customer_label
    ) AS customer_label_array
  FROM customer_label_source
  GROUP BY customer_id
)

SELECT
  customer.customer_id,
  customer.customer_name,
  customer.customer_segment,
  customer.registered_date,
  customer.customer_prefecture,
  customer.customer_city,
  customer.segment_priority,
  COALESCE(
    aggregate.lifetime_order_count,
    0
  ) AS lifetime_order_count,
  COALESCE(
    aggregate.completed_order_count,
    0
  ) AS completed_order_count,
  COALESCE(
    aggregate.web_order_count,
    0
  ) AS web_order_count,
  COALESCE(
    aggregate.sales_assisted_order_count,
    0
  ) AS sales_assisted_order_count,
  COALESCE(
    aggregate.lifetime_quantity,
    0
  ) AS lifetime_quantity,
  COALESCE(
    aggregate.lifetime_gross_amount,
    0
  ) AS lifetime_gross_amount,
  COALESCE(
    aggregate.lifetime_discount_amount,
    0
  ) AS lifetime_discount_amount,
  COALESCE(
    aggregate.lifetime_billed_amount,
    0
  ) AS lifetime_billed_amount,
  COALESCE(
    aggregate.average_order_amount,
    0
  ) AS average_order_amount,
  COALESCE(
    aggregate.maximum_order_amount,
    0
  ) AS maximum_order_amount,
  aggregate.first_order_date,
  aggregate.latest_order_date,
  aggregate.days_since_latest_order,
  aggregate.lifetime_discount_rate,
  top_product.top_product_id,
  top_product.top_product_name,
  top_product.top_product_category,
  top_product.top_product_billed_amount,
  category.subscription_sales_amount,
  category.service_sales_amount,
  category.other_sales_amount,
  labels.customer_label_count,
  labels.customer_label_array,
  extrema.joined_maximum_order_amount,
  month_history.recent_month_history,
  STRUCT(
    customer.customer_id AS customer_id,
    customer.customer_name AS customer_name,
    customer.customer_segment AS customer_segment,
    customer.customer_prefecture AS customer_prefecture
  ) AS customer_identity,
  STRUCT(
    COALESCE(
      aggregate.lifetime_order_count,
      0
    ) AS order_count,
    COALESCE(
      aggregate.lifetime_billed_amount,
      0
    ) AS billed_amount,
    aggregate.latest_order_date AS latest_order_date,
    top_product.top_product_id AS top_product_id
  ) AS customer_sales_profile,
  CASE
    WHEN COALESCE(
      aggregate.lifetime_order_count,
      0
    ) = 0
      THEN 'NO_PURCHASE_HISTORY'
    WHEN COALESCE(
      aggregate.days_since_latest_order,
      99999
    ) > 90
      AND COALESCE(
        aggregate.lifetime_billed_amount,
        0
      ) >= 100000
      THEN 'HIGH_VALUE_AT_RISK'
    WHEN COALESCE(
      aggregate.days_since_latest_order,
      99999
    ) > 90
      THEN 'DORMANT'
    WHEN COALESCE(
      aggregate.days_since_latest_order,
      99999
    ) <= 30
      THEN 'ACTIVE'
    ELSE 'STANDARD' END AS customer_operational_status,
  DENSE_RANK() OVER (
    ORDER BY COALESCE(
        aggregate.lifetime_billed_amount,
        0
      ) DESC,
      customer.customer_id
  ) AS lifetime_value_rank,
  PERCENT_RANK() OVER (
    ORDER BY COALESCE(
        aggregate.lifetime_billed_amount,
        0
      )
  ) AS lifetime_value_percentile
FROM customer_base AS customer
LEFT JOIN
  customer_aggregate AS aggregate
  ON aggregate.customer_id = customer.customer_id
LEFT JOIN
  top_product AS top_product
  ON top_product.customer_id = customer.customer_id
LEFT JOIN
  category_pivot AS category
  ON category.customer_id = customer.customer_id
LEFT JOIN
  customer_labels AS labels
  ON labels.customer_id = customer.customer_id
LEFT JOIN
  customer_order_extrema AS extrema
  ON extrema.customer_id = customer.customer_id
LEFT JOIN
  customer_month_history AS month_history
  ON month_history.customer_id = customer.customer_id;
