-- ============================================================
-- 017_permissions_system.sql
-- 分權系統
--   1. 新增營運部會計 / 營運部人事 兩個子角色
--   2. 每個模組可設定哪些角色「能看 / 能改」
--   3. is_admin=true 的角色（super_admin / dept_head / operation_lead）自動全權
-- ============================================================

-- ── 1. 角色定義表 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
    id          BIGSERIAL PRIMARY KEY,
    key         VARCHAR(50) UNIQUE NOT NULL,
    label       VARCHAR(100) NOT NULL,
    is_admin    BOOLEAN NOT NULL DEFAULT false,    -- true = 不受 permissions 限制，全權
    sort_order  INT NOT NULL DEFAULT 100,
    color       VARCHAR(20),                       -- badge 底色
    text_color  VARCHAR(20),                       -- badge 文字色
    description TEXT,
    is_system   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. 模組註冊表 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS modules (
    id          BIGSERIAL PRIMARY KEY,
    key         VARCHAR(50) UNIQUE NOT NULL,
    label       VARCHAR(100) NOT NULL,
    icon        VARCHAR(10),
    sort_order  INT NOT NULL DEFAULT 100,
    is_system   BOOLEAN NOT NULL DEFAULT true,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 3. 角色 × 模組權限 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_module_permissions (
    id          BIGSERIAL PRIMARY KEY,
    role_key    VARCHAR(50) NOT NULL,
    module_key  VARCHAR(50) NOT NULL,
    can_view    BOOLEAN NOT NULL DEFAULT false,
    can_edit    BOOLEAN NOT NULL DEFAULT false,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (role_key, module_key)
);

CREATE INDEX IF NOT EXISTS idx_role_perms_role ON role_module_permissions(role_key);

-- 沿用 015 的共用 trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_roles_updated   ON roles;
CREATE TRIGGER trg_roles_updated   BEFORE UPDATE ON roles   FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_modules_updated ON modules;
CREATE TRIGGER trg_modules_updated BEFORE UPDATE ON modules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_role_perms_updated ON role_module_permissions;
CREATE TRIGGER trg_role_perms_updated BEFORE UPDATE ON role_module_permissions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 預設角色
-- ============================================================
INSERT INTO roles (key, label, is_admin, sort_order, color, text_color, description) VALUES
    ('super_admin',          '超級管理員',  true,  10, '#fed7d7', '#c53030', '系統全權'),
    ('dept_head',            '部門主管',    true,  20, '#fef3c7', '#92400e', '部門主管全權'),
    ('operation_lead',       '營運部主管',  true,  30, '#fef3c7', '#92400e', '營運部全權'),
    ('operation_accounting', '營運部會計',  false, 40, '#dbeafe', '#1e40af', '帳務、開帳、支票、常態費用'),
    ('operation_hr',         '營運部人事',  false, 50, '#dcfce7', '#15803d', '人員、招募、業績、任務派發'),
    ('operation_staff',      '營運部部員',  false, 60, '#f5f0ea', '#50422d', '未分類部員（暫時保留全部可看）')
ON CONFLICT (key) DO UPDATE SET
    label       = EXCLUDED.label,
    is_admin    = EXCLUDED.is_admin,
    sort_order  = EXCLUDED.sort_order,
    color       = EXCLUDED.color,
    text_color  = EXCLUDED.text_color,
    description = EXCLUDED.description;

-- ============================================================
-- 預設模組（對應 Layout.jsx 的 NAV_ITEMS）
-- ============================================================
INSERT INTO modules (key, label, icon, sort_order, description) VALUES
    ('dashboard',           '首頁',         '🏠', 10,  '系統首頁與重點摘要'),
    ('personnel',           '人員管理',     '👥', 20,  '系統人員 / 同步 / LINE UID'),
    ('basic_data',          '基本資料',     '📚', 30,  '電費 / 電話 / 房租 等門市基本資料'),
    ('billing',             '工程開帳',     '🔧', 40,  '工程開帳 v1'),
    ('billing_v2',          '帳單管理',     '🧾', 50,  '帳單管理 v2'),
    ('billing_report',      '帳單月報',     '📊', 60,  '帳單月報'),
    ('checks',              '支票紀錄',     '🏦', 70,  '支票紀錄與到期通知'),
    ('recurring_expenses',  '常態費用',     '💴', 80,  '常態費用管理'),
    ('recruitment',         '人力招募',     '🧑‍💼', 90,  '人力需求 / 履歷 / 面試'),
    ('sales_events',        '業績活動',     '📣', 100, '業績活動發佈'),
    ('quests',              '任務派發',     '📋', 110, '任務派發到市場部'),
    ('processes',           '各類流程',     '🗂️', 120, '門市交接表等各類流程'),
    ('appointed_units',     '特約廠商',     '🤝', 130, '特約廠商 / LINE 綁定 / 推播'),
    ('point_redemption',    '分數兌換',     '🪙', 140, '員工分數兌換管理'),
    ('scheduled_notify',    '排程推播',     '⏰', 150, '自訂排程推播'),
    ('system_settings',     '系統設定',     '⚙', 200, '權限設定等系統管理')
ON CONFLICT (key) DO UPDATE SET
    label       = EXCLUDED.label,
    icon        = EXCLUDED.icon,
    sort_order  = EXCLUDED.sort_order,
    description = EXCLUDED.description;

-- ============================================================
-- 預設權限：is_admin=true 角色自動全權，無需設定
-- 只設定：accounting / hr / staff
-- ============================================================

-- 會計 — 帳務類全開
INSERT INTO role_module_permissions (role_key, module_key, can_view, can_edit) VALUES
    ('operation_accounting', 'dashboard',           true,  false),
    ('operation_accounting', 'personnel',           true,  false),
    ('operation_accounting', 'basic_data',          true,  true),
    ('operation_accounting', 'billing',             true,  true),
    ('operation_accounting', 'billing_v2',          true,  true),
    ('operation_accounting', 'billing_report',      true,  true),
    ('operation_accounting', 'checks',              true,  true),
    ('operation_accounting', 'recurring_expenses',  true,  true),
    ('operation_accounting', 'processes',           true,  false),
    ('operation_accounting', 'appointed_units',     true,  false),
    ('operation_accounting', 'quests',              true,  false)
ON CONFLICT (role_key, module_key) DO NOTHING;

-- 人事 — 人員類全開
INSERT INTO role_module_permissions (role_key, module_key, can_view, can_edit) VALUES
    ('operation_hr', 'dashboard',        true,  false),
    ('operation_hr', 'basic_data',       true,  false),
    ('operation_hr', 'personnel',        true,  true),
    ('operation_hr', 'recruitment',      true,  true),
    ('operation_hr', 'sales_events',     true,  true),
    ('operation_hr', 'quests',           true,  true),
    ('operation_hr', 'processes',        true,  false),
    ('operation_hr', 'point_redemption', true,  true)
ON CONFLICT (role_key, module_key) DO NOTHING;

-- 部員（未分類）— 保留現狀：全部可看可改（除了系統設定）
INSERT INTO role_module_permissions (role_key, module_key, can_view, can_edit)
SELECT 'operation_staff', key, true, true
FROM modules
WHERE key <> 'system_settings'
ON CONFLICT (role_key, module_key) DO NOTHING;
