// services/linePushService.js
// LINE 推播服務 — 透過供單系統 LINEBOT API（ticket.ruki-ai.com）
//
// API 端點：POST https://ticket.ruki-ai.com/api/external/notify
// Header：x-api-key: lohas-notify-2026-secret
// 使用 app_number（APP 會員編號）而非 line_uid
//
// 單筆：{ app_number, message }
// 批次：{ app_numbers, message }

const https = require('https');
const http  = require('http');

const NOTIFY_URL = process.env.LINEBOT_PUSH_URL || 'https://ticket.ruki-ai.com/api/external/notify';
const API_KEY    = process.env.LINEBOT_API_KEY   || 'lohas-notify-2026-secret';

// ── HTTP POST 工具 ───────────────────────────────────────────
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj  = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const payload = JSON.stringify(body);

    const req = lib.request({
      hostname: urlObj.hostname,
      port:     urlObj.port || (isHttps ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length':  Buffer.byteLength(payload),
        'x-api-key':      API_KEY,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── 基本推播 ─────────────────────────────────────────────────

/**
 * 推播訊息給單一使用者（by app_number）
 * @param {string} appNumber - 員工 APP 會員編號
 * @param {string} message   - 文字訊息
 */
async function pushToUser(appNumber, message) {
  if (!appNumber) {
    console.log('[LinePush] 跳過推播：app_number 為空');
    return null;
  }

  try {
    const result = await httpPost(NOTIFY_URL, {
      app_number: appNumber,
      message,
    });
    console.log(`[LinePush] 單筆推播 → ${appNumber}:`, result);
    return result;
  } catch (err) {
    console.error(`[LinePush] 推播失敗 → ${appNumber}:`, err.message);
    return null;
  }
}

/**
 * 批次推播訊息給多人（by app_numbers）
 * @param {string[]} appNumbers - APP 會員編號陣列
 * @param {string} message      - 文字訊息
 */
async function pushToUsers(appNumbers, message) {
  const validNumbers = (appNumbers || []).filter(Boolean);
  if (validNumbers.length === 0) return null;

  try {
    const result = await httpPost(NOTIFY_URL, {
      app_numbers: validNumbers,
      message,
    });
    console.log(`[LinePush] 批次推播 → ${validNumbers.length} 人:`, result);
    return result;
  } catch (err) {
    console.error(`[LinePush] 批次推播失敗:`, err.message);
    return null;
  }
}

// ── 任務系統專用推播 ─────────────────────────────────────────

/**
 * 任務相關推播
 * @param {'quest_published'|'quest_approved'|'quest_rejected'} type
 * @param {object} data
 */
async function pushQuestNotify(type, data) {
  switch (type) {
    // ── 新任務發布 → 批次推播給指派對象 ──
    case 'quest_published': {
      const { questTitle, urgency, appNumbers } = data;
      const urgencyText = urgency === 'emergency' ? '🚨【緊急任務】' : urgency === 'urgent' ? '🔥【限時】' : '';
      const extraNote = urgency === 'emergency' ? '\n⚠️ 此為強制任務，已自動接取。未交付將暫停任務承接 15 天。' : '\n請前往任務看板查看並接取。';
      const message = `📜 新任務發布\n${urgencyText}${questTitle}${extraNote}`;
      return pushToUsers(appNumbers, message);
    }

    // ── 審核通過 → 單筆推播給提交者 ──
    case 'quest_approved': {
      const { questTitle, xp, reward, appNumber } = data;
      let message = `✅ 任務通過審核\n「${questTitle}」`;
      if (xp > 0) message += `\n+${xp} XP`;
      if (reward) message += `\n🎁 獎勵：${reward}`;
      return pushToUser(appNumber, message);
    }

    // ── 審核退回 → 單筆推播給提交者 ──
    case 'quest_rejected': {
      const { questTitle, reason, appNumber } = data;
      const message = `❌ 任務未通過審核\n「${questTitle}」\n原因：${reason || '未說明'}`;
      return pushToUser(appNumber, message);
    }

    // ── 即將截止 → 單筆推播給接取者 ──
    case 'quest_deadline': {
      const { questTitle, timeRemaining, urgency, appNumber } = data;
      const urgencyText = urgency === 'urgent' ? '🔥【限時】' : '';
      const message = `⏰ 任務即將截止提醒\n${urgencyText}「${questTitle}」\n剩餘時間：${timeRemaining}\n\n請盡快完成並提交！`;
      return pushToUser(appNumber, message);
    }

    default:
      console.warn(`[LinePush] 未知推播類型：${type}`);
      return null;
  }
}

module.exports = { pushToUser, pushToUsers, pushQuestNotify };
