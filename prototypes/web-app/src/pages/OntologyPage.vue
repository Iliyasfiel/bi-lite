<script setup>
import { computed, reactive, ref, watch } from 'vue'
import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  Database,
  FileText,
  Lock,
  Network,
  Pencil,
  Plus,
  Power,
  Search,
  Shapes,
  Tags,
  Trash2,
  X,
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
import { addMember, dimension, makeId, navigate, notify, store } from '@/store'

const PRESET_DIMENSIONS = [
  { id: 'company', name: '主体' },
  { id: 'metric', name: '指标' },
  { id: 'period', name: '期数' },
  { id: 'window', name: '口径' },
]

const activeDimensionId = ref(store.profile.dimensions[0]?.id || '')
const memberSearch = ref('')

const profileSpecs = computed(() =>
  store.specs.filter((spec) => spec.profileId === store.profile.id),
)
const reviewedSpecs = computed(() =>
  profileSpecs.value.filter((spec) => spec.ontologyReviews?.length),
)
const activeDimension = computed(
  () =>
    store.profile.dimensions.find((item) => item.id === activeDimensionId.value) ||
    store.profile.dimensions[0] ||
    null,
)
const activeMemberCount = computed(() =>
  store.profile.dimensions.reduce(
    (total, item) => total + item.members.filter((member) => member.active).length,
    0,
  ),
)
const filteredMembers = computed(() => {
  const members = activeDimension.value?.members || []
  const keyword = memberSearch.value.trim().toLocaleLowerCase()
  if (!keyword) return members

  return members.filter(
    (member) =>
      member.name.toLocaleLowerCase().includes(keyword) ||
      member.aliases.some((alias) => alias.toLocaleLowerCase().includes(keyword)),
  )
})
const semantics = computed(() => store.profile.semantics || [])
const allMemberNames = computed(() => {
  const values = store.profile.dimensions.flatMap((item) =>
    item.members.flatMap((member) => [member.name, ...member.aliases]),
  )
  return [...new Set(values)]
})

watch(
  () => store.profile.dimensions.map((item) => item.id),
  (ids) => {
    if (!ids.includes(activeDimensionId.value)) {
      activeDimensionId.value = ids[0] || ''
    }
  },
)

watch(activeDimensionId, () => {
  memberSearch.value = ''
})

function selectDimension(id) {
  activeDimensionId.value = id
}

function memberMeta(member) {
  const details = []
  if (member.unit) details.push(`单位：${member.unit}`)
  if (member.formula) details.push(`公式：${member.formula}`)
  return details.join(' · ')
}

function clearMemberReviews(dimensionId, memberId) {
  const result = { restored: 0, pending: 0, semanticPreserved: 0 }
  for (const spec of profileSpecs.value) {
    if (!spec.ontologyReviews?.length) continue
    const remainingReviews = spec.ontologyReviews.filter(
      (review) =>
        !(
          review.kind === 'member' &&
          review.dimensionId === dimensionId &&
          review.memberId === memberId
        ),
    )
    if (remainingReviews.length === spec.ontologyReviews.length) continue

    result.semanticPreserved += remainingReviews.filter(
      (review) => review.kind === 'semantic',
    ).length

    if (remainingReviews.length) {
      spec.ontologyReviews = remainingReviews
      spec.status = 'review'
      continue
    }

    delete spec.ontologyReviews
    if (spec.previousStatus === 'published') {
      spec.status = 'published'
      delete spec.previousStatus
      result.restored += 1
    } else {
      // Draft or otherwise changed specs stay blocked until a human confirms them.
      spec.status = 'review'
      result.pending += 1
    }
  }
  return result
}

function markSpecReview(spec, review) {
  if (spec.status !== 'review') {
    spec.previousStatus = spec.status
    spec.status = 'review'
  }
  if (!spec.ontologyReviews) spec.ontologyReviews = []
  const existingIndex = spec.ontologyReviews.findIndex((item) => item.key === review.key)
  if (existingIndex >= 0) {
    spec.ontologyReviews.splice(existingIndex, 1, review)
  } else {
    spec.ontologyReviews.push(review)
  }
}

function dimensionRoleLabel(role) {
  return (
    store.profile.dimensions.find((item) => item.id === role)?.name ||
    PRESET_DIMENSIONS.find((item) => item.id === role)?.name ||
    role
  )
}

function specMemberDependencyReason(spec, dimensionId, target) {
  const mapping = spec.mapping || {}
  const reasons = []
  const memberNames = new Set(
    [target.memberName || target.name, ...(target.memberAliases || target.aliases || [])].filter(
      Boolean,
    ),
  )
  const matchesMember = (value) => typeof value === 'string' && memberNames.has(value.trim())
  const roles = (mapping.columns || [])
    .map((column) => column.role)
    .filter((role) => role === dimensionId)

  if (spec.direction === 'export') {
    if (
      dimensionId === 'company' &&
      Array.isArray(mapping.companies) &&
      mapping.companies.some((company) => matchesMember(company))
    ) {
      reasons.push('导出主体范围明确包含该成员或别称')
    }
    if (dimensionId === 'metric' && matchesMember(mapping.exportMetric)) {
      reasons.push('导出规格固定该指标')
    }
    if (dimensionId === 'period' && matchesMember(mapping.periodValue)) {
      reasons.push('导出期间固定为该成员')
    }
    if (dimensionId === 'window' && matchesMember(mapping.exportWindow)) {
      reasons.push('导出规格固定该口径')
    }
    if (dimensionId === 'scenario' && matchesMember(mapping.scenario)) {
      reasons.push('导出规格固定该场景')
    }
    if (dimensionId === 'currency' && matchesMember(mapping.currency)) {
      reasons.push('导出规格固定该币种')
    }
    return reasons.join('；')
  }

  if (roles.length) {
    reasons.push(
      mapping.dynamic
        ? `动态列接入按“${dimensionRoleLabel(dimensionId)}”成员目录建立依赖；停用会改变可选目录`
        : `列映射引用“${dimensionRoleLabel(dimensionId)}”成员目录`,
    )
  }
  if (dimensionId === 'period' && !roles.length && mapping.periodMode) {
    reasons.push('期间取值规则依赖期数目录')
  }
  if (
    dimensionId === 'window' &&
    (mapping.columns || []).some(
      (column) => column.role === 'value' && matchesMember(column.window),
    )
  ) {
    reasons.push('接入列固定使用该口径')
  }
  if (dimensionId === 'scenario' && matchesMember(mapping.scenario)) {
    reasons.push('接入规格固定该场景')
  }
  if (dimensionId === 'currency' && matchesMember(mapping.currency)) {
    reasons.push('接入规格固定该币种')
  }

  return reasons.join('；')
}

