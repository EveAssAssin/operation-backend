// config/constants.js
// 營運部系統角色與權限定義

const ROLES = {
  operation_staff:  1,   // 營運部員工
  operation_lead:   2,   // 營運部組長 / 區域主管
  dept_head:        3,   // 部門主管
  super_admin:      4,   // 超級管理員
};

const MODULE_PERMISSIONS = {
  'personnel.view':    ROLES.operation_staff,
  'personnel.edit':    ROLES.operation_staff,  // 部員可編輯（LINE UID 等）
  'personnel.sync':    ROLES.operation_staff,  // 部員可手動觸發同步
  // 開帳系統（v1）
  'billing.view':      ROLES.operation_staff,
  'billing.sync':      ROLES.operation_staff,
  // 開帳系統 v2
  'billing.create':    ROLES.operation_staff,  // 建立帳單
  'billing.confirm':   ROLES.operation_staff,  // 確認 / 分配 / 作廢
  'billing.manage':    ROLES.operation_staff,  // 管理來源單位 / 會計科目
  // 系統用戶管理
  'system_user.view':  ROLES.operation_staff,  // 查看（部員以上）
  'system_user.edit':  ROLES.operation_lead,   // 授權/撤銷 → 主管以上才能修改權限設定
};

// 同步類型
const SYNC_TYPE = {
  MANUAL:    'manual',
  SCHEDULED: 'scheduled',
};

// 同步狀態
const SYNC_STATUS = {
  IN_PROGRESS: 'in_progress',
  SUCCESS:     'success',
  FAILED:      'failed',
};

module.exports = { ROLES, MODULE_PERMISSIONS, SYNC_TYPE, SYNC_STATUS };
