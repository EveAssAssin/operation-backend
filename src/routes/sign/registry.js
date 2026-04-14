// routes/sign/registry.js
// ═══════════════════════════════════════════════════════════════
// 簽收 Handler 註冊中心
//
// 每個需要 QR Code 簽收的系統只要實作一個 handler 物件：
//   {
//     type:           'maintenance',           // 唯一識別名
//     label:          '例行養護',              // 中文顯示名
//     validateStatus: async (referenceId) => {},  // 檢查單據是否可簽收
//     getContent:     async (referenceId) => {},  // 取得簽收頁面要顯示的資料
//     confirmSign:    async (referenceId, employee, meta) => {},  // 執行簽收
//     getStoreErpid:  async (referenceId) => '',  // 取得單據所屬門市 erpid（門市比對用）
//   }
//
// 然後在此檔案 register 即可。universal API 不用改。
// ═══════════════════════════════════════════════════════════════

const handlers = {};

function register(handler) {
  if (!handler.type) throw new Error('Sign handler must have a "type"');
  if (handlers[handler.type]) {
    console.warn(`[SignRegistry] handler "${handler.type}" 已存在，將被覆寫`);
  }
  handlers[handler.type] = handler;
  console.log(`[SignRegistry] ✅ 已註冊簽收模組：${handler.type}（${handler.label || handler.type}）`);
}

function getHandler(type) {
  return handlers[type] || null;
}

function getAllTypes() {
  return Object.keys(handlers);
}

module.exports = { register, getHandler, getAllTypes };
