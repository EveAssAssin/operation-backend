// services/storageService.js
// Supabase Storage 照片上傳服務

const supabase = require('../config/supabase');
const crypto   = require('crypto');
const path     = require('path');

const BUCKET = 'operation-photos';

/**
 * 上傳照片到 Supabase Storage
 * @param {Buffer} fileBuffer - 檔案 Buffer
 * @param {string} originalName - 原始檔名（取副檔名用）
 * @param {string} folder - 存放子資料夾（如 order ID）
 * @returns {Promise<string>} 公開 URL
 */
async function uploadPhoto(fileBuffer, originalName, folder = 'general') {
  const ext      = path.extname(originalName).toLowerCase() || '.jpg';
  const fileName = `${folder}/${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(fileName, fileBuffer, {
      contentType:  getMimeType(ext),
      upsert:       false,
    });

  if (error) throw new Error(`照片上傳失敗：${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
}

/**
 * 刪除照片
 * @param {string} publicUrl - 照片公開 URL
 */
async function deletePhoto(publicUrl) {
  // 從 URL 取出路徑
  const urlObj  = new URL(publicUrl);
  const filePath = urlObj.pathname.split(`/storage/v1/object/public/${BUCKET}/`)[1];
  if (!filePath) return;

  await supabase.storage.from(BUCKET).remove([filePath]);
}

function getMimeType(ext) {
  const map = {
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
  };
  return map[ext] || 'image/jpeg';
}

module.exports = { uploadPhoto, deletePhoto };
