// jobs/hubPoller.js
// 每 5 分鐘自動掃 Hub 收件匣，處理其他系統 AI 的訊息
// 讓 AI 之間的溝通完全在 server 端自動進行，不再需要用戶介入

const cron     = require('node-cron');
const { getInbox, sendMessage, updateStatus } = require('../services/hubClient');
const supabase = require('../config/supabase');

const POLL_SCHEDULE = process.env.HUB_POLL_CRON || '*/5 * * * *'; // 每 5 分鐘

/**
 * 處理單則訊息
 * - request：自動回覆「已收到，處理中」，並 log 以便後續手動跟進
 * - sync / notify：標為 read，記錄到 console
 * - response：標為 done
 */
async function handleMessage(msg) {
  const { id, from_system, category, subject, body, priority } = msg;

  console.log(`[Hub] 收到訊息 [${category}][${priority}] from=${from_system} subject="${subject}"`);

  try {
    // ── 人力需求通知（市場部 → 營運部）────────────────────────
    if (category === 'request' && subject && subject.includes('人力需求')) {
      await handleRecruitmentNeed(msg);
      return;
    }

    // ── 新人到職通知（教育訓練 → 營運部）────────────────────
    if ((category === 'notify' || category === 'response') && subject && subject.includes('新人到職')) {
      await handleNewHireArrival(msg);
      return;
    }

    if (category === 'request') {
      // 自動回覆「已收到」，讓對方知道我們有看到
      await sendMessage(from_system, 'response', `RE: ${subject}`, '已收到此需求，正在處理中。', {
        ref_message_id: id,
      });
      await updateStatus(id, 'in_progress');
      console.log(`[Hub] request 已自動回覆並標為 in_progress：${subject}`);

    } else if (category === 'response') {
      await updateStatus(id, 'done');
      console.log(`[Hub] response 已標為 done：${subject}`);

    } else {
      // notify / sync → 標為 read，留給後續處理
      await updateStatus(id, 'read');
      console.log(`[Hub] ${category} 已標為 read：${subject}`);
    }
  } catch (err) {
    console.error(`[Hub] 處理訊息失敗 (id=${id})：`, err.message);
  }
}

/**
 * 執行一次收件匣掃描
 */
async function pollInbox() {
  try {
    const result = await getInbox('unread');
    if (!result.success) {
      console.warn('[Hub] 收件匣查詢失敗');
      return;
    }

    if (result.count === 0) return; // 無新訊息，靜默略過

    console.log(`[Hub] 發現 ${result.count} 則未讀訊息，開始處理...`);

    for (const msg of result.data) {
      await handleMessage(msg);
    }
  } catch (err) {
    console.error('[Hub] pollInbox 錯誤：', err.message);
  }
}

/**
 * 啟動排程
 */
function startHubPoller() {
  console.log(`[Hub] 收件匣自動掃描已啟動（${POLL_SCHEDULE}）`);

  cron.schedule(POLL_SCHEDULE, pollInbox, {
    timezone: 'Asia/Taipei',
  });

  // 啟動時立即掃一次（讓已積壓的訊息馬上被處理）
  pollInbox();
}

/**
 * 處理人力需求通知
 * 市場部發送格式：body 為 JSON 字串
 * { store_erpid, store_name, total_needed, urgent_needed, note? }
 */
async function handleRecruitmentNeed(msg) {
  const { id, from_system, body } = msg;
  try {
    let payload;
    try { payload = typeof body === 'string' ? JSON.parse(body) : body; }
    catch { console.warn('[Hub] 人力需求 body 非 JSON，跳過：', body); await updateStatus(id, 'read'); return; }

    const { store_erpid, store_name, total_needed, urgent_needed } = payload || {};
    if (!store_erpid || !store_name || !total_needed) {
      console.warn('[Hub] 人力需求缺少必要欄位，跳過');
      await updateStatus(id, 'read');
      return;
    }

    // 防重複：同一則 hub message 只建一筆
    const { data: existing } = await supabase
      .from('recruitment_needs')
      .select('id')
      .eq('hub_message_id', id)
      .maybeSingle();

    if (!existing) {
      await supabase.from('recruitment_needs').insert({
        store_erpid, store_name,
        total_needed:  Number(total_needed)  || 1,
        urgent_needed: Number(urgent_needed) || 0,
        note:          payload.note          || null,
        source:        'hub',
        hub_message_id: id,
      });
      console.log(`[Hub] 人力需求已建立：${store_name} 缺 ${total_needed} 人`);
    }

    await sendMessage(from_system, 'response', `RE: 人力需求通知 - ${store_name}`,
      `已收到 ${store_name} 缺 ${total_needed} 人（急缺 ${urgent_needed || 0} 人）的需求，已建立招募任務。`,
      { ref_message_id: id }
    );
    await updateStatus(id, 'done');
  } catch (err) {
    console.error('[Hub] 處理人力需求失敗：', err.message);
    await updateStatus(id, 'read').catch(() => {});
  }
}

/**
 * 處理新人到職通知（教育訓練系統）
 * body 格式：{ store_erpid, store_name }
 * 找到該門市最新的 open need，filled +1
 */
async function handleNewHireArrival(msg) {
  const { id, body } = msg;
  try {
    let payload;
    try { payload = typeof body === 'string' ? JSON.parse(body) : body; }
    catch { await updateStatus(id, 'read'); return; }

    const { store_erpid } = payload || {};
    if (!store_erpid) { await updateStatus(id, 'read'); return; }

    const { data: need } = await supabase
      .from('recruitment_needs')
      .select('id, filled, total_needed')
      .eq('store_erpid', store_erpid)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (need) {
      const newFilled = need.filled + 1;
      const newStatus = newFilled >= need.total_needed ? 'fulfilled' : 'open';
      await supabase.from('recruitment_needs').update({
        filled: newFilled, status: newStatus, updated_at: new Date().toISOString(),
      }).eq('id', need.id);
      console.log(`[Hub] 新人到職：${store_erpid} filled=${newFilled}, status=${newStatus}`);
    }

    await updateStatus(id, 'done');
  } catch (err) {
    console.error('[Hub] 處理新人到職通知失敗：', err.message);
    await updateStatus(id, 'read').catch(() => {});
  }
}

module.exports = { startHubPoller, pollInbox };