function specsUsingMember(target) {
  return profileSpecs.value
    .filter((spec) => specMemberDependencyReason(spec, target.dimensionId, target))
    .map((spec) => ({
      spec,
      reason: specMemberDependencyReason(spec, target.dimensionId, target),
    }))
}

const deactivationDialogOpen = ref(false)
const deactivationTarget = ref(null)
const deactivationSpecs = computed(() => {
  const target = deactivationTarget.value
  if (!target) return []
  return specsUsingMember(target)
})

function toggleMember(member) {
  const dim = activeDimension.value
  if (!dim) return

  if (member.active) {
    if (member.referenced) {
      deactivationTarget.value = {
        dimensionId: dim.id,
        dimensionName: dim.name,
        memberId: member.id,
        memberName: member.name,
        memberAliases: [...member.aliases],
      }
      deactivationDialogOpen.value = true
      return
    }

    member.active = false
    notify(`已停用“${member.name}”；该成员未被规格标记为引用。`)
    return
  }

  member.active = true
  const cleared = clearMemberReviews(dim.id, member.id)
  const messages = [`已启用“${member.name}”`]
  if (cleared.restored) {
    messages.push(`${cleared.restored} 个此前为 published 且无其他复核的规格已恢复`)
  }
  if (cleared.pending) {
    messages.push(`${cleared.pending} 个规格保留 review 等待人工确认`)
  }
  if (cleared.semanticPreserved) {
    messages.push('已修改语义的复核标记保持不变')
  }
  notify(`${messages.join('；')}。`)
}

function confirmDeactivateMember() {
  const target = deactivationTarget.value
  const dim = target ? dimension(target.dimensionId) : null
  const member = dim?.members.find((item) => item.id === target?.memberId)
  if (!target || !dim || !member) {
    deactivationDialogOpen.value = false
    return
  }

  member.active = false
  for (const { spec, reason } of deactivationSpecs.value) {
    markSpecReview(spec, {
      id: makeId('review'),
      key: `member:${target.dimensionId}:${target.memberId}`,
      kind: 'member',
      dimensionId: target.dimensionId,
      memberId: target.memberId,
      title: `成员“${target.memberName}”已停用`,
      detail: `${target.dimensionName}维度发生变化；${reason}。请复核该规格对停用成员的处理。`,
      createdAt: new Date().toISOString(),
      demo: true,
    })
  }

  const count = deactivationSpecs.value.length
  deactivationDialogOpen.value = false
  notify(
    count
      ? `已停用“${target.memberName}”，并标记 ${count} 个实际关联规格待复核。`
      : `已停用“${target.memberName}”；当前演示规格中没有找到显式维度依赖。`,
  )
}

function removeMember(member) {
  const dim = activeDimension.value
  if (!dim || member.referenced) return
  if (!window.confirm(`确定从“${dim.name}”维度删除成员“${member.name}”吗？`)) {
    return
  }

  const index = dim.members.findIndex((item) => item.id === member.id)
  if (index >= 0) dim.members.splice(index, 1)
  clearMemberReviews(dim.id, member.id)
  notify(`已删除未引用成员“${member.name}”。`)
}

const memberDialogOpen = ref(false)
const memberError = ref('')
const memberForm = reactive({
  kind: 'member',
  name: '',
  aliasOf: '',
  dimensionId: '',
})
const memberDialogDimension = computed(() =>
  store.profile.dimensions.find((item) => item.id === memberForm.dimensionId),
)
const aliasTargets = computed(
  () => memberDialogDimension.value?.members.filter((member) => member.active) || [],
)

function openMemberDialog(kind = 'member', member = null) {
  const dim = activeDimension.value
  if (!dim) return

  memberForm.kind = kind
  memberForm.name = ''
  memberForm.aliasOf = kind === 'alias' ? member?.id || aliasTargets.value[0]?.id || '' : ''
  memberForm.dimensionId = dim.id
  memberError.value = ''
  memberDialogOpen.value = true
}

function chooseMemberKind(kind) {
  memberForm.kind = kind
  memberError.value = ''
  if (kind === 'alias' && !memberForm.aliasOf) {
    memberForm.aliasOf = aliasTargets.value[0]?.id || ''
  }
}

function submitMember() {
  const dim = memberDialogDimension.value
  const name = memberForm.name.trim()
  memberError.value = ''

  if (!dim) {
    memberError.value = '当前维度不可用，请关闭弹窗后重试。'
    return
  }
  if (!name) {
    memberError.value = memberForm.kind === 'alias' ? '请输入别称。' : '请输入成员名称。'
    return
  }
  if (dim.members.some((member) => member.name === name || member.aliases.includes(name))) {
    memberError.value = '该名称或别称已存在于当前维度，请换一个名称。'
    return
  }
  if (memberForm.kind === 'alias' && !memberForm.aliasOf) {
    memberError.value = '请选择有效且已启用的成员。'
    return
  }

  try {
    addMember(dim.id, name, memberForm.kind === 'alias' ? memberForm.aliasOf : '')
    memberDialogOpen.value = false
    notify(
      memberForm.kind === 'alias'
        ? `已为成员添加别称“${name}”。`
        : `已在“${dim.name}”维度新增成员“${name}”。`,
    )
  } catch (error) {
    memberError.value = error instanceof Error ? error.message : '保存失败。'
  }
}

function containsSemanticReference(value, semanticId, seen = new WeakSet()) {
  if (value === semanticId) return true
  if (!value || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)

  if (Array.isArray(value)) {
    return value.some((item) => containsSemanticReference(item, semanticId, seen))
  }
  return Object.values(value).some((item) => containsSemanticReference(item, semanticId, seen))
}

function specsUsingSemantic(semantic) {
  return profileSpecs.value.filter((spec) => {
    const mapping = spec.mapping || {}
    const explicitReferenceFields = [
      'semantics',
      'semanticIds',
      'semanticRefs',
      'semanticId',
      'calculation',
      'conversion',
      'relations',
      'transforms',
    ]
    return explicitReferenceFields.some((key) =>
      containsSemanticReference(mapping[key], semantic.id),
    )
  })
}

function semanticUsageLabel(semantic) {
  const count = specsUsingSemantic(semantic).length
  return count ? `${count} 个规格显式引用` : '未引用 · 修改无需复核'
}

const semanticDialogOpen = ref(false)
const semanticError = ref('')
const semanticForm = reactive({
  id: '',
  type: '关系',
  name: '',
  from: '',
  to: '',
  expression: '',
})
const editingSemantic = computed(
  () => semantics.value.find((item) => item.id === semanticForm.id) || null,
)

