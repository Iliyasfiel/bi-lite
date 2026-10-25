<script setup>
import { computed, ref } from 'vue'
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Database,
  Download,
  FileInput,
  FileOutput,
  History,
  Search,
  ShieldCheck,
} from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { navigate, notify, store } from '@/store'

const search = ref('')
const directionFilter = ref('all')
const originFilter = ref('all')
const detailOpen = ref(false)
const selectedRecord = ref(null)

const directionLabels = {
  ingest: '接入',
  export: '导出',
}
const statusLabels = {
  success: '演示完成',
  warning: '有待处理项',
  failed: '演示失败',
}

const isCurrentSimulation = (record) => Boolean(record?.simulated)
const originLabel = (record) => (isCurrentSimulation(record) ? '本次模拟' : '预置演示')

const visibleRecords = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return store.records.filter((record) => {
    if (directionFilter.value !== 'all' && record.direction !== directionFilter.value) return false
    if (originFilter.value === 'current' && !isCurrentSimulation(record)) return false
    if (originFilter.value === 'preset' && isCurrentSimulation(record)) return false
    if (!keyword) return true
    return [record.title, record.details, record.period, directionLabels[record.direction]]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword))
  })
})

const currentSimulationCount = computed(
  () => store.records.filter((record) => isCurrentSimulation(record)).length,
)
const presetDemoCount = computed(
  () => store.records.filter((record) => !isCurrentSimulation(record)).length,
)
const hasFilters = computed(
  () =>
    Boolean(search.value.trim()) || directionFilter.value !== 'all' || originFilter.value !== 'all',
)

function openDetail(record) {
  selectedRecord.value = record
  detailOpen.value = true
}

function clearFilters() {
  search.value = ''
  directionFilter.value = 'all'
  originFilter.value = 'all'
}

function openRecordFromKeyboard(event, record) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    openDetail(record)
  }
}

function downloadJson() {
  if (!selectedRecord.value) return
  const payload = {
    artifact: 'bi-lite 浏览器内演示记录',
    exportedAt: new Date().toISOString(),
    boundary: '仅用于原型展示，不代表真实入库、重放或正式报送结果。',
    record: selectedRecord.value,
  }
  const text = JSON.stringify(payload, null, 2)
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `bilite-演示记录-${selectedRecord.value.id}.json`
  link.click()
  URL.revokeObjectURL(url)
  notify('已下载浏览器内演示记录 JSON。')
}
</script>

