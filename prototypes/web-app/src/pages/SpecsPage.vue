<script setup>
import { computed, ref } from 'vue'
import {
  Files,
  Plus,
  Search,
  FileInput,
  FileOutput,
  ArrowRight,
  MoreHorizontal,
  Filter,
  PencilLine,
  Copy,
  CheckCircle2,
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
import { store, openEditor, createSpec, notify } from '../store'
const search = ref(''),
  filter = ref('all'),
  open = ref(false),
  name = ref(''),
  direction = ref('ingest')
const labels = { published: '已发布', draft: '草稿', review: '待复核' }
const specs = computed(() =>
  store.specs.filter(
    (x) =>
      x.profileId === store.profile.id &&
      (filter.value === 'all' || x.direction === filter.value) &&
      x.title.includes(search.value),
  ),
)
function create() {
  if (!name.value.trim()) {
    notify('请填写规格名称。')
    return
  }
  createSpec(name.value, direction.value)
  open.value = false
}
</script>
<template>
  <div class="page-header">
    <div>
      <div class="eyebrow">配置 / 模板规格</div>
      <h1 class="page-title">模板规格</h1>
      <p class="page-description">把一次配置，变成每月可复用的报送规则。</p>
    </div>
    <Button @click="open = true"><Plus :size="16" />新建规格</Button>
  </div>
  <div class="notice">
    <CheckCircle2 :size="16" /><span
      >接入与导出分别保存。日常报送只调用已发布、无需复核的规格。</span
    >
  </div>
  <div class="list-toolbar">
    <Tabs v-model="filter"
      ><TabsList
        ><TabsTrigger value="all">全部规格</TabsTrigger
        ><TabsTrigger value="ingest">接入规格</TabsTrigger
        ><TabsTrigger value="export">导出规格</TabsTrigger></TabsList
      ></Tabs
    >
    <div class="search-field">
      <Search :size="15" /><Input
        v-model="search"
        placeholder="搜索规格名称"
        aria-label="搜索规格名称"
      />
    </div>
  </div>
  <div class="panel table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>名称与用途</th>
          <th>方向</th>
          <th>状态</th>
          <th>更新日期</th>
          <th class="text-right">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="spec in specs" :key="spec.id">
          <td>
            <div class="spec-name">
              <span class="file-tile" :class="spec.direction"
                ><component :is="spec.direction === 'ingest' ? FileInput : FileOutput" :size="19"
              /></span>
              <div>
                <strong>{{ spec.title }}</strong
                ><small>{{ spec.description }}</small>
              </div>
            </div>
          </td>
          <td>
            <Badge variant="outline">{{ spec.direction === 'ingest' ? '接入' : '导出' }}</Badge>
          </td>
          <td>
            <span class="status-pill" :class="spec.status">{{ labels[spec.status] }}</span>
          </td>
          <td class="muted">{{ spec.updatedAt }}</td>
          <td class="text-right">
            <Button variant="ghost" size="sm" @click="openEditor(spec.id)"
              >{{ spec.status === 'published' ? '查看与编辑' : '继续配置' }}<ArrowRight :size="14"
            /></Button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!specs.length" class="empty-state">
      <Files :size="28" />
      <h3>还没有匹配的规格</h3>
      <p>新建一份接入或导出规格，从 Excel 的布局开始。</p>
      <Button variant="outline" @click="open = true">新建规格</Button>
    </div>
  </div>
  <div class="spec-tip">
    <PencilLine :size="19" />
    <div>
      <strong>规格定义语义，报表承载数据。</strong>
      <p>配置草稿可以不完整；发布前必须补齐每个值的全部必需维度。新增成员与别称随草稿确认。</p>
    </div>
  </div>
  <Dialog v-model:open="open"
    ><DialogContent
      ><DialogHeader
        ><DialogTitle>新建模板规格</DialogTitle
        ><DialogDescription
          >选择方向，再进入 Excel 配置。当前原型使用内置演示样例，不读取新的 Excel
          文件。</DialogDescription
        ></DialogHeader
      >
      <div class="field">
        <label for="spec-name">规格名称</label
        ><Input id="spec-name" v-model="name" placeholder="例如：月度经营快报" />
      </div>
      <div class="field">
        <label for="spec-direction">规格方向</label
        ><select id="spec-direction" v-model="direction" class="input">
          <option value="ingest">接入 · Excel → 本体坐标和值</option>
          <option value="export">导出 · 取数语义 → Excel 位置</option>
        </select>
      </div>
      <div class="notice">绑定 profile：{{ store.profile.name }}。创建不会执行导入或导出。</div>
      <DialogFooter
        ><Button variant="outline" @click="open = false">取消</Button
        ><Button @click="create"
          >创建并配置<ArrowRight :size="15" /></Button></DialogFooter></DialogContent
  ></Dialog>
</template>