function openSemanticDialog(semantic = null) {
  semanticForm.id = semantic?.id || ''
  semanticForm.type = semantic?.type || '关系'
  semanticForm.name = semantic?.name || ''
  semanticForm.from = semantic?.from || ''
  semanticForm.to = semantic?.to || ''
  semanticForm.expression = semantic?.expression || ''
  semanticError.value = ''
  semanticDialogOpen.value = true
}

function setSemanticType(type) {
  semanticForm.type = type
  semanticError.value = ''
}

function saveSemantic() {
  const name = semanticForm.name.trim()
  const from = semanticForm.from.trim()
  const to = semanticForm.to.trim()
  const expression = semanticForm.expression.trim()
  semanticError.value = ''

  if (!name || !from || !to || !expression) {
    semanticError.value = '请完整填写名称、两端及表达式或关系标签。'
    return
  }
  if (
    semantics.value.some(
      (item) =>
        item.id !== semanticForm.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
  ) {
    semanticError.value = '已有同名语义，请换一个名称。'
    return
  }

  const existing = editingSemantic.value
  if (
    existing &&
    existing.type === semanticForm.type &&
    existing.name === name &&
    existing.from === from &&
    existing.to === to &&
    existing.expression === expression
  ) {
    semanticDialogOpen.value = false
    notify('定义没有变化，无需重新复核规格。')
    return
  }
  const affectedSpecs = existing ? specsUsingSemantic(existing) : []

  if (existing) {
    Object.assign(existing, {
      type: semanticForm.type,
      name,
      from,
      to,
      expression,
    })
  } else {
    if (!store.profile.semantics) store.profile.semantics = []
    store.profile.semantics.push({
      id: makeId('semantic'),
      name,
      type: semanticForm.type,
      from,
      to,
      expression,
      referenced: false,
    })
  }

  for (const spec of affectedSpecs) {
    markSpecReview(spec, {
      id: makeId('review'),
      key: `semantic:${existing.id}`,
      kind: 'semantic',
      semanticId: existing.id,
      title: `语义“${name}”已修改`,
      detail: `${semanticForm.type}定义已变化。该规格已显式关联此语义，请复核执行口径。`,
      createdAt: new Date().toISOString(),
      demo: true,
    })
  }

  semanticDialogOpen.value = false
  if (existing) {
    notify(
      affectedSpecs.length
        ? `语义已更新，并标记 ${affectedSpecs.length} 个实际依赖规格待复核。`
        : '语义已更新；没有规格显式引用它，因此未改动任何规格。',
    )
  } else {
    notify('已新增浏览器内的语义元数据；当前草稿尚不参与本地引擎执行。')
  }
}

const profileDialogOpen = ref(false)
const profileError = ref('')
const customDimensionError = ref('')
const profileForm = reactive({
  mode: 'preset',
  name: '我的经营 profile',
  customDimensions: PRESET_DIMENSIONS.map((item) => item.name),
  newDimension: '',
})

function openProfileDialog() {
  profileForm.mode = 'preset'
  profileForm.name = '我的经营 profile'
  profileForm.customDimensions = PRESET_DIMENSIONS.map((item) => item.name)
  profileForm.newDimension = ''
  profileError.value = ''
  customDimensionError.value = ''
  profileDialogOpen.value = true
}

function addCustomDimension() {
  const name = profileForm.newDimension.trim()
  customDimensionError.value = ''
  if (!name) return
  if (
    profileForm.customDimensions.some(
      (item) => item.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
  ) {
    customDimensionError.value = '维度名称不能重复。'
    return
  }
  profileForm.customDimensions.push(name)
  profileForm.newDimension = ''
}

function removeCustomDimension(index) {
  profileForm.customDimensions.splice(index, 1)
  customDimensionError.value = ''
}

function currentDate() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function createProfile() {
  const profileName = profileForm.name.trim()
  profileError.value = ''
  if (!profileName) {
    profileError.value = '请输入 profile 名称。'
    return
  }

  const dimensionNames =
    profileForm.mode === 'preset'
      ? PRESET_DIMENSIONS.map((item) => item.name)
      : profileForm.customDimensions.map((item) => item.trim())
  if (!dimensionNames.length || dimensionNames.some((item) => !item)) {
    profileError.value = '自定义 profile 至少需要一个有名称的维度。'
    return
  }
  if (
    new Set(dimensionNames.map((item) => item.toLocaleLowerCase())).size !== dimensionNames.length
  ) {
    profileError.value = '维度名称不能重复。'
    return
  }

  const dimensions = dimensionNames.map((name, index) => ({
    id: profileForm.mode === 'preset' ? PRESET_DIMENSIONS[index].id : makeId('dimension'),
    name,
    members: [],
  }))
  const nextProfile = {
    id: makeId('profile'),
    name: profileName,
    frozen: true,
    createdAt: currentDate(),
    dimensions,
    semantics: [],
  }

  store.profile = nextProfile
  store.specs.splice(0, store.specs.length)
  store.records.splice(0, store.records.length)
  store.editorId = ''
  activeDimensionId.value = dimensions[0].id
  memberSearch.value = ''
  profileDialogOpen.value = false
  notify(`已创建独立演示 profile“${profileName}”；浏览器内的旧规格、执行记录与语义已清空。`)
}
</script>

<template>
  <div class="ontology-page">
    <section class="page-header ontology-hero">
      <div class="hero-copy">
        <div class="eyebrow">
          <Database />
          <span>本地本体配置</span>
          <Badge variant="outline">浏览器演示</Badge>
        </div>
        <h1 class="page-title">本体配置</h1>
        <p class="page-description">
          维护 profile 的维度成员、别称与语义元数据。所有维度地位平等，维度结构在 profile
          创建后保持只读；原型仅维护浏览器演示配置，未连接业务引擎。
        </p>
      </div>
      <div class="button-row hero-actions">
        <Badge variant="outline" class="readonly-badge">
          <Lock />
          维度结构只读
        </Badge>
        <Button type="button" @click="openProfileDialog">
          <Plus />
          创建 profile
        </Button>
      </div>
    </section>

    <div class="notice" style="margin-bottom: 16px">
      <Shapes :size="16" />
      <div>
        <strong>原型 v0.3 · 默认 profile 已更新为四维</strong>
        <p>主体、指标、期数、口径；金额默认人民币，场景和币种不再作为默认维度。</p>
        <p v-if="store.profile.id !== 'finance-rmb-v3'" class="muted">
          当前展示的是已保存的自建 profile，其维度结构保持不变；新建时可选择四维预设。
        </p>
      </div>
    </div>
    <section class="panel profile-summary">
      <div class="profile-main">
        <div class="profile-mark">
          <Shapes />
        </div>
        <div>
          <div class="profile-title-row">
            <h2>{{ store.profile.name }}</h2>
            <Badge variant="secondary">{{
              store.profile.id === 'finance-rmb-v3' ? '人民币四维默认 profile' : '自建 profile'
            }}</Badge>
          </div>
          <p class="muted">
            ID：{{ store.profile.id }} · 创建于 {{ store.profile.createdAt || '—' }}
          </p>
        </div>
      </div>
      <dl class="summary-metrics">
        <div>
          <dt>维度</dt>
          <dd>{{ store.profile.dimensions.length }}</dd>
        </div>
        <div>
          <dt>启用成员</dt>
          <dd>{{ activeMemberCount }}</dd>
        </div>
        <div>
          <dt>关联规格</dt>
          <dd>{{ profileSpecs.length }}</dd>
        </div>
        <div>
          <dt>语义定义</dt>
          <dd>{{ semantics.length }}</dd>
        </div>
      </dl>
      <div v-if="reviewedSpecs.length" class="review-strip">
        <div class="review-strip-label">
          <AlertTriangle />
          <span>{{ reviewedSpecs.length }} 个规格待复核</span>
        </div>
        <div class="review-spec-list">
          <Button
            v-for="spec in reviewedSpecs"
            :key="spec.id"
            type="button"
            variant="outline"
            size="xs"
            @click="navigate('reports', spec.id)"
          >
            <FileText />
            {{ spec.title }}
          </Button>
        </div>
      </div>
    </section>

    <section class="panel dimension-panel">
      <div class="panel-header dimension-heading">
        <div>
          <div class="section-kicker">PROFILE DIMENSIONS</div>
          <h2>本体维度</h2>
          <p class="muted">
            各维度使用同一套成员规则。切换 tab 后维护成员，不改变 profile 的维度结构。
          </p>
        </div>
        <Badge variant="outline">
          <Lock />
          结构不可增删
        </Badge>
      </div>

      <div class="dimension-tabs" role="tablist" aria-label="本体维度">
        <button
          v-for="(item, index) in store.profile.dimensions"
          :key="item.id"
          type="button"
          role="tab"
          class="dimension-tab"
          :class="{ active: item.id === activeDimension?.id }"
          :aria-selected="item.id === activeDimension?.id"
          @click="selectDimension(item.id)"
        >
          <span class="tab-index">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="tab-copy">
            <strong>{{ item.name }}</strong>
            <small
              >{{ item.members.filter((member) => member.active).length }} 启用 /
              {{ item.members.length }} 成员</small
            >
          </span>
          <Shapes class="tab-icon" />
        </button>
      </div>

      <div v-if="activeDimension" class="dimension-content" role="tabpanel">
        <div class="dimension-toolbar">
          <div>
            <h3>{{ activeDimension.name }}成员</h3>
            <p class="muted">
              名称与别称在“{{ activeDimension.name }}”内必须唯一；跨维度允许同名。
            </p>
          </div>
          <Button type="button" size="sm" @click="openMemberDialog('member')">
            <Plus />
            增加成员
          </Button>
        </div>

        <div class="search-row">
          <div class="search-box">
            <Search />
            <Input
              v-model="memberSearch"
              type="search"
              :placeholder="`搜索${activeDimension.name}名称或别称`"
              aria-label="搜索成员"
            />
          </div>
          <Badge variant="secondary"> {{ filteredMembers.length }} 条结果 </Badge>
        </div>

        <div v-if="filteredMembers.length" class="table-wrap">
          <table class="data-table member-table">
            <thead>
              <tr>
                <th scope="col">成员</th>
                <th scope="col">别称</th>
                <th scope="col">状态</th>
                <th scope="col" class="actions-column">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="member in filteredMembers"
                :key="member.id"
                :class="{ 'row-muted': !member.active }"
              >
                <td>
                  <div class="member-name-row">
                    <strong>{{ member.name }}</strong>
                    <Badge v-if="member.referenced" variant="outline">
                      <Lock />
                      已引用
                    </Badge>
                  </div>
                  <small v-if="memberMeta(member)" class="member-meta">
                    {{ memberMeta(member) }}
                  </small>
                </td>
                <td>
                  <div v-if="member.aliases.length" class="alias-list">
                    <Badge
                      v-for="alias in member.aliases"
                      :key="alias"
                      variant="secondary"
                      class="alias-pill"
                    >
                      {{ alias }}
                    </Badge>
                  </div>
                  <span v-else class="muted">暂无别称</span>
                </td>
                <td>
                  <Badge :variant="member.active ? 'default' : 'outline'">
                    {{ member.active ? '已启用' : '已停用' }}
                  </Badge>
                </td>
                <td>
                  <div class="row-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      :disabled="!member.active"
                      @click="openMemberDialog('alias', member)"
                    >
                      <Tags />
                      加别称
                    </Button>
                    <Button type="button" variant="outline" size="xs" @click="toggleMember(member)">
                      <Power />
                      {{ member.active ? '停用' : '启用' }}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      class="danger-action"
                      :disabled="member.referenced"
                      :title="
                        member.referenced
                          ? '规格正在引用该成员，只能停用，不能直接删除'
                          : '删除未引用成员'
                      "
                      @click="removeMember(member)"
                    >
                      <Trash2 />
                      删除
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty-state">
          <Search />
          <strong>{{ memberSearch ? '没有匹配的成员' : '这个维度还没有成员' }}</strong>
          <p>
            {{
              memberSearch
                ? '尝试搜索其他名称或别称。'
                : '增加成员后，才可在规格中绑定该维度的坐标值。'
            }}
          </p>
          <Button
            v-if="!memberSearch"
            type="button"
            variant="outline"
            size="sm"
            @click="openMemberDialog('member')"
          >
            <Plus />
            增加第一个成员
          </Button>
        </div>
      </div>
    </section>

    <section class="panel semantic-panel">
      <div class="panel-header semantic-heading">
        <div>
          <div class="section-kicker">SEMANTIC METADATA</div>
          <h2>关系与换算</h2>
          <p class="muted">
            先描述业务关系与单位换算，再由具体规格显式引用。这里不推导合并、不自动换汇。
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" @click="openSemanticDialog()">
          <Plus />
          新增语义
        </Button>
      </div>

      <div class="notice prototype-notice">
        <Shapes />
        <div>
          <strong>仅保存浏览器原型元数据</strong>
          <p>
            当前页面不会生成可执行配置，也不会执行关系或换算。规格影响按页面中已保存的显式关联判断，未显式关联的语义不会触发复核。
          </p>
        </div>
      </div>

      <div v-if="semantics.length" class="semantic-grid">
        <article v-for="semantic in semantics" :key="semantic.id" class="semantic-card">
          <div class="semantic-card-top">
            <div class="semantic-type" :class="{ conversion: semantic.type === '换算' }">
              <Network v-if="semantic.type === '关系'" />
              <ArrowRightLeft v-else />
              <span>{{ semantic.type }}</span>
            </div>
            <Button type="button" variant="ghost" size="xs" @click="openSemanticDialog(semantic)">
              <Pencil />
              编辑
            </Button>
          </div>
          <h3>{{ semantic.name }}</h3>
          <div class="semantic-formula">
            <span>{{ semantic.from }}</span>
            <ArrowRight />
            <span>{{ semantic.to }}</span>
          </div>
          <p class="semantic-expression">{{ semantic.expression }}</p>
          <div class="semantic-usage">
            <Badge :variant="specsUsingSemantic(semantic).length ? 'secondary' : 'outline'">
              {{ semanticUsageLabel(semantic) }}
            </Badge>
            <Button
              v-for="spec in specsUsingSemantic(semantic)"
              :key="spec.id"
              type="button"
              variant="link"
              size="xs"
              @click="navigate('reports', spec.id)"
            >
              {{ spec.title }}
            </Button>
          </div>
        </article>
      </div>
      <div v-else class="empty-state semantic-empty">
        <Network />
        <strong>尚未定义关系或换算</strong>
        <p>新增语义后，可在规格中通过明确的语义 ID 引用。</p>
        <Button type="button" variant="outline" size="sm" @click="openSemanticDialog()">
          <Plus />
          新增语义
        </Button>
      </div>
    </section>

    <Dialog v-model:open="deactivationDialogOpen">
      <DialogContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>停用已引用成员</DialogTitle>
          <DialogDescription>
            “{{
              deactivationTarget?.memberName
            }}”被规格引用。停用后历史引用仍保留，但当前演示工作区会要求相关规格复核。
          </DialogDescription>
        </DialogHeader>

        <div class="notice notice-warning">
          <AlertTriangle />
          <div>
            <strong>只标记实际关联的演示规格</strong>
            <p>
              接入动态列按成员目录保守判断；导出只检查实际选用的主体、固定指标及固定期间/口径，不会误标未使用该成员的导出。
            </p>
          </div>
        </div>

        <div v-if="deactivationSpecs.length" class="review-list">
          <div v-for="{ spec, reason } in deactivationSpecs" :key="spec.id" class="review-item">
            <div>
              <strong>{{ spec.title }}</strong>
              <p>{{ reason }}</p>
            </div>
            <Badge v-if="spec.demo" variant="secondary">demo</Badge>
          </div>
        </div>
        <div v-else class="empty-state compact">
          <FileText />
          <strong>没有找到显式依赖</strong>
          <p>仍可停用；不会给无关规格添加复核标记。</p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="deactivationDialogOpen = false">
            取消
          </Button>
          <Button type="button" @click="confirmDeactivateMember">
            <Power />
            停用并标记复核
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="memberDialogOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {{ memberForm.kind === 'alias' ? '增加别称' : '增加成员' }}
          </DialogTitle>
          <DialogDescription>
            当前维度：{{ memberDialogDimension?.name || '—' }}。保存后立即写入浏览器演示状态。
          </DialogDescription>
        </DialogHeader>

        <form class="dialog-form" @submit.prevent="submitMember">
          <div class="choice-grid two">
            <button
              type="button"
              class="choice-card"
              :class="{ active: memberForm.kind === 'member' }"
              @click="chooseMemberKind('member')"
            >
              <Plus />
              <span>
                <strong>新成员</strong>
                <small>加入维度成员集合</small>
              </span>
            </button>
            <button
              type="button"
              class="choice-card"
              :class="{ active: memberForm.kind === 'alias' }"
              :disabled="!aliasTargets.length"
              @click="chooseMemberKind('alias')"
            >
              <Tags />
              <span>
                <strong>已有成员的别称</strong>
                <small>
                  {{ aliasTargets.length ? '同名指向唯一成员' : '没有可添加的启用成员' }}
                </small>
              </span>
            </button>
          </div>

          <label v-if="memberForm.kind === 'alias'" class="field">
            <span>归属成员</span>
            <select v-model="memberForm.aliasOf" class="input native-select">
              <option v-for="member in aliasTargets" :key="member.id" :value="member.id">
                {{ member.name }}
              </option>
            </select>
          </label>

          <label class="field">
            <span>{{ memberForm.kind === 'alias' ? '别称' : '成员名称' }}</span>
            <Input
              v-model="memberForm.name"
              autofocus
              :placeholder="memberForm.kind === 'alias' ? '例如：集团本部' : '例如：子公司C'"
            />
          </label>

          <p class="muted field-hint">名称与别称在同一维度内不可冲突；冲突时不会保存任何修改。</p>
          <p v-if="memberError" class="form-error">
            <AlertTriangle />
            {{ memberError }}
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" @click="memberDialogOpen = false">
              取消
            </Button>
            <Button type="submit">
              {{ memberForm.kind === 'alias' ? '保存别称' : '增加成员' }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="semanticDialogOpen">
      <DialogContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {{ editingSemantic ? '编辑语义' : '新增语义' }}
          </DialogTitle>
          <DialogDescription>
            关系与换算在此仅作为浏览器演示配置保存，不会生成可执行配置，也不会执行计算或修改业务数据。
          </DialogDescription>
        </DialogHeader>

        <form class="dialog-form" @submit.prevent="saveSemantic">
          <div class="choice-grid two">
            <button
              type="button"
              class="choice-card"
              :class="{ active: semanticForm.type === '关系' }"
              @click="setSemanticType('关系')"
            >
              <Network />
              <span>
                <strong>关系</strong>
                <small>描述成员之间的业务关联</small>
              </span>
            </button>
            <button
              type="button"
              class="choice-card"
              :class="{ active: semanticForm.type === '换算' }"
              @click="setSemanticType('换算')"
            >
              <ArrowRightLeft />
              <span>
                <strong>换算</strong>
                <small>记录单位或值之间的转换</small>
              </span>
            </button>
          </div>

          <label class="field">
            <span>语义名称</span>
            <Input v-model="semanticForm.name" placeholder="例如：人民币兑美元月度汇率" />
          </label>

          <div class="form-grid two">
            <label class="field">
              <span>{{ semanticForm.type === '关系' ? '起点成员' : '来源单位' }}</span>
              <Input
                v-model="semanticForm.from"
                list="member-name-options"
                placeholder="例如：集团公司（本部）"
              />
            </label>
            <label class="field">
              <span>{{ semanticForm.type === '关系' ? '终点成员' : '目标单位' }}</span>
              <Input
                v-model="semanticForm.to"
                list="member-name-options"
                placeholder="例如：子公司A"
              />
            </label>
          </div>

          <label class="field">
            <span>{{ semanticForm.type === '关系' ? '关系标签' : '换算表达式' }}</span>
            <Input
              v-model="semanticForm.expression"
              :placeholder="semanticForm.type === '关系' ? '例如：控股 / 隶属' : '例如：× 10000'"
            />
          </label>

          <p class="muted field-hint">
            修改后只标记已显式关联该语义的规格。当前没有关联时，不会改动任何规格。
          </p>
          <p v-if="semanticError" class="form-error">
            <AlertTriangle />
            {{ semanticError }}
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" @click="semanticDialogOpen = false">
              取消
            </Button>
            <Button type="submit">保存浏览器元数据</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="profileDialogOpen">
      <DialogContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>创建演示 profile</DialogTitle>
          <DialogDescription>
            创建后在当前浏览器工作区替换现有演示 profile，并清空其规格、执行记录和语义元数据。
          </DialogDescription>
        </DialogHeader>

        <div class="notice notice-warning">
          <AlertTriangle />
          <div>
            <strong>将替换当前浏览器演示工作区</strong>
            <p>
              本操作只修改浏览器 localStorage，不写磁盘、不修改真实项目数据。确认后将创建全新
              profile，旧演示规格和记录不会保留。
            </p>
          </div>
        </div>

        <form class="dialog-form" @submit.prevent="createProfile">
          <label class="field">
            <span>Profile 名称</span>
            <Input v-model="profileForm.name" placeholder="例如：区域经营分析" />
          </label>

          <div class="choice-grid two">
            <button
              type="button"
              class="choice-card profile-choice"
              :class="{ active: profileForm.mode === 'preset' }"
              @click="profileForm.mode = 'preset'"
            >
              <Shapes />
              <span>
                <strong>预设四维</strong>
                <small>主体、指标、期数、口径</small>
              </span>
            </button>
            <button
              type="button"
              class="choice-card profile-choice"
              :class="{ active: profileForm.mode === 'custom' }"
              @click="profileForm.mode = 'custom'"
            >
              <Plus />
              <span>
                <strong>自定义维度</strong>
                <small>按业务名称建立独立维度列表</small>
              </span>
            </button>
          </div>

          <div v-if="profileForm.mode === 'preset'" class="preset-preview">
            <Badge v-for="item in PRESET_DIMENSIONS" :key="item.id" variant="outline">
              {{ item.name }}
            </Badge>
          </div>

          <div v-else class="custom-dimension-editor">
            <div class="field-label-row">
              <span>维度名称列表</span>
              <small class="muted">创建后维度结构只读</small>
            </div>
            <div class="custom-dimension-list">
              <div
                v-for="(_, index) in profileForm.customDimensions"
                :key="index"
                class="custom-dimension-row"
              >
                <span class="dimension-order">{{ index + 1 }}</span>
                <Input v-model="profileForm.customDimensions[index]" />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="移除维度"
                  @click="removeCustomDimension(index)"
                >
                  <X />
                </Button>
              </div>
            </div>
            <div class="custom-dimension-add">
              <Input
                v-model="profileForm.newDimension"
                placeholder="输入新维度名称"
                @keydown.enter.prevent="addCustomDimension"
              />
              <Button type="button" variant="outline" size="sm" @click="addCustomDimension">
                <Plus />
                添加
              </Button>
            </div>
            <p v-if="customDimensionError" class="form-error">
              <AlertTriangle />
              {{ customDimensionError }}
            </p>
          </div>

          <p v-if="profileError" class="form-error">
            <AlertTriangle />
            {{ profileError }}
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" @click="profileDialogOpen = false">
              取消
            </Button>
            <Button type="submit">替换并创建 profile</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <datalist id="member-name-options">
      <option v-for="name in allMemberNames" :key="name" :value="name" />
    </datalist>
  </div>
</template>

<style scoped>
.ontology-page {
  --onto-ink: #17221d;
  --onto-muted: #637068;
  --onto-line: #dce4de;
  --onto-soft: #f4f8f4;
  --onto-accent: #0f6b4e;
  --onto-accent-soft: #e6f3ec;
  --onto-warm: #f6b54b;
  display: grid;
  gap: 18px;
  max-width: 1440px;
  margin: 0 auto;
  color: var(--onto-ink);
}

.ontology-hero {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  overflow: hidden;
  padding: 30px 32px;
  border: 1px solid #cbdacf;
  border-radius: 20px;
  background:
    linear-gradient(120deg, rgba(248, 252, 248, 0.98), rgba(236, 246, 239, 0.94)),
    repeating-linear-gradient(90deg, transparent 0, transparent 31px, rgba(15, 107, 78, 0.05) 32px);
}

.ontology-hero::after {
  position: absolute;
  top: -68px;
  right: 13%;
  width: 210px;
  height: 210px;
  border: 34px solid rgba(15, 107, 78, 0.06);
  border-radius: 50%;
  content: '';
}

.hero-copy,
.hero-actions {
  position: relative;
  z-index: 1;
}

.hero-copy {
  max-width: 760px;
}

.eyebrow,
.semantic-type,
.review-strip-label {
  display: flex;
  align-items: center;
  gap: 8px;
}

.eyebrow {
  margin-bottom: 13px;
  color: var(--onto-accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}

.eyebrow svg,
.readonly-badge svg,
.section-kicker + h2 + p svg,
.notice svg,
.form-error svg,
.empty-state > svg,
.review-strip-label svg {
  width: 16px;
  height: 16px;
}

.page-title {
  max-width: 780px;
  margin: 0;
  font-family: 'Iowan Old Style', 'Songti SC', serif;
  font-size: clamp(29px, 4vw, 47px);
  font-weight: 700;
  letter-spacing: -0.035em;
  line-height: 1.09;
}

.page-description {
  max-width: 760px;
  margin: 14px 0 0;
  color: var(--onto-muted);
  font-size: 14px;
  line-height: 1.75;
}

.hero-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.readonly-badge {
  height: 34px;
  gap: 7px;
  border-color: #c7d6cc;
  background: rgba(255, 255, 255, 0.68);
}

.panel {
  border: 1px solid var(--onto-line);
  border-radius: 17px;
  background: #fff;
  box-shadow: 0 10px 30px rgba(28, 53, 39, 0.035);
}

.profile-summary {
  display: grid;
  grid-template-columns: minmax(280px, 1.25fr) minmax(440px, 1fr);
  gap: 24px;
  align-items: center;
  padding: 19px 22px;
}

.profile-main {
  display: flex;
  gap: 14px;
  align-items: center;
  min-width: 0;
}

.profile-mark {
  display: grid;
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 13px;
  color: #fff;
  background: var(--onto-ink);
}

.profile-mark svg {
  width: 21px;
  height: 21px;
}

.profile-title-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.profile-title-row h2,
.panel-header h2,
.dimension-toolbar h3,
.semantic-card h3 {
  margin: 0;
}

.profile-title-row h2 {
  font-size: 18px;
}

.muted {
  color: var(--onto-muted);
}

.profile-main p {
  margin: 5px 0 0;
  overflow-wrap: anywhere;
  font-size: 12px;
}

.summary-metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin: 0;
}

.summary-metrics div {
  min-width: 0;
  padding: 2px 16px;
  border-left: 1px solid var(--onto-line);
}

.summary-metrics dt {
  color: var(--onto-muted);
  font-size: 11px;
}

.summary-metrics dd {
  margin: 4px 0 0;
  font-size: 20px;
  font-weight: 750;
}

.review-strip {
  grid-column: 1 / -1;
  display: flex;
  gap: 12px;
  align-items: center;
  margin: 0 -22px -19px;
  padding: 11px 22px;
  border-top: 1px solid #f0dfbd;
  background: #fffaf0;
}

.review-strip-label {
  flex: 0 0 auto;
  color: #865b13;
  font-size: 12px;
  font-weight: 700;
}

.review-spec-list,
.semantic-usage,
.row-actions,
.alias-list,
.button-row,
.preset-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.dimension-panel,
.semantic-panel {
  padding: 22px;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-start;
}

.panel-header > div {
  max-width: 780px;
}

.panel-header h2 {
  font-size: 21px;
  letter-spacing: -0.02em;
}

.panel-header p,
.dimension-toolbar p {
  margin: 7px 0 0;
  font-size: 13px;
  line-height: 1.6;
}

.section-kicker {
  margin-bottom: 6px;
  color: var(--onto-accent);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.13em;
}

.dimension-tabs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
  gap: 9px;
  margin-top: 20px;
  padding-bottom: 2px;
  overflow-x: auto;
}

.dimension-tab {
  position: relative;
  display: flex;
  min-height: 88px;
  gap: 10px;
  align-items: flex-start;
  overflow: hidden;
  padding: 13px;
  border: 1px solid var(--onto-line);
  border-radius: 13px;
  color: inherit;
  text-align: left;
  background: #fff;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background 150ms ease,
    transform 150ms ease;
}

.dimension-tab:hover {
  border-color: #a9c4b3;
  transform: translateY(-1px);
}

.dimension-tab.active {
  border-color: var(--onto-accent);
  background: linear-gradient(135deg, rgba(230, 243, 236, 0.95), rgba(249, 252, 249, 0.98));
  box-shadow: inset 0 3px 0 var(--onto-accent);
}

.dimension-tab:focus-visible {
  outline: 3px solid rgba(15, 107, 78, 0.2);
  outline-offset: 2px;
}

.tab-index {
  color: #95a39a;
  font-family: ui-monospace, 'SFMono-Regular', monospace;
  font-size: 10px;
}

.tab-copy {
  display: grid;
  min-width: 0;
  gap: 5px;
  padding-right: 16px;
}

.tab-copy strong {
  font-size: 14px;
}

.tab-copy small {
  color: var(--onto-muted);
  font-size: 10px;
  line-height: 1.4;
}

.tab-icon {
  position: absolute;
  right: 8px;
  bottom: 8px;
  width: 19px;
  height: 19px;
  color: #c4d1c8;
}

.dimension-content {
  margin-top: 18px;
  border-top: 1px solid var(--onto-line);
  padding-top: 18px;
}

.dimension-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: flex-start;
}

.dimension-toolbar h3 {
  font-size: 17px;
}

.search-row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin: 16px 0 12px;
}

