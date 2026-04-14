// services/leftHandApi.js
// 左手 API 整合服務（完整 5-Step 同步 + AES-128-CBC 加密）

const crypto = require('crypto');
const https  = require('https');
const http   = require('http');

const AES_KEY  = process.env.LEFTHAND_AES_KEY || 'GmAOoS003d5OJ2G2';
const AES_IV   = process.env.LEFTHAND_AES_IV  || 'bgfDcfWdWG6NSUr5';
const BASE_URL = process.env.LEFTHAND_API_URL  || 'https://map.lohasglasses.com/_api/v1.ashx';

// ── AES-128-CBC 加密 ──────────────────────────────────────────
function aesEncrypt(text) {
  const key    = Buffer.from(AES_KEY, 'utf8');
  const iv     = Buffer.from(AES_IV,  'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  let enc = cipher.update(text, 'utf8', 'base64');
  enc += cipher.final('base64');
  return enc;
}

// ── 安全解析 data 欄位（API 回傳 data 為 JSON 字串，需二次解析）──
function parseData(data) {
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch (e) { return []; }
  }
  return Array.isArray(data) ? data : [];
}

// ── HTTP POST 請求（支援 http / https）────────────────────────
function post(body) {
  return new Promise((resolve, reject) => {
    const url     = new URL(BASE_URL);
    const payload = JSON.stringify(body);
    const isHttps = url.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(raw));
        }
        catch (e) {
          const raw = Buffer.concat(chunks).toString('utf8');
          reject(new Error(`回應非 JSON：${raw.slice(0, 100)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('左手 API 請求超時')); });
    req.write(payload);
    req.end();
  });
}

// ── Step 1：取得全部門市清單 ──────────────────────────────────
async function getStoreDatas() {
  const res = await post({ method: 'getstoredatas' });
  return parseData(res.data);
  // 回傳格式：[{ erpid, name, id }, ...]
}

// ── Step 2：依門市取得員工列表 ────────────────────────────────
async function getEmployeesByGroup(storeErpid) {
  const res = await post({
    method:  'getemployeebygroup',
    groupid: aesEncrypt(storeErpid),
  });
  return parseData(res.data);
  // 回傳格式：[{ erpid, name, jobtitle, isleave, isfreeze }, ...]
}

// ── Step 3：取得全部員工推播用會員編號 ───────────────────────
async function getAllEmployees() {
  const res = await post({ method: 'getallemployees' });
  return parseData(res.data);
  // 回傳格式：[{ employeeerpid, employeeappnumber, employeename }, ...]
  // ⚠️ 注意：此 API 不含離職門市的人員
}

// ── 取得單一人員詳細資料（診斷用 / 補撈用）──────────────────
async function getEmployeeByErpId(erpid) {
  const res = await post({
    method: 'getemployeebyerps',
    id:     aesEncrypt(erpid),
  });
  return parseData(res.data);
}

// ── 有效員工過濾規則 ──────────────────────────────────────────
// ⚠️ 營運部系統包含所有部門（含行政：總經理室、企劃部等）
//    不以 app_number 為必要條件，行政部門員工無 app_number 仍應同步
function isValidEmployee(emp) {
  return (
    emp.erpid &&
    !emp.isleave &&
    !emp.isfreeze &&
    !emp.name?.includes('不指定') &&
    !emp.erpid?.startsWith('9999')
  );
}

/**
 * 完整 5-Step 同步：取得所有有效員工
 * Step 1：取得全部門市
 * Step 2：依門市取得員工列表
 * Step 3：取得全部推播用會員編號
 * Step 4：交叉比對建立完整資料
 * Step 5：補撈特殊部門人員（如加工部）
 *
 * @returns {{ departments: [], employees: [], errors: [] }}
 */
async function syncAllEmployees() {
  const errors = [];

  // Step 1
  const stores = await getStoreDatas();
  console.log(`[左手API] Step1 取得門市數：${stores.length}`);

  // Step 3（提前取得，避免多次請求）
  const allEmps = await getAllEmployees();
  const appNumberMap = {};
  allEmps.forEach(e => {
    if (e.employeeerpid && e.employeeappnumber) {
      appNumberMap[e.employeeerpid] = e.employeeappnumber;
    }
  });
  console.log(`[左手API] Step3 推播名單人數：${allEmps.length}`);

  const departmentsMap = {};  // store_erpid -> { store_erpid, store_name }
  const employees = [];

  // Step 2 + Step 4
  for (const store of stores) {
    departmentsMap[store.erpid] = { store_erpid: store.erpid, store_name: store.name };

    let storeEmps = [];
    try {
      storeEmps = await getEmployeesByGroup(store.erpid);
    } catch (err) {
      errors.push({ store_erpid: store.erpid, store_name: store.name, error: err.message });
      continue;
    }

    storeEmps
      .filter(emp => isValidEmployee(emp))
      .forEach(emp => {
        employees.push({
          store_erpid: store.erpid,
          store_name:  store.name,
          erpid:       emp.erpid,
          app_number:  appNumberMap[emp.erpid] || null,  // 無推播帳號者為 null，仍寫入
          name:        emp.name,
          jobtitle:    emp.jobtitle || null,
          is_active:   true,
        });
      });
  }

  // Step 5：補撈特殊部門人員（grouperpid 為空，不在 getstoredatas 中）
  const syncedErpIds = new Set(employees.map(e => e.erpid));
  let supplementCount = 0;

  for (const emp of allEmps) {
    if (syncedErpIds.has(emp.employeeerpid))   continue;
    if (emp.employeeerpid?.startsWith('9999')) continue;
    if (emp.employeename?.includes('不指定'))  continue;

    try {
      const details = await getEmployeeByErpId(emp.employeeerpid);
      const detail  = details[0];
      if (!detail || detail.isleave || detail.isfreeze) continue;

      const storeErpid = detail.grouperpid || '';
      const storeName  = detail.groupname  || '特殊部門';

      // 補充部門清單
      if (storeErpid && !departmentsMap[storeErpid]) {
        departmentsMap[storeErpid] = { store_erpid: storeErpid, store_name: storeName };
      }

      employees.push({
        store_erpid: storeErpid,
        store_name:  storeName,
        erpid:       detail.erpid,
        app_number:  emp.employeeappnumber || null,
        name:        detail.name,
        jobtitle:    detail.jobtitle || null,
        is_active:   true,
      });
      supplementCount++;
    } catch (err) {
      errors.push({ erpid: emp.employeeerpid, error: `Step5補撈失敗: ${err.message}` });
    }
  }

  console.log(`[左手API] 同步完成：員工 ${employees.length} 人（補撈 ${supplementCount} 人），錯誤 ${errors.length} 筆`);

  return {
    departments: Object.values(departmentsMap),
    employees,
    errors,
  };
}

module.exports = {
  syncAllEmployees,
  getEmployeeByErpId,
  aesEncrypt,
};
