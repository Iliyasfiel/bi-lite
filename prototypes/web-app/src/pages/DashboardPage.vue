<script setup>
import { computed, ref, watch } from 'vue'
import {
  Search,
  Download,
  BookmarkPlus,
  TrendingUp,
  ArrowUpRight,
  BarChart3,
  Table2,
  CalendarDays,
  SlidersHorizontal,
  X,
  FileSpreadsheet,
  Info,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { store, notify, makeId } from '../store'
import sample from '../demo/sample.js'
import {
  querySample,
  sampleWindows,
  formatValue,
  previousMonth,
  changeDescription,
} from '../lib/dashboard-query'

const available = (id) =>
  store.profile.dimensions
    .find((d) => d.id === id)
    ?.members.filter((m) => m.active)
    .map((m) => m.name) || []
const companies = computed(() => available('company')),
  metrics = computed(() => available('metric'))
const periods = [...new Set(sample.rows.map((row) => row[1]))].sort()
const windows = computed(() => sampleWindows.filter((w) => available('window').includes(w.name)))
const filter = ref({
  company: companies.value[0] || '',
  period: periods.at(-1),
  metric: metrics.value[0] || '',
  window: '本年累计',
  keyword: '',
})
const applied = ref({ ...filter.value }),
  chartMode = ref('trend'),
  saveOpen = ref(false),
  queryName = ref(''),
  page = ref(0),
  selectedRow = ref(null),
  detailOpen = ref(false)
const pageSize = 10
const output = computed(() => querySample(sample, store.profile, applied.value))
const results = computed(() => output.value.rows)
const dirty = computed(() => JSON.stringify(filter.value) !== JSON.stringify(applied.value))
const noData = computed(() => output.value.error || !results.value.length)
const currentUnit = computed(() => [...new Set(results.value.map((row) => row.unit))].join(' / '))
const visibleRows = computed(() =>
  results.value.slice(page.value * pageSize, (page.value + 1) * pageSize),
)
const favorites = computed(() =>
  (store.dashboardFavorites || []).filter((item) => item.profileId === store.profile.id),
)
const cards = computed(() => {
  if (applied.value.company === 'all')
    return [
      {
        label: '匹配主体',
        value: `${new Set(results.value.map((r) => r.company)).size}`,
        unit: '个主体',
        subtitle: '按主体分别展示，不自动合计',
      },
      {
        label: '有值的坐标',
        value: `${results.value.filter((r) => r.value !== null).length}`,
        unit: '条',
        subtitle: '空值不作为零值',
      },
      {
        label: '缺数或冲突',
        value: `${results.value.filter((r) => r.value === null).length}`,
        unit: '条',
        subtitle: '在明细中查看来源',
      },
      { label: '查询期数', value: applied.value.period, unit: '', subtitle: applied.value.window },
    ]
  return metrics.value.slice(0, 4).map((metric) => {
    const now = querySample(sample, store.profile, { ...applied.value, metric }).rows[0]
    const previous = querySample(sample, store.profile, {
      ...applied.value,
      metric,
      period: previousMonth(applied.value.period),
    }).rows[0]
    return {
      label: metric,
      value: formatValue(now?.value),
      unit: now?.unit || '',
      subtitle: now?.duplicate
        ? '坐标冲突，请检查来源'
        : changeDescription(now?.value, previous?.value, now?.unit),
      metric,
    }
  })
})
const trend = computed(() => {
  if (applied.value.company === 'all') return []
  return periods
    .filter((period) => period <= applied.value.period)
    .slice(-12)
    .map((period) => {
      const r = querySample(sample, store.profile, { ...applied.value, period }).rows[0]
      return { period, value: r?.value ?? null, unit: r?.unit || currentUnit.value }
    })
})
const plotted = computed(() => {
  const values = trend.value.map((p) => p.value).filter((v) => v !== null)
  if (!values.length) return { points: [], segments: [], ticks: [], min: 0, max: 1 }
  const lo = Math.min(...values),
    hi = Math.max(...values),
    pad = (hi - lo) * 0.15 || Math.max(Math.abs(hi) * 0.1, 1)
  const min = lo - pad,
    max = hi + pad
  const points = trend.value.map((p, index) => ({
    ...p,
    x: 55 + (index / Math.max(trend.value.length - 1, 1)) * 665,
    y: p.value === null ? null : 210 - ((p.value - min) / (max - min)) * 175,
  }))
  const segments = []
  let current = []
  points.forEach((p) => {
    if (p.y === null) {
      if (current.length) segments.push(current)
      current = []
    } else current.push(p)
  })
  if (current.length) segments.push(current)
  return {
    points,
    segments,
    ticks: Array.from({ length: 4 }, (_, i) => ({
      y: 210 - (i / 3) * 175,
      value: min + (i / 3) * (max - min),
    })),
    min,
    max,
  }
})
const comparison = computed(
  () => querySample(sample, store.profile, { ...applied.value, company: 'all' }).rows,
)
const comparisonScale = computed(() =>
  Math.max(...comparison.value.map((r) => Math.abs(r.value || 0)), 1),
)
const isComparison = computed(
  () => chartMode.value === 'comparison' || applied.value.company === 'all',
)
function runQuery() {
  applied.value = { ...filter.value }
  page.value = 0
  if (filter.value.company === 'all') chartMode.value = 'comparison'
}
function chooseMetric(metric) {
  if (!metric) return
  filter.value.metric = metric
  runQuery()
}
function useFavorite(item) {
  filter.value = { ...item.filters }
  runQuery()
  notify(`已应用“${item.name}”。`)
}
function saveQuery() {
  const name = queryName.value.trim()
  if (!name) {
    notify('请填写查询名称。')
    return
  }
  if (favorites.value.some((q) => q.name === name)) {
    notify('该名称已经存在。')
    return
  }
  store.dashboardFavorites ||= []
  if (favorites.value.length >= 8) {
    notify('原型最多保留 8 个常用查询。')
    return
  }
  store.dashboardFavorites.push({
    id: makeId('query'),
    name,
    profileId: store.profile.id,
    filters: { ...applied.value },
  })
  saveOpen.value = false
  notify('已保存当前查询条件。')
}
function removeFavorite(item) {
  store.dashboardFavorites = store.dashboardFavorites.filter((q) => q.id !== item.id)
}
function showDetail(row) {
  selectedRow.value = row
  detailOpen.value = true
}
function exportCsv() {
  const csv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`
  const header = ['主体', '期数', '指标', '口径', '源单位', '演示值', '来源', '状态']
  const rows = results.value.map((r) => [
    r.company,
    r.period,
    r.metric,
    r.window,
    r.unit,
    r.value,
    r.source,
    r.duplicate ? '坐标冲突' : r.value === null ? '缺数' : '有值',
  ])
  const blob = new Blob(
    ['\uFEFF' + [header, ...rows].map((row) => row.map(csv).join(',')).join('\r\n')],
    { type: 'text/csv;charset=utf-8' },
  )
  const url = URL.createObjectURL(blob),
    link = document.createElement('a')
  link.href = url
  link.download = `看板演示查询-${applied.value.period}.csv`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
watch(
  () => store.profile.id,
  () => {
    filter.value.company = companies.value[0] || ''
    filter.value.metric = metrics.value[0] || ''
    runQuery()
  },
)
function openSaveQuery() {
  queryName.value = ''
  saveOpen.value = true
}
</script>

<template>
  <div class="page-header">
    <div>
      <div class="eyebrow">使用 / 数据看板</div>
      <h1 class="page-title">数据看板</h1>
      <p class="page-description">快捷查看经营数据，按需要切换主体、期数与指标。</p>
    </div>
    <div class="button-row">
      <Button
        variant="outline"
        size="sm"
        :disabled="dirty || noData"
        @click="openSaveQuery"
        ><BookmarkPlus :size="14" />保存查询</Button
      ><Button variant="outline" size="sm" :disabled="dirty || noData" @click="exportCsv"
        ><Download :size="14" />导出演示 CSV</Button
      >
    </div>
  </div>
  <div class="dashboard-banner">
    <Badge variant="secondary">演示数据</Badge
    ><span>全部数值已替换；当前查询内置样例，尚未连接业务数据库。</span>
  </div>
  <form class="panel dashboard-filters" @submit.prevent="runQuery">
    <div class="filter-topline">
      <strong><SlidersHorizontal :size="14" />快捷查询</strong
      ><span>主体自身取数 · 不自动汇总控股关系</span>
    </div>
    <div class="dashboard-filter-grid">
      <div class="field">
        <label for="query-company">主体</label
        ><select id="query-company" v-model="filter.company" class="input">
          <option value="all">全部主体 · 分别展示</option>
          <option v-for="name in companies" :key="name">{{ name }}</option>
        </select>
      </div>
      <div class="field">
        <label for="query-period">期数</label
        ><select id="query-period" v-model="filter.period" class="input">
          <option v-for="period in periods.toReversed()" :key="period">{{ period }}</option>
        </select>
      </div>
      <div class="field">
        <label for="query-metric">指标</label
        ><select id="query-metric" v-model="filter.metric" class="input">
          <option v-for="name in metrics" :key="name">{{ name }}</option>
        </select>
      </div>
      <div class="field">
        <label for="query-window">口径</label
        ><select id="query-window" v-model="filter.window" class="input">
          <option v-for="w in windows" :key="w.name">{{ w.name }}</option>
        </select>
      </div>
    </div>
    <div class="filter-bottomline">
      <div class="search-field">
        <Search :size="14" /><Input
          v-model="filter.keyword"
          aria-label="查询名称或别称"
          placeholder="搜索主体名称、别称或指标"
        />
      </div>
      <span v-if="dirty" class="pending-query">条件已修改，点击查询后更新</span
      ><span v-else class="muted"
        >{{ applied.period }} · {{ applied.window }} · 金额按人民币展示</span
      ><Button type="submit" size="sm"><Search :size="14" />查询数据</Button>
    </div>
  </form>
  <div v-if="favorites.length" class="dashboard-favorites">
    <span>常用查询</span>
    <div v-for="item in favorites" :key="item.id" class="favorite-item">
      <button @click="useFavorite(item)">{{ item.name }}</button
      ><button :aria-label="`移除常用查询 ${item.name}`" @click="removeFavorite(item)">
        <X :size="11" />
      </button>
    </div>
  </div>
  <div v-if="output.error" class="notice notice-warning mt-5">
    <Info :size="15" />{{ output.error }}
  </div>
  <template v-else>
    <div class="dashboard-section-caption">
      <span>{{
        applied.company === 'all' ? '查询范围概览' : applied.company + ' · 期末指标概览'
      }}</span
      ><span>{{ applied.period }} / {{ applied.window }}</span>
    </div>
    <div class="dashboard-cards">
      <button
        v-for="card in cards"
        :key="card.label"
        :disabled="!card.metric"
        class="dashboard-kpi"
        :class="{ 'is-active': card.metric === applied.metric }"
        @click="chooseMetric(card.metric)"
      >
        <div class="kpi-label">{{ card.label }}<ArrowUpRight v-if="card.metric" :size="13" /></div>
        <div class="kpi-value">
          {{ card.value }}<small>{{ card.unit }}</small>
        </div>
        <div class="kpi-note">{{ card.subtitle }}</div>
      </button>
    </div>
    <section class="panel dashboard-chart">
      <div class="panel-header">
        <div>
          <strong
            >{{ applied.metric || '指标' }} · {{ isComparison ? '主体对比' : '期间走势' }}</strong
          >
          <p class="help-text">
            {{ applied.window }} · {{ currentUnit === '%' ? '比率' : '人民币金额'
            }}<span v-if="currentUnit"> · 单位：{{ currentUnit }}</span>
          </p>
        </div>
        <Tabs v-model="chartMode"
          ><TabsList
            ><TabsTrigger value="trend" :disabled="applied.company === 'all'"
              ><TrendingUp :size="13" />期间走势</TabsTrigger
            ><TabsTrigger value="comparison"
              ><BarChart3 :size="13" />主体对比</TabsTrigger
            ></TabsList
          ></Tabs
        >
      </div>
      <div v-if="!isComparison && plotted.segments.length" class="trend-chart">
        <svg
          viewBox="0 0 750 255"
          role="img"
          :aria-label="`${applied.company} ${applied.metric} ${applied.window}期间走势`"
        >
          <g v-for="tick in plotted.ticks" :key="tick.y">
            <line
              x1="55"
              x2="720"
              :y1="tick.y"
              :y2="tick.y"
              stroke="#edf1ee"
              stroke-dasharray="3 4"
            />
            <text x="43" :y="tick.y + 4" text-anchor="end" fill="#9aa59d" font-size="9">
              {{ tick.value.toFixed(0) }}
            </text>
          </g>
          <polyline
            v-for="(segment, i) in plotted.segments"
            :key="i"
            :points="segment.map((p) => `${p.x},${p.y}`).join(' ')"
            fill="none"
            stroke="#368567"
            stroke-width="2.5"
            stroke-linejoin="round"
          />
          <g v-for="point in plotted.points" :key="point.period">
            <circle
              v-if="point.y !== null"
              :cx="point.x"
              :cy="point.y"
              r="3"
              fill="#fff"
              stroke="#368567"
              stroke-width="2"
            >
              <title>{{ point.period }}：{{ formatValue(point.value) }} {{ point.unit }}</title>
            </circle>
            <text :x="point.x" y="238" text-anchor="middle" fill="#9aa59d" font-size="9">
              {{ point.period.slice(2) }}
            </text>
          </g>
        </svg>
        <p>按各期末值展示，累计值不跨期求和；缺数断开显示。</p>
      </div>
      <div v-else-if="isComparison && comparison.length" class="comparison-chart">
        <div v-for="row in comparison" :key="row.company" class="comparison-row">
          <span>{{ row.company }}</span>
          <div class="bar-track">
            <div
              v-if="row.value !== null"
              class="bar-fill"
              :style="{
                width: (Math.abs(row.value) / comparisonScale) * 100 + '%',
                background: row.value < 0 ? '#c38d68' : undefined,
              }"
            ></div>
          </div>
          <strong
            >{{ formatValue(row.value) }}<small>{{ row.unit }}</small></strong
          >
        </div>
        <p>每个主体单独展示；条长表示绝对值，负值保留负号。</p>
      </div>
      <div v-else class="empty-state">
        <BarChart3 :size="28" />
        <h3>当前条件下没有可展示的数值</h3>
        <p>请检查主体、期间、指标及口径。缺数不会补零，也不自动换汇。</p>
      </div>
    </section>
    <section class="panel dashboard-results">
      <div class="panel-header">
        <div>
          <strong>查询明细</strong><span class="result-count">{{ results.length }} 条</span>
          <p class="help-text">
            {{
              applied.company === 'all'
                ? '各主体分别展示，无合计行。'
                : '点击一条结果，查看完整坐标与源格。'
            }}
          </p>
        </div>
        <Badge variant="outline">{{ applied.period }}</Badge>
      </div>
      <div v-if="results.length" class="table-wrap">
        <table class="data-table dashboard-table">
          <thead>
            <tr>
              <th>主体 / 指标</th>
              <th>期数</th>
              <th>口径</th>
              <th class="text-right">演示值</th>
              <th>单位</th>
              <th>来源</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in visibleRows"
              :key="[row.company, row.metric, row.source].join()"
              @click="showDetail(row)"
            >
              <td>
                <strong>{{ row.company }}</strong
                ><small>{{ row.metric }}</small>
              </td>
              <td>{{ row.period }}</td>
              <td>{{ row.window }}</td>
              <td class="text-right numeric" :class="{ 'warning-text': row.value === null }">
                {{ row.duplicate ? '坐标冲突' : formatValue(row.value) }}
              </td>
              <td>{{ row.unit }}</td>
              <td class="muted">{{ row.source }}</td>
              <td>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="`查看 ${row.company} 的完整坐标`"
                  @click.stop="showDetail(row)"
                  ><ArrowUpRight :size="14"
                /></Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty-state compact">
        <Search :size="24" />
        <h3>没有匹配的记录</h3>
        <p>更换查询条件，或清除名称搜索后重试。</p>
      </div>
      <div v-if="results.length" class="dashboard-table-footer">
        <span>缺数显示 —，不代表 0；来源均为替换数值后的样例。</span>
        <div class="button-row">
          <Button variant="ghost" size="sm" :disabled="page === 0" @click="page--">上一页</Button
          ><span>{{ page + 1 }} / {{ Math.max(1, Math.ceil(results.length / pageSize)) }}</span
          ><Button
            variant="ghost"
            size="sm"
            :disabled="(page + 1) * pageSize >= results.length"
            @click="page++"
            >下一页</Button
          >
        </div>
      </div>
    </section>
    <p class="dashboard-binding-note">
      <Info :size="12" />单月使用原型中显式配置的 H
      列「本月累计」；真实规格仍须用户确认。指标卡片只展示当前主体、期数和口径，不把不同指标相加。
    </p>
  </template>
  <Dialog v-model:open="saveOpen"
    ><DialogContent
      ><DialogHeader
        ><DialogTitle>保存常用查询</DialogTitle
        ><DialogDescription
          >仅保存这组筛选条件，方便下次快速打开，不新建业务口径或模板规格。</DialogDescription
        ></DialogHeader
      >
      <div class="field">
        <label for="saved-query-name">查询名称</label
        ><Input
          id="saved-query-name"
          v-model="queryName"
          placeholder="例如：集团月度收入"
          @keyup.enter="saveQuery"
        />
      </div>
      <p class="help-text">
        {{ applied.company === 'all' ? '全部主体' : applied.company }} / {{ applied.metric }} /
        {{ applied.period }} / {{ applied.window }}
      </p>
      <DialogFooter
        ><Button variant="outline" @click="saveOpen = false">取消</Button
        ><Button @click="saveQuery">保存查询条件</Button></DialogFooter
      ></DialogContent
    ></Dialog
  >
  <Dialog v-model:open="detailOpen"
    ><DialogContent
      ><DialogHeader
        ><DialogTitle>值的完整坐标</DialogTitle
        ><DialogDescription>查看该值的业务含义和演示来源。</DialogDescription></DialogHeader
      ><template v-if="selectedRow"
        ><div class="review-summary">
          <div
            v-for="[key, label] in [
              ['company', '主体'],
              ['metric', '指标'],
              ['period', '期数'],
              ['window', '口径'],
            ]"
            :key="key"
          >
            <span>{{ label }}</span
            ><strong>{{ selectedRow[key] }}</strong>
          </div>
          <div>
            <span>源格</span><strong>经营数据!{{ selectedRow.source }}</strong>
          </div>
          <div>
            <span>源值 / 单位</span
            ><strong>{{ formatValue(selectedRow.value) }} {{ selectedRow.unit }}</strong>
          </div>
        </div>
        <div class="notice">
          演示源列：{{
            selectedRow.sourceHeader
          }}。期数取自源报表；正式事实期间与窗口的编译、单位换算尚未执行。
        </div></template
      ><DialogFooter
        ><Button variant="outline" @click="detailOpen = false">关闭详情</Button></DialogFooter
      ></DialogContent
    ></Dialog
  >
</template>

<style scoped>
.dashboard-banner {
  display: flex;
  gap: 10px;
  align-items: center;
  color: #91a095;
  font-size: 10px;
  margin: -10px 0 20px;
}
.dashboard-filters {
  padding: 17px 20px;
}
.filter-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.filter-topline strong {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
}
.filter-topline > span {
  font-size: 10px;
  color: #93a096;
}
.dashboard-filter-grid {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1.4fr 1fr;
  gap: 12px;
}
.dashboard-filter-grid .field {
  margin-bottom: 12px;
}
.dashboard-filter-grid .input {
  font-size: 11px;
}
.filter-bottomline {
  display: flex;
  align-items: center;
  gap: 13px;
  border-top: 1px solid #edf1ee;
  padding-top: 13px;
  font-size: 10px;
}
.filter-bottomline .search-field {
  flex: 1;
  max-width: 300px;
}
.filter-bottomline > .muted,
.pending-query {
  margin-left: auto;
}
.pending-query {
  color: #ac8345;
}
.dashboard-favorites {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 14px;
  font-size: 10px;
  color: #8b9b8f;
}
.favorite-item {
  display: flex;
  align-items: center;
  border: 1px solid #dfe8e1;
  border-radius: 5px;
  background: #fff;
  color: #617f69;
}
.favorite-item button {
  padding: 5px 8px;
}
.favorite-item button + button {
  border-left: 1px solid #edf1ee;
  padding: 7px;
}
.dashboard-section-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 25px 0 12px;
  font-size: 10px;
  color: #819487;
}
.dashboard-section-caption span:first-child {
  font-weight: 500;
  color: #5b7362;
}
.dashboard-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 22px;
}
.dashboard-kpi {
  border: 1px solid #e3e9e4;
  background: #fff;
  text-align: left;
  border-radius: 8px;
  padding: 18px 17px;
  min-width: 0;
  transition: border-color 0.15s;
}
.dashboard-kpi:hover:not(:disabled) {
  border-color: #8db29b;
}
.dashboard-kpi.is-active {
  border-color: #9cbdab;
  box-shadow: 0 0 0 1px #d9e9df inset;
}
.dashboard-kpi:disabled {
  cursor: default;
  opacity: 1;
}
.kpi-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 5px;
  color: #7f9486;
  font-size: 11px;
  min-height: 20px;
}
.kpi-value {
  font-size: 25px;
  letter-spacing: -0.7px;
  color: #334f3e;
  font-weight: 600;
  margin: 14px 0 8px;
  white-space: nowrap;
}
.kpi-value small {
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0;
  color: #94a296;
  margin-left: 6px;
}
.kpi-note {
  font-size: 9px;
  color: #94a498;
}
.dashboard-chart {
  margin-bottom: 20px;
}
.trend-chart {
  padding: 18px 25px 12px;
}
.trend-chart svg {
  width: 100%;
  height: auto;
  max-height: 290px;
}
.trend-chart p,
.comparison-chart > p {
  font-size: 9px;
  color: #9caaa0;
  text-align: center;
  margin: 8px 0 0;
}
.comparison-chart {
  padding: 25px 25px 15px;
  min-height: 240px;
}
.comparison-row {
  display: grid;
  grid-template-columns: 145px minmax(0, 1fr) 110px;
  gap: 15px;
  align-items: center;
  margin: 16px 0;
  font-size: 11px;
}
.comparison-row > span {
  color: #6f8677;
}
.comparison-row strong {
  text-align: right;
  font-weight: 500;
  font-size: 12px;
}
.comparison-row strong small {
  font-size: 9px;
  color: #91a297;
  margin-left: 5px;
}
.bar-track {
  height: 9px;
  background: #f0f5f1;
  border-radius: 2px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  min-width: 1px;
  background: #75a68a;
  border-radius: 2px;
}
.result-count {
  margin-left: 9px;
  color: #91a197;
  font-size: 10px;
}
.dashboard-table td {
  padding-top: 13px;
  padding-bottom: 13px;
}
.dashboard-table td strong {
  font-size: 11px;
  font-weight: 500;
}
.dashboard-table td small {
  display: block;
  font-size: 10px;
  color: #94a197;
  margin-top: 5px;
}
.dashboard-table tr {
  cursor: pointer;
}
.numeric {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  color: #4d755c;
}
.dashboard-table-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 17px;
  border-top: 1px solid #edf1ee;
  font-size: 9px;
  color: #a0ada3;
}
.dashboard-binding-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  line-height: 1.9;
  font-size: 9px;
  color: #9eaba2;
  margin: 14px 0 0;
}
.dashboard-binding-note svg {
  flex-shrink: 0;
  margin-top: 2px;
}
@media (max-width: 1200px) {
  .dashboard-filter-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .dashboard-cards {
    gap: 10px;
  }
  .dashboard-kpi {
    padding: 15px 12px;
  }
  .kpi-value {
    font-size: 21px;
  }
  .kpi-label {
    font-size: 10px;
  }
}
@media (max-width: 760px) {
  .dashboard-banner {
    align-items: flex-start;
    line-height: 1.8;
  }
  .filter-topline > span {
    display: none;
  }
  .dashboard-filter-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .dashboard-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .filter-bottomline {
    flex-wrap: wrap;
  }
  .filter-bottomline .search-field {
    max-width: none;
    flex-basis: 100%;
  }
  .filter-bottomline > span {
    margin-left: 0;
    flex: 1;
  }
  .dashboard-chart .panel-header {
    align-items: flex-start;
    flex-direction: column;
  }
  .comparison-row {
    grid-template-columns: 110px minmax(0, 1fr) 85px;
    gap: 8px;
  }
  .dashboard-table-footer > span {
    max-width: 50%;
    line-height: 1.7;
  }
  .page-header .button-row {
    justify-content: flex-end;
  }
  .dashboard-section-caption {
    gap: 10px;
  }
  .dashboard-section-caption > span {
    max-width: 65%;
    line-height: 1.8;
  }
}
</style>