.search-box {
  position: relative;
  flex: 1;
  max-width: 430px;
}

.search-box > svg {
  position: absolute;
  z-index: 1;
  top: 50%;
  left: 11px;
  width: 16px;
  height: 16px;
  color: #7f8c84;
  transform: translateY(-50%);
}

.search-box :deep(input) {
  padding-left: 34px;
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--onto-line);
  border-radius: 12px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.data-table th,
.data-table td {
  padding: 13px 14px;
  border-bottom: 1px solid #edf1ee;
  text-align: left;
  vertical-align: top;
}

.data-table th {
  background: #f7faf7;
  color: #657269;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.035em;
}

.data-table tbody tr:last-child td {
  border-bottom: 0;
}

.data-table tbody tr:hover {
  background: #fbfdfb;
}

.member-table {
  min-width: 760px;
}

.member-table th:first-child {
  width: 29%;
}

.member-table th:nth-child(2) {
  width: 28%;
}

.member-table th:nth-child(3) {
  width: 11%;
}

.member-name-row {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  align-items: center;
}

.member-name-row > strong {
  font-size: 14px;
}

.member-meta {
  display: block;
  margin-top: 5px;
  color: var(--onto-muted);
}

.alias-pill {
  font-weight: 500;
}

.row-muted {
  color: #748078;
}

