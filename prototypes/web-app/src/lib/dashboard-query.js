// Explicit sample bindings only. Production queries must use the local semantic engine.
export const sampleWindows = [
  { name: '本年累计', column: 4, letter: 'E', header: '本年累计' },
  { name: '去年同期累计', column: 5, letter: 'F', header: '去年同期累计' },
  { name: '单月', column: 7, letter: 'H', header: '本月累计' },
]
export const supportedDimensions = ['company', 'metric', 'period', 'window']

export function querySample(sample, profile, filters) {
  if (
    profile.dimensions.some((d) => !supportedDimensions.includes(d.id)) ||
    supportedDimensions.some((id) => !profile.dimensions.some((d) => d.id === id))
  )
    return { rows: [], error: '当前自定义 profile 尚未接入演示查询，请使用预设 profile 体验。' }
  const binding = sampleWindows.find((w) => w.name === filters.window)
  if (!binding) return { rows: [], error: '演示数据没有该口径的值来源。' }
  // Amounts in this default profile are RMB; a foreign currency must be converted at import.
  if (filters.currency && filters.currency !== '人民币')
    return { rows: [], error: '外币需先在导入时明确换算为人民币。' }
  const resolve = (kind, text) =>
    profile.dimensions
      .find((d) => d.id === kind)
      ?.members.find((m) => m.active && (m.name === text || m.aliases.includes(text)))?.name
  if (!resolve('window', filters.window)) return { rows: [], error: '' }
  const rows = new Map()
  sample.rows.forEach((cells, index) => {
    const company = resolve('company', cells[0]),
      metric = resolve('metric', cells[2])
    if (!company || !metric || !resolve('period', cells[1])) return
    if (filters.company !== 'all' && company !== filters.company) return
    if (filters.metric && metric !== filters.metric) return
    if (filters.period && cells[1] !== filters.period) return
    const aliases =
      profile.dimensions.find((d) => d.id === 'company')?.members.find((m) => m.name === company)
        ?.aliases || []
    const keyword = (filters.keyword || '').trim().toLowerCase()
    if (
      keyword &&
      ![company, metric, ...aliases].some((text) => text.toLowerCase().includes(keyword))
    )
      return
    const raw = cells[binding.column]
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    const record = {
      company,
      metric,
      period: cells[1],
      window: binding.name,
      currency: '人民币',
      unit: cells[3],
      value,
      source: `${binding.letter}${index + 2}`,
      sourceHeader: binding.header,
      duplicate: false,
    }
    const key = [company, metric, record.period, binding.name].join('\u0000')
    const existing = rows.get(key)
    if (existing) {
      existing.value = null
      existing.duplicate = true
      existing.source += `、${record.source}`
    } else rows.set(key, record)
  })
  return { rows: [...rows.values()], error: '' }
}

export function formatValue(value) {
  return value === null || value === undefined
    ? '—'
    : new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
        value,
      )
}

export function previousMonth(period) {
  const [year, month] = period.split('-').map(Number)
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7)
}

export function changeDescription(current, previous, unit) {
  if (current === null || current === undefined || previous === null || previous === undefined)
    return '上期缺数，暂不比较'
  const difference = current - previous
  const sign = difference > 0 ? '+' : ''
  if (unit === '%') return `较上期 ${sign}${difference.toFixed(2)} 个百分点`
  if (previous === 0) return '上期为零，暂不计算变化率'
  return `较上期 ${sign}${((difference / Math.abs(previous)) * 100).toFixed(2)}%`
}
