<script setup>
import { computed, ref, watch } from 'vue'
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Database,
  Download,
  FileInput,
  FileOutput,
  FileSpreadsheet,
  Link2,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Upload,
  XCircle,
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
import sample from '@/demo/sample.js'
import { addMember, addRecord, navigate, notify, openEditor, resolveMember, store } from '@/store'

const mode = ref('ingest')
const demoPeriods = [...new Set(sample.rows.map((row) => row[1]).filter(Boolean))].sort()
const latestDemoPeriod = demoPeriods[demoPeriods.length - 1] || '2026-06'

const publishedIngestSpecs = computed(() =>
  store.specs.filter(
    (spec) =>
      spec.profileId === store.profile.id &&
      spec.direction === 'ingest' &&
      spec.status === 'published' &&
      !spec.ontologyReviews?.length,
  ),
)
const publishedExportSpecs = computed(() =>
  store.specs.filter(
    (spec) =>
      spec.profileId === store.profile.id &&
      spec.direction === 'export' &&
      spec.status === 'published' &&
      !spec.ontologyReviews?.length,
  ),
)

const selectedIngestId = ref('')
const selectedExportId = ref('')

watch(
  publishedIngestSpecs,
  (specs) => {
    if (!specs.some((spec) => spec.id === selectedIngestId.value)) {
      selectedIngestId.value = specs[0]?.id || ''
    }
  },
  { immediate: true },
)
watch(
  publishedExportSpecs,
  (specs) => {
    if (!specs.some((spec) => spec.id === selectedExportId.value)) {
      selectedExportId.value = specs[0]?.id || ''
    }
  },
  { immediate: true },
)

const selectedIngestSpec = computed(
  () => publishedIngestSpecs.value.find((spec) => spec.id === selectedIngestId.value) || null,
)
const selectedExportSpec = computed(
  () => publishedExportSpecs.value.find((spec) => spec.id === selectedExportId.value) || null,
)

const ingestPeriodFilter = ref('')
const simulateUnknown = ref(false)
const simulateMissingPeriod = ref(false)
const simulateOverlap = ref(false)
const demoChecked = ref(false)
const checkedSignature = ref('')
const overlapChoices = ref({})
const unknownInput = ref('')
const aliasTarget = ref('')
const confirmOpen = ref(false)

const activeCompanies = computed(
  () =>
    store.profile.dimensions
      .find((dimension) => dimension.id === 'company')
      ?.members.filter((member) => member.active) || [],
)

watch(
  activeCompanies,
  (members) => {
    if (!members.some((member) => member.id === aliasTarget.value)) {
      aliasTarget.value = members[0]?.id || ''
    }
  },
  { immediate: true },
)

const filteredDemoRows = computed(() =>
  sample.rows.filter((row) => !ingestPeriodFilter.value || row[1] === ingestPeriodFilter.value),
)
const targetDemoPeriod = computed(() => ingestPeriodFilter.value || latestDemoPeriod)

const demoIngestRows = computed(() => {
  const rows = filteredDemoRows.value.map((values, index) => ({
    id: `source-${index}`,
    values,
    company: values[0],
    period: values[1],
    metric: values[2],
    variant: 'source',
    sourceLabel: '内置演示文件',
  }))

  if (simulateUnknown.value) {
    const values = [
      '演示新主体',
      targetDemoPeriod.value,
      '营业总收入',
      '万元',
      88.8,
      '',
      '',
      16.6,
      '',
    ]
    rows.push({
      id: 'simulated-unknown-subject',
      values,
      company: values[0],
      period: values[1],
      metric: values[2],
      variant: 'unknown',
      sourceLabel: '模拟未知主体',
    })
  }

  if (simulateMissingPeriod.value) {
    const values = ['子公司A', '', '营业总收入', '万元', 66.6, '', '', 12.3, '']
    rows.push({
      id: 'simulated-missing-period',
      values,
      company: values[0],
      period: values[1],
      metric: values[2],
      variant: 'missing-period',
      sourceLabel: '模拟期数缺失',
    })
  }

  if (simulateOverlap.value) {
    const anchor =
      filteredDemoRows.value.find((row) => row[1] === targetDemoPeriod.value) ||
      filteredDemoRows.value[0]
    if (anchor) {
      const values = [...anchor]
      const baseValue = Number(values[4])
      values[4] = Number.isFinite(baseValue) ? Number((baseValue + 10.07).toFixed(2)) : 10.07
      rows.push({
        id: 'simulated-overlap',
        values,
        company: values[0],
        period: values[1],
        metric: values[2],
        variant: 'overlap',
        sourceLabel: '模拟重叠替代值',
      })
    }
  }

  return rows
})

const coordinateOf = (row) => `${row.company}\u0000${row.period}\u0000${row.metric}`