.row-muted .member-name-row > strong {
  text-decoration: line-through;
  text-decoration-color: #aab4ad;
}

.actions-column {
  width: 260px;
}

.row-actions {
  justify-content: flex-end;
}

.danger-action {
  color: #a33c32;
}

.empty-state {
  display: grid;
  justify-items: center;
  gap: 7px;
  padding: 38px 20px;
  border: 1px dashed #cbd7ce;
  border-radius: 12px;
  color: var(--onto-muted);
  text-align: center;
  background: #fbfdfb;
}

.empty-state > svg {
  width: 24px;
  height: 24px;
  color: #8ba195;
}

.empty-state strong {
  color: var(--onto-ink);
}

.empty-state p {
  max-width: 460px;
  margin: 0 0 5px;
  font-size: 12px;
  line-height: 1.55;
}

.empty-state.compact {
  padding: 20px;
}

.semantic-heading {
  align-items: center;
}

.notice {
  display: flex;
  gap: 11px;
  align-items: flex-start;
  margin-top: 16px;
  padding: 13px 15px;
  border: 1px solid #d9e5dd;
  border-radius: 11px;
  background: var(--onto-soft);
}

.notice > svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--onto-accent);
}

.notice strong {
  font-size: 13px;
}

.notice p {
  margin: 4px 0 0;
  color: var(--onto-muted);
  font-size: 12px;
  line-height: 1.6;
}

