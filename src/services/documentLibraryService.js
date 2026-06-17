// services/documentLibraryService.js
// 文件庫：以廠商/門市/員工分類存文件 + tag
// 檔案實體存 Supabase Storage 的 `attachments` bucket

const supabase = require('../config/supabase');

const BUCKET = 'attachments';

const TYPES = new Set(['vendor', 'rent', 'employee']);

function checkType(t) {
  if (!TYPES.has(t)) throw new Error(`doc_type 須為 vendor / rent / employee，收到 "${t}"`);
}

/** 列出某 type 全部分類（distinct category）+ 每類文件數 */
async function listCategories(doc_type) {
  checkType(doc_type);
  const { data, error } = await supabase
    .from('document_library')
    .select('category, category_ref')
    .eq('doc_type', doc_type);
  if (error) throw new Error(error.message);
  const map = new Map();
  for (const r of data || []) {
    if (!map.has(r.category)) map.set(r.category, { category: r.category, category_ref: r.category_ref, count: 0 });
    map.get(r.category).count++;
  }
  return [...map.values()].sort((a, b) => a.category.localeCompare(b.category, 'zh-TW'));
}

/** 列出某分類的所有文件 */
async function listDocs(doc_type, category) {
  checkType(doc_type);
  const { data, error } = await supabase
    .from('document_library')
    .select('*')
    .eq('doc_type', doc_type)
    .eq('category', category)
    .order('uploaded_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

/** 上傳文件 */
async function uploadDoc(input, uploader) {
  const { buffer, mimeType, originalName, doc_type, category, category_ref, tags, description } = input;
  checkType(doc_type);
  if (!buffer || buffer.length === 0) throw new Error('空檔案');
  if (!category) throw new Error('category（分類名）必填');

  // Storage key 限制嚴格：用 UUID 當檔名避開所有特殊字元問題
  // 原始檔名仍會存在 attachments.original_name 給使用者看
  const ext   = String(originalName || '').match(/\.[a-zA-Z0-9]{1,8}$/)?.[0] || '';
  const uuid  = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2));
  // category 也用 hash（避開 storage 對中文 / 空格 / 底線連用的奇怪 case）
  const catHash = require('crypto').createHash('md5').update(String(category)).digest('hex').slice(0, 12);
  const storagePath = `doclib/${doc_type}/${catHash}/${uuid}${ext}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimeType || 'application/octet-stream',
      upsert: false,
    });
  if (upErr) {
    if (upErr.message?.includes('Bucket not found')) {
      throw new Error('Supabase Storage 沒有 attachments bucket，請先建立');
    }
    throw new Error('Storage 上傳失敗：' + upErr.message);
  }

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  const public_url = urlData?.publicUrl || null;

  // 清整 tags
  let tagArr = [];
  if (Array.isArray(tags)) tagArr = tags.filter(Boolean).map(String);
  else if (typeof tags === 'string') tagArr = tags.split(',').map(s => s.trim()).filter(Boolean);

  const row = {
    doc_type,
    category:      String(category).trim(),
    category_ref:  category_ref || null,
    tags:          tagArr,
    storage_path:  storagePath,
    public_url,
    original_name: originalName || null,
    mime_type:     mimeType || null,
    size_bytes:    buffer.length,
    description:   description || null,
    uploaded_by:   uploader || null,
  };
  const { data, error } = await supabase
    .from('document_library')
    .insert(row)
    .select()
    .single();
  if (error) {
    await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    throw new Error(error.message);
  }
  return data;
}

/** 更新（改 tags / description / category 重新分類） */
async function updateDoc(id, patch) {
  const allowed = ['category', 'category_ref', 'tags', 'description', 'original_name'];
  const update = {};
  for (const k of allowed) if (patch[k] !== undefined) update[k] = patch[k];
  if (update.tags !== undefined) {
    if (Array.isArray(update.tags)) update.tags = update.tags.filter(Boolean).map(String);
    else if (typeof update.tags === 'string') update.tags = update.tags.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (Object.keys(update).length === 0) {
    const { data } = await supabase.from('document_library').select('*').eq('id', id).maybeSingle();
    return data;
  }
  const { data, error } = await supabase
    .from('document_library')
    .update(update)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** 刪除文件（DB + Storage 都刪） */
async function deleteDoc(id) {
  const { data: d } = await supabase
    .from('document_library')
    .select('storage_path')
    .eq('id', id)
    .maybeSingle();
  if (!d) throw new Error('文件不存在');
  await supabase.storage.from(BUCKET).remove([d.storage_path]).catch(e => {
    console.warn('[docLib] storage remove fail:', e?.message);
  });
  const { error } = await supabase.from('document_library').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { id, deleted: true };
}


/**
 * 新分類連動 — 門市類型，自動在 departments 加一筆（如果不存在的話）
 * @param category 門市名
 */
async function ensureStoreInDepartments(category, store_erpid_hint) {
  // 直接撈 departments 看有沒有
  const { data: existing } = await supabase
    .from('departments')
    .select('store_erpid, store_name')
    .eq('store_name', category)
    .maybeSingle();
  if (existing) return existing;

  // 沒有 → 自動建一筆，erpid 用 store_erpid_hint，否則用「DOC-時間戳」
  const newErpid = store_erpid_hint || `DOC-${Date.now()}`;
  const { data, error } = await supabase
    .from('departments')
    .insert({ store_erpid: newErpid, store_name: category, is_active: true })
    .select()
    .single();
  if (error) {
    console.warn('[docLib] 自動建 departments fail:', error.message);
    return null;
  }
  return data;
}


module.exports = {
  listCategories, listDocs, uploadDoc, updateDoc, deleteDoc,
  ensureStoreInDepartments,
};
