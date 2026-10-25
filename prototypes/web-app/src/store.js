import { reactive, watch } from 'vue'
import sample from './demo/sample.js'

export const storageKey = 'bilite-web-prototype-v3'
export const makeId = (prefix = 'item') => `${prefix}-${crypto.randomUUID()}`
const member = (name, extra = {}) => ({
  id: makeId('member'),
  name,
  aliases: [],
  active: true,
  ...extra,
})
export function initialMapping(direction = 'ingest') {
  return {
    columns: [
      { role: 'company' },
      { role: 'period' },
      { role: 'metric' },
      { role: 'unit' },
      { role: 'value', window: '本年累计' },
      { role: 'value', window: '去年同期累计' },
      { role: 'ignore', reason: '增长率不作为基础值接入' },
      { role: 'value', window: '' },
      { role: 'ignore', reason: '增长率不作为基础值接入' },
    ],
    range: 'A2:I541',
    dynamic: true,
    ignored: [],
    exceptions: {},
    periodMode: 'column',
    periodValue: '2026-06',
    monthOffset: 1,
    formulaMode: 'preserve',
    direction,
  }
}
const seed = () => ({
  schema: 3,
  route: 'dashboard',
  editorId: 'monthly-draft',
  notice: '',
  dashboardFavorites: [],
  profile: {
    id: 'finance-rmb-v3',
    name: '经营与财务',
    frozen: true,
    createdAt: '2026-10-25',
    dimensions: [
      {
        id: 'company',
        name: '主体',
        members: sample.companies.map((name) => member(name, { referenced: true })),
      },
      {
        id: 'metric',
        name: '指标',
        members: sample.metrics.map((name) =>
          member(name, { unit: name.includes('率') ? '%' : '万元', formula: '', referenced: true }),
        ),
      },
      {
        id: 'period',
        name: '期数',
        members: [...new Set(sample.rows.map((row) => row[1]))].map((name) =>
          member(name, { referenced: true }),
        ),
      },
      {
        id: 'window',
        name: '口径',
        members: ['本年累计', '去年同期累计', '单月', '账面累计'].map((name) => member(name)),
      },
    ],
    semantics: [
      {
        id: 'rel-1',
        name: '主体控股关系示例',
        type: '关系',
        from: '集团公司（本部）',
        to: '子公司A',
        expression: '控股',
        referenced: false,
      },
      {
        id: 'calc-1',
        name: '金额单位换算示例',
        type: '换算',
        from: '万元',
        to: '元',
        expression: '× 10000',
        referenced: true,
      },
    ],
  },
  specs: [
    {
      id: 'monthly-ready',
      title: '月度经营快报',
      direction: 'ingest',
      status: 'published',
      description: '统一快报格式 · 主体 × 指标 × 期间',
      updatedAt: '2026-10-25',
      profileId: 'finance-rmb-v3',
      mapping: {
        ...initialMapping(),
        semanticIds: ['calc-1'],
        columns: initialMapping().columns.map((c, i) => (i === 7 ? { ...c, window: '单月' } : c)),
      },
      revision: 1,
      demo: true,
    },
    {
      id: 'monthly-draft',
      title: '经营快报 · 配置练习',
      direction: 'ingest',
      status: 'draft',
      description: '确认 H 列口径，体验配置与审阅',
      updatedAt: '2026-10-25',
      profileId: 'finance-rmb-v3',
      mapping: initialMapping(),
      revision: 1,
      demo: true,
    },
    {
      id: 'export-demo',
      title: '经营指标报送表',
      direction: 'export',
      status: 'published',
      description: '固定布局 · 演示模板，非用户指定报送样表',
      updatedAt: '2026-10-25',
      profileId: 'finance-rmb-v3',
      mapping: {
        ...initialMapping('export'),
        exportMetric: '营业总收入',
        exportWindow: '本年累计',
        companies: ['集团公司（合并）', '子公司A', '子公司B'],
        formulaMode: 'preserve',
      },
      revision: 1,
      demo: true,
    },
  ],
  records: [
    {
      id: 'demo-history-1',
      title: '月度经营快报',
      direction: 'ingest',
      period: '2026-05',
      status: 'success',
      time: '2026-10-24 15:32',
      details: '预置演示记录 · 不代表真实入库',
      count: 60,
      demo: true,
    },
  ],
})
let data = seed()
try {
  const saved = JSON.parse(localStorage.getItem(storageKey))
  if (saved?.schema === 3 && Array.isArray(saved.specs) && saved.profile?.dimensions?.length)
    data = { ...data, ...saved, notice: '' }
} catch {
  /* no storage is acceptable */
}
export const store = reactive(data)
watch(
  store,
  () => {
    try {
      const { notice, ...saved } = store
      localStorage.setItem(storageKey, JSON.stringify(saved))
    } catch {
      /* storage limit does not change engine state */
    }
  },
  { deep: true },
)
let timer
export function notify(message) {
  store.notice = message
  clearTimeout(timer)
  timer = setTimeout(() => {
    store.notice = ''
  }, 4000)
}
export function navigate(route, id) {
  store.route = route
  if (id) store.editorId = id
}
export function addRecord(record) {
  store.records.unshift({
    id: makeId('record'),
    time: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16),
    demo: true,
    ...record,
  })
}
export function formatDate(value) {
  return value || '—'
}
export function dimension(id) {
  return store.profile.dimensions.find((x) => x.id === id)
}
export function resolveMember(id, name) {
  return dimension(id)?.members.find(
    (x) => x.active && (x.name === name || x.aliases.includes(name)),
  )
}
export function addMember(id, name, aliasOf = '') {
  const dim = dimension(id),
    clean = name.trim()
  if (!dim || !clean) throw new Error('请输入成员名称。')
  if (dim.members.some((x) => x.name === clean || x.aliases.includes(clean)))
    throw new Error('名称或别称已存在，不能指向多个成员。')
  if (aliasOf) {
    const target = dim.members.find((x) => x.id === aliasOf && x.active)
    if (!target) throw new Error('请选择有效成员。')
    target.aliases.push(clean)
  } else dim.members.push(member(clean, id === 'metric' ? { unit: '元', formula: '' } : {}))
}
export function openEditor(id) {
  navigate('editor', id)
}
export function createSpec(title, direction = 'ingest') {
  const id = makeId('spec')
  store.specs.push({
    id,
    title: title.trim() || '未命名规格',
    direction,
    status: 'draft',
    description: '新建配置草稿',
    profileId: store.profile.id,
    updatedAt: '2026-10-25',
    revision: 1,
    mapping:
      direction === 'export'
        ? {
            ...initialMapping('export'),
            exportMetric: '',
            exportWindow: '',
            companies: [],
            formulaMode: 'preserve',
          }
        : initialMapping(),
  })
  openEditor(id)
  return id
}
export function resetDemo() {
  const next = seed()
  for (const key of Object.keys(store)) delete store[key]
  Object.assign(store, next)
  notify('已重置浏览器内的演示状态。')
}
