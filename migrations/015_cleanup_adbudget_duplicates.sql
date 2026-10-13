-- 015_cleanup_adbudget_duplicates.sql
-- 清除 syncAdBudget 服務產生的 `ad-store-%` 格式殘留
-- 這些跟 /ad-sync-v2 寫的 `ad-{camp_id}-{store_id}` 重複計算，造成金額雙倍
--
-- /ad-sync-v2 寫入格式：ad-{camp_id}-{store_id}（1 筆/campaign/store）
-- syncAdBudget 寫入格式：ad-store-{store_id}-{month}（1 筆/store/month，彙總）
-- 兩個同時寫 → 金額被疊加
--
-- 這支 migration 一次性刪掉 ad-store-% 的殘留。
-- 以後 billingService.syncMonth 不再呼叫 syncAdBudget（已移除），
-- 所以不會再長出來。

DELETE FROM billing_orders
WHERE source_type = 'ad_budget'
  AND order_id LIKE 'ad-store-%';
