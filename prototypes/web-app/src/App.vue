<script setup>
import { computed, ref } from 'vue'
import {
  LayoutDashboard,
  FileInput,
  Files,
  Shapes,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronRight,
  ArrowUpRight,
  FlaskConical,
  RotateCcw,
  ShieldCheck,
  Workflow,
  FolderOpen,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { store, navigate, resetDemo } from './store'
import ReportsPage from './pages/ReportsPage.vue'
import SpecsPage from './pages/SpecsPage.vue'
import EditorPage from './pages/EditorPage.vue'
import OntologyPage from './pages/OntologyPage.vue'
import RecordsPage from './pages/RecordsPage.vue'
import DashboardPage from './pages/DashboardPage.vue'
const collapsed = ref(window.innerWidth < 960),
  resetOpen = ref(false)
const nav = [
  { id: 'dashboard', label: '数据看板', icon: LayoutDashboard, section: '使用' },
  { id: 'reports', label: '日常报送', icon: FileInput },
  { id: 'specs', label: '模板规格', icon: Files, section: '配置' },
  { id: 'ontology', label: '本体配置', icon: Shapes },
  { id: 'records', label: '操作记录', icon: History, section: '工作区' },
]
const active = computed(() => (store.route === 'editor' ? 'specs' : store.route))
const title = computed(() => nav.find((x) => x.id === active.value)?.label || '日常报送')
const draftCount = computed(
  () =>
    store.specs.filter((x) => x.profileId === store.profile.id && x.status !== 'published').length,
)
function confirmReset() {
  resetDemo()
  resetOpen.value = false
}
</script>

<template>
  <div class="application" :class="{ 'nav-collapsed': collapsed }">
    <aside class="app-sidebar">
      <a class="app-logo" href="#" @click.prevent="navigate('dashboard')"
        ><span class="logo-square"><Workflow :size="21" /></span
        ><span class="nav-text">bi-lite<span class="logo-sub">本地报送工作台</span></span></a
      >
      <button class="workspace-switch" @click="navigate('ontology')">
        <FolderOpen :size="16" /><span class="nav-text"
          ><strong>{{ store.profile.name }}</strong
          ><small>本地工作区</small></span
        ><ChevronRight class="nav-text" :size="14" />
      </button>
      <nav aria-label="主导航">
        <template v-for="item in nav" :key="item.id">
          <p v-if="item.section" class="nav-section nav-text">{{ item.section }}</p>
          <button
            :title="item.label"
            :aria-label="item.label"
            class="nav-item"
            :class="{ active: active === item.id }"
            :aria-current="active === item.id ? 'page' : undefined"
            @click="navigate(item.id)"
          >
            <component :is="item.icon" :size="17" /><span class="nav-text">{{ item.label }}</span
            ><span v-if="item.id === 'specs' && draftCount" class="nav-count nav-text">{{
              draftCount
            }}</span>
          </button>
        </template>
      </nav>
      <div class="sidebar-bottom">
        <div class="local-status">
          <span class="status-dot"></span><span class="nav-text">本机运行 · 数据不出本机</span>
        </div>
        <button class="nav-item" @click="resetOpen = true" title="重置演示">
          <RotateCcw :size="16" /><span class="nav-text">重置演示状态</span>
        </button>
        <div class="sidebar-foot nav-text">
          <span>界面原型 v0.3</span><span>Vue + shadcn-vue</span>
        </div>
      </div>
    </aside>
    <div class="app-main">
      <header class="app-topbar">
        <div class="breadcrumb">
          <Button
            variant="ghost"
            size="icon"
            :aria-label="collapsed ? '展开导航' : '收起导航'"
            @click="collapsed = !collapsed"
            ><component :is="collapsed ? PanelLeftOpen : PanelLeftClose" :size="16" /></Button
          ><span class="breadcrumb-divider"></span><span>{{ store.profile.name }}</span
          ><ChevronRight :size="13" /><strong>{{ title }}</strong
          ><template v-if="store.route === 'editor'"
            ><ChevronRight :size="13" /><span>配置规格</span></template
          >
        </div>
        <div class="topbar-right">
          <Badge variant="outline" class="prototype-badge"
            ><FlaskConical :size="12" />交互原型</Badge
          ><span class="local-label"><ShieldCheck :size="13" />本地演示</span>
        </div>
      </header>
      <main class="page-content" :class="{ 'editor-content': store.route === 'editor' }">
        <DashboardPage v-if="store.route === 'dashboard'" />
        <ReportsPage v-else-if="store.route === 'reports'" />
        <SpecsPage v-else-if="store.route === 'specs'" />
        <EditorPage v-else-if="store.route === 'editor'" :key="store.editorId" />
        <OntologyPage v-else-if="store.route === 'ontology'" />
        <RecordsPage v-else-if="store.route === 'records'" />
      </main>
      <footer class="app-footer">
        <span><span class="status-dot"></span>仅保存在当前浏览器</span
        ><span>未连接业务引擎或数据库</span>
      </footer>
    </div>
    <div v-if="store.notice" class="app-toast" role="status">
      <ShieldCheck :size="17" />{{ store.notice }}
    </div>
    <Dialog v-model:open="resetOpen"
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>重置演示工作区？</DialogTitle
          ><DialogDescription
            >清除当前浏览器内的原型草稿、成员变更与模拟记录，恢复预置示例。不会操作磁盘、源 Excel
            或业务数据库。</DialogDescription
          ></DialogHeader
        ><DialogFooter
          ><Button variant="outline" @click="resetOpen = false">取消</Button
          ><Button
            @click="confirmReset"
            >确认重置演示</Button
          ></DialogFooter
        ></DialogContent
      ></Dialog
    >
  </div>
</template>
