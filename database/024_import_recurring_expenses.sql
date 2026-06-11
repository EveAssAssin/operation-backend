-- ============================================================
-- 024_import_recurring_expenses.sql (40 筆，先跑 023+025 再跑此檔)
-- 約期已自動換算為西元並填到 start/end_year_month
-- ============================================================

INSERT INTO recurring_expenses
  (name, amount, cycle_type, cycle_day, cycle_day_text,
   payment_method, payee_name, needs_billing, period_text,
   start_year_month, end_year_month,
   bill_target_type, bill_target_id, bill_target_name,
   holiday_rule, note, is_active)
VALUES
  ('楠梓店隔壁間房租', 40000, 'monthly_fixed_day', 5, '5號', '臨櫃無褶', '黃博新彰銀', false, '109.08.15 ~ 114.08.14 31500元
114.08.15 ~ 119.08.14 40000元', '2025-08', '2030-08', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('群茂營所稅', 10691, 'monthly_fixed_day', 5, NULL, '現金繳納', '黃博新彰銀', false, '114.07~116.06', '2025-07', '2027-06', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('114年樂活光學暫繳分期', 16294, 'monthly_fixed_day', 18, '18號前', '現金繳納', '黃博新彰銀', false, '114.10.06~116.09.06', '2025-10', '2027-09', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('109年樂活有限公司營業稅分期', 100000, 'monthly_fixed_day', 17, '17號前', '現金繳納', '黃博新彰銀', false, '114.07.17~116.03.17', '2025-07', '2027-03', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('111年吳郁蓁綜所稅分期(六家)', 31002, 'monthly_fixed_day', 18, '18號前', '現金繳納', '黃博新彰銀', false, '114.11.06~117.10.06', '2025-11', '2028-10', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('113年黃信儒綜所稅分期', 75934, 'monthly_fixed_day', 28, '28號前', '現金繳納', '黃博新彰銀', false, '114.11.19~116.10.19', '2025-11', '2027-10', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('112年吳郁蓁綜所稅利息分期', 37905, 'monthly_fixed_day', 10, '10號前', '現金繳納', '黃博新彰銀', false, '115.01.01~115.12.01', '2026-01', '2026-12', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('114年樂活光學營所分期', 13745, 'monthly_fixed_day', 15, '15號前', '現金繳納', '黃博新彰銀', false, '115.06.06~117.05.15', '2026-06', '2028-05', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('新竹114年營所稅暫繳分期', 1500, 'monthly_fixed_day', 15, '15號前', '群茂代繳', '黃博新彰銀', false, '24期114.10~116.09', '2025-10', '2027-09', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('樂活光學有限公司營所稅暫繳分期', 2500, 'monthly_fixed_day', 15, '15號前', '群茂代繳', '黃博新彰銀', false, '36期114.10~117.09', '2025-10', '2028-09', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('高應大房租', 65921, 'monthly_fixed_day', 1, '1號', '匯款', '資峰興業有限公司', false, '110.10.01~113.9.30 62782元
113.10.1~115.09.30 65921元', '2024-10', '2026-09', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('楠梓房租過帳', 150000, 'monthly_fixed_day', 10, '10號', '匯款', '歐普不動產開發有限公司', false, NULL, NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('元大過帳', 22500, 'monthly_fixed_day', 9, '9號', '匯款', '張素靜', false, NULL, NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('董事長貨款2', 249000, 'monthly_fixed_day', 26, '26號', '匯款', '黃志雄', false, '2020.05起', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('中壢房租', 120000, 'monthly_fixed_day', 10, '10號', '匯款', '李岱蓉', false, '112.01.15 ~ 115.01.14', '2023-01', '2026-01', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('勞保勞退健保', 800000, 'monthly_fixed_day', 10, '10號', '匯款', '長鴻眼鏡行', false, '80萬 / 次', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('勞保勞退健保', 800000, 'monthly_fixed_day', 25, '25號', '匯款', '長鴻眼鏡行', false, '80萬 / 次', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('高大借證照人員黃彥華', 8000, 'monthly_fixed_day', 5, '5號', '匯款', '黃彥華', false, '110.8起', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('高美借證照人員顏君芳', 8000, 'monthly_fixed_day', 5, '5號', '匯款', '顏君芳', false, '112.11.20開始常態', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('永和借證照人員葉治綱', 8000, 'monthly_fixed_day', 5, '5號', '匯款', '葉治綱', false, '113.05.03開始常態', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('文山借證照人員蔡鎮陽', 8000, 'monthly_fixed_day', 5, '5號', '匯款', '蔡鎮陽', false, '112.04開始常態', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('東山借證照人員吳千亦', 8000, 'monthly_fixed_day', 5, '5號', '匯款', '吳千亦', false, '113.05開始常態', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('竹北借證照人員陳偉新', 36800, 'monthly_fixed_day', 5, '5號', '匯款', '陳偉新', false, '111.06.04開始常態', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('南京借證照人員施郁昀', 8000, 'monthly_fixed_day', 5, '5號', '匯款', '施郁昀', false, '114.06開始常態', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('鼎山借證照人員杜佳珍', 8000, 'monthly_fixed_day', 5, '5號', '匯款', '杜佳珍', false, '114.08.21開始常態', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('北屯借證照人員林季醇', 8000, 'monthly_fixed_day', 5, '5號', '匯款', '林季醇', false, '114.11.13開始常態', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('大里借證照人員周庭萱', 8000, 'monthly_fixed_day', 5, '5號', '匯款', '周庭萱', false, '115.04.01開始常態', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('板橋借證照人員吳姿璇', 12256, 'monthly_fixed_day', 5, '5號', '匯款', '吳姿璇', false, '115.05開始常態', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('左手設計有限公司', 96000, 'monthly_fixed_day', 25, '25號', '匯款', '左手設計有限公司', false, '115.6.1~115.11.30', '2026-06', '2026-11', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('新竹宿舍 - 黃信儒', 18000, 'monthly_fixed_day', 10, '10號', '匯款', '黃信儒', false, NULL, NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('後甲房東 - 張敬忠', 41748, 'monthly_fixed_day', 1, '1號', '匯款', '張敬忠', false, '112.10.1~116.9.30(112.10、11裝修免租)', '2023-10', '2027-09', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('後甲房東 - 溫秀卿', 11875, 'monthly_fixed_day', 1, '1號', '匯款', '溫秀卿', false, '112.10.1~116.9.30(112.10、11裝修免租)', '2023-10', '2027-09', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('後甲房東 - 溫秀紅', 11875, 'monthly_fixed_day', 1, '1號', '匯款', '溫秀紅', false, '112.10.1~116.9.30(112.10、11裝修免租)', '2023-10', '2027-09', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('後甲房東 - 温秀敏(ATM付)', 11875, 'monthly_fixed_day', 1, '1號', '匯款', '温秀敏', false, '112.10.1~116.9.30(112.10、11裝修免租)', '2023-10', '2027-09', NULL, NULL, NULL, 'previous_workday', 'ATM轉帳', true),
  ('後甲房東 - 温榮彬(ATM付)', 11875, 'monthly_fixed_day', 1, '1號', '匯款', '温榮彬', false, '112.10.1~116.9.30(112.10、11裝修免租)', '2023-10', '2027-09', NULL, NULL, NULL, 'previous_workday', 'ATM轉帳', true),
  ('文化房東-曾麗市', 50000, 'monthly_fixed_day', 25, '25號', '匯款', '曾麗市', false, '113.10.25~', NULL, NULL, NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('文化房東-陳南舟', 35000, 'monthly_fixed_day', 10, '10號', '匯款', '林聖敏', false, '113.10.25~', NULL, NULL, NULL, NULL, NULL, 'previous_workday', '2025/4月起20號匯至小米帳戶領出現金25號前給房東', true),
  ('文化房東-(ATM付)', 35000, 'monthly_fixed_day', 10, '10號', '匯款', '林聖敏', false, '113.10.25~', NULL, NULL, NULL, NULL, NULL, 'previous_workday', '2025/4月起20號匯至小米帳戶領出現金25號前給房東', true),
  ('北屯房東-成香投資有限公司', 126000, 'monthly_fixed_day', 1, '1號', '匯款', '盛香投資有限公司', false, '113.12.1~119.11.30(113.10、11裝修免租)', '2024-12', '2030-11', NULL, NULL, NULL, 'previous_workday', NULL, true),
  ('大墩房東-誠友開發股份有限公司', 109185, 'monthly_fixed_day', 15, '15號前', '匯款', '誠友開發股份有限公司', false, '114.01.05~119.01.04(裝修期20天)', '2025-01', '2030-01', NULL, NULL, NULL, 'previous_workday', NULL, true)
;