-- 014_recruitment_interview_video.sql
-- 面試紀錄新增：影片檔連結欄位（mp4/webm 等）
-- 沿用 Supabase Storage bucket，用另一個資料夾 videos/ 存

ALTER TABLE recruitment_interviews
  ADD COLUMN IF NOT EXISTS video_url TEXT;

COMMENT ON COLUMN recruitment_interviews.video_url IS
  '面試錄影檔的 public URL（Supabase Storage: recruitment-audio/videos/{id}.mp4）';
