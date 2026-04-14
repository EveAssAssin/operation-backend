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
  'personnel.edit':    ROLES.dept_head,
  'personnel.sync':    ROLES.dept_head,
  'system_user.view':  ROLES.dept_head,
  'system_user.edit':  ROLES.super_admin,
  // 開帳系統
  'billing.view':      ROLES.operation_lead,
  'billing.sync':      ROLES.operation_lead,
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
