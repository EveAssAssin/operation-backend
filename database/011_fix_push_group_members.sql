-- ============================================================
-- 011_fix_push_group_members.sql
-- 修補推播群組 schema：
--   1. push_group_members 表如果不存在就建立
--   2. employee_id 用 UUID（對應 employees.id）
--   3. group_id 自動跟 push_groups.id 同型別（INTEGER / UUID）
-- ============================================================

-- 先把舊的（如果有）爆破，因為原本型別錯誤，裡面不會有有效資料
DROP TABLE IF EXISTS push_group_members CASCADE;

-- 依 push_groups.id 的實際型別建立 push_group_members
DO $$
DECLARE
    pg_id_type text;
BEGIN
    SELECT data_type INTO pg_id_type
    FROM information_schema.columns
    WHERE table_name = 'push_groups' AND column_name = 'id';

    IF pg_id_type IS NULL THEN
        -- push_groups 不存在，順便建立（用 UUID 比較統一）
        EXECUTE '
            CREATE TABLE push_groups (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name        VARCHAR(100) NOT NULL,
                description TEXT,
                created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                created_by  VARCHAR(100)
            )';
        pg_id_type := 'uuid';
    END IF;

    IF pg_id_type = 'uuid' THEN
        EXECUTE '
            CREATE TABLE push_group_members (
                id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                group_id      UUID NOT NULL REFERENCES push_groups(id) ON DELETE CASCADE,
                employee_id   UUID NOT NULL,
                employee_name VARCHAR(100) NOT NULL,
                app_number    VARCHAR(50),
                store_name    VARCHAR(100),
                created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(group_id, employee_id)
            )';
    ELSE
        -- push_groups.id 是 INTEGER（SERIAL）
        EXECUTE '
            CREATE TABLE push_group_members (
                id            SERIAL PRIMARY KEY,
                group_id      INTEGER NOT NULL REFERENCES push_groups(id) ON DELETE CASCADE,
                employee_id   UUID NOT NULL,
                employee_name VARCHAR(100) NOT NULL,
                app_number    VARCHAR(50),
                store_name    VARCHAR(100),
                created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(group_id, employee_id)
            )';
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pgm_group_id ON push_group_members(group_id);
