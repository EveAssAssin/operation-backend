// services/contractPdfService.js
// 用 Gemini API 從合約 PDF 抽結構化資訊（房租 / 廠商 / 員工）

const supabase     = require('../config/supabase');
// 預設用 2.0-flash 比 2.5-flash 穩定且量大；環境變數可以覆寫
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
// 503 fallback model（如果主 model 也 503，試這個）
const FALLBACK_MODELS = ['gemini-2.0-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];

/** 從 company_profile DB 撈 gemini_api_key；fallback 環境變數 */
async function getGeminiKey() {
  // 先試 DB
  try {
    const { data } = await supabase
      .from('company_profile')
      .select('gemini_api_key')
      .eq('id', 1)
      .maybeSingle();
    if (data?.gemini_api_key) return data.gemini_api_key;
  } catch (e) {
    console.warn('[contractPdf] read company_profile.gemini_api_key fail:', e.message);
  }
  // fallback env
  return process.env.GEMINI_API_KEY || null;
}

/** 房租合約 prompt */
const RENT_PROMPT = `你是合約解析助手。請從以下房租合約 PDF 抽出結構化資訊，回傳 **純 JSON**（不要 markdown、不要 \`\`\`），格式如下：

{
  "name": "合約名稱（看不到就用『XX店房租合約』格式）",
  "party_name": "房東姓名或公司",
  "our_side_name": "承租方門市名稱（如：北屯店）",
  "signed_date": "簽約日 YYYY-MM-DD（沒寫填 null）",
  "start_date": "合約起始日 YYYY-MM-DD",
  "end_date": "合約終止日 YYYY-MM-DD",
  "monthly_amount": 當下月租（依今天屬於哪一段）數字,
  "total_amount": 合約總額（月租×月數）數字,
  "type_data": {
    "rent_schedule": [
      { "from_date": "YYYY-MM-DD", "monthly_amount": 數字 }
    ],
    "deposit": 押金 數字 或 null,
    "notice_days": 解約預告天數 或 null,
    "landlord_account": "房東匯款帳號 或 null",
    "landlord_bank": "房東銀行（如：816 元大 0083 分行）"
  },
  "note": "其他重點補充（押金歸還條款、修繕約定等）"
}

規則：
- 民國年要換成西元年（民國 110 = 西元 2021）
- 如果租金分段（例：109.08.15~114.08.14 31500元；114.08.15~119.08.14 40000元），全部填入 rent_schedule
- 如果是單一固定月租，rent_schedule 也要填一筆（from_date=合約起始日）
- 金額去掉逗號跟「元」字
- 看不到的欄位填 null（除了 name 必填）
- 直接回 JSON，不要任何說明文字`;

/** 廠商合約 prompt */
const VENDOR_PROMPT = `你是合約解析助手。從廠商貨款合約 PDF 抽結構化資訊，回傳 **純 JSON**：
{
  "name": "合約名稱",
  "party_name": "廠商名稱",
  "our_side_name": "我方公司或部門",
  "signed_date": "YYYY-MM-DD",
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD",
  "total_amount": 合約總額,
  "type_data": {
    "benefits": [
      // 把所有「優惠/獎勵/折讓/獎金」條款都抽出來，每筆一個 object：
      // type:        '階梯回饋' / '回饋' / '現金折讓' / '獎金' / '折扣' / '抵用' / '其他'
      // condition:   條件描述（例：'0~50萬' / '提早 7 天付現' / '年銷售達 500 萬'）
      // value_type:  'percent' 或 'amount'
      // value:       數值（5% 填 5，金額直接填數字）
      // note:        備註（選填）
      { "type": "階梯回饋", "condition": "0~50萬", "value_type": "percent", "value": 3 },
      { "type": "階梯回饋", "condition": "50萬~200萬", "value_type": "percent", "value": 5 },
      { "type": "現金折讓", "condition": "提早 7 天付現", "value_type": "percent", "value": 2 }
    ],
    "payment_terms":   "付款條件文字（月結 60 天 等）",
    "cost_target":     成本比對目標 數字,
    "warranty_months": 保固月數,
    "billing_cycle":   "結帳週期（每月 / 每季）"
  },
  "note": "其他要點（無法歸類為 benefits 的條款放這）"
}
民國年換西元，看不到填 null。benefits 沒寫的話填空陣列 []。直接回 JSON。`;

/** 員工合約 prompt */
const EMPLOYEE_PROMPT = `你是合約解析助手。從員工雇用合約 PDF 抽結構化資訊，回傳 **純 JSON**：
{
  "name": "合約名稱（如：王小明 雇用合約）",
  "party_name": "雇主公司",
  "our_side_name": "員工姓名",
  "signed_date": "YYYY-MM-DD",
  "start_date": "雇用起始日 YYYY-MM-DD",
  "end_date": "終止日 YYYY-MM-DD 或 null（無限期）",
  "monthly_amount": 現行月薪,
  "total_amount": 年薪 或 null,
  "type_data": {
    "position":          "職位",
    "probation_end":     "試用期結束 YYYY-MM-DD 或 null",
    "probation_salary":  試用期月薪 數字,
    "formal_salary":     轉正後月薪 數字,
    "salary_base":       現行底薪 數字,
    "insurance_grade":   勞保投保級距金額 數字（例：36300、38200）,
    "adjustment_type":   "annual" / "performance" / "both" / "none",
    "adjustment_month":  年度調薪月份（1-12 數字）或 null,
    "resignation_notice_days": 離職預告天數,
    "id_last4": "身分證末四碼"
  },
  "note": "其他要點（保密條款、競業條款等）"
}
民國年換西元，看不到填 null，直接回 JSON。`;

const PROMPTS = {
  rent:     RENT_PROMPT,
  vendor:   VENDOR_PROMPT,
  employee: EMPLOYEE_PROMPT,
};


/**
 * 用 Gemini 解析 PDF 合約，回傳 { type, parsed }
 * @param {Buffer} pdfBuffer
 * @param {string} type   'rent' | 'vendor' | 'employee'
 */
async function parseContractPdf(pdfBuffer, type = 'rent') {
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new Error('還沒設定 Gemini API Key，請到「應付帳款 → ⚙ 公司資料」最下方填入');

  const prompt = PROMPTS[type] || RENT_PROMPT;
  const body = {
    contents: [{
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data:     pdfBuffer.toString('base64'),
          },
        },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature:     0.1,
      responseMimeType: 'application/json',
    },
  };

  // 依序試 GEMINI_MODEL → fallback models，遇 503/429 才換下一個
  const candidates = [GEMINI_MODEL, ...FALLBACK_MODELS.filter(m => m !== GEMINI_MODEL)];
  let res, json, lastErr = '';
  for (const model of candidates) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (res.ok) break;
    const t = await res.text().catch(() => '');
    lastErr = `Gemini API ${res.status} (${model}): ${t.slice(0, 200)}`;
    // 503 / 429 才繼續試下一個；其他錯（401, 400）直接停
    if (![503, 429].includes(res.status)) {
      throw new Error(lastErr);
    }
    console.warn('[gemini] retry next model due to', res.status, model);
  }
  if (!res.ok) throw new Error(lastErr || `Gemini API 全部 model 都失敗`);
  json = await res.json();
  const txt  = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!txt) throw new Error('Gemini 回傳沒有解析結果');

  // 嘗試 parse JSON
  let parsed;
  try {
    parsed = JSON.parse(txt);
  } catch (e) {
    // 有時 Gemini 還是會包 ```json ... ```
    const cleaned = String(txt).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { parsed = JSON.parse(cleaned); }
    catch (e2) { throw new Error('Gemini 回傳的 JSON 無法解析：' + txt.slice(0, 200)); }
  }

  parsed.type = type;
  return parsed;
}


module.exports = { parseContractPdf };