.notice-warning {
  border-color: #ecd6a9;
  background: #fff9ec;
}

.notice-warning > svg {
  color: #a66c08;
}

.semantic-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.semantic-card {
  padding: 16px;
  border: 1px solid var(--onto-line);
  border-radius: 13px;
  background: linear-gradient(180deg, #fff, #fbfdfb);
}

.semantic-card-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.semantic-type {
  width: fit-content;
  padding: 4px 8px;
  border-radius: 999px;
  color: #24533e;
  font-size: 11px;
  font-weight: 700;
  background: var(--onto-accent-soft);
}

.semantic-type.conversion {
  color: #80550c;
  background: #fff2d8;
}

.semantic-type svg {
  width: 14px;
  height: 14px;
}

.semantic-card h3 {
  margin-top: 13px;
  font-size: 16px;
}

.semantic-formula {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 14px;
  padding: 11px;
  border: 1px solid #e7ece8;
  border-radius: 9px;
  font-size: 13px;
  background: #fff;
}

.semantic-formula svg {
  width: 14px;
  height: 14px;
  color: #829087;
}

.semantic-expression {
  display: inline-block;
  margin: 12px 0;
  padding: 4px 8px;
  border-radius: 6px;
  color: #36463c;
  font-family: ui-monospace, 'SFMono-Regular', monospace;
  font-size: 12px;
  background: #edf2ee;
}

.semantic-usage {
  align-items: center;
}

.semantic-empty {
  margin-top: 14px;
}

.dialog-form {
  display: grid;
  gap: 15px;
}

.field {
  display: grid;
  gap: 7px;
  color: #33423a;
  font-size: 13px;
  font-weight: 650;
}

.field > span,
.field-label-row > span {
  font-weight: 650;
}

.field-hint {
  margin: -5px 0 0;
  font-size: 11px;
  line-height: 1.55;
}

.native-select {
  width: 100%;
  height: 36px;
  border: 1px solid #d7ded9;
  border-radius: 6px;
  padding: 0 10px;
  color: inherit;
  background: #fff;
}

.form-grid {
  display: grid;
  gap: 12px;
}

.form-grid.two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.choice-grid {
  display: grid;
  gap: 9px;
}

.choice-grid.two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.choice-card {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px;
  border: 1px solid var(--onto-line);
  border-radius: 10px;
  color: inherit;
  text-align: left;
  background: #fff;
  cursor: pointer;
}

.choice-card:hover:not(:disabled) {
  border-color: #a9c4b3;
}

.choice-card.active {
  border-color: var(--onto-accent);
  background: var(--onto-accent-soft);
  box-shadow: inset 0 0 0 1px rgba(15, 107, 78, 0.12);
}

.choice-card:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.choice-card > svg {
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  margin-top: 2px;
  color: var(--onto-accent);
}

.choice-card span {
  display: grid;
  gap: 3px;
}

.choice-card strong {
  font-size: 13px;
}

.choice-card small {
  color: var(--onto-muted);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.4;
}

.form-error {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  margin: 0;
  padding: 9px 11px;
  border: 1px solid #edc7c0;
  border-radius: 8px;
  color: #983b31;
  font-size: 12px;
  font-weight: 500;
  background: #fff4f2;
}

.form-error svg {
  flex: 0 0 auto;
}

.review-list {
  display: grid;
  gap: 8px;
  max-height: 260px;
  overflow-y: auto;
}

.review-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 12px;
  border: 1px solid var(--onto-line);
  border-radius: 9px;
  background: #fbfdfb;
}

