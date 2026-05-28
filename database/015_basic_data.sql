-- ============================================================
-- 015_basic_data.sql
-- 「基本資料」模組
--   為每個門市(=departments.store_erpid) 紀錄各種分類的彈性資料
--   例：電費(電號/戶名/地址)、電話與網路(用戶號碼/帳號)、房租(合約租金/實付租金/...)
--
--   設計：
--     entity_fact_categories  分類（電費/電話/房租/+自訂）
--     entity_fact_fields      欄位定義（每分類有哪些欄位）
--     entity_facts            實際資料（一個門市對一個分類可以有多筆）
--
--   彈性：使用者可以在前端 UI
--         1) 新增自訂分類
--         2) 為任何分類新增/修改/刪除欄位
--         3) 新增/修改/刪除資料
--
--   系統預設的分類(is_system=true)不能刪、改名要謹慎
-- ============================================================

-- ── 1. 分類表 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity_fact_categories (
    id              BIGSERIAL PRIMARY KEY,
    code            VARCHAR(50) UNIQUE NOT NULL,        -- 程式用代碼：electricity / telecom / rent / custom_xxx
    name            VARCHAR(100) NOT NULL,              -- 顯示名稱：電費 / 電話與網路 / 房租
    icon            VARCHAR(10),                        -- 圖示 emoji
    is_system       BOOLEAN NOT NULL DEFAULT false,     -- 系統預設不可刪
    sort_order      INT NOT NULL DEFAULT 0,
    extra           JSONB NOT NULL DEFAULT '{}'::jsonb, -- 分類層級的 meta（例如電費的「查詢網址」）
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN entity_fact_categories.code   IS '程式用唯一代碼（英數+底線）';
COMMENT ON COLUMN entity_fact_categories.extra  IS '分類層級的 meta，例如 {"query_url": "https://..."} 給電費查詢用';

-- ── 2. 欄位定義表 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity_fact_fields (
    id              BIGSERIAL PRIMARY KEY,
    category_id     BIGINT NOT NULL REFERENCES entity_fact_categories(id) ON DELETE CASCADE,
    field_key       VARCHAR(50) NOT NULL,               -- 程式用 key，jsonb 取值用
    field_label     VARCHAR(100) NOT NULL,              -- 顯示用名稱
    field_type      VARCHAR(20)  NOT NULL DEFAULT 'text', -- text / number / date / url / multiline / boolean
    is_required     BOOLEAN NOT NULL DEFAULT false,
    sort_order      INT NOT NULL DEFAULT 0,
    placeholder     TEXT,                               -- 輸入框 placeholder
    is_system       BOOLEAN NOT NULL DEFAULT false,     -- 系統預設欄位不可刪
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (category_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_fact_fields_category
    ON entity_fact_fields(category_id, sort_order);

-- ── 3. 實際資料表 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity_facts (
    id                     BIGSERIAL PRIMARY KEY,
    category_id            BIGINT NOT NULL REFERENCES entity_fact_categories(id) ON DELETE CASCADE,
    store_erpid            VARCHAR(50) NOT NULL,        -- = departments.store_erpid
    store_name             VARCHAR(100),                -- snapshot（建立當下的門市名）
    data                   JSONB NOT NULL DEFAULT '{}'::jsonb, -- { field_key: value, ... }
    note                   TEXT,                        -- 額外備註（系統的 note 欄位，跟 fields 的 note 是不同的）
    created_by_app_number  VARCHAR(20),
    updated_by_app_number  VARCHAR(20),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_facts_store         ON entity_facts(store_erpid);
CREATE INDEX IF NOT EXISTS idx_facts_category      ON entity_facts(category_id);
CREATE INDEX IF NOT EXISTS idx_facts_cat_store     ON entity_facts(category_id, store_erpid);

-- 自動更新 updated_at（如果還沒有共用 trigger）
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_facts_updated ON entity_facts;
CREATE TRIGGER trg_facts_updated
    BEFORE UPDATE ON entity_facts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_categories_updated ON entity_fact_categories;
CREATE TRIGGER trg_categories_updated
    BEFORE UPDATE ON entity_fact_categories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 4. 異動歷史（audit log） ──────────────────────────────
-- 紀錄 facts / categories / fields 的所有變動（給「最近異動」+ 推播訊息用）
CREATE TABLE IF NOT EXISTS entity_fact_history (
    id                BIGSERIAL PRIMARY KEY,
    action            VARCHAR(20)  NOT NULL,                 -- create / update / delete
    entity_type       VARCHAR(30)  NOT NULL,                 -- fact / category / field
    entity_id         BIGINT,                                -- 對應的 PK
    category_id       BIGINT,                                -- fact / field 的話帶這個，方便篩
    category_name     VARCHAR(100),                          -- snapshot
    store_erpid       VARCHAR(50),                           -- fact 的話帶這個
    store_name        VARCHAR(100),                          -- snapshot
    changes           JSONB,                                 -- update 時：{ field_key: [old, new], ... }
    full_data         JSONB,                                 -- create / delete 時：完整資料快照
    actor_app_number  VARCHAR(20),
    actor_name        VARCHAR(50),
    note              TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fact_history_created   ON entity_fact_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_history_category  ON entity_fact_history(category_id);
CREATE INDEX IF NOT EXISTS idx_fact_history_store     ON entity_fact_history(store_erpid);

-- ── 5. 推播訂閱名單 ───────────────────────────────────────
-- 在前端設定頁勾選哪些 app_number 要收通知
CREATE TABLE IF NOT EXISTS basic_data_notify_subscribers (
    id           BIGSERIAL PRIMARY KEY,
    app_number   VARCHAR(20) NOT NULL UNIQUE,
    name         VARCHAR(50),                                -- snapshot
    enabled      BOOLEAN NOT NULL DEFAULT true,
    events       JSONB   NOT NULL DEFAULT
                 '["fact_create","fact_update","fact_delete","meta_change"]'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN basic_data_notify_subscribers.events IS
  '訂閱的事件類型清單。可用：fact_create / fact_update / fact_delete / meta_change';

DROP TRIGGER IF EXISTS trg_subscribers_updated ON basic_data_notify_subscribers;
CREATE TRIGGER trg_subscribers_updated
    BEFORE UPDATE ON basic_data_notify_subscribers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 預設不加任何訂閱者。請部署後到前端「基本資料 → ⚙ 推播名單」勾選自己。

-- ============================================================
-- 預設種子：電費 / 電話與網路 / 房租
-- ============================================================

-- 1) 電費（系統分類）
INSERT INTO entity_fact_categories (code, name, icon, is_system, sort_order, extra)
VALUES ('electricity', '電費', '🔌', true, 10,
        '{"query_url": "https://ebpps2.taipower.com.tw/simplebill/simple-query-bill"}'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO entity_fact_fields (category_id, field_key, field_label, field_type, sort_order, is_system, placeholder)
SELECT c.id, v.field_key, v.field_label, v.field_type, v.sort_order, true, v.placeholder
FROM entity_fact_categories c
CROSS JOIN (VALUES
    ('area',         '區域',     'text',      10, '例：新北區'),
    ('meter_id',     '電號',     'text',      20, '例：05780382066'),
    ('account_name', '用電戶名', 'text',      30, '例：陳秀傳（國宅段48地號）'),
    ('address',      '用電地址', 'text',      40, '例：新北市林口區忠孝路518號'),
    ('auto_debit',   '代扣繳',   'text',      50, '例：已代扣繳 / 未代扣'),
    ('note',         '備註',     'multiline', 90, '其他補充說明')
) AS v(field_key, field_label, field_type, sort_order, placeholder)
WHERE c.code = 'electricity'
ON CONFLICT (category_id, field_key) DO NOTHING;

-- 2) 電話與網路費（系統分類）
INSERT INTO entity_fact_categories (code, name, icon, is_system, sort_order, extra)
VALUES ('telecom', '電話與網路費', '📞', true, 20,
        '{"query_url": "https://123.cht.com.tw/ecas/B71"}'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO entity_fact_fields (category_id, field_key, field_label, field_type, sort_order, is_system, placeholder)
SELECT c.id, v.field_key, v.field_label, v.field_type, v.sort_order, true, v.placeholder
FROM entity_fact_categories c
CROSS JOIN (VALUES
    ('account_no',     '用戶號碼',       'text',      10, '例：Y530715'),
    ('user_name',      '用戶帳號',       'text',      20, '例：黃志雄'),
    ('account_id',     '統編/帳號',      'text',      30, '例：B71979058073011'),
    ('billing_method', '單據寄送',       'text',      40, '例：單據寄公司自動轉帳'),
    ('billing_cycle',  '單月/雙月繳',    'text',      50, '例：單月（每月寄）'),
    ('service_type',   '服務類型',       'text',      60, '例：電話+電路+網路費'),
    ('spec',           '規格',           'text',      70, '例：100M/40M、300M/300M、光世代+MOD'),
    ('note',           '備註',           'multiline', 90, '例：這張掛在 3552363 下面')
) AS v(field_key, field_label, field_type, sort_order, placeholder)
WHERE c.code = 'telecom'
ON CONFLICT (category_id, field_key) DO NOTHING;

-- 3) 房租（系統分類）
INSERT INTO entity_fact_categories (code, name, icon, is_system, sort_order, extra)
VALUES ('rent', '房租', '🏠', true, 30, '{}'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO entity_fact_fields (category_id, field_key, field_label, field_type, sort_order, is_system, placeholder)
SELECT c.id, v.field_key, v.field_label, v.field_type, v.sort_order, true, v.placeholder
FROM entity_fact_categories c
CROSS JOIN (VALUES
    ('contract_rent',    '合約租金',         'number',    10, '例：111000'),
    ('actual_rent',      '實付租金',         'number',    20, '例：97558'),
    ('check_amount',     '支票金額',         'text',      30, '例：97558 或 匯款'),
    ('report_amount',    '月報應列金額',     'number',    40, '例：97558'),
    ('rent_tax',         '租賃稅',           'text',      50, '例：11100 或 無'),
    ('health_insurance', '二代健保',         'text',      60, '例：2342 或 無'),
    ('note',             '備註',             'multiline', 90, '例：發票另開~沒有二代租賃~')
) AS v(field_key, field_label, field_type, sort_order, placeholder)
WHERE c.code = 'rent'
ON CONFLICT (category_id, field_key) DO NOTHING;

-- ============================================================
-- 結束
-- ============================================================
