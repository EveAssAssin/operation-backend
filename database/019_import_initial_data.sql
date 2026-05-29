-- ============================================================
-- 019_import_initial_data.sql
-- 從「門市水電紀錄.xlsx」匯入初始資料到 entity_facts
--   執行前提：015 + 018 必須已跑過
--
--   匯入內容：
--     - 電費 (electricity)
--     - 水費 (water — 新建分類)
--     - 電話與網路 (telecom — 中華電信)
--     - 公務機 (telecom — 遠傳金雞)
--     - 房租 (rent — 含『驗光所租賃 optical_rent』新欄位)
--
--   注意：
--     1. store_erpid 用 Excel 內的『門市名』當佔位，未自動對應 departments。
--        若要對應到真實門市，匯入後到 UI 用「編輯」改門市選擇即可。
--     2. 全部用 ON CONFLICT 防呆，但因 entity_facts 沒 UNIQUE constraint，
--        跑兩次會有重複資料，注意只能跑一次。
-- ============================================================

-- ── 0. 為水費建分類 + 欄位 ───────────────────────────────────
INSERT INTO entity_fact_categories (code, name, icon, is_system, sort_order, extra)
VALUES ('water', '水費', '💧', true, 15,
        '{"query_url": "https://www.water.gov.tw/ch/EQuery/WaterFeeQuery?nodeId=753"}'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO entity_fact_fields (category_id, field_key, field_label, field_type, sort_order, is_system, placeholder)
SELECT c.id, v.field_key, v.field_label, v.field_type, v.sort_order, true, v.placeholder
FROM entity_fact_categories c
CROSS JOIN (VALUES
    ('water_id',       '水號',         'text',      10, '例：71165338199'),
    ('account_name',   '用水戶名',     'text',      20, '例：好明毅眼鏡行'),
    ('billing_cycle',  '單月/雙月繳',  'text',      30, '例：雙月'),
    ('deliver_to',     '單據寄送',     'text',      40, '例：總公司 / 門市'),
    ('meter_read_day', '抄表日',       'text',      50, '例：27'),
    ('address',        '用水地址',     'text',      60, '例：高雄市裕誠路235號'),
    ('auto_debit',     '代扣繳',       'text',      70, '例：總公司自動扣款(高銀846)'),
    ('note',           '備註',         'multiline', 90, '其他補充說明')
) AS v(field_key, field_label, field_type, sort_order, placeholder)
WHERE c.code = 'water'
ON CONFLICT (category_id, field_key) DO NOTHING;

-- ── 0b. 為房租加『驗光所租賃』欄位 ──────────────────────────
INSERT INTO entity_fact_fields (category_id, field_key, field_label, field_type, sort_order, is_system, placeholder)
SELECT c.id, 'optical_rent', '驗光所租賃', 'text', 25, true, '例：30000 或 無'
FROM entity_fact_categories c
WHERE c.code = 'rent'
ON CONFLICT (category_id, field_key) DO NOTHING;

-- ── 0c. 為電話與網路費加『網路客戶號碼/密碼』欄位 ───────────
INSERT INTO entity_fact_fields (category_id, field_key, field_label, field_type, sort_order, is_system, placeholder)
SELECT c.id, v.field_key, v.field_label, v.field_type, v.sort_order, true, v.placeholder
FROM entity_fact_categories c
CROSS JOIN (VALUES
    ('net_account',  '網路客戶號碼', 'text', 81, '例：75692692'),
    ('net_password', '網路客戶密碼', 'text', 82, '例：xmcltwbw')
) AS v(field_key, field_label, field_type, sort_order, placeholder)
WHERE c.code = 'telecom'
ON CONFLICT (category_id, field_key) DO NOTHING;


-- ── 電費（61 筆）─────────────────────
INSERT INTO entity_facts (category_id, store_erpid, store_name, data) VALUES
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '林口', '林口', '{"meter_id": "05780382066", "account_name": "陳秀傳（國宅段48地號）", "billing_cycle": "單月", "deliver_to": "總公司", "address": "新北市林口區忠孝路518號左邊54公尺(堆積場)", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '板橋 134號 1F', '板橋 134號 1F', '{"meter_id": "01234361105", "account_name": "樂群光學有限公司板橋分公司", "billing_cycle": "單月", "deliver_to": "總公司", "address": "新北市板橋區中山路1段134號", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '板橋 134號 2F', '板橋 134號 2F', '{"meter_id": "01234361207", "account_name": "樂群光學有限公司板橋分公司", "billing_cycle": "單月", "deliver_to": "總公司", "address": "新北市板橋區中山路1段134號二樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '板橋 136號 1F', '板橋 136號 1F', '{"meter_id": "01234360104", "account_name": "樂群光學有限公司板橋分公司", "billing_cycle": "單月", "deliver_to": "總公司", "address": "新北市板橋區中山路1段136號", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '板橋 136號 2F', '板橋 136號 2F', '{"meter_id": "01234360206", "account_name": "樂群光學有限公司板橋分公司", "billing_cycle": "單月", "deliver_to": "總公司", "address": "新北市板橋區中山路1段136號二樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '永和', '永和', '{"meter_id": "01362111114", "account_name": "劉春綢", "address": "新北市永和區中正路500號1、2樓"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '中壢', '中壢', '{"meter_id": "04327291021", "account_name": "黃信儒", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "桃園市中壢區環北路457號1樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '八德 3號', '八德 3號', '{"meter_id": "04180003109", "account_name": "林建成", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "桃園市八德區介壽路2段3號", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '八德 5號', '八德 5號', '{"meter_id": "04181511106", "account_name": "樂活光學有限公司", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "桃園市八德區介壽路2段5號", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '新竹 (雙)', '新竹 (雙)', '{"meter_id": "06076225109", "account_name": "黃信儒", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "新竹市北區中正路147號1樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '新竹 1F', '新竹 1F', '{"meter_id": "06076227101", "account_name": "黃信儒", "billing_cycle": "單月", "deliver_to": "總公司", "address": "新竹市北區中正路147號1樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '新竹 2.3F', '新竹 2.3F', '{"meter_id": "06076235203", "account_name": "黃信儒", "billing_cycle": "單月", "deliver_to": "總公司", "address": "新竹市北區中正路147號2.3樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '竹北', '竹北', '{"meter_id": "06379401105", "account_name": "黃信儒", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "新竹縣竹北市中正西路1號1樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '六家 91號', '六家 91號', '{"meter_id": "06382939770", "account_name": "黃信儒", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "新竹縣竹北市自強南路91號1樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '六家 89號', '六家 89號', '{"meter_id": "06382939758", "account_name": "爍活眼鏡行 黃信儒", "billing_cycle": "單月", "deliver_to": "總公司", "address": "新竹縣竹北市自強南路89號1樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '東山 1F', '東山 1F', '{"meter_id": "07256537007", "account_name": "樂活眼鏡行黃信儒", "billing_cycle": "單月", "deliver_to": "總公司", "address": "台中市東山路一段272號1樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '東山 2F', '東山 2F', '{"meter_id": "07256537018", "account_name": "樂活眼鏡行黃信儒", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "台中市東山路一段272號2樓"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '中科 85號', '中科 85號', '{"meter_id": "07391269031", "account_name": "熱活眼鏡有限公司", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "台中市西屯區西屯路三段166之85號1樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '中科 86號', '中科 86號', '{"meter_id": "07391269075", "account_name": "熱活眼鏡有限公司", "billing_cycle": "單月", "deliver_to": "總公司", "address": "台中市西屯區西屯路三段166之86號1樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '十甲', '十甲', '{"meter_id": "07005253106", "account_name": "楊淑芬", "address": "中市東區十甲路521號1樓"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '潭子', '潭子', '{"meter_id": "07541772510", "account_name": "爍活眼鏡行 黃信儒", "billing_cycle": "單月", "deliver_to": "總公司", "address": "台中市潭子區中山路二段123號1樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '大里', '大里', '{"meter_id": "07781610453", "account_name": "樂群光學有限公司", "billing_cycle": "單月", "deliver_to": "總公司", "address": "台中市大里區德芳南路196號", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '中清623號 1樓', '中清623號 1樓', '{"meter_id": "07820657102", "account_name": "林陳月勤", "address": "台中市北區中清路623號1樓地下室"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '中清625號 1樓', '中清625號 1樓', '{"meter_id": "07820656101", "account_name": "陳勝榮", "address": "台中市北區中清路625號 1樓"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '中清625號 3樓', '中清625號 3樓', '{"meter_id": "07820656305", "account_name": "陳勝榮", "address": "台中市北區中清路625號 3樓"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '成大 2號', '成大 2號', '{"meter_id": "10190764041", "account_name": "周震基", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "台南市長榮路三段2號1-2F"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '成大 4號', '成大 4號', '{"meter_id": "10190764906", "account_name": "周昭良", "billing_cycle": "單月", "deliver_to": "總公司", "address": "台南市長榮路三段4號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '北屯(臨時電表)', '北屯(臨時電表)', '{"meter_id": "07150063102", "account_name": "樂活北屯有限公司", "address": "台中市北屯區北屯路231號", "auto_debit": "已拆除"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '北屯231號1.2樓', '北屯231號1.2樓', '{"meter_id": "07150062101", "account_name": "樂活北屯有限公司", "address": "台中市北屯區北屯路231號1、2樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '北屯233號1.2樓', '北屯233號1.2樓', '{"meter_id": "07150062123", "account_name": "樂活北屯有限公司", "address": "台中市北屯區北屯路233號1、2樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '後甲 1樓', '後甲 1樓', '{"meter_id": "10184939037", "account_name": "樂活眼鏡行黃信儒", "deliver_to": "總公司", "address": "台南市中華東路一段269號", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '後甲 2樓', '後甲 2樓', '{"meter_id": "10184939231", "account_name": "樂活眼鏡行黃信儒", "deliver_to": "總公司", "address": "台南市中華東路一段269號", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '後甲 3樓', '後甲 3樓', '{"meter_id": "10184939333", "account_name": "樂活眼鏡行黃信儒", "deliver_to": "總公司", "address": "台南市中華東路一段269號", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '文化', '文化', '{"meter_id": "10158394002", "account_name": "忠霖眼鏡黃信儒", "billing_cycle": "單月", "deliver_to": "總公司", "address": "台南市中華東路三段317號", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '楠梓', '楠梓', '{"meter_id": "11551879058", "account_name": "希爾頓隱形眼鏡 黃志雄", "billing_cycle": "單月", "deliver_to": "總公司", "address": "高雄市楠梓區楠梓新路191號", "meter_read_day": "25", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '新左營 左半', '新左營 左半', '{"meter_id": "11542380273", "account_name": "高鐵眼鏡行黃信儒", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "高雄市左營區大中二路598號一樓左半段", "meter_read_day": "25號", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '新左營 右半', '新左營 右半', '{"meter_id": "11542380262", "account_name": "郭宗達", "billing_cycle": "單月", "deliver_to": "總公司", "address": "高雄市左營區大中二路598號一樓右半段", "meter_read_day": "25號", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '熱河', '熱河', '{"meter_id": "11063620005", "account_name": "長鴻眼鏡行黃博新", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "高雄市三民區自由一路95號一樓", "meter_read_day": "5", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '鼎山', '鼎山', '{"meter_id": "11477405115", "account_name": "絡繹眼鏡行黃博新", "billing_cycle": "單月", "deliver_to": "總公司", "address": "高雄市鼎山街340號一樓", "meter_read_day": "8", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '明誠', '明誠', '{"meter_id": "11517358104", "account_name": "好明毅眼鏡行黃信儒", "billing_cycle": "偶雙月繳", "deliver_to": "總公司", "address": "高雄市明誠三路602號1.2樓及夾層", "meter_read_day": "15"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '河堤', '河堤', '{"meter_id": "11548026061", "account_name": "上品眼鏡行吳郁蓁", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "高雄市裕誠路235號一樓", "meter_read_day": "29"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '河堤', '河堤', '{"meter_id": "11548026072", "account_name": "上品眼鏡行吳郁蓁", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "高雄市裕誠路235號二、三、四及五樓"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '高大 3F', '高大 3F', '{"meter_id": "11374951301", "account_name": "資峰餐飲有限公司", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "高雄市三民區建工路460號3樓", "meter_read_day": "11"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '高大 2F', '高大 2F', '{"meter_id": "11374951209", "account_name": "資峰餐飲有限公司", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "高雄市三民區建工路460號2樓", "meter_read_day": "11"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '高大 1F', '高大 1F', '{"meter_id": "11374951107", "account_name": "信儒眼鏡行 黃信儒", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "高雄市三民區建工路460號", "meter_read_day": "11"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '南京', '南京', '{"meter_id": "18295296535", "account_name": "南京眼鏡行黃志雄", "billing_cycle": "單月", "deliver_to": "總公司", "address": "高雄市鳳山區南京路272號", "meter_read_day": "7", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '文山', '文山', '{"meter_id": "18303257137", "account_name": "平安眼鏡有限公司", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "高雄市鳳山區青年路二段330號一樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '美術館', '美術館', '{"meter_id": "11037319857", "account_name": "好明毅眼鏡行", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "高雄市鼓山區中華一路976-1號1樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '董事長', '董事長', '{"meter_id": "11563108711", "account_name": "歐普不動產開發有限公司", "billing_cycle": "雙月繳", "deliver_to": "單據寄公司", "address": "高雄市楠梓區立安路63號5樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '董事長', '董事長', '{"meter_id": "11563108700", "account_name": "歐普不動產開發有限公司", "billing_cycle": "雙月繳", "deliver_to": "單據寄公司", "address": "高雄市楠梓區立安路63號4樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '董事長', '董事長', '{"meter_id": "11563108697", "account_name": "歐普不動產開發有限公司", "billing_cycle": "雙月繳", "deliver_to": "單據寄公司", "address": "高雄市楠梓區立安路63號3樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '董事長', '董事長', '{"meter_id": "11563108686", "account_name": "歐普不動產開發有限公司", "billing_cycle": "雙月繳", "deliver_to": "單據寄公司", "address": "高雄市楠梓區立安路63號2樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '董事長', '董事長', '{"meter_id": "11563108675", "account_name": "歐普不動產開發有限公司", "billing_cycle": "雙月繳", "deliver_to": "單據寄公司", "address": "高雄市楠梓區立安路63號1樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '董事長', '董事長', '{"meter_id": "11563091017", "account_name": "歐普不動產開發有限公司", "billing_cycle": "雙月繳", "deliver_to": "單據寄公司", "address": "高雄市楠梓區安泰街117號2-4樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '董事長', '董事長', '{"meter_id": "11563091006", "account_name": "歐普不動產開發有限公司", "billing_cycle": "雙月繳", "deliver_to": "單據寄公司", "address": "高雄市楠梓區安泰街117號1樓", "auto_debit": "已代扣繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '大昌', '大昌', '{"meter_id": "11074197107", "account_name": "志雄眼鏡行 黃志雄", "billing_cycle": "雙月", "deliver_to": "門市", "address": "高雄市三民區大昌二路89號1樓"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '永豐', '永豐', '{"meter_id": "18518399419", "account_name": "秀珍商行高美華", "billing_cycle": "單月", "deliver_to": "門市", "address": "高雄市前鎮區永豐路32號一樓", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '復國', '復國', '{"meter_id": "10218569147", "account_name": "富國眼鏡行黃信儒", "billing_cycle": "單月", "deliver_to": "門市", "address": "台南市永康區復國一路297號一樓", "meter_read_day": "25"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '復國', '復國', '{"meter_id": "10218569374", "account_name": "富國眼鏡行黃信儒(租人)", "billing_cycle": "雙月", "deliver_to": "門市", "address": "台南市永康區復國一路297號二樓", "auto_debit": "員工宿舍(直接做營業費用)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '安平', '安平', '{"meter_id": "10310791368", "account_name": "平安眼鏡行黃信儒", "billing_cycle": "雙月", "deliver_to": "門市", "address": "台南市安平路726號一樓", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'electricity'), '總哥竹北宿舍', '總哥竹北宿舍', '{"meter_id": "6351131449", "account_name": "謝菊茜", "billing_cycle": "雙月"}'::jsonb);

-- ── 水費（43 筆）─────────────────────
INSERT INTO entity_facts (category_id, store_erpid, store_name, data) VALUES
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '熱河', '熱河', '{"account_name": "無水費單據，每月固定$300由房東支付後，報給我們，款項會隨二代及租賃扣款後交給門市人員匯回總公司。"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '鼎山', '鼎山', '{"account_name": "無水費單據，每月固定$500由每次交票(年)時給屋主6000元現金。"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '明誠', '明誠', '{"water_id": "71165338199", "account_name": "好明毅眼鏡行", "billing_cycle": "雙月", "deliver_to": "總公司", "meter_read_day": "27", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '河堤', '河堤', '{"water_id": "71261953253", "account_name": "上品眼鏡行", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "高雄市裕誠路235號", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '高大1F', '高大1F', '{"water_id": "71227097006", "account_name": "資峰餐飲有限公司", "billing_cycle": "雙月", "deliver_to": "門市", "meter_read_day": "6", "address": "高雄市三民區本文里建工路460號1樓", "auto_debit": "高大水費為共用水費，房東每\"月\"補貼我們500，\n其餘我們自付，故高大月報的水費應為 \"帳單費用-1000=水費\""}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '高大', '高大', '{"billing_cycle": "雙月", "deliver_to": "門市", "meter_read_day": "17"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '南京', '南京', '{"water_id": "74553415624", "account_name": "南京", "billing_cycle": "雙月", "deliver_to": "總公司", "meter_read_day": "30", "address": "高雄市鳳山區海洋里南京路272號", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '文山', '文山', '{"water_id": "74528892717", "billing_cycle": "雙月", "deliver_to": "總公司", "meter_read_day": "17", "auto_debit": "總公司自動扣款(高銀846) 每月水費固定200元 收據拍給房東"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '東山', '東山', '{"water_id": "41180351006", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "台中市北屯區東山路1段272號", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '中科166-85', '中科166-85', '{"water_id": "41968311280", "account_name": "熱活眼鏡行黃信儒", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "台中市西屯區西屯路3段166-85號", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '中科166-86', '中科166-86', '{"water_id": "41968311275", "account_name": "熱活眼鏡行黃信儒", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "台中市西屯區西屯路3段166-86號", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '潭子', '潭子', '{"water_id": "4F333159013", "account_name": "爍活眼鏡行", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "台中市潭子區潭陽里中山路2段123號", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '中清', '中清', '{"water_id": "41581721005", "account_name": "樂活中清有限公司", "address": "台中市北區中清路1段625號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '中壢', '中壢', '{"water_id": "23808401078", "billing_cycle": "雙月", "deliver_to": "門市", "meter_read_day": "1", "address": "桃園市中壢區環北路457號", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '新竹', '新竹', '{"water_id": "31051477058", "account_name": "蘇繼棟", "billing_cycle": "雙月", "deliver_to": "門市", "address": "新竹市北門里中正路145號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '竹北', '竹北', '{"water_id": "3H361956011", "account_name": "福裕盛有限公司", "billing_cycle": "雙月", "deliver_to": "總公司", "meter_read_day": "18", "address": "新竹縣竹北市中正西路1號", "auto_debit": "由樓上租客繳納，門市每期給租客 250元/期"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '六家91號', '六家91號', '{"water_id": "3H-327002017", "account_name": "蔡瑞國", "billing_cycle": "雙月", "deliver_to": "門市", "address": "新竹縣竹北市自強南路91號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '六家89號', '六家89號', '{"water_id": "3H-327002001", "account_name": "蔡瑞國", "billing_cycle": "雙月", "deliver_to": "門市", "address": "新竹縣竹北市自強南路89號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '楠梓', '楠梓', '{"water_id": "77300484028", "account_name": "希爾頓隱形眼鏡", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "高雄市楠梓區惠楠里建楠路218號", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '成大2號', '成大2號', '{"water_id": "60054010003", "account_name": "周明德", "billing_cycle": "雙月", "address": "台南市東區長榮路3段2號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '成大4號', '成大4號', '{"water_id": "60054011007", "account_name": "周明德", "billing_cycle": "雙月", "address": "台南市東區長榮路3段4號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '林口', '林口', '{"account_name": "無水費單據，每月固定$500由每次交票(年)時給，2021年先開4500元交屋"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '林口', '林口', '{"water_id": "2C32281050K", "account_name": "陳重二", "billing_cycle": "雙月", "deliver_to": "門市", "meter_read_day": "6", "address": "新北市林口區麗園里文化一路1段38號", "auto_debit": "門市代繳，銀存金額支付"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '八德', '八德', '{"water_id": "22550180007", "account_name": "林建成", "billing_cycle": "雙月", "deliver_to": "總公司", "address": "桃園市八德區和平路2號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '新左營', '新左營', '{"water_id": "71269061134", "account_name": "高鐵眼鏡行", "billing_cycle": "基數月", "deliver_to": "總公司", "meter_read_day": "21", "address": "高雄市左營區菜公里大中二路598號", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '文化', '文化', '{"water_id": "60098331007", "account_name": "忠霖眼鏡", "billing_cycle": "雙月", "deliver_to": "總公司", "meter_read_day": "17", "address": "台南市東區中華東路3段317號", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '安泰街', '安泰街', '{"water_id": "77302993468", "account_name": "張素靜", "billing_cycle": "雙月繳", "deliver_to": "單據寄公司", "auto_debit": "高雄市楠梓區清豐里安泰街117號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '立安路', '立安路', '{"water_id": "77309866507", "billing_cycle": "雙月繳", "deliver_to": "單據寄公司", "auto_debit": "高雄市楠梓區清豐里立安街63號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '高美', '高美', '{"water_id": "71163076808", "account_name": "好明毅眼鏡行", "deliver_to": "門市", "address": "高雄市鼓山區龍水里中華一路976-1號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '板橋 134號', '板橋 134號', '{"water_id": "C1220835004", "account_name": "樂群光學有限公司板橋分公司", "deliver_to": "單據寄公司", "address": "新北市板橋區中山路1段134號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '板橋 136號', '板橋 136號', '{"water_id": "C1220836008", "account_name": "樂群光學有限公司板橋分公司", "deliver_to": "單據寄公司", "address": "新北市板橋區中山路1段136號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '大昌', '大昌', '{"water_id": "71833605200", "billing_cycle": "雙月", "deliver_to": "總公司"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '永豐', '永豐', '{"water_id": "71132906496", "billing_cycle": "雙月", "deliver_to": "總公司", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '復國一樓', '復國一樓', '{"water_id": "6H026242938", "billing_cycle": "雙月", "deliver_to": "總公司", "meter_read_day": "17", "auto_debit": "總公司自動扣款(高銀846)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '復國二樓', '復國二樓', '{"water_id": "6H026242943", "billing_cycle": "雙月", "deliver_to": "門市", "meter_read_day": "17"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '安平', '安平', '{"water_id": "每月水費固定$500元，隨房租支付。 (房租$38000 水費$500)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '俊平', '俊平', '{"water_id": "60282120790", "billing_cycle": "雙月"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '後甲', '後甲', '{"water_id": "60071296016", "account_name": "床的世界股份有限公司台南裕農分公司", "address": "台南市東區中華東路1段269號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '永和 1F', '永和 1F', '{"water_id": "Y160496986", "account_name": "鴻騰烘焙事業有限公司", "address": "新北市永和區中正路500號一樓"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '永和 2F', '永和 2F', '{"water_id": "Y160496995", "account_name": "鴻騰烘焙事業有限公司", "address": "新北市永和區中正路500號二樓"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '北屯231號', '北屯231號', '{"water_id": "41081832028", "account_name": "樂活北屯有限公司", "address": "台中市北屯區北屯里北屯路231號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '北屯233號', '北屯233號', '{"water_id": "41081832049", "account_name": "樂活北屯有限公司", "address": "台中市北屯區北屯里北屯路233號"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'water'), '（未指定）', '（未指定）', '{"water_id": "*大里水費，由房東繳納，每年房東統計後提供資料核對並且出款，出款後調整月報~"}'::jsonb);

-- ── 電話與網路（中華電信）（77 筆）─────────────────────
INSERT INTO entity_facts (category_id, store_erpid, store_name, data) VALUES
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '熱河', '熱河', '{"account_no": "Y530715", "note": 3552363, "net_account": "75692692", "net_password": "xmcltwbw"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '（未指定）', '（未指定）', '{"account_no": "3552363", "account_name": "黃志雄", "account_id": "B71979058073011"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '鼎山', '鼎山', '{"account_no": "3835545(3*3*5*5)", "account_name": "絡繹眼鏡行", "account_id": "B85975663931001", "billing_method": "單據寄公司自動轉帳", "billing_cycle": "單月", "service_type": "市話+電路", "net_account": "75692691", "net_password": "jveslwnn"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '鼎山 - 網', '鼎山 - 網', '{"account_no": "Y530718", "service_type": "網路費", "note": "300M/300M"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '鼎山', '鼎山', '{"account_no": "3838140", "service_type": "電路", "note": "這張掛在3552363下面"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '南京', '南京', '{"account_no": "Y116798", "billing_method": "單據寄公司自動轉帳", "service_type": "電路費", "note": "這張掛在3552363下面"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '南京', '南京', '{"account_no": "7655626", "billing_method": "單據寄公司自動轉帳", "service_type": "電話費", "note": "這張掛在3552363下面", "net_account": "3552363的帳密", "net_password": "0938489099"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '南京', '南京', '{"account_no": "HN75572372", "billing_method": "單據寄公司自動轉帳", "service_type": "網路費", "note": "這張掛在3552363下面", "net_account": "總哥帳密", "net_password": "0981889291"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '高應大', '高應大', '{"account_no": "3839113", "account_name": "信儒眼鏡行", "account_id": "B85976461141010", "billing_method": "單據寄公司自動轉帳", "billing_cycle": "單月(每月寄)", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '高美', '高美', '{"account_no": "5525155(5*2*1*5)", "account_name": "黃信儒", "account_id": "B85976461141001", "billing_method": "單據寄公司繳", "billing_cycle": "單月(每月寄)", "service_type": "電話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '文山', '文山', '{"account_no": "7*7*4*7", "account_name": "黃信儒", "account_id": "B85976461141002", "billing_method": "單據寄公司繳", "billing_cycle": "單月(每月寄)", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '文山 - 網', '文山 - 網', '{"account_no": "Y183200", "account_name": "黃信儒", "account_id": "B85976461141038", "billing_method": "單據寄公司繳", "billing_cycle": "單月(每月寄)", "service_type": "光世代+MOD", "note": "100M/40M"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '東山', '東山', '{"account_no": "24*7*3*6", "account_name": "黃信儒", "account_id": "B85976461141012", "billing_method": "單據寄公司繳", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '中科', '中科', '{"account_no": "24*1*4*1", "account_name": "黃信儒", "account_id": "B85976461141015", "billing_method": "單據寄公司繳", "billing_cycle": "單月", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '中科 - 網', '中科 - 網', '{"account_no": "Y382831", "account_name": "黃信儒", "account_id": "B85976461141041", "billing_method": "單據寄公司繳", "service_type": "光世代+MOD", "note": "300M/300M"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '河堤', '河堤', '{"account_no": "5568965", "account_id": "B85976461141016", "billing_method": "單據寄公司繳", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '潭子', '潭子', '{"account_no": "25*4*1*9(25342109)", "account_name": "黃信儒", "account_id": "B85976461141017", "billing_method": "單據寄公司繳", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '潭子 - 網', '潭子 - 網', '{"account_no": "Y149232", "account_name": "黃信儒", "account_id": "B85976461141037", "billing_method": "單據寄公司繳", "service_type": "光世代+MOD", "note": "300M/300M"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '十甲', '十甲', '{"account_no": "22*2*3*7", "account_name": "黃信儒", "account_id": "B85976461141042", "billing_method": "單據寄公司繳", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '中壢', '中壢', '{"account_no": "4*4*2*6", "account_name": "黃信儒", "account_id": "B85976461141020", "billing_method": "單據寄公司繳", "billing_cycle": "單月", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '新竹', '新竹', '{"account_no": "5*4*9*2", "account_name": "黃信儒", "account_id": "B85976461141022", "billing_method": "單據寄公司繳", "billing_cycle": "單月", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '竹北', '竹北', '{"account_no": "5*2*9*7", "account_name": "黃信儒", "account_id": "B85976461141023", "billing_method": "單據寄公司繳", "billing_cycle": "單月", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '六家', '六家', '{"account_no": "6*7*9*3", "account_name": "黃信儒", "account_id": "B85976461141024", "billing_method": "單據寄公司繳", "billing_cycle": "單月", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '屏東', '屏東', '{"account_no": "7*1*6*0", "account_name": "黃信儒", "account_id": "B85976461141025", "billing_method": "單據寄公司繳", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '後甲', '後甲', '{"account_no": "2*8*9*9", "account_name": "黃信儒", "account_id": "B85976461141028", "billing_method": "單據寄公司繳", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '誠品', '誠品', '{"account_no": "3330517", "account_id": "B85976461141026", "billing_cycle": "單月", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '復國', '復國', '{"account_no": "2011057", "account_id": "B71979058073045", "billing_method": "單據寄公司自動轉帳", "billing_cycle": "單月(每月寄)", "service_type": "電話+電路+網路費", "note": "扣高銀846"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '安平', '安平', '{"account_no": "HN75572376", "account_id": "B85976461141005", "billing_method": "單據寄公司", "billing_cycle": "單月(每月寄)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '安平', '安平', '{"account_no": "2295663", "account_id": "B85976461141019", "billing_method": "單據寄公司", "billing_cycle": "單月(每月寄)", "service_type": "網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '楠梓', '楠梓', '{"account_no": "3511147", "account_name": "黃信儒", "account_id": "B85976461141011", "billing_method": "單據寄公司", "billing_cycle": "單月(每月寄)", "service_type": "市話+電路+網路費", "note": "建楠電話跟大昌相似，須注意，收費區間1號31號。"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '楠梓 - 網', '楠梓 - 網', '{"account_no": "Y656351", "account_name": "希爾頓隱形眼鏡", "account_id": "B85976461141040", "billing_method": "單據寄公司", "service_type": "光世代+MOD", "note": "100M/40M"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '永豐', '永豐', '{"account_no": "7279861", "account_id": "B85976461141009", "billing_method": "單據寄公司", "billing_cycle": "單月(每月寄)", "service_type": "市話"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '永豐', '永豐', '{"account_no": "Y383721", "account_id": "B85976461141006", "billing_method": "單據寄公司", "billing_cycle": "單月(每月寄)", "service_type": "電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '新左營', '新左營', '{"account_no": "3593289", "account_name": "高鐵眼鏡行", "account_id": "B85976461141008", "billing_method": "單據寄公司", "billing_cycle": "單月(每月寄)", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '新左營 - 網', '新左營 - 網', '{"account_no": "Y656352", "account_name": "高鐵眼鏡行", "account_id": "B85976461141039", "service_type": "光世代+MOD", "note": "100M/40M"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '文化', '文化', '{"account_no": "2*0*4*2(2904492)", "account_name": "黃信儒", "billing_method": "單據寄公司", "billing_cycle": "單月", "service_type": "市話"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '文化 - 網', '文化 - 網', '{"account_no": "Y328977", "account_name": "忠霖眼鏡", "account_id": "B85976461141014", "billing_method": "單據寄公司繳", "billing_cycle": "單月", "service_type": "電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '郡平', '郡平', '{"account_no": "2981141", "account_id": "B85976461141003", "billing_method": "單據寄公司繳", "billing_cycle": "單月", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '大昌', '大昌', '{"account_no": "3*1*1*7(3813117)", "account_id": "B85976461141013", "billing_method": "單據寄公司繳", "billing_cycle": "單月", "service_type": "市話+電路+網路費", "note": "大昌電話跟建楠相似，須注意，收費區間16號15號。"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '永和', '永和', '{"account_no": "29*2*0*2", "account_name": "黃信儒", "account_id": "B85976461141043", "billing_method": "單據寄公司繳", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '林口', '林口', '{"account_no": "26*0*9*7", "account_name": "黃信儒", "account_id": "B85976461141031", "billing_method": "單據寄公司繳", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '八德', '八德', '{"account_no": "2*8*0*9", "account_name": "黃信儒", "account_id": "B85976461141032", "billing_method": "單據寄公司繳", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '大里', '大里', '{"account_no": "24*3*4*1", "account_name": "黃信儒", "account_id": "B85976461141033", "billing_method": "單據寄公司繳", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '高應大商辦', '高應大商辦', '{"account_no": "3839311", "account_id": "WG78612354", "billing_method": "單據寄公司自動轉帳", "service_type": "電話費", "note": "已退租"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '高應大商辦', '高應大商辦', '{"account_no": "3836417", "account_id": "無", "billing_method": "單據寄公司", "billing_cycle": "單月", "service_type": "公司0800客服專線"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '客服0800', '客服0800', '{"account_no": "0800002272", "account_name": "上光隱形眼鏡城", "account_id": "3530902", "service_type": "公司0800客服專線", "note": "有2張 客服0800"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '高應大商辦', '高應大商辦', '{"account_no": "3830861", "service_type": "傳真電話", "note": "已退租"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '中部代工', '中部代工', '{"account_no": "24*6*8*4(24369824)", "account_name": "黃信儒", "account_id": "B85976461141018", "billing_method": "單據寄公司繳", "billing_cycle": "單月", "service_type": "市話"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '北部辦公室', '北部辦公室', '{"account_no": "5*2*8*7(5220837)", "account_name": "黃信儒", "account_id": "B85976461141021", "billing_method": "單據寄公司繳", "billing_cycle": "單月", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '北部客服', '北部客服', '{"account_no": "5*4*6*6(5240616)", "account_name": "黃志雄", "account_id": "1210310102336", "billing_method": "單據寄公司繳", "service_type": "市話(0800附掛市話)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '北部倉庫', '北部倉庫', '{"account_no": "5*2*8*0", "account_name": "黃信儒", "service_type": "市話"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '豐原', '豐原', '{"account_no": "W003243", "account_id": "B71979058072002", "service_type": "ADSL電路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '興業', '興業', '{"account_no": "W003685", "billing_method": "單據寄公司自動轉帳", "service_type": "電路費", "note": "這張掛在3552363下面"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '北興', '北興', '{"account_no": "W003686", "billing_method": "單據寄公司自動轉帳", "service_type": "電路費", "note": "這張掛在3552363下面"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '太保', '太保', '{"account_no": "W003687", "billing_method": "單據寄公司自動轉帳", "service_type": "電路費", "note": "這張掛在3552363下面"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '民權', '民權', '{"account_no": "W005794", "billing_method": "單據寄公司自動轉帳", "service_type": "電路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '3F總', '3F總', '{"account_no": "Y051423", "billing_method": "單據寄公司自動轉帳", "service_type": "電路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '3F總', '3F總', '{"account_no": "HN72390032", "billing_method": "單據寄公司自動轉帳", "service_type": "網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '熱河', '熱河', '{"account_no": "3136271", "billing_method": "單據寄公司自動轉帳", "service_type": "電話費+電路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '總公司', '總公司', '{"account_no": "3552363", "service_type": "電話費", "note": "合併帳單"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '南部代工中心', '南部代工中心', '{"account_no": "3511590(3*1*5*0)", "account_name": "黃志雄", "account_id": "B71979058073046", "billing_method": "單據寄公司自動轉帳", "service_type": "電話費+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '南部辦公室傳真', '南部辦公室傳真', '{"account_no": "3533832", "account_name": "南京眼鏡行"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '板橋', '板橋', '{"account_no": "29*6*8*7", "account_name": "黃信儒", "account_id": "B85976461141035", "billing_method": "單據寄公司", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '董事長家裡電話', '董事長家裡電話', '{"account_no": "07-3581783"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '立安路一樓', '立安路一樓', '{"account_no": "Y530719", "account_name": "吳郁蓁", "account_id": "B85975663931002", "service_type": "光世代+MOD"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '總哥新竹網路', '總哥新竹網路', '{"account_no": "Y587054"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '總公司系統伺服器', '總公司系統伺服器', '{"account_no": "Y602594", "account_name": "黃信儒", "account_id": "B85976461141029", "service_type": "電路費+網路費", "note": "100M/40M"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '南加工', '南加工', '{"account_no": "Y564530", "account_id": "76903675", "billing_cycle": "單月(每月寄)", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '5F公司主機', '5F公司主機', '{"account_no": "Y652439", "account_name": "黃信儒", "account_id": "B85976461141036", "billing_cycle": "單月(每月寄)", "service_type": "網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '中央管理平版', '中央管理平版', '{"account_no": "0911592318", "account_name": "樂活光學有限公司"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '中清', '中清', '{"account_no": "22*5*6*0", "account_name": "黃信儒", "account_id": "B85976461141045"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '庶民眼鏡路竹店', '庶民眼鏡路竹店', '{"account_no": "07-6968241"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '北屯', '北屯', '{"account_no": "22*6*1*7", "account_name": "黃信儒", "account_id": "B85976461141046", "billing_method": "單據寄公司", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '北屯', '北屯', '{"account_no": "Y404478", "account_name": "黃信儒", "service_type": "電路", "note": "跟42 22*6*1*7一起"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '北屯', '北屯', '{"account_no": "HN77908847", "account_name": "黃信儒", "service_type": "網路", "note": "跟42 22*6*1*7一起"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '大墩', '大墩', '{"account_no": "23*0*1*2", "account_name": "黃信儒", "account_id": "B85976461141047", "billing_method": "單據寄公司", "service_type": "市話+電路+網路費"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '大墩', '大墩', '{"account_no": "Y355603", "account_name": "黃信儒", "service_type": "網路", "note": "跟43 23*0*1*2"}'::jsonb);

-- ── 公務機（遠傳金雞）（35 筆）─────────────────────
INSERT INTO entity_facts (category_id, store_erpid, store_name, data) VALUES
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '楠梓(希爾頓)', '楠梓(希爾頓)', '{"bill_account_name": "絡繹眼鏡行", "account_id": "38697318", "full_phone": "0906337872", "user_name": "楠梓(希爾頓)", "monthly_fee": 299, "contract_end": "114.04.14", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '人事', '人事', '{"bill_account_name": "希爾頓隱形眼鏡", "account_id": "78734556", "full_phone": "0906337675", "user_name": "人事", "monthly_fee": 299, "contract_end": "114.04.14", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '竹北', '竹北', '{"bill_account_name": "希爾頓隱形眼鏡", "account_id": "78734556", "full_phone": "0907956837", "user_name": "竹北", "monthly_fee": 499, "contract_end": "112.11.10", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '梓倉', '梓倉', '{"bill_account_name": "長鴻眼鏡行", "account_id": "38697289", "full_phone": "0906389311", "user_name": "梓倉", "monthly_fee": 499, "phone_code": "2009", "contract_end": "114.09.21", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '南京', '南京', '{"bill_account_name": "南京眼鏡行", "account_id": "26477155", "full_phone": "0906958626", "user_name": "南京", "monthly_fee": 396, "phone_code": "2005", "contract_end": "114.03.22", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '公關部客服', '公關部客服', '{"bill_account_name": "長鴻眼鏡行", "account_id": "38697289", "full_phone": "0906781517", "user_name": "公關部客服", "monthly_fee": 599, "contract_end": "114.04.04", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '熱河', '熱河', '{"bill_account_name": "長鴻眼鏡行", "account_id": "38697289", "full_phone": "0906636271", "user_name": "熱河", "monthly_fee": 499, "phone_code": "2003", "contract_end": "112.11.09", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '會計', '會計', '{"bill_account_name": "信儒眼鏡行", "account_id": "47656611", "full_phone": "0907729113", "user_name": "會計", "monthly_fee": 199, "phone_code": "2018", "contract_end": "113.8.14", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '鼎山', '鼎山', '{"bill_account_name": "絡繹眼鏡行", "account_id": "38697318", "full_phone": "0906485545", "user_name": "鼎山", "monthly_fee": 499, "phone_code": "2004", "contract_end": "112.10.25", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '企畫副理', '企畫副理', '{"bill_account_name": "希爾頓隱形眼鏡", "account_id": "78734556", "full_phone": "0906291733", "user_name": "企畫副理", "monthly_fee": 299, "contract_end": "114.04.14", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '新左營', '新左營', '{"bill_account_name": "高鐵眼鏡行", "account_id": "47662607", "full_phone": "0907843289", "user_name": "新左營", "monthly_fee": 499, "phone_code": "2019", "contract_end": "112.11.25", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '南辦校專', '南辦校專', '{"bill_account_name": "歐普不動產", "account_id": "28295477", "full_phone": "0906337101", "user_name": "南辦校專", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '高大', '高大', '{"bill_account_name": "信儒眼鏡行", "account_id": "47656611", "full_phone": "0906639113", "user_name": "高大", "monthly_fee": 499, "phone_code": "2002", "contract_end": "112.11.09", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '企劃部', '企劃部', '{"bill_account_name": "歐普不動產", "account_id": "28295477", "full_phone": "0906337038", "user_name": "企劃部", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '高美', '高美', '{"bill_account_name": "好明毅眼鏡行", "account_id": "41333116", "full_phone": "0968525155", "user_name": "高美", "monthly_fee": 499, "phone_code": "2006", "contract_end": "112.10.26", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '文山', '文山', '{"bill_account_name": "平安眼鏡有限公司", "account_id": "94249671", "full_phone": "0906079427", "user_name": "文山", "monthly_fee": 499, "phone_code": "2007", "contract_end": "112.10.27", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '東山', '東山', '{"bill_account_name": "樂活眼鏡行", "account_id": "72326765", "full_phone": "0906479366", "user_name": "東山", "phone_code": "                                                                 ", "contract_end": "112.11.09", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '中科', '中科', '{"bill_account_name": "平安眼鏡有限公司", "account_id": "94249671", "full_phone": "0906623491", "user_name": "中科", "monthly_fee": 499, "phone_code": "2011", "contract_end": "112.12.16", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '潭子', '潭子', '{"bill_account_name": "爍活眼鏡行", "account_id": "72357909", "full_phone": "0906552109", "user_name": "潭子", "monthly_fee": 499, "phone_code": "2013", "contract_end": "112.11.09", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '中壢', '中壢', '{"bill_account_name": "樂活眼鏡行", "account_id": "72829534", "full_phone": "0906830226", "user_name": "中壢", "monthly_fee": 399, "phone_code": "2014", "contract_end": "113.08.14", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '中部代工', '中部代工', '{"bill_account_name": "平安眼鏡有限公司", "account_id": "47657739", "full_phone": "0906558965", "user_name": "中部代工", "monthly_fee": 499, "phone_code": "2010", "contract_end": "112.11.12", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '新竹', '新竹', '{"bill_account_name": "樂活光學有限公司", "account_id": "90848479", "full_phone": "0906111982", "user_name": "新竹", "monthly_fee": 199, "phone_code": "2015", "contract_end": "113.08.24", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '南部代工', '南部代工', '{"bill_account_name": "熱活眼鏡有限公司", "account_id": "94134517", "full_phone": "0968593387", "user_name": "南部代工", "monthly_fee": 499, "contract_end": "113.03.24", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '林口', '林口', '{"bill_account_name": "樂活眼鏡行", "account_id": "82010456", "full_phone": "0907617670", "user_name": "林口", "monthly_fee": 299, "phone_code": "2020", "contract_end": "114.04.09", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '文化', '文化', '{"bill_account_name": "歐普不動產", "account_id": "28295477", "full_phone": "0906252163", "user_name": "文化", "monthly_fee": 199, "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '六家', '六家', '{"bill_account_name": "信儒眼鏡行", "account_id": "47656611", "full_phone": "0906142482", "user_name": "六家", "monthly_fee": 199, "contract_end": "113.08.24", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '後甲', '後甲', '{"bill_account_name": "南京眼鏡行", "account_id": "26477155", "full_phone": "0906337013", "user_name": "後甲", "monthly_fee": 599, "contract_end": "114.04.14", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '板橋', '板橋', '{"bill_account_name": "南京眼鏡行", "account_id": "26477155", "full_phone": "0906955578", "user_name": "板橋", "monthly_fee": 699, "contract_end": "114.09.20", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '大里', '大里', '{"bill_account_name": "平安眼鏡有限公司", "account_id": "94249671", "full_phone": "0985011068", "user_name": "大里", "monthly_fee": 599, "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '八德', '八德', '{"bill_account_name": "絡繹眼鏡行", "account_id": "38697318", "full_phone": "0977396068", "user_name": "八德", "monthly_fee": 699, "phone_code": "114.3.25退租", "contract_end": "114.01.23", "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '十甲', '十甲', '{"bill_account_name": "爍活眼鏡行", "account_id": "72357909", "full_phone": "0906660621", "user_name": "十甲", "monthly_fee": 399, "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '永和', '永和', '{"bill_account_name": "爍活眼鏡行", "account_id": "72357909", "full_phone": "0906660631", "user_name": "永和", "monthly_fee": 399, "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '中清', '中清', '{"bill_account_name": "樂活中清有限公司", "account_id": "93569555", "full_phone": "0955997543", "user_name": "中清", "monthly_fee": 599, "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '北屯', '北屯', '{"bill_account_name": "樂活北屯有限公司", "account_id": "00165337", "full_phone": "0968171660", "user_name": "北屯", "monthly_fee": 260, "service_type": "公務機（遠傳金雞）"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'telecom'), '大墩', '大墩', '{"bill_account_name": "樂活北屯有限公司", "account_id": "00165337", "full_phone": "0966801159", "user_name": "大墩", "monthly_fee": 599, "contract_end": "117.01.02", "service_type": "公務機（遠傳金雞）"}'::jsonb);

-- ── 房租（31 筆）─────────────────────
INSERT INTO entity_facts (category_id, store_erpid, store_name, data) VALUES
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '熱河', '熱河', '{"actual_rent": 70000, "check_amount": "70000", "report_amount": 70000, "rent_tax": "7000", "health_insurance": "1477", "note": "公司先付後，房東會拿給門市再銀存給回二代與租賃"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '鼎山', '鼎山', '{"actual_rent": 65000, "check_amount": "65000", "report_amount": 65000, "rent_tax": "無", "health_insurance": "無"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '高美', '高美', '{"actual_rent": 138000, "check_amount": "138000", "report_amount": 138000, "rent_tax": "13800", "health_insurance": "2912"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '河堤', '河堤', '{"actual_rent": 60000, "check_amount": "52854/39550", "rent_tax": "6000/4500", "health_insurance": "1266/950"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '高大', '高大', '{"actual_rent": 58800, "check_amount": "匯款", "report_amount": 62782, "rent_tax": "5880", "health_insurance": "1241", "note": "發票另開~沒有二代租賃~"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '南京', '南京', '{"actual_rent": 75000, "check_amount": "75000", "report_amount": 78500, "rent_tax": "無", "health_insurance": "無", "note": "每年需多新增一張40,000元的支票(漲租租金)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '文山', '文山', '{"actual_rent": 180000, "check_amount": "158202", "report_amount": 158202, "rent_tax": "18000", "health_insurance": "3798", "note": "  "}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '新左營', '新左營', '{"contract_rent": 111000, "actual_rent": 97558, "check_amount": "97558", "report_amount": 97558, "rent_tax": "11100", "health_insurance": "2342"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '誠品', '誠品', '{"actual_rent": 87890, "rent_tax": "無", "health_insurance": "無"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '屏東', '屏東', '{"rent_tax": "無", "health_insurance": "無"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '東山', '東山', '{"contract_rent": 204801, "actual_rent": 180000, "check_amount": "180000", "report_amount": 170000, "rent_tax": "20480", "health_insurance": "4321", "note": "2022.3  押金52.5萬升成54萬，列業主往來"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '中科', '中科', '{"actual_rent": 153800, "check_amount": "158800", "report_amount": 158800, "rent_tax": "15880", "health_insurance": "3350", "note": "54756自108.2到109.1開立此金額，將之前未開但有繳的稅補回"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '潭子', '潭子', '{"actual_rent": 135000, "check_amount": "135000", "report_amount": 135000, "rent_tax": "無", "health_insurance": "無"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '大里', '大里', '{"contract_rent": 230000, "actual_rent": 230000, "check_amount": "202147", "report_amount": 202147, "rent_tax": "23000", "health_insurance": "4853", "note": "租賃與二代房東繳納，支票忘了扣掉我們代繳的租賃與二代，經確認改由第二年支票一併扣掉"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '新竹', '新竹', '{"contract_rent": 100000, "actual_rent": 270000, "check_amount": "270000", "report_amount": 250000, "rent_tax": "10000", "health_insurance": "2110", "note": "從112.08.01~117.07.31 租金漲為270,000"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '中壢', '中壢', '{"actual_rent": 136534, "check_amount": "匯款", "report_amount": 120000, "rent_tax": "12000", "health_insurance": "2532"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '竹北', '竹北', '{"actual_rent": 157500, "check_amount": "157500", "report_amount": 157500, "rent_tax": "無", "health_insurance": "無", "note": "       "}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '六家', '六家', '{"actual_rent": 178000, "check_amount": "178000", "report_amount": 178000, "rent_tax": "無", "health_insurance": "無"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '後甲', '後甲', '{"contract_rent": 95000, "actual_rent": 89248, "report_amount": 89248, "rent_tax": "9500", "health_insurance": "2004.5"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '林口', '林口', '{"contract_rent": 60000, "actual_rent": 180000, "check_amount": "285000", "report_amount": 180000, "rent_tax": "11689", "health_insurance": "2466", "note": "112.06開始 兩位房東  申報租金為=(60000元 + 56889元)  租賃+所得(7266+6889)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '八德', '八德', '{"contract_rent": 60000, "actual_rent": 120000, "check_amount": "120000", "report_amount": 120000, "rent_tax": "6000", "health_insurance": "無"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '楠梓', '楠梓', '{"contract_rent": 40000, "actual_rent": 100000, "check_amount": "40000", "report_amount": 140000, "rent_tax": "無", "health_insurance": "無"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '文化', '文化', '{"actual_rent": 120000, "check_amount": "120000", "report_amount": 120000, "rent_tax": "5000", "health_insurance": "無"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '板橋', '板橋', '{"actual_rent": 200000, "check_amount": "175780", "report_amount": 175780, "rent_tax": "20000", "health_insurance": "4220"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '十甲', '十甲', '{"contract_rent": 50000, "actual_rent": 43945, "check_amount": "43945", "report_amount": 43945, "rent_tax": "5000", "health_insurance": "1055"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '後甲', '後甲', '{"contract_rent": 95000, "actual_rent": 89248, "check_amount": "匯款", "report_amount": 89248, "rent_tax": "4750", "health_insurance": "1002.2499999999999", "note": "只報47,500  超過兩萬的才報稅 沒有超過可以不用    五個房東 41748*1、11875*4 "}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '永和', '永和', '{"contract_rent": 160000, "actual_rent": 140624, "check_amount": "140624", "report_amount": 140624, "rent_tax": "16000", "health_insurance": "3376"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '中清', '中清', '{"contract_rent": 55000, "actual_rent": 55000, "check_amount": "55000", "report_amount": 55000, "rent_tax": "無", "health_insurance": "無", "note": "113/3/20房東通知台中姐確認，報5萬租約，二代租賃由台中姐報稅列印繳費單後，給房東繳"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '北屯', '北屯', '{"contract_rent": 120000, "actual_rent": 126000, "check_amount": "126000", "report_amount": 126000, "rent_tax": "無", "health_insurance": "無", "note": "公司行號無二代與租賃，需收發票(含稅)\n113.12.1~116.11.30每月12萬(未稅值)，實付126,000元\n116.12.1~119.11.30每月123600元(未稅值)，實付129,780元"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '大墩', '大墩', '{"contract_rent": 114644, "actual_rent": 114644, "optical_rent": 109185, "report_amount": 114644, "rent_tax": "無", "health_insurance": "無", "note": "電費夏季$9.3 非夏季$8 水費1度 17.5\n租金95,000 管理費$300/坪 空調費$176/坪 29.8坪 95,000+8,940+5,245(未稅)"}'::jsonb),
  ((SELECT id FROM entity_fact_categories WHERE code = 'rent'), '馬來西亞', '馬來西亞', '{"contract_rent": 21600, "actual_rent": 21600, "note": "房租押金 $ 4,800 / 水電押金 $ 1,600"}'::jsonb);

-- ── 匯入完成 ─────────────────────────────────────