.review-item strong {
  font-size: 13px;
}

.review-item p {
  margin: 4px 0 0;
  color: var(--onto-muted);
  font-size: 11px;
}

.preset-preview {
  padding: 12px;
  border: 1px solid var(--onto-line);
  border-radius: 9px;
  background: #fbfdfb;
}

.custom-dimension-editor {
  display: grid;
  gap: 9px;
}

.field-label-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  font-size: 13px;
}

.field-label-row small {
  font-size: 10px;
  font-weight: 400;
}

.custom-dimension-list {
  display: grid;
  gap: 7px;
  max-height: 210px;
  overflow-y: auto;
}

.custom-dimension-row {
  display: grid;
  grid-template-columns: 22px 1fr 32px;
  gap: 7px;
  align-items: center;
}

.dimension-order {
  color: #849189;
  font-family: ui-monospace, 'SFMono-Regular', monospace;
  font-size: 10px;
}

.custom-dimension-add {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 7px;
}

@media (max-width: 1060px) {
  .profile-summary {
    grid-template-columns: 1fr;
  }

  .summary-metrics div:first-child {
    border-left: 0;
    padding-left: 0;
  }

  .dimension-tabs {
    grid-auto-columns: 146px;
    grid-auto-flow: column;
    grid-template-columns: none;
  }
}