const unknownSubjects = computed(() => [
  ...new Set(
    demoIngestRows.value
      .map((row) => row.company)
      .filter((company) => !resolveMember('company', company)),
  ),
])
const missingPeriodRows = computed(() => demoIngestRows.value.filter((row) => !row.period))
const overlapGroups = computed(() => {
  const groups = new Map()
  for (const row of demoIngestRows.value) {
    const key = coordinateOf(row)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({ key, rows }))
})

watch(
  unknownSubjects,
  (subjects) => {
    if (subjects[0] && !subjects.includes(unknownInput.value)) {
      unknownInput.value = subjects[0]
    }
  },
  { immediate: true },
)

const overlapResolved = computed(() =>
  overlapGroups.value.every((group) =>
    group.rows.some((row) => overlapChoices.value[group.key] === row.id),
  ),
)
const unresolvedOverlapCount = computed(
  () =>
    overlapGroups.value.filter(
      (group) => !group.rows.some((row) => overlapChoices.value[group.key] === row.id),
    ).length,
)

const sourceRecordCount = computed(() => demoIngestRows.value.length)
const effectiveRecordCount = computed(
  () => new Set(demoIngestRows.value.map((row) => coordinateOf(row))).size,
)
const blockerCount = computed(
  () =>
    unknownSubjects.value.length + missingPeriodRows.value.length + unresolvedOverlapCount.value,
)

const currentDemoSignature = computed(() =>
  [
    selectedIngestId.value,
    ingestPeriodFilter.value,
    simulateUnknown.value ? 'unknown' : '',
    simulateMissingPeriod.value ? 'missing' : '',
    simulateOverlap.value ? 'overlap' : '',
  ].join('|'),
)

watch(
  currentDemoSignature,
  () => {
    demoChecked.value = false
    checkedSignature.value = ''
    overlapChoices.value = {}
  },
  { flush: 'sync' },
)

const checksCurrent = computed(
  () =>
    Boolean(selectedIngestSpec.value) &&
    demoChecked.value &&
    checkedSignature.value === currentDemoSignature.value,
)
const canConfirm = computed(() => checksCurrent.value && blockerCount.value === 0)
const checkStateLabel = computed(() => {
  if (!checksCurrent.value) return '等待演示检查'
  if (blockerCount.value) return `${blockerCount.value} 项待处理`
  return '演示检查通过'
})

const periodScopeLabel = computed(() => {
  if (ingestPeriodFilter.value) return `${ingestPeriodFilter.value} · 单月演示子集`
  return `行内“期数”列 · ${demoPeriods.length} 个期间`
})

function formatNumber(value) {
  if (value === '' || value === null || value === undefined) return '空值'
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString('zh-CN') : String(value)
}

function runDemoCheck() {
  if (!selectedIngestSpec.value) {
    notify('请先选择一个已发布的接入规格。')
    return
  }
  overlapChoices.value = {}
  demoChecked.value = true
  checkedSignature.value = currentDemoSignature.value
  notify(`演示检查完成：${sourceRecordCount.value} 条来源记录，未读取上传文件或数据库。`)
}

function chooseOverlap(groupKey, rowId) {
  overlapChoices.value = { ...overlapChoices.value, [groupKey]: rowId }
}

function resolveAsNewMember() {
  const name = unknownInput.value.trim()
  if (!name) {
    notify('请输入要新建的主体名称。')
    return
  }
  try {
    addMember('company', name)
    notify(`已在当前浏览器演示 profile 中新建主体“${name}”。`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '新建主体失败，请检查名称。')
  }
}

function resolveAsAlias() {
  const name = unknownInput.value.trim()
  if (!name) {
    notify('请输入要添加的别称。')
    return
  }
  if (!aliasTarget.value) {
    notify('请选择一个已有主体作为别称目标。')
    return
  }
  try {
    addMember('company', name, aliasTarget.value)
    notify(`已将“${name}”作为别称加入当前浏览器演示 profile。`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '添加别称失败，请检查名称。')
  }
}

function restoreDemoPeriods() {
  simulateMissingPeriod.value = false
  overlapChoices.value = {}
  notify('已恢复演示数据并移除期数缺失模拟项，请重新运行检查。')
}

function openConfirm() {
  if (!canConfirm.value) return
  confirmOpen.value = true
}

function confirmDemoImport() {
  if (!canConfirm.value || !selectedIngestSpec.value) return
  addRecord({
    title: `${selectedIngestSpec.value.title} · 演示`,
    direction: 'ingest',
    period: ingestPeriodFilter.value || '多期间（来自行内）',
    status: 'success',
    details: `浏览器内模拟记录；来源 ${sourceRecordCount.value} 条，保留 ${effectiveRecordCount.value} 条来源记录；未读取上传文件，未写入业务数据库。`,
    count: effectiveRecordCount.value,
    sourceFile: sample.filename,
    sourceRows: sourceRecordCount.value,
    simulated: true,
  })
  confirmOpen.value = false
  notify('已添加浏览器内演示记录；没有真实入库。')
  navigate('records')
}

