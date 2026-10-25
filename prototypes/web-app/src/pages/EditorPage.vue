<script setup>
import { computed, ref } from 'vue'
import {
  ArrowLeft,
  ArrowRight,
  Save,
  Check,
  AlertCircle,
  FileSpreadsheet,
  Scan,
  EyeOff,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Plus,
  CheckCircle2,
  CircleHelp,
  Download,
  SlidersHorizontal,
  MousePointer2,
  Columns3,
  ShieldCheck,
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
import sample from '../demo/sample.js'
import { store, navigate, notify, dimension, resolveMember, addMember } from '../store'

const spec = computed(() => store.specs.find((s) => s.id === store.editorId))
const mapping = computed(() => spec.value?.mapping)
const isExport = computed(() => spec.value?.direction === 'export')
const letters = 'ABCDEFGHI'.split(''),
  roleNames = {
    none: '未配置',
    company: '主体来源',
    period: '期数来源',
    metric: '指标来源',
    unit: '源单位',
    value: '值来源',
    ignore: '忽略',
  }
const selected = ref({ c: 7, r: null }),
  inspector = ref('binding'),
  screen = ref('mapping'),
  month = ref('2026-06'),
  page = ref(0),
  rangeMode = ref(false),
  drag = ref(null),
  selectionRect = ref(null),
  injectedError = ref(false),
  reviewOpen = ref(false),
  memberOpen = ref(false),
  memberKind = ref('company'),
  memberName = ref(''),
  memberAction = ref('new'),
  aliasOf = ref(''),
  exceptionOpen = ref(false),
  exceptionDim = ref('company'),
  exceptionValue = ref('')
const months = [...new Set(sample.rows.map((r) => r[1]))]
const labels = { company: '主体', metric: '指标', period: '期数', window: '口径' }
const pending = computed(() => spec.value?.pendingMembers || [])
const members = (id) => [
  ...(dimension(id)
    ?.members.filter((m) => m.active)
    .map((m) => m.name) || []),
  ...pending.value.filter((x) => x.dimension === id && !x.aliasOf).map((x) => x.name),
]
const isKnown = (id, name) =>
  !!resolveMember(id, name) || pending.value.some((x) => x.dimension === id && x.name === name)
const rows = computed(() =>
  sample.rows
    .map((cells, i) => ({ cells, row: i + 2 }))
    .filter((x) => !month.value || x.cells[1] === month.value),
)
const visibleRows = computed(() => rows.value.slice(page.value * 12, page.value * 12 + 12))
const parsedRange = computed(() => {
  const m = /^([A-I])(\d+):([A-I])(\d+)$/i.exec(mapping.value?.range || '')
  if (!m) return null
  const [c1, r1, c2, r2] = [
    letters.indexOf(m[1].toUpperCase()),
    +m[2],
    letters.indexOf(m[3].toUpperCase()),
    +m[4],
  ]
  return c1 <= c2 && r1 >= 2 && r2 >= r1 && r2 <= 541
    ? { c1, c2, r1, r2: mapping.value.dynamic ? 541 : r2 }
    : null
})
function inBlock(r, c) {
  const b = parsedRange.value
  return b && c >= b.c1 && c <= b.c2 && r >= b.r1 && r <= b.r2
}
function ignored(r, c) {
  return (
    mapping.value.columns[c].role === 'ignore' ||
    mapping.value.ignored.some((x) => c >= x.c1 && c <= x.c2 && r >= x.r1 && r <= x.r2)
  )
}
function raw(r, c) {
  return injectedError.value && r === 514 && c === 1 ? '' : (sample.rows[r - 2]?.[c] ?? '')
}
function touch() {
  spec.value.status = 'draft'
  spec.value.updatedAt = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  spec.value.revision++
}
function source(kind, r) {
  const cs = mapping.value.columns
    .map((x, c) => ({ ...x, c }))
    .filter((x) => x.role === kind && inBlock(r, x.c))
  if (cs.length === 1)
    return {
      value: ignored(r, cs[0].c) ? '' : raw(r, cs[0].c),
      source: `${letters[cs[0].c]}${r} · 逐行读取`,
    }
  if (cs.length > 1) return { value: '', source: '多个来源冲突' }
  if (kind === 'period' && mapping.value.periodMode !== 'column') {
    if (mapping.value.periodMode === 'fixed')
      return { value: mapping.value.periodValue, source: '区块固定期数' }
    const offset = Number(mapping.value.monthOffset)
    if (!Number.isInteger(offset) || offset < 0 || offset > 120)
      return { value: '', source: '月偏移须为 0–120 的整数' }
    const date = new Date()
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: 'numeric',
    }).formatToParts(date)
    const year = +parts.find((p) => p.type === 'year').value,
      m = +parts.find((p) => p.type === 'month').value
    return {
      value: new Date(Date.UTC(year, m - 1 - +mapping.value.monthOffset, 1))
        .toISOString()
        .slice(0, 7),
      source: `当前月减 ${mapping.value.monthOffset} 月`,
    }
  }
  return { value: mapping.value.fixed?.[kind] || '', source: '区块固定来源' }
}
function coords(r, c) {
  const out = {
    company: source('company', r),
    metric: source('metric', r),
    period: source('period', r),
    window: { value: mapping.value.columns[c].window || '', source: `${letters[c]} 列设置` },
  }
  const ex = mapping.value.exceptions[letters[c] + r]
  if (ex)
    for (const [key, val] of Object.entries(ex)) out[key] = { value: val, source: '单元格例外' }
  return out
}
const diagnostics = computed(() => {
  if (!spec.value) return [{ message: '找不到规格', detail: '返回规格列表重新选择。' }]
  if (isExport.value) {
    const list = []
    if (!mapping.value.exportMetric)
      list.push({ message: '请选择取数指标', detail: '每个目标值需要明确指标。' })
    if (!mapping.value.exportWindow)
      list.push({ message: '请选择取数口径', detail: '模板口径保存在此规格中。' })
    if (!mapping.value.companies?.length)
      list.push({ message: '请选择至少一个主体', detail: '选择主体自身，不自动展开控股关系。' })
    if (mapping.value.exportMetric && !members('metric').includes(mapping.value.exportMetric))
      list.push({ message: '取数指标已停用或不存在', detail: '请在本体配置中检查该指标。' })
    if (mapping.value.companies?.some((name) => !members('company').includes(name)))
      list.push({ message: '主体范围含已停用或不存在的成员', detail: '请重新确认主体范围。' })
    return list
  }
  const list = [],
    b = parsedRange.value
  if (!b) return [{ message: '区块范围无效', detail: '示例支持 A2:I541 内的矩形范围。' }]
  const cs = mapping.value.columns
    .map((x, c) => ({ ...x, c }))
    .filter((x) => x.c >= b.c1 && x.c <= b.c2)
  const values = cs.filter((x) => x.role === 'value')
  if (!values.length) list.push({ message: '缺少值来源', detail: '选择要接入的值列。' })
  for (const x of cs) {
    if (x.role === 'none')
      list.push({ message: `${letters[x.c]} 列未配置`, detail: '指定用途，或明确忽略。', c: x.c })
    if (x.role === 'value' && !x.window)
      list.push({
        message: `${letters[x.c]} 列「${sample.headers[x.c]}」缺少口径`,
        detail: '表头不替代用户确认，请明确选择。',
        c: x.c,
      })
    if (x.role === 'ignore' && !x.reason?.trim())
      list.push({
        message: `${letters[x.c]} 列缺少忽略原因`,
        detail: '不接入也需要明确依据。',
        c: x.c,
      })
  }
  for (const id of ['company', 'metric', 'period']) {
    const sources = cs.filter((x) => x.role === id)
    if (sources.length > 1)
      list.push({
        message: `${labels[id]}存在多个来源`,
        detail: '请解决绑定冲突，不自动覆盖。',
        c: sources[1].c,
      })
    else if (!source(id, b.r1).value && !sources.length)
      list.push({
        message: `缺少${labels[id]}来源`,
        detail: '语义不完备，先配置来源或固定值。',
        defaults: true,
      })
  }
  if (!cs.some((x) => x.role === 'unit'))
    list.push({ message: '未配置源单位', detail: '演示样例包含金额和比率，请明确单位来源。' })
  for (const dim of store.profile.dimensions)
    if (!labels[dim.id])
      list.push({
        message: `维度「${dim.name}」缺少来源`,
        detail: '此原型尚未实现自定义维度的绑定，不能发布。',
      })
  const seen = new Set()
  for (let r = b.r1; r <= b.r2; r++) {
    if (!values.some((x) => !ignored(r, x.c) && raw(r, x.c) !== '')) continue
    for (const id of ['company', 'metric', 'period']) {
      const s = source(id, r)
      if (!s.value && !seen.has(id)) {
        list.push({
          message: `第 ${r} 行${labels[id]}缺失`,
          detail: '数据错误，不使用默认值掩盖已配置来源的空值。',
          r,
          c: cs.find((x) => x.role === id)?.c ?? 0,
        })
        seen.add(id)
      } else if (s.value && id !== 'period' && !isKnown(id, s.value) && !seen.has(id + s.value)) {
        list.push({
          message: `未登记${labels[id]}：${s.value}`,
          detail: '新建成员或手动增加别称。',
          r,
          c: cs.find((x) => x.role === id)?.c ?? 0,
          dimension: id,
          raw: s.value,
        })
        seen.add(id + s.value)
      }
    }
  }
  return list
})
const selectedRole = computed(() => mapping.value?.columns[selected.value.c])
const selectedCoords = computed(() =>
  coords(selected.value.r || visibleRows.value[0]?.row || 2, selected.value.c),
)
const facts = computed(() => {
  if (isExport.value || !parsedRange.value) return []
  const result = []
  for (const row of rows.value)
    for (let c = parsedRange.value.c1; c <= parsedRange.value.c2; c++)
      if (
        inBlock(row.row, c) &&
        mapping.value.columns[c].role === 'value' &&
        !ignored(row.row, c) &&
        raw(row.row, c) !== ''
      )
        result.push({
          r: row.row,
          c,
          coord: coords(row.row, c),
          value: raw(row.row, c),
          unit: source('unit', row.row).value,
        })
  return result
})
function chooseColumn(c) {
  selected.value = { c, r: null }
  inspector.value = 'binding'
  selectionRect.value = null
}
function pointerStart(row, c) {
  drag.value = { row, c }
  selectionRect.value = null
}
function pointerEnd(row, c) {
  if (!drag.value) return
  const start = drag.value
  drag.value = null
  selected.value = { c, r: row }
  if (start.row !== row || start.c !== c) {
    selectionRect.value = {
      r1: Math.min(start.row, row),
      r2: Math.max(start.row, row),
      c1: Math.min(start.c, c),
      c2: Math.max(start.c, c),
    }
    inspector.value = 'binding'
  } else inspector.value = 'coordinate'
  if (rangeMode.value) {
    const b = selectionRect.value || { r1: row, r2: row, c1: c, c2: c }
    mapping.value.range = `${letters[b.c1]}${b.r1}:${letters[b.c2]}${b.r2}`
    mapping.value.dynamic = false
    rangeMode.value = false
    touch()
  }
}
function hideSelection() {
  if (selectionRect.value) mapping.value.ignored.push({ ...selectionRect.value })
  else if (selected.value.r)
    mapping.value.ignored.push({
      r1: selected.value.r,
      r2: selected.value.r,
      c1: selected.value.c,
      c2: selected.value.c,
    })
  else mapping.value.columns[selected.value.c] = { role: 'ignore', reason: '用户明确屏蔽' }
  touch()
  notify('已屏蔽选区，源内容保持不变。')
}
function restore() {
  mapping.value.ignored = []
  if (selectedRole.value.role === 'ignore')
    mapping.value.columns[selected.value.c] = { role: 'none' }
  touch()
  notify('已恢复局部屏蔽；列用途请重新确认。')
}
function focusIssue(item) {
  if (item.dimension) {
    memberKind.value = item.dimension
    memberName.value = item.raw
    memberOpen.value = true
    return
  }
  screen.value = 'mapping'
  if (item.defaults) inspector.value = 'defaults'
  else {
    if (item.r) {
      month.value = sample.rows[item.r - 2][1]
      const index = rows.value.findIndex((x) => x.row === item.r)
      page.value = Math.floor(index / 12)
    }
    selected.value = { c: item.c ?? 7, r: item.r || null }
    inspector.value = 'binding'
  }
}
function beginReview() {
  if (diagnostics.value.length) {
    notify(`还有 ${diagnostics.value.length} 项待处理，不能发布。`)
    return
  }
  reviewOpen.value = true
}
function confirm() {
  for (const item of pending.value) {
    if (resolveMember(item.dimension, item.name)) continue
    try {
      addMember(item.dimension, item.name, item.aliasOf)
    } catch (e) {
      notify(e.message)
      return
    }
  }
  spec.value.pendingMembers = []
  spec.value.ontologyReviews = []
  delete spec.value.previousStatus
  spec.value.status = 'published'
  reviewOpen.value = false
  notify('已确认浏览器内的演示规格，可前往日常报送体验调用。未写入正式 YAML。')
}
function savePendingMember() {
  const name = memberName.value.trim()
  if (!name || isKnown(memberKind.value, name)) {
    notify('请输入未占用的名称或别称。')
    return
  }
  if (memberAction.value === 'alias' && !aliasOf.value) {
    notify('请选择已有成员。')
    return
  }
  spec.value.pendingMembers ||= []
  spec.value.pendingMembers.push({
    dimension: memberKind.value,
    name,
    aliasOf: memberAction.value === 'alias' ? aliasOf.value : '',
  })
  memberOpen.value = false
  memberName.value = ''
  touch()
  notify('成员变更已加入规格草稿，确认后才写入演示目录。')
}
function saveException() {
  const r = selected.value.r,
    c = selected.value.c
  if (!r || !exceptionValue.value) return
  mapping.value.exceptions[letters[c] + r] = { [exceptionDim.value]: exceptionValue.value }
  touch()
  exceptionOpen.value = false
}
function download() {
  const blob = new Blob(
    [JSON.stringify({ kind: 'ui-prototype-only', spec: spec.value }, null, 2)],
    { type: 'application/json' },
  )
  const url = URL.createObjectURL(blob),
    a = document.createElement('a')
  a.href = url
  a.download = `${spec.value.title}-原型配置.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function selectCell(row, c) {
  selected.value = { c, r: row }
  inspector.value = 'coordinate'
}
function openException() {
  exceptionOpen.value = true
  exceptionValue.value = ''
}
function removeException() {
  delete mapping.value.exceptions[letters[selected.value.c] + selected.value.r]
  touch()
}
function setFixedSource(id, value) {
  mapping.value.fixed ||= {}
  mapping.value.fixed[id] = value
  touch()
}
function toggleSemantic(id, checked) {
  mapping.value.semanticIds ||= []
  if (checked) mapping.value.semanticIds.push(id)
  else mapping.value.semanticIds = mapping.value.semanticIds.filter(value => value !== id)
  touch()
}
</script>

<template>
  <div v-if="!spec" class="empty-state">
    <h2>找不到规格</h2>
    <Button @click="navigate('specs')">返回规格列表</Button>
  </div>
  <template v-else>
    <div class="editor-heading">
      <div>
        <button class="back-link" @click="navigate('specs')">
          <ArrowLeft :size="13" />模板规格
        </button>
        <div class="editor-title">
          <h1>{{ spec.title }}</h1>
          <Badge variant="outline">{{ isExport ? '导出规格' : '接入规格' }}</Badge
          ><span class="status-pill" :class="spec.status">{{
            spec.status === 'published'
              ? '已发布 · 演示'
              : spec.status === 'review'
                ? '待复核'
                : '草稿'
          }}</span>
        </div>
      </div>
      <div class="button-row">
        <Button variant="outline" size="sm" @click="notify('草稿已暂存到当前浏览器。')"
          ><Save :size="14" />暂存</Button
        ><Button size="sm" @click="beginReview"><Check :size="14" />审阅并确认</Button>
      </div>
    </div>
    <div v-if="spec.ontologyReviews?.length" class="notice notice-warning mb-4">
      <AlertCircle :size="16" />
      <div>
        <strong>相关本体定义已变化，请人工复核</strong>
        <p v-for="item in spec.ontologyReviews" :key="item.key" class="mt-1">
          {{ item.title }}：{{ item.detail }}
        </p>
        <p class="mt-2">确认口径仍适用、配置来源检查通过后，再审阅发布。</p>
      </div>
    </div>
    <div class="editor-subbar">
      <Tabs v-if="!isExport" v-model="screen"
        ><TabsList
          ><TabsTrigger value="mapping"><Columns3 :size="14" />配置映射</TabsTrigger
          ><TabsTrigger value="preview"><Scan :size="14" />语义预览</TabsTrigger></TabsList
        ></Tabs
      ><span v-if="isExport" class="section-title">取数与目标位置</span
      ><span class="muted"
        >{{ store.profile.name }} · {{ store.profile.dimensions.length }} 个维度<span
          class="editor-version"
        >
          / v{{ spec.revision }}</span
        ></span
      >
    </div>
    <div v-if="isExport" class="notice">
      <FileSpreadsheet
        :size="16"
      />此处为导出交互演示布局，非用户提供的报送模板；显示取数绑定，不执行数据库查询。
    </div>
    <div v-else class="editor-filebar">
      <FileSpreadsheet :size="16" /><span>{{ sample.filename }}</span
      ><Badge variant="secondary">数值已替换</Badge
      ><span class="ml-auto muted">3 张表 · 本轮配置经营数据</span>
    </div>
    <div v-if="isExport" class="export-editor-layout">
      <div class="panel">
        <div class="panel-header">
          <strong>报送模板 · 演示布局</strong><Badge variant="outline">固定行列</Badge>
        </div>
        <div class="table-wrap">
          <table class="excel-grid export-grid">
            <thead>
              <tr>
                <th></th>
                <th>A</th>
                <th>B</th>
                <th>C</th>
              </tr>
              <tr>
                <th>1</th>
                <th>主体</th>
                <th>{{ mapping.exportMetric || '待选指标' }}</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(company, i) in mapping.companies?.length
                  ? mapping.companies
                  : ['待配置主体']"
                :key="company"
              >
                <th>{{ i + 2 }}</th>
                <td>{{ company }}</td>
                <td class="value-cell">取数填充</td>
                <td class="ignored-cell">保留原内容</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="editor-sheet-footer">
          <span>金额格由引擎填写</span><span>备注保留 · 不自动扩行</span>
        </div>
        <div class="p-5">
          <div class="notice">
            主体以自身实存值取数；控股关系不会自动触发汇总。展示值仅表示目标位置。
          </div>
        </div>
      </div>
      <div class="panel p-5 space-y-4">
        <h3 class="section-title">取数语义</h3>
        <div class="field">
          <label for="export-metric">指标</label
          ><select id="export-metric" v-model="mapping.exportMetric" class="input" @change="touch">
            <option value="">请选择</option>
            <option v-for="m in members('metric')" :key="m">{{ m }}</option>
          </select>
        </div>
        <div class="field">
          <label for="export-window">口径</label
          ><select id="export-window" v-model="mapping.exportWindow" class="input" @change="touch">
            <option value="">请选择</option>
            <option v-for="m in members('window')" :key="m">{{ m }}</option>
          </select>
        </div>
        <div class="field">
          <label>主体范围 · 自身</label
          ><label v-for="m in members('company')" :key="m" class="checkbox-line"
            ><input type="checkbox" v-model="mapping.companies" :value="m" @change="touch" />{{
              m
            }}</label
          >
        </div>
        <div class="field">
          <label for="formula-policy">已有公式</label
          ><select id="formula-policy" v-model="mapping.formulaMode" class="input" @change="touch">
            <option value="preserve">保留公式，用户确认后在 Excel 重算</option>
            <option value="replace">明确替换为引擎填值</option>
          </select>
        </div>
        <p class="help-text">
          演示布局没有实际公式，此处仅表达处理选择。忽略区域保留原内容，不等同于清空。
        </p>
      </div>
    </div>
    <template v-else>
      <div v-if="screen === 'mapping'" class="mapping-layout">
        <section class="panel mapping-canvas">
          <div class="grid-toolbar">
            <Button
              variant="outline"
              size="sm"
              :class="{ 'ring-2 ring-primary/30': rangeMode }"
              @click="rangeMode = !rangeMode"
              ><Scan :size="14" />{{ rangeMode ? '请拖选范围' : '圈定区块' }}</Button
            ><Button variant="ghost" size="sm" @click="hideSelection"
              ><EyeOff :size="14" />屏蔽</Button
            ><Button variant="ghost" size="sm" @click="restore"><RotateCcw :size="14" />恢复</Button
            ><select
              v-model="month"
              aria-label="预览月份"
              class="input preview-month"
              @change="page = 0"
            >
              <option value="">全部期间</option>
              <option v-for="m in months" :key="m">{{ m }}</option>
            </select>
          </div>
          <div class="grid-range">
            <Badge variant="secondary">区块 1</Badge
            ><Input
              v-model="mapping.range"
              aria-label="区块范围"
              class="range-input"
              @change="touch"
            /><label class="checkbox-line"
              ><input v-model="mapping.dynamic" type="checkbox" @change="touch" />动态行</label
            ><span class="muted">从起始行到有效内容末尾</span>
          </div>
          <div class="excel-scroll">
            <table class="excel-grid" @mouseleave="drag = null">
              <thead>
                <tr>
                  <th></th>
                  <th
                    v-for="(l, c) in letters"
                    :key="l"
                    :class="{ 'selected-header': selected.c === c }"
                  >
                    <button @click="chooseColumn(c)" :aria-label="`选择 ${l} 列`">{{ l }}</button>
                  </th>
                </tr>
                <tr>
                  <th>1</th>
                  <th v-for="(h, c) in sample.headers" :key="h" @click="chooseColumn(c)">
                    <strong>{{ h }}</strong
                    ><small>{{ roleNames[mapping.columns[c].role] }}</small>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in visibleRows" :key="row.row">
                  <th>{{ row.row }}</th>
                  <td
                    v-for="(v, c) in row.cells"
                    :key="c"
                    tabindex="0"
                    :aria-label="`${letters[c]}${row.row}`"
                    :class="{
                      'value-cell': mapping.columns[c].role === 'value',
                      'dimension-cell': ['company', 'metric', 'period'].includes(
                        mapping.columns[c].role,
                      ),
                      'ignored-cell': ignored(row.row, c),
                      'outside-cell': !inBlock(row.row, c),
                      'selected-cell': selected.c === c && (!selected.r || selected.r === row.row),
                      'incomplete-cell':
                        mapping.columns[c].role === 'value' && !mapping.columns[c].window,
                      'exception-cell': mapping.exceptions[letters[c] + row.row],
                      'rect-cell':
                        selectionRect &&
                        c >= selectionRect.c1 &&
                        c <= selectionRect.c2 &&
                        row.row >= selectionRect.r1 &&
                        row.row <= selectionRect.r2,
                    }"
                    @mousedown.prevent="pointerStart(row.row, c)"
                    @mouseup="pointerEnd(row.row, c)"
                    @keydown.enter="selectCell(row.row, c)"
                  >
                    {{
                      raw(row.row, c) === ''
                        ? '—'
                        : typeof v === 'number'
                          ? Number(raw(row.row, c)).toLocaleString('zh-CN', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })
                          : raw(row.row, c)
                    }}<span v-if="mapping.exceptions[letters[c] + row.row]" class="exception-mark"
                      >◇</span
                    >
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="editor-sheet-tabs">
            <strong>经营数据</strong><span>核验明细</span><span>合并抵销</span
            ><span class="ml-auto muted">后两张表暂不配置</span>
          </div>
          <div class="editor-sheet-footer">
            <div class="grid-legend">
              <span class="legend-dim">维度</span><span class="legend-value">值</span
              ><span class="legend-warning">待补齐</span><span>灰色为屏蔽</span>
            </div>
            <div class="pagination">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="上一页"
                :disabled="page === 0"
                @click="page--"
                ><ChevronLeft :size="14" /></Button
              ><span>{{ page + 1 }} / {{ Math.max(1, Math.ceil(rows.length / 12)) }}</span
              ><Button
                variant="ghost"
                size="icon-sm"
                aria-label="下一页"
                :disabled="(page + 1) * 12 >= rows.length"
                @click="page++"
                ><ChevronRight :size="14"
              /></Button>
            </div>
          </div>
        </section>
        <aside class="panel mapping-inspector">
          <div class="inspector-tabs">
            <button
              v-for="t in [
                ['binding', '选区设置'],
                ['coordinate', '完整语义'],
                ['defaults', '区块默认'],
              ]"
              :key="t[0]"
              :class="{ active: inspector === t[0] }"
              @click="inspector = t[0]"
            >
              {{ t[1] }}
            </button>
          </div>
          <div class="inspector-content">
            <template v-if="inspector === 'binding'"
              ><div class="inspector-heading">
                <h3>{{ letters[selected.c] }}{{ selected.r || ' 列' }}</h3>
                <Badge variant="outline">{{ selected.r ? '单元格' : '整列' }}</Badge>
              </div>
              <p class="help-text">列设置复用到每一行。局部差异使用单元格例外。</p>
              <div class="field">
                <label for="column-role">用途</label
                ><select id="column-role" v-model="selectedRole.role" class="input" @change="touch">
                  <option v-for="(name, id) in roleNames" :key="id" :value="id">{{ name }}</option>
                </select>
              </div>
              <div v-if="selectedRole.role === 'value'" class="field">
                <label for="column-window">值对应的口径</label
                ><select
                  id="column-window"
                  v-model="selectedRole.window"
                  class="input"
                  @change="touch"
                >
                  <option value="">请选择口径</option>
                  <option v-for="m in members('window')" :key="m">{{ m }}</option>
                </select>
                <p class="help-text">“本月累计”需要业务确认，不自动解释为单月。</p>
              </div>
              <div v-if="selectedRole.role === 'ignore'" class="field">
                <label for="ignore-reason">忽略原因</label
                ><Input
                  id="ignore-reason"
                  v-model="selectedRole.reason"
                  @update:model-value="touch"
                />
              </div>
              <div class="inspector-divider"></div>
              <h4 class="section-title">必需维度的来源</h4>
              <div v-for="(name, id) in labels" :key="id" class="source-row">
                <span>{{ name }}</span
                ><strong>{{
                  ['company', 'metric', 'period'].includes(id)
                    ? source(id, visibleRows[0]?.row || 2).source
                    : id === 'window'
                      ? selectedRole.window || '待配置'
                      : mapping[id] || '待配置'
                }}</strong>
              </div>
              <Button
                variant="ghost"
                class="w-full justify-start text-primary mt-3"
                size="sm"
                @click="inspector = 'defaults'"
                ><SlidersHorizontal :size="14" />补充区块默认<ArrowRight :size="14" /></Button
            ></template>
            <template v-else-if="inspector === 'coordinate'"
              ><div class="inspector-heading">
                <h3>{{ letters[selected.c] }}{{ selected.r || visibleRows[0]?.row }} · 完整语义</h3>
              </div>
              <template
                v-if="
                  selectedRole.role === 'value' &&
                  !ignored(selected.r || visibleRows[0]?.row || 2, selected.c)
                "
                ><div v-for="(name, id) in labels" :key="id" class="coordinate-row">
                  <span>{{ name }}</span>
                  <div>
                    <strong :class="{ 'text-amber-700': !selectedCoords[id].value }">{{
                      selectedCoords[id].value || '待补齐'
                    }}</strong
                    ><small>{{ selectedCoords[id].source }}</small>
                  </div>
                </div>
                <div class="notice mt-4">
                  源值 {{ raw(selected.r || visibleRows[0]?.row || 2, selected.c) }}<br />源单位
                  {{ source('unit', selected.r || visibleRows[0]?.row || 2).value || '未配置' }}
                </div>
                <p class="help-text">这里只解释来源和绑定；未执行单位换算、窗口编译或业务计算。</p>
                <Button
                  v-if="selected.r"
                  variant="outline"
                  size="sm"
                  @click="openException"
                  >设置单元格例外</Button
                ><Button
                  v-if="selected.r && mapping.exceptions[letters[selected.c] + selected.r]"
                  variant="ghost"
                  size="sm"
                  @click="removeException"
                  >移除例外</Button
                ></template
              >
              <div v-else class="empty-state compact">
                <MousePointer2 :size="23" />
                <p>点击值格，查看它的完整业务含义。</p>
              </div></template
            >
            <template v-else
              ><h3 class="section-title mb-2">区块默认来源</h3>
              <p class="help-text">
                行内来源优先。固定来源用于补齐模板没有提供的维度，不能掩盖数据错误。
              </p>
              <div v-for="id in ['company', 'metric']" :key="id" class="field">
                <label :for="'fixed-' + id">固定{{ labels[id] }} · 无来源时</label
                ><select
                  :id="'fixed-' + id"
                  class="input"
                  :value="mapping.fixed?.[id] || ''"
                  @change="setFixedSource(id, $event.target.value)"
                >
                  <option value="">不设置</option>
                  <option v-for="m in members(id)" :key="m">{{ m }}</option>
                </select>
              </div>
              <div class="field">
                <label for="period-source">缺省期数方式</label
                ><select
                  id="period-source"
                  v-model="mapping.periodMode"
                  class="input"
                  @change="touch"
                >
                  <option value="column">从期数列读取</option>
                  <option value="fixed">固定日期</option>
                  <option value="auto">当前月减若干月</option>
                </select>
                <p v-if="mapping.columns.some((x) => x.role === 'period')" class="help-text">
                  当前仍从期数列逐行读取，缺省规则不覆盖该列。
                </p>
              </div>
              <Input
                v-if="mapping.periodMode === 'fixed'"
                v-model="mapping.periodValue"
                type="month"
                aria-label="固定期数"
                @update:model-value="touch"
              /><Input
                v-if="mapping.periodMode === 'auto'"
                v-model="mapping.monthOffset"
                type="number"
                min="0"
                max="120"
                aria-label="减去月数"
                @update:model-value="touch"
              />
              <p class="help-text">默认金额统一为人民币；外币换算属于后续导入转换。</p></template
            >
            <div class="inspector-divider"></div>
            <h4 class="section-title mb-2">引用语义规则</h4>
            <p class="help-text">仅记录显式依赖供复核演示，尚未执行计算。</p>
            <label v-for="rule in store.profile.semantics" :key="rule.id" class="checkbox-line"
              ><input
                type="checkbox"
                :checked="mapping.semanticIds?.includes(rule.id)"
                @change="toggleSemantic(rule.id, $event.target.checked)"
              />{{ rule.name }}</label
            >
            <div class="inspector-divider"></div>
            <Button variant="outline" size="sm" class="w-full" @click="memberOpen = true"
              ><Plus :size="14" />新增成员或别称</Button
            >
            <p v-if="pending.length" class="help-text">
              {{ pending.length }} 项目录变更待随规格确认。
            </p>
          </div>
        </aside>
      </div>
      <div v-else class="panel">
        <div class="panel-header">
          <div>
            <strong>完整坐标预览</strong>
            <p class="help-text">
              当前 {{ month || '全部期间' }} · {{ facts.length }} 个非空值，展示前 60 条。
            </p>
          </div>
          <Badge variant="outline">不写数据库</Badge>
        </div>
        <div class="table-wrap">
          <table class="data-table preview-data">
            <thead>
              <tr>
                <th>源格</th>
                <th v-for="name in labels" :key="name">{{ name }}</th>
                <th>源值</th>
                <th>源单位</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in facts.slice(0, 60)" :key="`${f.c}-${f.r}`">
                <td>{{ letters[f.c] }}{{ f.r }}</td>
                <td
                  v-for="(name, id) in labels"
                  :key="id"
                  :class="{ 'warning-text': !f.coord[id].value }"
                >
                  {{ f.coord[id].value || '待补齐' }}
                </td>
                <td>{{ f.value }}</td>
                <td>{{ f.unit }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="p-4 help-text">
          空值跳过；原型不验证数值业务正确性。去年同期的期间平移及窗口起点由后续引擎适配实现。
        </div>
      </div>
    </template>
    <section class="panel diagnostics-panel">
      <div class="panel-header">
        <div class="flex items-center gap-2">
          <strong>配置检查</strong
          ><Badge :variant="diagnostics.length ? 'outline' : 'secondary'">{{
            diagnostics.length ? diagnostics.length + ' 项待处理' : '来源已完整'
          }}</Badge>
        </div>
        <Button
          v-if="!isExport"
          variant="ghost"
          size="sm"
          @click="injectedError = !injectedError"
          >{{ injectedError ? '清除演示错误' : '模拟期数缺失' }}</Button
        >
      </div>
      <div v-if="!diagnostics.length" class="diagnostic-success">
        <CheckCircle2 :size="16" />配置来源检查通过，可审阅确认。业务计算与引擎兼容性尚未验证。
      </div>
      <div v-for="(d, i) in diagnostics.slice(0, 6)" :key="i" class="diagnostic-row">
        <AlertCircle :size="16" />
        <div>
          <strong>{{ d.message }}</strong>
          <p>{{ d.detail }}</p>
        </div>
        <Button variant="ghost" size="sm" @click="focusIssue(d)"
          >处理<ArrowRight :size="13"
        /></Button>
      </div>
    </section>
    <Dialog v-model:open="reviewOpen"
      ><DialogContent class="max-h-[85vh] overflow-auto"
        ><DialogHeader
          ><DialogTitle>审阅并确认规格</DialogTitle
          ><DialogDescription
            >本次只发布浏览器内的演示配置，让它出现在日常报送中。不会生成正式 YAML
            或写入业务数据。</DialogDescription
          ></DialogHeader
        >
        <div class="review-summary">
          <div>
            <span>规格</span><strong>{{ spec.title }}</strong>
          </div>
          <div>
            <span>profile</span><strong>{{ store.profile.name }}</strong>
          </div>
          <div>
            <span>目录新增</span><strong>{{ pending.length }} 项</strong>
          </div>
          <div>
            <span>方向</span><strong>{{ isExport ? '导出' : '接入' }}</strong>
          </div>
        </div>
        <div class="notice">
          {{
            isExport
              ? '确认取数指标、主体范围和公式策略。'
              : '确认列用途、口径、单位来源及忽略范围。'
          }}
          未完成正式引擎验收。
        </div>
        <DialogFooter
          ><Button variant="outline" @click="download"><Download :size="14" />原型 JSON</Button
          ><Button variant="outline" @click="reviewOpen = false">继续修改</Button
          ><Button @click="confirm">确认演示发布</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
    <Dialog v-model:open="memberOpen"
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>新增成员或别称</DialogTitle
          ><DialogDescription
            >变更先进入当前规格草稿，发布确认后才加入浏览器内的演示目录。</DialogDescription
          ></DialogHeader
        >
        <div class="field">
          <label for="new-dim">维度</label
          ><select id="new-dim" v-model="memberKind" class="input">
            <option value="company">主体</option>
            <option value="metric">指标</option>
          </select>
        </div>
        <div class="field">
          <label for="new-member-name">名称</label
          ><Input id="new-member-name" v-model="memberName" />
        </div>
        <div class="field">
          <label for="member-action">方式</label
          ><select id="member-action" v-model="memberAction" class="input">
            <option value="new">新建成员</option>
            <option value="alias">添加为现有成员的别称</option>
          </select>
        </div>
        <div v-if="memberAction === 'alias'" class="field">
          <label for="alias-target">现有成员</label
          ><select id="alias-target" v-model="aliasOf" class="input">
            <option value="">请选择</option>
            <option
              v-for="m in dimension(memberKind)?.members.filter((m) => m.active)"
              :key="m.id"
              :value="m.id"
            >
              {{ m.name }}
            </option>
          </select>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="memberOpen = false">取消</Button
          ><Button @click="savePendingMember">加入草稿</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
    <Dialog v-model:open="exceptionOpen"
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>{{ letters[selected.c] }}{{ selected.r }} · 单元格例外</DialogTitle
          ><DialogDescription
            >只覆盖此值格的一个维度，其余设置继续继承。</DialogDescription
          ></DialogHeader
        >
        <div class="field">
          <label for="exception-dim">维度</label
          ><select
            id="exception-dim"
            v-model="exceptionDim"
            class="input"
            @change="exceptionValue = ''"
          >
            <option v-for="(name, id) in labels" :key="id" :value="id">{{ name }}</option>
          </select>
        </div>
        <div class="field">
          <label for="exception-value">成员</label
          ><select id="exception-value" v-model="exceptionValue" class="input">
            <option value="">请选择</option>
            <option v-for="m in members(exceptionDim)" :key="m">{{ m }}</option>
          </select>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="exceptionOpen = false">取消</Button
          ><Button @click="saveException" :disabled="!exceptionValue"
            >保存例外</Button
          ></DialogFooter
        ></DialogContent
      ></Dialog
    >
  </template>
</template>
