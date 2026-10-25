import assert from 'node:assert/strict'
import sample from '../src/demo/sample.js'
import { querySample, supportedDimensions, changeDescription } from '../src/lib/dashboard-query.js'

const lists = {
  company: sample.companies,
  metric: sample.metrics,
  period: [...new Set(sample.rows.map((r) => r[1]))],
  window: ['本年累计', '去年同期累计', '单月'],
}
const profile = {
  dimensions: supportedDimensions.map((id) => ({
    id,
    members: lists[id].map((name) => ({ name, aliases: [], active: true })),
  })),
}
const filters = {
  company: sample.companies[0],
  metric: sample.metrics[0],
  period: '2026-06',
  window: '本年累计',
}
const one = querySample(sample, profile, filters).rows
assert.equal(one.length, 1)
assert.equal(supportedDimensions.length, 4, '默认本体只有四个维度')
assert.equal(one[0].currency, '人民币', '人民币作为金额约定，不增加本体坐标维度')
assert.equal(
  one[0].value,
  sample.rows.find(
    (r) => r[0] === filters.company && r[1] === filters.period && r[2] === filters.metric,
  )[4],
)
assert.equal(
  querySample(sample, profile, { ...filters, company: 'all' }).rows.length,
  sample.companies.length,
  '主体分别返回，不额外产生合计',
)
assert.equal(
  querySample(sample, profile, { ...filters, period: '2025-01', window: '去年同期累计' }).rows[0]
    .value,
  null,
  '缺失值保留为空',
)
assert.equal(
  querySample(sample, profile, { ...filters, currency: '美元' }).rows.length,
  0,
  '不能将未换算的外币当作人民币查询',
)
assert.match(changeDescription(25, 20, '%'), /5\.00 个百分点/)
const duplicateSample = {
  ...sample,
  rows: [
    ...sample.rows,
    sample.rows.find(
      (r) => r[0] === filters.company && r[1] === filters.period && r[2] === filters.metric,
    ),
  ],
}
const duplicate = querySample(duplicateSample, profile, filters).rows[0]
assert.equal(duplicate.duplicate, true)
assert.equal(duplicate.value, null, '重复坐标不能任取或自动相加')
console.log('看板代表性查询检查通过：坐标筛选、主体分列、缺数、币种边界及重复拦截。')