const exportPeriod = ref(latestDemoPeriod)
const exportGenerated = ref(false)
const generatedExportSignature = ref('')

watch(
  () => [selectedExportId.value, exportPeriod.value].join('|'),
  () => {
    exportGenerated.value = false
    generatedExportSignature.value = ''
  },
)

const exportSignature = computed(() => [selectedExportId.value, exportPeriod.value].join('|'))
const exportPreviewCurrent = computed(
  () =>
    Boolean(selectedExportSpec.value) &&
    exportGenerated.value &&
    generatedExportSignature.value === exportSignature.value,
)
const exportWindowIndex = computed(() =>
  sample.headers.indexOf(selectedExportSpec.value?.mapping?.exportWindow || ''),
)
const exportRows = computed(() => {
  const spec = selectedExportSpec.value
  if (!spec) return []
  const companies = spec.mapping?.companies || []
  const metric = spec.mapping?.exportMetric || ''
  return companies.map((company) => {
    const raw = sample.rows.find(
      (row) => row[0] === company && row[1] === exportPeriod.value && row[2] === metric,
    )
    return {
      company,
      period: exportPeriod.value,
      metric,
      window: spec.mapping?.exportWindow || '未指定',
      unit: raw?.[3] || '—',
      value: raw && exportWindowIndex.value >= 0 ? raw[exportWindowIndex.value] : '—',
    }
  })
})

function generateExportPreview() {
  if (!selectedExportSpec.value) {
    notify('请先选择一个已发布的导出规格。')
    return
  }
  exportGenerated.value = true
  generatedExportSignature.value = exportSignature.value
  notify(`已生成 ${exportPeriod.value} 的浏览器内演示预览。`)
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replaceAll('"', '""')}"`
}

function downloadDemoCsv() {
  if (!exportPreviewCurrent.value || !exportRows.value.length) {
    notify('请先生成可用的演示预览。')
    return
  }
  const header = ['主体', '期间', '指标', '口径', '单位', '演示值', '说明']
  const lines = exportRows.value.map((row) => [
    row.company,
    row.period,
    row.metric,
    row.window,
    row.unit,
    row.value,
    '浏览器内演示 CSV，不能作为正式 Excel 报送验收',
  ])
  const csv = `\uFEFF${[header, ...lines].map((row) => row.map(csvCell).join(',')).join('\r\n')}`
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `bilite-演示导出-${exportPeriod.value}.csv`
  link.click()
  URL.revokeObjectURL(url)
  notify('已下载浏览器内演示 CSV；没有生成真实 Excel 报表。')
}
</script>

