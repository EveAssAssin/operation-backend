// services/contractPdfService.js
// 用 Gemini API 從合約 PDF 抽結構化資訊（房租 / 廠商 / 員工）

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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
    "reward_rate": 回饋率小數（5% = 0.05）,
    "cost_target": 成本比對目標,
    "payment_terms": "付款條件文字（月結 60 天 等）",
    "warranty_months": 保固月數
  },
  "note": "其他要點"
}
民國年換西元，看不到填 null，直接回 JSON。`;

/** 員工合約 prompt */
const EMPLOYEE_PROMPT = `你是合約解析助手。從員工雇用合約 PDF 抽結構化資訊，回傳 **純 JSON**：
{
  "name": "合約名稱",
  "party_name": "雇主公司",
  "our_side_name": "員工姓名",
  "signed_date": "YYYY-MM-DD",
  "start_date": "雇用起始日 YYYY-MM-DD",
  "end_date": "終止日 YYYY-MM-DD 或 null（無限期）",
  "monthly_amount": 月薪,
  "total_amount": 年薪 或 null,
  "type_data": {
    "position": "職位",
    "probation_end": "試用期結束 YYYY-MM-DD 或 null",
    "salary_base": 底薪,
    "resignation_notice_days": 離職預告天數
  },
  "note": "其他要點"
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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('伺服器未設 GEMINI_API_KEY 環境變數');

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

  const res = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
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
