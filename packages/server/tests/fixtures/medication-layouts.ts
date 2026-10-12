// Synthetic layout cases: no patient, hospital, or source-report information.
export const medicationLayouts = [
  { name: 'spaced numbered prescription', type: 'prescription', pages: [[
    '处 方 笺', '1. 阿莫西林胶囊 0.25g × 24粒', '用法：口服 每次0.5g 每日3次',
  ]] },
  { name: 'untitled medication table', type: 'prescription', pages: [[
    '药品名称 | 规格 | 数量', '阿莫西林胶囊 | 0.25g | 24粒',
  ]] },
  { name: 'untitled split instructions', type: 'prescription', pages: [[
    '阿莫西林胶囊 0.25g', '用法：口服 每次0.5g 每日3次',
  ]] },
  { name: 'outpatient embedded table', type: 'outpatient', pages: [[
    '门诊病历', '主诉：复诊', '药品名称 | 规格 | 用法用量 | 数量',
    '阿莫西林胶囊 | 0.25g | 口服 每日3次 | 24粒',
  ]] },
  { name: 'discharge medication table', type: 'inpatient', pages: [[
    '出院小结', '出院用药', '药品名称 | 规格 | 用法用量 | 数量',
    '阿莫西林胶囊 | 0.25g | 口服 每日3次 | 24粒',
  ]] },
  { name: 'temporary orders', type: 'prescription', pages: [[
    '临时医嘱', '阿莫西林胶囊 0.25g', '用法：口服 即刻',
  ]] },
  { name: 'parallel columns', type: 'prescription', pages: [[
    '用药清单', '药品名称 | 用法用量 | 药品名称 | 用法用量',
    '阿莫西林胶囊 | 口服 每日3次 | 维生素C片 | 口服 每日1次',
  ]] },
  { name: 'continuation without repeated heading', type: 'prescription', pages: [
    ['用药清单', '1. 阿莫西林胶囊 0.25g', '用法：口服 每日3次'],
    ['2. 维生素C片 0.1g × 20片'],
  ] },
  { name: 'discharge instructions on the next page', type: 'inpatient', pages: [
    ['出院小结', '出院用药', '1. 阿莫西林胶囊 0.25g'],
    ['用法：口服 每次0.5g 每日3次'],
  ] },
  { name: 'checkup with explicit medication section', type: 'checkup', pages: [[
    '健康体检报告', '当前用药', '阿莫西林胶囊 0.25g', '用法：口服 每日3次',
  ]] },
] as const;

export const nonMedicationLayouts = [
  ['医疗收费票据', '药品名称 | 规格 | 数量', '阿莫西林胶囊 | 0.25g | 24粒', '总金额：12.00'],
  ['药品说明书', '阿莫西林胶囊', '用法用量：口服', '不良反应', '禁忌'],
  ['门诊病历', '过敏史：阿莫西林胶囊过敏'],
  ['检验报告', '血糖 | 5.0 | mmol/L'],
  ['健康体检报告', '建议必要时咨询医生用药'],
] as const;
