SELECT
  customer_id,
  metric_name,
  metric_value
FROM `project_id.dataset.t_unpivot_source`
UNPIVOT (
  metric_value FOR metric_name IN (
    sales_amount,
    cost_amount
  )
)
