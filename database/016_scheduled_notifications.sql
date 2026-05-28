-- ============================================================
-- 016_scheduled_notifications.sql
-- 「排程推播」模組
--   讓使用者在前端 UI 自由建立排程：每天 / 每週 / 每月 / 一次性
--   推播給：個別 app_number 或角色群（all operation_staff 等）
--   訊息支援動態變數：{date} {time} {weekday} {year} {month} {day} {ym} {days_left}
-- ============================================================

CREATE TABLE IF NOT EXISTS scheduled_notifications (
    id                       BIGSERIAL PRIMARY KEY,
    title                    VARCHAR(100) NOT NULL,                 -- 排程名稱（內部識別用，不會推給收件人）
    message                  TEXT NOT NULL,                          -- 推播內容（可含變數）

    -- 排程
    schedule_type            VARCHAR(20) NOT NULL,                   -- once / daily / weekly / monthly
    schedule_config          JSONB NOT NULL DEFAULT '{}'::jsonb,
        -- once:    { "datetime": "2026-07-15T09:00:00+08:00" }
        -- daily:   { "time": "09:00" }
        -- weekly:  { "time": "13:00", "days_of_week": [1,3,5] }   (1=週一 ... 7=週日)
        -- monthly: { "time": "10:00", "day_of_month": 25, "fallback": "prev" }  (prev=找前一個工作日 / skip=跳過 / next=下個月)

    next_run_at              TIMESTAMPTZ,                            -- 下次執行（dispatcher 排序用，UI 顯示用）
    last_run_at              TIMESTAMPTZ,
    last_run_status          VARCHAR(20),                            -- success / failed
    last_run_error           TEXT,
    last_run_recipient_count INT,

    -- 收件人（兩種都支援，最終會合併去重）
    recipient_app_numbers    JSONB NOT NULL DEFAULT '[]'::jsonb,     -- 個別 app_number
    recipient_roles          JSONB NOT NULL DEFAULT '[]'::jsonb,     -- 角色群（'operation_staff' / 'operation_lead' / 'dept_head' / 'super_admin'）

    -- 狀態
    enabled                  BOOLEAN NOT NULL DEFAULT true,
    completed                BOOLEAN NOT NULL DEFAULT false,         -- once 型推完後設 true

    -- 元資料
    created_by_app_number    VARCHAR(20),
    created_by_name          VARCHAR(50),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_notif_next_run
    ON scheduled_notifications(next_run_at)
    WHERE enabled = true AND completed = false;

COMMENT ON COLUMN scheduled_notifications.schedule_type    IS 'once / daily / weekly / monthly';
COMMENT ON COLUMN scheduled_notifications.recipient_roles  IS 'JSON array，例如 ["operation_staff","operation_lead"]';

-- 自動更新 updated_at（沿用 015 已建好的共用函式）
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sched_notif_updated ON scheduled_notifications;
CREATE TRIGGER trg_sched_notif_updated
    BEFORE UPDATE ON scheduled_notifications
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 執行歷史 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_notification_logs (
    id                BIGSERIAL PRIMARY KEY,
    notification_id   BIGINT REFERENCES scheduled_notifications(id) ON DELETE CASCADE,
    title             VARCHAR(100),                            -- snapshot
    message_rendered  TEXT,                                    -- 變數展開後的訊息
    recipient_count   INT,
    recipient_sample  JSONB,                                   -- 推給的前 10 個 app_number（debug 用）
    status            VARCHAR(20),                             -- success / failed
    error             TEXT,
    triggered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_manual         BOOLEAN NOT NULL DEFAULT false           -- true = 立即測試觸發 / false = 排程自動觸發
);

CREATE INDEX IF NOT EXISTS idx_sched_logs_notif
    ON scheduled_notification_logs(notification_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_sched_logs_triggered
    ON scheduled_notification_logs(triggered_at DESC);