<template>
  <section class="records-page">
    <header class="page-header">
      <div>
        <div class="eyebrow">工作区 / 操作记录</div>
        <h1 class="page-title">操作记录</h1>
        <p class="page-description">
          查看预置样例和本次浏览器内模拟。记录只保存在当前浏览器，不代表真实入库或报表生成。
        </p>
      </div>
      <Badge variant="outline" class="prototype-status">
        <ShieldCheck :size="13" />
        演示记录
      </Badge>
    </header>

    <div class="stats-grid record-stats">
      <div class="stat-card">
        <span>全部记录</span>
        <strong>{{ store.records.length }}</strong>
        <small>当前浏览器内的演示条目</small>
      </div>
      <div class="stat-card">
        <span>本次模拟</span>
        <strong>{{ currentSimulationCount }}</strong>
        <small>在接入演示中确认后保存</small>
      </div>
      <div class="stat-card">
        <span>预置演示</span>
        <strong>{{ presetDemoCount }}</strong>
        <small>随原型初始化提供</small>
      </div>
    </div>

    <section class="panel records-panel">
      <div class="records-toolbar">
        <div class="search-field">
          <Search :size="15" />
          <Input
            v-model="search"
            placeholder="搜索名称、期间或边界说明"
            aria-label="搜索演示记录"
          />
        </div>
        <div class="filter-group">
          <label>
            <span>方向</span>
            <select v-model="directionFilter" class="input native-select">
              <option value="all">全部方向</option>
              <option value="ingest">接入</option>
              <option value="export">导出</option>
            </select>
          </label>
          <label>
            <span>来源</span>
            <select v-model="originFilter" class="input native-select">
              <option value="all">全部来源</option>
              <option value="current">本次模拟</option>
              <option value="preset">预置演示</option>
            </select>
          </label>
          <Button v-if="hasFilters" variant="ghost" size="sm" @click="clearFilters">
            清除筛选
          </Button>
        </div>
      </div>

      <div v-if="visibleRecords.length" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>记录</th>
              <th>入口</th>
              <th>期间</th>
              <th>来源</th>
              <th>状态</th>
              <th>记录数</th>
              <th class="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="record in visibleRecords"
              :key="record.id"
              class="record-row"
              tabindex="0"
              @click="openDetail(record)"
              @keydown="openRecordFromKeyboard($event, record)"
            >
              <td>
                <div class="record-name">
                  <span class="record-icon" :class="record.direction">
                    <FileInput v-if="record.direction === 'ingest'" :size="18" />
                    <FileOutput v-else :size="18" />
                  </span>
                  <span>
                    <strong>{{ record.title }}</strong>
                    <small>{{ record.time }}</small>
                  </span>
                </div>
              </td>
              <td>
                <Badge variant="outline">{{
                  directionLabels[record.direction] || record.direction
                }}</Badge>
              </td>
              <td class="period-cell">{{ record.period || '—' }}</td>
              <td>
                <span class="origin-pill" :class="{ current: isCurrentSimulation(record) }">
                  <CheckCircle2 v-if="isCurrentSimulation(record)" :size="13" />
                  {{ originLabel(record) }}
                </span>
              </td>
              <td>
                <span class="status-pill" :class="record.status">
                  {{ statusLabels[record.status] || record.status }}
                </span>
              </td>
              <td>{{ record.count ?? '—' }}</td>
              <td class="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  :aria-label="`查看 ${record.title} 详情`"
                  @click.stop="openDetail(record)"
                >
                  查看详情
                  <ArrowRight :size="14" />
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else class="empty-state">
        <History :size="30" />
        <h2>{{ store.records.length ? '没有匹配的演示记录' : '还没有演示记录' }}</h2>
        <p>
          {{
            store.records.length
              ? '调整搜索词或筛选条件后再试。'
              : '从月度调用页运行一次演示检查，并确认添加演示记录。'
          }}
        </p>
        <Button v-if="hasFilters" variant="outline" @click="clearFilters">清除筛选</Button>
        <Button v-else variant="outline" @click="navigate('reports')">
          前往月度调用
          <ArrowRight :size="15" />
        </Button>
      </div>
    </section>

    <div class="notice">
      <Database :size="16" />
      <span>记录仅在当前浏览器保存，不代表真实入库或正式报表生成。</span>
    </div>

    <Dialog v-model:open="detailOpen">
      <DialogContent class="record-dialog">
        <DialogHeader>
          <DialogTitle>{{ selectedRecord?.title || '演示记录' }}</DialogTitle>
          <DialogDescription>
            {{ selectedRecord ? originLabel(selectedRecord) : '演示' }} · {{ selectedRecord?.time }}
          </DialogDescription>
        </DialogHeader>

        <template v-if="selectedRecord">
          <div class="detail-badges">
            <Badge variant="outline">
              {{ directionLabels[selectedRecord.direction] || selectedRecord.direction }}
            </Badge>
            <Badge :variant="selectedRecord.status === 'failed' ? 'destructive' : 'secondary'">
              {{ statusLabels[selectedRecord.status] || selectedRecord.status }}
            </Badge>
            <Badge variant="outline">{{ originLabel(selectedRecord) }}</Badge>
          </div>

          <div class="detail-grid">
            <div>
              <span><CalendarDays :size="13" />期间</span>
              <strong>{{ selectedRecord.period || '—' }}</strong>
            </div>
            <div>
              <span><History :size="13" />记录数</span>
              <strong>{{ selectedRecord.count ?? '—' }}</strong>
            </div>
            <div>
              <span
                ><FileInput v-if="selectedRecord.direction === 'ingest'" :size="13" /><FileOutput
                  v-else
                  :size="13"
                />入口</span
              >
              <strong>{{
                directionLabels[selectedRecord.direction] || selectedRecord.direction
              }}</strong>
            </div>
          </div>

          <div class="detail-section">
            <span>说明</span>
            <p>{{ selectedRecord.details || '没有附加说明。' }}</p>
          </div>

          <div v-if="selectedRecord.sourceFile" class="detail-section compact">
            <span>演示来源</span>
            <p>{{ selectedRecord.sourceFile }}</p>
          </div>

          <div class="notice notice-warning">
            <ShieldCheck :size="16" />
            <span
              >该条目只用于原型交互展示，不证明真实文件读取、数据库写入、重放或正式报表生成已完成。</span
            >
          </div>
        </template>

        <DialogFooter>
          <Button variant="outline" @click="detailOpen = false">关闭</Button>
          <Button variant="outline" :disabled="!selectedRecord" @click="downloadJson">
            <Download :size="15" />
            下载演示 JSON
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>

