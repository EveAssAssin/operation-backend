-- 合約綁門市＋實際／報稅＋續約串接＋付款條件（2026-10-20；規劃 pet-feature/PLAN_合約管理與門市基礎設定_20261020.md）
-- 營運定案：月報房租用「合約總額」（含扣繳），有兩份合約的門市用「實際」那份；廠商年度銷售合約＝現有 vendor 類型（benefits 階梯回饋）
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS store_erpid  TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS purpose      TEXT NOT NULL DEFAULT 'actual';   -- actual 實際／tax 報稅用
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS renewed_from UUID;                            -- 續約：上一份合約
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS payment      JSONB NOT NULL DEFAULT '{}'::jsonb; -- 付款條件（C3：方式、每月幾號、收款人／帳戶／比例、扣繳）
CREATE INDEX IF NOT EXISTS idx_contracts_store ON contracts(store_erpid);

-- 現有 10 份房租合約對門市（10-20 依合約名稱對；our_side_name 是自由文字不可靠）
UPDATE contracts SET store_erpid = '120085'  WHERE id = '500b463a-3d0d-4d8f-9804-807ada5ba54b' AND store_erpid IS NULL; -- 愛民後甲
UPDATE contracts SET store_erpid = '2469300', purpose = 'tax' WHERE id = '0469040b-ee17-462c-8987-49d39fbe62a2' AND store_erpid IS NULL; -- 中清（報稅使用）
UPDATE contracts SET store_erpid = '2469300', purpose = 'actual', status = 'active' WHERE id = 'e8171716-7a06-424e-9577-d8098611181b' AND store_erpid IS NULL; -- 中清（實際合約；原本被封存，月報要用它）
UPDATE contracts SET store_erpid = '2465300' WHERE id = '53064201-83dd-4c83-af52-2d828768beea' AND store_erpid IS NULL; -- 十甲
UPDATE contracts SET store_erpid = '120057', purpose = 'tax' WHERE id = 'be16faa0-8329-4745-ab7f-d3a7e1c6c046' AND store_erpid IS NULL; -- 文化（報稅使用；實際那份還沒建）
UPDATE contracts SET store_erpid = '120059'  WHERE id = '9c0e6d20-de70-41ca-940c-c542e6253996' AND store_erpid IS NULL; -- 文山
UPDATE contracts SET store_erpid = '120052'  WHERE id = '36f93769-9c59-4b1f-98fc-7c2aa65f49f2' AND store_erpid IS NULL; -- 新左營
UPDATE contracts SET store_erpid = '120046', renewed_from = 'cf71beee-a739-4aa5-974c-b47ceec1cd64' WHERE id = '435ec67e-4a68-42b9-aac3-08208a0a7f70' AND store_erpid IS NULL; -- 楠梓驗光所（隔壁間）
UPDATE contracts SET store_erpid = '120046'  WHERE id = 'cf71beee-a739-4aa5-974c-b47ceec1cd64' AND store_erpid IS NULL; -- 楠梓驗光所舊約（已封存）
UPDATE contracts SET store_erpid = '2466300' WHERE id = 'ba507f5b-f495-4d21-ae48-0af5deb29ba0' AND store_erpid IS NULL; -- 永和
