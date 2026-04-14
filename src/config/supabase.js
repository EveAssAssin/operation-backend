// config/supabase.js
// Supabase 客戶端設定（使用 service_role 金鑰，後端專用）
// 注意：service_role 金鑰可繞過 RLS，僅限後端使用，禁止暴露給前端

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl  = process.env.SUPABASE_URL;
const supabaseKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('[Supabase] 缺少環境變數 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

module.exports = supabase;
