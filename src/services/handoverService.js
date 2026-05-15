// services/handoverService.js
// 門市交接表業務邏輯
// - 從模板建交接 (snapshot items)
// - 推進 stage（pending_original → pending_new → pending_third → completed）
// - 驗證 response 完整性

const supabase = require('../config/supabase');

const STAGES = {
  PENDING_ORIGINAL: 'pending_original',
  PENDING_NEW:      'pending_new',
  PENDING_THIRD:    'pending_third',
  COMPLETED:        'completed',
  CANCELLED:        'cancelled',
};

/**
 * 從模板建立一份新交接
 * @param {Object} args
 *   { templateId? (selectStrategy), customItems?, store_erpid, store_name, user }
 */
async function createHandoverFromTemplate({ templateId, customItems, store_erpid, store_name, user }) {
  let items = [];
  let template = null;

  if (templateId) {
    const { data, error } = await supabase
      .from('handover_templates')
      .select('*')
      .eq('id', templateId)
      .single();
    if (error) throw new Error('找不到模板：' + error.message);
    template = data;
    items = Array.isArray(template.items) ? template.items : [];
  }

  // 若帶了 customItems 則覆蓋（允許建立時微調）
  if (Array.isArray(customItems) && customItems.length > 0) {
    items = customItems;
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('交接表必須至少有一個品項（請選模板或自訂品項）');
  }

  // 確保每個 item 都有 id
  items = items.map(it => ({
    id: it.id || cryptoRandomId(),
    label: String(it.label || '').trim(),
    type: ['check', 'number', 'count_module'].includes(it.type) ? it.type : 'check',
    required: it.required !== false,
    allow_photo: it.allow_photo !== false,
  })).filter(it => it.label);

  const insertRow = {
    template_id: templateId || null,
    store_erpid: store_erpid || template?.store_erpid || '',
    store_name:  store_name  || template?.store_name  || '',
    items,
    stage: STAGES.PENDING_ORIGINAL,
    created_by_id:   user?.id || null,
    created_by_name: user?.name || '營運部',
  };

  const { data: created, error } = await supabase
    .from('handovers')
    .insert(insertRow)
    .select()
    .single();
  if (error) throw error;
  return created;
}

/**
 * 提交原交接方
 */
async function submitOriginal(handoverId, { member_id, name, responses, extra_note }) {
  const handover = await getHandover(handoverId);
  if (handover.stage !== STAGES.PENDING_ORIGINAL) {
    throw new Error(`此階段無法提交（目前 stage=${handover.stage}）`);
  }
  if (!member_id || !name) throw new Error('member_id / name 為必填');
  if (!Array.isArray(responses)) throw new Error('responses 必須為陣列');

  // 驗證 required item 都有回答
  validateResponses(handover.items, responses);

  const { data, error } = await supabase
    .from('handovers')
    .update({
      original_member_id:  String(member_id),
      original_name:       name,
      original_filled_at:  new Date().toISOString(),
      original_responses:  responses,
      original_extra_note: extra_note || null,
      stage:               STAGES.PENDING_NEW,
      updated_at:          new Date().toISOString(),
    })
    .eq('id', handoverId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * 提交新交接方
 */
async function submitNew(handoverId, { member_id, name, extra_note }) {
  const handover = await getHandover(handoverId);
  if (handover.stage !== STAGES.PENDING_NEW) {
    throw new Error(`此階段無法提交（目前 stage=${handover.stage}）`);
  }
  if (!member_id || !name) throw new Error('member_id / name 為必填');
  if (handover.original_member_id && String(member_id) === String(handover.original_member_id)) {
    throw new Error('新交接方不可為原交接方本人');
  }

  const { data, error } = await supabase
    .from('handovers')
    .update({
      new_member_id:  String(member_id),
      new_name:       name,
      new_filled_at:  new Date().toISOString(),
      new_extra_note: extra_note || null,
      stage:          STAGES.PENDING_THIRD,
      updated_at:     new Date().toISOString(),
    })
    .eq('id', handoverId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * 第三方確認
 */
async function submitThird(handoverId, { member_id, name, note }) {
  const handover = await getHandover(handoverId);
  if (handover.stage !== STAGES.PENDING_THIRD) {
    throw new Error(`此階段無法提交（目前 stage=${handover.stage}）`);
  }
  if (!member_id || !name) throw new Error('member_id / name 為必填');

  const { data, error } = await supabase
    .from('handovers')
    .update({
      third_member_id:    String(member_id),
      third_name:         name,
      third_confirmed_at: new Date().toISOString(),
      third_note:         note || null,
      stage:              STAGES.COMPLETED,
      updated_at:         new Date().toISOString(),
    })
    .eq('id', handoverId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function cancelHandover(handoverId, reason) {
  const { data, error } = await supabase
    .from('handovers')
    .update({
      stage: STAGES.CANCELLED,
      third_note: reason ? `(取消) ${reason}` : '(取消)',
      updated_at: new Date().toISOString(),
    })
    .eq('id', handoverId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getHandover(id) {
  const { data, error } = await supabase
    .from('handovers')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw new Error('找不到交接表：' + error.message);
  return data;
}

// ─── helpers ──────────────────────────────────────────────────
function cryptoRandomId() {
  // 簡易 UUID v4 (避免 require crypto.randomUUID 相容性問題)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function validateResponses(items, responses) {
  const respMap = new Map(responses.map(r => [r.item_id, r]));
  for (const it of items) {
    if (!it.required) continue;
    const r = respMap.get(it.id);
    if (!r) throw new Error(`必填品項「${it.label}」未填`);
    if (it.type === 'check' && r.checked !== true && r.checked !== false) {
      throw new Error(`必填品項「${it.label}」未勾選`);
    }
    if (it.type === 'number' && (r.value == null || r.value === '')) {
      throw new Error(`必填品項「${it.label}」未填數字`);
    }
  }
}

module.exports = {
  STAGES,
  createHandoverFromTemplate,
  submitOriginal,
  submitNew,
  submitThird,
  cancelHandover,
  getHandover,
};
