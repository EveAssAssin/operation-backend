// services/fileService.js
// 通用附件上傳服務
//   - 檔案實體存 Supabase Storage 的 `attachments` bucket
//   - meta 存 attachments 表
//   - 用 entity_type + entity_id 連結到任何模組（contract / medical_doc / ...）

const supabase = require('../config/supabase');

const BUCKET = 'attachments';

/**
 * 上傳一個檔案
 * @param {object} input
 *   - buffer:        Buffer  (multer memoryStorage)
 *   - mimeType:      string
 *   - originalName:  string
 *   - entity_type:   string  (例：'contract')
 *   - entity_id:     string  (UUID)
 *   - category:      string? (例：'contract_pdf')
 *   - note:          string?
 * @param {string} uploaderAppNumber
 */
async function uploadFile(input, uploaderAppNumber) {
  const { buffer, mimeType, originalName, entity_type, entity_id, category, note } = input;
  if (!buffer || buffer.length === 0) throw new Error('空檔案');
  if (!entity_type) throw new Error('entity_type 必填');
  if (!entity_id)   throw new Error('entity_id 必填');

  // 1. 上傳到 Storage（用 UUID 檔名避開 Supabase Storage 對特殊字元的限制）
  const ext  = String(originalName || '').match(/\.[a-zA-Z0-9]{1,8}$/)?.[0] || '';
  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2));
  const storagePath = `${entity_type}/${entity_id}/${uuid}${ext}`;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimeType || 'application/octet-stream',
      upsert: false,
    });
  if (upErr) {
    if (upErr.message?.includes('Bucket not found')) {
      throw new Error('Supabase Storage 還沒建立 "attachments" bucket，請到 Supabase Dashboard → Storage → Create bucket（name=attachments, public 勾起來）');
    }
    throw new Error('Storage 上傳失敗：' + upErr.message);
  }

  // 2. 取得 public URL
  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  const public_url = urlData?.publicUrl || null;

  // 3. 寫 attachments 表
  const row = {
    entity_type, entity_id,
    storage_path:  storagePath,
    public_url,
    original_name: originalName || null,
    mime_type:     mimeType || null,
    size_bytes:    buffer.length,
    category:      category || null,
    note:          note || null,
    uploaded_by:   uploaderAppNumber || null,
  };
  const { data, error } = await supabase
    .from('attachments')
    .insert(row)
    .select()
    .single();
  if (error) {
    // 寫 DB 失敗 → 把 storage 上傳的也刪掉，避免孤兒檔
    await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    throw new Error(error.message);
  }
  return data;
}


/** 列出某個 entity 的所有附件 */
async function listFiles(entity_type, entity_id) {
  if (!entity_type || !entity_id) return [];
  const { data, error } = await supabase
    .from('attachments')
    .select('*')
    .eq('entity_type', entity_type)
    .eq('entity_id', entity_id)
    .order('uploaded_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}


/** 刪除附件（DB + Storage 都刪） */
async function deleteFile(id) {
  // 先取得 storage_path
  const { data: f, error: fErr } = await supabase
    .from('attachments')
    .select('storage_path')
    .eq('id', id)
    .maybeSingle();
  if (fErr) throw new Error(fErr.message);
  if (!f)   throw new Error('附件不存在');

  // 刪 Storage
  await supabase.storage.from(BUCKET).remove([f.storage_path]).catch(e => {
    console.warn('[fileService] storage remove fail:', e?.message);
  });

  // 刪 DB
  const { error } = await supabase.from('attachments').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { id, deleted: true };
}


/** 拿 signed URL（有需要時用，例如 bucket 不 public 時） */
async function getSignedUrl(storage_path, expiresInSec = 3600) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storage_path, expiresInSec);
  if (error) throw new Error(error.message);
  return data?.signedUrl;
}


module.exports = {
  uploadFile, listFiles, deleteFile, getSignedUrl,
};