@media (max-width: 760px) {
  .ontology-page {
    gap: 12px;
  }

  .ontology-hero {
    display: grid;
    align-items: start;
    padding: 22px 18px;
    border-radius: 14px;
  }

  .hero-actions {
    justify-content: flex-start;
  }

  .page-title {
    font-size: 31px;
  }

  .profile-summary {
    padding: 16px;
  }

  .summary-metrics {
    grid-template-columns: repeat(2, 1fr);
    row-gap: 13px;
  }

  .summary-metrics div:nth-child(3) {
    padding-left: 0;
    border-left: 0;
  }

  .review-strip {
    margin: 0 -16px -16px;
    padding: 11px 16px;
  }

  .dimension-panel,
  .semantic-panel {
    padding: 16px;
  }

  .dimension-heading,
  .dimension-toolbar,
  .panel-header {
    align-items: stretch;
  }

  .dimension-heading,
  .semantic-heading {
    flex-direction: column;
  }

  .dimension-toolbar {
    display: grid;
  }

  .search-row {
    align-items: stretch;
  }

  .search-box {
    max-width: none;
  }

  .semantic-grid,
  .form-grid.two,
  .choice-grid.two {
    grid-template-columns: 1fr;
  }

  .choice-card {
    min-height: 62px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dimension-tab {
    transition: none;
  }
}
</style>