<template>
  <section class="reports-page">
    <header class="page-header">
      <div>
        <div class="eyebrow">使用 / 日常报送</div>
        <h1 class="page-title">月度调用</h1>
        <p class="page-description">
          选择已发布规格，用内置演示数据检查接入或导出。不会读取任意上传文件，也不会写入数据库。
        </p>
      </div>
      <Badge variant="outline" class="prototype-status">
        <ShieldCheck :size="13" />
        浏览器内演示
      </Badge>
    </header>

    <div class="entry-switch" role="tablist" aria-label="选择报送方向">
      <button
        class="entry-option"
        :class="{ active: mode === 'ingest' }"
        role="tab"
        :aria-selected="mode === 'ingest'"
        @click="mode = 'ingest'"
      >
        <span class="entry-icon ingest"><FileInput :size="22" /></span>
        <span>
          <strong>接入</strong>
          <small>检查源数据，模拟形成接入记录</small>
        </span>
        <ChevronRight :size="18" />
      </button>
      <button
        class="entry-option"
        :class="{ active: mode === 'export' }"
        role="tab"
        :aria-selected="mode === 'export'"
        @click="mode = 'export'"
      >
        <span class="entry-icon export"><FileOutput :size="22" /></span>
        <span>
          <strong>导出</strong>
          <small>预览指定期间，下载演示 CSV</small>
        </span>
        <ChevronRight :size="18" />
      </button>
    </div>

    <template v-if="mode === 'ingest'">
      <div class="notice notice-warning">
        <AlertTriangle :size="17" />
        <span
          ><strong>演示边界：</strong
          >页面只使用内置演示文件，数值已替换为原型演示值。确认仅保存演示记录，不执行真实入库。</span
        >
      </div>

      <div v-if="!publishedIngestSpecs.length" class="panel empty-state">
        <FileInput :size="30" />
        <h2>没有可调用的接入规格</h2>
        <p>仅列当前 profile 中已发布的接入规格。请先完成配置并发布。</p>
        <Button variant="outline" @click="navigate('specs')">
          前往规格列表
          <ArrowRight :size="15" />
        </Button>
      </div>

      <div v-else class="ingest-layout">
        <div class="left-stack">
          <section class="panel">
            <div class="panel-header">
              <div>
                <span class="step-label">01 · 已发布规格</span>
                <h2>选择接入规格</h2>
              </div>
              <Badge variant="secondary">{{ publishedIngestSpecs.length }} 个可用</Badge>
            </div>
            <div class="spec-picker">
              <button
                v-for="spec in publishedIngestSpecs"
                :key="spec.id"
                class="spec-choice"
                :class="{ selected: selectedIngestId === spec.id }"
                @click="selectedIngestId = spec.id"
              >
                <span class="choice-mark">
                  <CheckCircle2 v-if="selectedIngestId === spec.id" :size="18" />
                  <span v-else></span>
                </span>
                <span class="choice-copy">
                  <strong>{{ spec.title }}</strong>
                  <small>{{ spec.description }}</small>
                </span>
                <Badge variant="outline">已发布</Badge>
              </button>
            </div>
            <Button
              v-if="selectedIngestSpec"
              variant="ghost"
              size="sm"
              class="inspect-spec"
              @click="openEditor(selectedIngestSpec.id)"
            >
              查看规格
              <ArrowRight :size="14" />
            </Button>
          </section>

          <section class="panel">
            <div class="panel-header">
              <div>
                <span class="step-label">02 · 演示输入</span>
                <h2>使用内置演示文件</h2>
              </div>
              <Badge variant="outline">只读</Badge>
            </div>

            <div class="demo-file-card">
              <span class="file-icon"><FileSpreadsheet :size="23" /></span>
              <div class="file-copy">
                <strong>{{ sample.filename }}</strong>
                <span>{{ sample.sheet }} · {{ sample.headers.length }} 列</span>
                <small>{{ sample.numericValues }}；本页不会打开任意上传文件。</small>
              </div>
              <Badge variant="secondary">内置样例</Badge>
            </div>

            <div class="field">
              <label for="ingest-period-filter">月筛选（可选）</label>
              <select
                id="ingest-period-filter"
                v-model="ingestPeriodFilter"
                class="input native-select"
              >
                <option value="">全部演示期间</option>
                <option v-for="period in demoPeriods" :key="period" :value="period">
                  {{ period }}
                </option>
              </select>
              <p class="field-help">
                期间来自每行“期数”列，不强制手选。选择
                <strong>2026-06</strong> 可把演示范围缩到单月。
              </p>
            </div>

            <div class="simulation-list" aria-label="模拟异常开关">
              <label class="simulation-row">
                <span>
                  <strong>模拟未知主体</strong>
                  <small>加入一个当前 profile 未登记的主体</small>
                </span>
                <input v-model="simulateUnknown" type="checkbox" />
              </label>
              <label class="simulation-row">
                <span>
                  <strong>模拟期数缺失</strong>
                  <small>保留空期间，不套用默认值或上一期</small>
                </span>
                <input v-model="simulateMissingPeriod" type="checkbox" />
              </label>
              <label class="simulation-row">
                <span>
                  <strong>模拟数据重叠</strong>
                  <small>制造同坐标双值，必须明确选择一个</small>
                </span>
                <input v-model="simulateOverlap" type="checkbox" />
              </label>
            </div>

            <Button class="primary-action run-button" @click="runDemoCheck">
              <RefreshCw :size="15" />
              运行演示检查
            </Button>
          </section>
        </div>

        <section class="panel check-panel">
          <div class="panel-header">
            <div>
              <span class="step-label">03 · 集中检查</span>
              <h2>检查结果</h2>
            </div>
            <span
              class="check-state"
              :class="{
                ready: checksCurrent && !blockerCount,
                blocked: checksCurrent && blockerCount,
              }"
            >
              <CheckCircle2 v-if="checksCurrent && !blockerCount" :size="15" />
              <XCircle v-else :size="15" />
              {{ checkStateLabel }}
            </span>
          </div>

          <div v-if="!checksCurrent" class="check-placeholder">
            <RefreshCw :size="25" />
            <strong>等待运行演示检查</strong>
            <p>检查后显示来源记录数、行内期间以及需要处理的问题。</p>
          </div>

          <template v-else>
            <div class="stats-grid">
              <div class="stat-card">
                <span>来源记录数</span>
                <strong>{{ sourceRecordCount }}</strong>
                <small>演示行，包含模拟异常项</small>
              </div>
              <div class="stat-card">
                <span>保留记录</span>
                <strong>{{ effectiveRecordCount }}</strong>
                <small>重叠来源按用户选择保留</small>
              </div>
              <div class="stat-card">
                <span>期间来源</span>
                <strong class="stat-text">{{ periodScopeLabel }}</strong>
                <small>来自行内“期数”列</small>
              </div>
            </div>

            <div class="source-strip">
              <CalendarDays :size="16" />
              <span>可选月筛选只影响演示子集；确认时记录实际检查范围。</span>
              <Badge variant="outline">{{ ingestPeriodFilter || '多期间' }}</Badge>
            </div>

            <div v-if="unknownSubjects.length" class="issue-card warning">
              <div class="issue-heading">
                <AlertTriangle :size="17" />
                <div>
                  <strong>未知主体 {{ unknownSubjects.length }}</strong>
                  <p>需要明确新建成员，或把名称作为已有主体的别称。</p>
                </div>
              </div>
              <div class="issue-body">
                <div class="unknown-tags">
                  <span v-for="subject in unknownSubjects" :key="subject">{{ subject }}</span>
                </div>
                <div class="field compact-field">
                  <label for="unknown-subject">待处理名称</label>
                  <Input
                    id="unknown-subject"
                    v-model="unknownInput"
                    placeholder="输入主体名称或别称"
                  />
                </div>
                <div class="field compact-field">
                  <label for="alias-target">别称目标</label>
                  <select id="alias-target" v-model="aliasTarget" class="input native-select">
                    <option v-for="member in activeCompanies" :key="member.id" :value="member.id">
                      {{ member.name }}
                    </option>
                  </select>
                </div>
                <div class="button-row">
                  <Button size="sm" @click="resolveAsNewMember">
                    <Plus :size="14" />
                    新建主体
                  </Button>
                  <Button variant="outline" size="sm" @click="resolveAsAlias">
                    <Link2 :size="14" />
                    添加为别称
                  </Button>
                </div>
              </div>
            </div>

            <div v-if="missingPeriodRows.length" class="issue-card danger">
              <div class="issue-heading">
                <XCircle :size="18" />
                <div>
                  <strong>期数缺失 {{ missingPeriodRows.length }}</strong>
                  <p>期数必须来自数据或明确修正；不会用默认值掩盖缺失项。</p>
                </div>
              </div>
              <div class="button-row issue-action">
                <Button variant="outline" size="sm" @click="restoreDemoPeriods">
                  <RotateCcw :size="14" />
                  恢复演示数据
                </Button>
              </div>
            </div>

            <div
              v-for="(group, index) in overlapGroups"
              :key="group.key"
              class="issue-card warning"
            >
              <div class="issue-heading">
                <AlertTriangle :size="17" />
                <div>
                  <strong>数据重叠 {{ index + 1 }}</strong>
                  <p>相同主体、期间、指标出现两条来源。请明确保留哪一行的本年累计值。</p>
                </div>
              </div>
              <div class="overlap-options" role="radiogroup" aria-label="选择重叠记录的有效值">
                <label
                  v-for="row in group.rows"
                  :key="row.id"
                  class="overlap-option"
                  :class="{ selected: overlapChoices[group.key] === row.id }"
                >
                  <input
                    type="radio"
                    :name="`overlap-${index}`"
                    :checked="overlapChoices[group.key] === row.id"
                    @change="chooseOverlap(group.key, row.id)"
                  />
                  <span>
                    <strong>{{ row.sourceLabel }}</strong>
                    <small>{{ row.company }} · {{ row.period }} · {{ row.metric }}</small>
                  </span>
                  <b>{{ formatNumber(row.values[4]) }}</b>
                </label>
              </div>
              <div class="resolution-note" :class="{ resolved: overlapChoices[group.key] }">
                <CheckCircle2 v-if="overlapChoices[group.key]" :size="15" />
                <AlertTriangle v-else :size="15" />
                {{
                  overlapChoices[group.key]
                    ? '重叠已明确处理：只保留 1 个有效值，不自动累加。'
                    : '尚未选择替代值，不能确认演示。'
                }}
              </div>
            </div>

            <div v-if="!blockerCount" class="pass-card">
              <CheckCircle2 :size="20" />
              <div>
                <strong>检查通过</strong>
                <p>
                  来源期间明确，主体可解析，重叠项已选择唯一有效值。下一步只会添加浏览器内演示记录。
                </p>
              </div>
            </div>

            <div class="confirm-zone">
              <div>
                <strong>{{ blockerCount ? '仍有未解决项' : '准备生成演示记录' }}</strong>
                <p>
                  {{
                    blockerCount
                      ? '全部问题处理完毕前，不能进入确认演示。'
                      : '确认后仅在操作记录页展示本次模拟。'
                  }}
                </p>
              </div>
              <Button class="primary-action" :disabled="!canConfirm" @click="openConfirm">
                确认演示
                <ArrowRight :size="15" />
              </Button>
            </div>
          </template>
        </section>
      </div>
    </template>

    <template v-else>
      <div class="notice">
        <Download :size="17" />
        <span
          ><strong>演示导出边界：</strong>这里生成浏览器内预览和 CSV 下载，不查询数据库、不填充
          Excel，也不能充当正式 Excel 报送验收。</span
        >
      </div>

      <div v-if="!publishedExportSpecs.length" class="panel empty-state">
        <FileOutput :size="30" />
        <h2>没有可调用的导出规格</h2>
        <p>仅列当前 profile 中已发布的导出规格。请先完成配置并发布。</p>
        <Button variant="outline" @click="navigate('specs')">
          前往规格列表
          <ArrowRight :size="15" />
        </Button>
      </div>

      <div v-else class="export-layout">
        <section class="panel">
          <div class="panel-header">
            <div>
              <span class="step-label">01 · 已发布规格</span>
              <h2>选择导出规格</h2>
            </div>
            <Badge variant="secondary">{{ publishedExportSpecs.length }} 个可用</Badge>
          </div>
          <div class="spec-picker">
            <button
              v-for="spec in publishedExportSpecs"
              :key="spec.id"
              class="spec-choice"
              :class="{ selected: selectedExportId === spec.id }"
              @click="selectedExportId = spec.id"
            >
              <span class="choice-mark">
                <CheckCircle2 v-if="selectedExportId === spec.id" :size="18" />
                <span v-else></span>
              </span>
              <span class="choice-copy">
                <strong>{{ spec.title }}</strong>
                <small>{{ spec.description }}</small>
              </span>
              <Badge variant="outline">已发布</Badge>
            </button>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <span class="step-label">02 · 演示参数</span>
              <h2>选择一个期间</h2>
            </div>
          </div>
          <div class="export-controls">
            <div class="field">
              <label for="export-period">期间</label>
              <select id="export-period" v-model="exportPeriod" class="input native-select">
                <option v-for="period in demoPeriods" :key="period" :value="period">
                  {{ period }}
                </option>
              </select>
              <p class="field-help">期间值直接用于筛选内置演示行。</p>
            </div>
            <Button class="primary-action" @click="generateExportPreview">
              <RefreshCw :size="15" />
              生成演示预览
            </Button>
          </div>
          <div v-if="selectedExportSpec" class="export-spec-summary">
            <span>
              <strong>指标</strong>
              {{ selectedExportSpec.mapping?.exportMetric || '未指定' }}
            </span>
            <span>
              <strong>口径</strong>
              {{ selectedExportSpec.mapping?.exportWindow || '未指定' }}
            </span>
            <span>
              <strong>主体</strong>
              {{ selectedExportSpec.mapping?.companies?.length || 0 }} 个
            </span>
          </div>
        </section>

        <section class="panel export-preview-panel">
          <div class="panel-header">
            <div>
              <span class="step-label">03 · 浏览器内预览</span>
              <h2>{{ exportPeriod }} 演示导出</h2>
            </div>
            <Button variant="outline" :disabled="!exportPreviewCurrent" @click="downloadDemoCsv">
              <Download :size="15" />
              下载演示 CSV
            </Button>
          </div>

          <div v-if="!exportPreviewCurrent" class="check-placeholder">
            <FileSpreadsheet :size="26" />
            <strong>等待生成演示预览</strong>
            <p>预览只使用内置演示行，不调用报表引擎。</p>
          </div>

          <div v-else class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>主体</th>
                  <th>期间</th>
                  <th>指标</th>
                  <th>口径</th>
                  <th>单位</th>
                  <th class="text-right">演示值</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in exportRows" :key="row.company">
                  <td>
                    <strong>{{ row.company }}</strong>
                  </td>
                  <td>{{ row.period }}</td>
                  <td>{{ row.metric }}</td>
                  <td>{{ row.window }}</td>
                  <td>{{ row.unit }}</td>
                  <td class="text-right value-cell">{{ formatNumber(row.value) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="notice notice-warning export-warning">
            <AlertTriangle :size="16" />
            <span
              >“下载演示 CSV”仅输出浏览器内演示结果。它没有套用 Excel
              模板、公式或数据库正式取数，不能作为正式报送验收。</span
            >
          </div>
        </section>
      </div>
    </template>

    <Dialog v-model:open="confirmOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认演示导入？</DialogTitle>
          <DialogDescription>
            这一步只在当前浏览器保存演示记录，不执行真实入库。
          </DialogDescription>
        </DialogHeader>
        <div class="confirm-summary">
          <div>
            <span>接入规格</span>
            <strong>{{ selectedIngestSpec?.title }}</strong>
          </div>
          <div>
            <span>检查范围</span>
            <strong>{{ ingestPeriodFilter || '多期间（来自行内）' }}</strong>
          </div>
          <div>
            <span>来源 / 保留记录</span>
            <strong>{{ sourceRecordCount }} / {{ effectiveRecordCount }}</strong>
          </div>
        </div>
        <div class="notice">
          <Database :size="16" />
          <span>确认后仅在“操作记录”中保存本次模拟。</span>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="confirmOpen = false">取消</Button>
          <Button class="primary-action" @click="confirmDemoImport"> 仅添加演示记录 </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>

<style scoped>
.reports-page {
  --teal-700: #0f766e;
  --teal-600: #0d9488;
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

.entry-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #f6f8f7;
}

.entry-option {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 16px;
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--slate-700);
  text-align: left;
  cursor: pointer;
  background: transparent;
  transition:
    border-color 160ms ease,
    background 160ms ease,
    box-shadow 160ms ease;
}

.entry-option:hover {
  background: rgba(255, 255, 255, 0.7);
}

.entry-option.active {
  border-color: #bfd9d3;
  color: var(--slate-950);
  background: #fff;
  box-shadow: 0 4px 14px rgba(26, 62, 54, 0.07);
}

.entry-option strong,
.entry-option small {
  display: block;
}

.entry-option strong {
  margin-bottom: 3px;
  font-size: 15px;
}

.entry-option small {
  color: var(--slate-500);
  font-size: 12px;
}

.entry-icon {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: 10px;
}

.entry-icon.ingest {
  color: #0f766e;
  background: #ccfbf1;
}

.entry-icon.export {
  color: #0e7490;
  background: #cffafe;
}

.ingest-layout {
  display: grid;
  grid-template-columns: minmax(290px, 0.78fr) minmax(0, 1.45fr);
  align-items: start;
  gap: 18px;
}

.left-stack,
.export-layout {
  display: grid;
  gap: 18px;
}

.left-stack .panel {
  padding: 18px;
}

.panel-header {
  gap: 12px;
}

.panel-header h2 {
  margin: 2px 0 0;
  font-size: 17px;
  letter-spacing: -0.01em;
}

.step-label,
.eyebrow {
  color: var(--teal-700);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.spec-picker {
  display: grid;
  gap: 9px;
  margin-top: 14px;
}

.spec-choice {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  text-align: left;
  color: var(--slate-700);
  cursor: pointer;
  background: #fff;
}

.spec-choice:hover,
.spec-choice.selected {
  border-color: #8dcfc2;
}

.spec-choice.selected {
  background: var(--teal-50);
  box-shadow: inset 3px 0 0 var(--teal-600);
}

.choice-mark {
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 50%;
  color: var(--teal-700);
}

.choice-mark > span {
  width: 15px;
  height: 15px;
  border: 1px solid #b4c2be;
  border-radius: 50%;
}

.choice-copy {
  min-width: 0;
}

.choice-copy strong,
.choice-copy small {
  display: block;
}

.choice-copy strong {
  overflow: hidden;
  color: var(--slate-950);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.choice-copy small {
  overflow: hidden;
  margin-top: 3px;
  color: var(--slate-500);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inspect-spec {
  margin-top: 8px;
  padding-left: 0;
  color: var(--teal-700);
}

.demo-file-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 11px;
  margin: 14px 0 16px;
  padding: 12px;
  border: 1px solid #dce5e2;
  border-radius: 10px;
  background: #f8faf9;
}

.file-icon {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: 9px;
  color: #047857;
  background: #d1fae5;
}

.file-copy {
  min-width: 0;
}

.file-copy strong,
.file-copy span,
.file-copy small {
  display: block;
}

.file-copy strong {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-copy span {
  margin-top: 2px;
  color: var(--slate-500);
  font-size: 12px;
}

.file-copy small {
  margin-top: 5px;
  color: #64748b;
  font-size: 11px;
  line-height: 1.45;
}

.field {
  display: grid;
  gap: 7px;
}

.field label {
  color: #34423e;
  font-size: 12px;
  font-weight: 700;
}

.native-select {
  width: 100%;
  height: 38px;
  padding: 0 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--slate-950);
  background: #fff;
}

.field-help {
  margin: 0;
  color: var(--slate-500);
  font-size: 11px;
  line-height: 1.55;
}

.simulation-list {
  display: grid;
  gap: 8px;
  margin: 16px 0;
}

.simulation-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 11px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: #fff;
}

.simulation-row strong,
.simulation-row small {
  display: block;
}

.simulation-row strong {
  font-size: 12px;
}

.simulation-row small {
  margin-top: 2px;
  color: var(--slate-500);
  font-size: 11px;
}

.simulation-row input {
  width: 16px;
  height: 16px;
  accent-color: var(--teal-600);
}

.primary-action {
  border-color: var(--teal-700);
  color: #fff;
  background: var(--teal-700);
}

.primary-action:hover {
  background: #115e59;
}

.run-button {
  width: 100%;
}

.check-panel {
  min-height: 560px;
  padding: 20px;
}

.check-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border-radius: 999px;
  color: #64748b;
  font-size: 11px;
  font-weight: 700;
  background: #f1f5f4;
}

.check-state.ready {
  color: #047857;
  background: #d1fae5;
}

.check-state.blocked {
  color: #b45309;
  background: #fef3c7;
}

.check-placeholder {
  display: grid;
  min-height: 240px;
  place-items: center;
  align-content: center;
  gap: 8px;
  color: #73817d;
  text-align: center;
}

.check-placeholder strong {
  color: #40504b;
  font-size: 14px;
}

.check-placeholder p {
  max-width: 360px;
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
  margin: 16px 0 10px;
}

.stat-card {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fafcfb;
}

.stat-card span,
.stat-card small {
  display: block;
  color: var(--slate-500);
  font-size: 10px;
}

.stat-card strong {
  display: block;
  margin: 5px 0;
  font-size: 22px;
}

.stat-card .stat-text {
  overflow: hidden;
  font-size: 13px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 8px;
  color: #52605c;
  font-size: 11px;
  background: #f5f8f7;
}

.source-strip span {
  flex: 1;
}

.issue-card {
  margin-top: 11px;
  padding: 13px;
  border: 1px solid #f0d39f;
  border-radius: 10px;
  background: #fffcf4;
}

.issue-card.danger {
  border-color: #f2c3c0;
  background: #fff8f7;
}

.issue-heading {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: start;
  gap: 8px;
  color: #a16207;
}

.issue-card.danger .issue-heading {
  color: #b42318;
}

.issue-heading strong {
  font-size: 13px;
}

.issue-heading p {
  margin: 3px 0 0;
  color: #6b6457;
  font-size: 11px;
  line-height: 1.55;
}

.issue-body {
  display: grid;
  gap: 9px;
  margin-top: 11px;
  padding-top: 11px;
  border-top: 1px dashed #eadab9;
}

.unknown-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.unknown-tags span {
  padding: 4px 7px;
  border: 1px solid #ead7ae;
  border-radius: 999px;
  color: #8a5709;
  font-size: 11px;
  background: #fff;
}

.compact-field {
  grid-template-columns: 105px minmax(0, 1fr);
  align-items: center;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.issue-action {
  margin-top: 10px;
}

.overlap-options {
  display: grid;
  gap: 7px;
  margin-top: 10px;
}

.overlap-option {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 9px;
  border: 1px solid #ead7ae;
  border-radius: 8px;
  cursor: pointer;
  background: #fff;
}

.overlap-option.selected {
  border-color: #5cb7a9;
  background: var(--teal-50);
}

.overlap-option input {
  accent-color: var(--teal-600);
}

.overlap-option span {
  min-width: 0;
}

.overlap-option strong,
.overlap-option small {
  display: block;
}

.overlap-option strong {
  font-size: 11px;
}

.overlap-option small {
  overflow: hidden;
  margin-top: 2px;
  color: var(--slate-500);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overlap-option b {
  color: #34423e;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.resolution-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  color: #a16207;
  font-size: 11px;
}

.resolution-note.resolved {
  color: #047857;
}

.pass-card {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  padding: 12px;
  border: 1px solid #b7e4d6;
  border-radius: 10px;
  color: #047857;
  background: #f0fdf4;
}

.pass-card strong {
  color: #166534;
  font-size: 13px;
}

.pass-card p {
  margin: 3px 0 0;
  color: #4d6d5d;
  font-size: 11px;
  line-height: 1.55;
}

.confirm-zone {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.confirm-zone strong {
  font-size: 13px;
}

.confirm-zone p {
  margin: 3px 0 0;
  color: var(--slate-500);
  font-size: 11px;
}

.export-layout {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.export-layout > .panel {
  padding: 18px;
}

.export-preview-panel {
  grid-column: 1 / -1;
}

.export-controls {
  display: flex;
  align-items: end;
  gap: 10px;
  margin-top: 14px;
}

.export-controls .field {
  flex: 1;
}

.export-spec-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 14px;
}

.export-spec-summary span {
  padding: 9px;
  border-radius: 8px;
  color: var(--slate-500);
  font-size: 11px;
  background: #f7f9f8;
}

.export-spec-summary strong {
  display: block;
  margin-bottom: 3px;
  color: var(--slate-700);
  font-size: 10px;
}

.table-wrap {
  margin-top: 14px;
}

.value-cell {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

.export-warning {
  margin-top: 12px;
}

.confirm-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.confirm-summary > div {
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.confirm-summary span,
.confirm-summary strong {
  display: block;
}

.confirm-summary span {
  margin-bottom: 4px;
  color: var(--slate-500);
  font-size: 10px;
}

.confirm-summary strong {
  font-size: 12px;
}

.confirm-summary code {
  padding: 1px 4px;
  border-radius: 4px;
  background: #edf4f2;
}

@media (max-width: 900px) {
  .ingest-layout,
  .export-layout {
    grid-template-columns: 1fr;
  }

  .export-preview-panel {
    grid-column: auto;
  }
}

@media (max-width: 640px) {
  .entry-switch,
  .stats-grid,
  .export-spec-summary,
  .confirm-summary {
    grid-template-columns: 1fr;
  }

  .entry-option {
    padding: 12px;
  }

  .compact-field {
    grid-template-columns: 1fr;
  }

  .confirm-zone,
  .export-controls {
    align-items: stretch;
    flex-direction: column;
  }

  .confirm-zone .primary-action,
  .export-controls .primary-action {
    width: 100%;
  }
}
</style>
