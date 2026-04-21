// services/smsService.js
// 壹元簡訊（EasyGo）SMS 發送服務
// API 文件：httpapiservice.asmx / CallSendSMS

const axios = require('axios');
const qs    = require('querystring');

const EASYSMS_URL      = 'https://www.easysms.com.tw/easygohhttpapi/httpapiservice.asmx/CallSendSMS';
const EASYSMS_USERNAME = process.env.EASYSMS_USERNAME || '';
const EASYSMS_PASSWORD = process.env.EASYSMS_PASSWORD || '';

/**
 * 發送 SMS
 * @param {string} cellno  手機號碼（格式：0912345678）
 * @param {string} msgBody 簡訊內容（含中文請確認字數限制，一般 70 字）
 * @returns {{ success: boolean, batchNo: string, errorMsg: string }}
 */
async function sendSms(cellno, msgBody) {
  if (!EASYSMS_USERNAME || !EASYSMS_PASSWORD) {
    throw new Error('尚未設定 EASYSMS_USERNAME / EASYSMS_PASSWORD');
  }

  // 標準化手機號碼
  const phone = cellno.replace(/\D/g, '');
  if (!/^09\d{8}$/.test(phone)) {
    throw new Error(`手機號碼格式錯誤：${cellno}`);
  }

  const payload = qs.stringify({
    UserName: EASYSMS_USERNAME,
    PassWord: EASYSMS_PASSWORD,
    Cellno:   phone,
    MsgBody:  msgBody,
    Mode:     'Immediate',
  });

  const { data: xml } = await axios.post(EASYSMS_URL, payload, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });

  // 解析 XML 回應（不引入 xml2js，用正規式擷取）
  const getTag = (tag) => {
    const m = xml.match(new RegExp(`<${tag}>(.*?)<\\/${tag}>`, 's'));
    return m ? m[1].trim() : '';
  };

  const success  = getTag('Success').toLowerCase() === 'true';
  const batchNo  = getTag('StringOutput');
  const errorMsg = getTag('ErrorMsg');

  if (!success) {
    throw new Error(`EasyGo 簡訊發送失敗：${errorMsg || '未知錯誤'}`);
  }

  console.log(`[SMS] 發送成功 → ${phone}，批號 ${batchNo}`);
  return { success, batchNo, errorMsg };
}

module.exports = { sendSms };