<style scoped>
.records-page {
  --teal-700: #0f766e;
  --teal-50: #f0fdfa;
  --slate-950: #17201e;
  --slate-700: #46514e;
  --slate-500: #71807b;
  --line: #e1e7e5;
  display: grid;
  gap: 18px;
  color: var(--slate-950);
}

.prototype-status {
  border-color: #b8ddd6;
  color: var(--teal-700);
  background: var(--teal-50);
}

.record-stats {
  margin: 0;
}

.record-stats .stat-card {
  padding: 14px 16px;
}

.stat-card span,
.stat-card small {
  display: block;
  color: var(--slate-500);
  font-size: 11px;
}

.stat-card strong {
  display: block;
  margin: 5px 0;
  font-size: 25px;
}

.records-panel {
  overflow: hidden;
}

.records-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 16px;
  border-bottom: 1px solid var(--line);
}

.search-field {
  position: relative;
  width: min(360px, 100%);
}

.search-field > svg {
  position: absolute;
  top: 50%;
  left: 11px;
  z-index: 1;
  color: #7a8884;
  transform: translateY(-50%);
}

.search-field :deep(input) {
  padding-left: 33px;
}

.filter-group {
  display: flex;
  align-items: end;
  gap: 8px;
}

.filter-group label {
  display: grid;
  gap: 5px;
}

.filter-group label > span {
  color: var(--slate-500);
  font-size: 10px;
  font-weight: 700;
}

.native-select {
  width: 128px;
  height: 36px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--slate-950);
  background: #fff;
}

.record-row {
  cursor: pointer;
}

.record-row:focus-visible {
  position: relative;
  z-index: 1;
  outline: 2px solid #5cb7a9;
  outline-offset: -2px;
}

.record-name {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 220px;
}

.record-name strong,
.record-name small {
  display: block;
}

.record-name strong {
  font-size: 13px;
}

.record-name small {
  margin-top: 3px;
  color: var(--slate-500);
  font-size: 10px;
}

.record-icon {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
}

.record-icon.ingest {
  color: #0f766e;
  background: #ccfbf1;
}

.record-icon.export {
  color: #0e7490;
  background: #cffafe;
}

.period-cell {
  font-variant-numeric: tabular-nums;
}

.origin-pill,
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.origin-pill {
  color: #64748b;
  font-size: 11px;
}

.origin-pill.current {
  color: #0f766e;
  font-weight: 650;
}

.status-pill.success {
  color: #047857;
}

.status-pill.warning {
  color: #b45309;
}

.status-pill.failed {
  color: #b42318;
}

.eyebrow {
  color: var(--teal-700);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.detail-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.detail-grid > div {
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.detail-grid span,
.detail-grid strong {
  display: flex;
  align-items: center;
  gap: 4px;
}

.detail-grid span {
  color: var(--slate-500);
  font-size: 10px;
}

.detail-grid strong {
  margin-top: 5px;
  font-size: 12px;
}

.detail-section {
  padding: 11px;
  border-radius: 8px;
  background: #f6f8f7;
}

.detail-section.compact {
  padding: 9px 11px;
}

.detail-section > span {
  color: var(--slate-500);
  font-size: 10px;
  font-weight: 700;
}

.detail-section p {
  margin: 5px 0 0;
  color: #46514e;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

@media (max-width: 760px) {
  .record-stats,
  .detail-grid {
    grid-template-columns: 1fr;
  }

  .records-toolbar,
  .filter-group {
    align-items: stretch;
    flex-direction: column;
  }

  .search-field,
  .native-select {
    width: 100%;
  }
}
</style>
