<template>
  <section class="page" data-module="inspection">
    <header class="page-head">
      <div>
        <h2>巡检任务管理</h2>
        <p class="page-desc">路线批次按 待分配→已分配→执行中→已完成 顺序流转，跳级或完成后回退都会被拒绝。</p>
      </div>
      <div class="page-actions">
        <label class="operator-switch">
          <span>当前操作人</span>
          <input v-model="operatorInput" placeholder="输入姓名" />
          <button class="btn" type="button" @click="switchOperator">切换</button>
        </label>
        <button class="btn primary" type="button" @click="openCreate">登记巡检任务</button>
        <button class="btn" type="button" @click="exportRows">导出巡检任务清单</button>
      </div>
    </header>

    <section class="exec-panel">
      <template v-if="activeRow">
        <div class="exec-head">
          <strong>执行台 · 批次 {{ activeRow['批次编号'] }}</strong>
          <span>任务 {{ activeRow['任务编号'] }} · {{ activeRow['巡检区域'] }} · 路线 {{ activeRow['巡检路线'] }}</span>
          <span>
            当前状态「{{ activeRow.status }}」 · 责任人 {{ activeRow['巡检人员'] || '—' }}
            <template v-if="activeRow['领取时间']"> · 领取于 {{ activeRow['领取时间'] }}</template>
          </span>
        </div>
        <p v-if="restored" class="ok-text">已恢复上次中断的执行现场，批次与状态保持为「{{ activeRow.status }}」。</p>
        <div class="exec-actions">
          <button v-if="activeStatus === '待分配'" class="btn primary" type="button" @click="doClaim">
            领取批次
          </button>
          <button v-if="activeStatus === '已分配'" class="btn primary" type="button" @click="doStart">
            开始巡检
          </button>
          <template v-if="activeStatus === '执行中'">
            <button class="btn primary" type="button" @click="doAnomaly">上报异常</button>
            <button class="btn primary" type="button" @click="doComplete">确认完成</button>
          </template>
          <template v-if="canReassign">
            <input v-model="nextOperator" class="reassign-input" placeholder="新责任人姓名" />
            <button class="btn" type="button" @click="doReassign">变更责任人</button>
            <button class="btn ghost" type="button" @click="doCancel">取消任务</button>
          </template>
          <button class="btn ghost" type="button" @click="leaveConsole">移出执行台</button>
        </div>
        <ul v-if="handovers.length" class="handover-list">
          <li v-for="item in handovers" :key="String(item.id)">
            [{{ item['类型'] }}] {{ item['时间'] }} · {{ item['原责任人'] }} → {{ item['新责任人'] }}（操作人：{{ item['操作人'] }}）
          </li>
        </ul>
      </template>
      <p v-else class="exec-empty">
        执行台空闲：在下方列表领取批次，或把已领取的批次送入执行台；执行中断后重新进入会自动恢复原批次和当前状态。
      </p>
    </section>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="row.status === '待分配'"
              class="link"
              type="button"
              @click="claimRow(row)"
            >
              领取批次
            </button>
            <button
              v-else-if="row.status === '已分配' || row.status === '执行中'"
              class="link"
              type="button"
              @click="enterConsole(row)"
            >
              进入执行台
            </button>
            <span v-else class="muted-text">流程已终结</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无巡检任务数据，可先登记巡检任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡检任务记录</span>
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import {
  cancelBatch,
  claimBatch,
  completeInspection,
  getActiveTaskId,
  getTask,
  listHandovers,
  reassignBatch,
  reportAnomaly,
  setActiveTaskId,
  startInspection,
} from '@/api/inspection-service'
import type { ActionResult, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('inspection')
const columns = ["任务编号", "批次编号", "巡检区域", "巡检人员", "巡检日期", "巡检路线", "计划时长", "完成情况", "领取时间", "任务状态"]
const statuses = ["待分配", "已分配", "执行中", "已完成"]
const stats = [{"label": "今日任务", "value": 0}, {"label": "待分配任务", "value": 0}, {"label": "已完成任务", "value": 0}]

const session = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const operatorInput = ref(session.operator)
const activeRow = ref<EntryRow | null>(null)
const handovers = ref<EntryRow[]>([])
const restored = ref(false)
const nextOperator = ref('')

const activeStatus = computed(() => String(activeRow.value?.status ?? ''))
const canReassign = computed(() => activeStatus.value === '已分配' || activeStatus.value === '执行中')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function showResult(result: ActionResult) {
  if (result.ok) {
    okMessage.value = result.message
    errorMessage.value = ''
  } else {
    errorMessage.value = result.message
    okMessage.value = ''
  }
  reload()
  refreshActive()
}

function refreshActive(markRestored = false) {
  const id = getActiveTaskId(session.operator)
  const row = id === null ? null : getTask(id)
  if (id !== null && !row) {
    setActiveTaskId(session.operator, null)
  }
  activeRow.value = row
  handovers.value = row ? listHandovers(String(row['任务编号'])) : []
  if (markRestored && row && (String(row.status) === '已分配' || String(row.status) === '执行中')) {
    restored.value = true
  }
}

function switchOperator() {
  const name = operatorInput.value.trim()
  if (!name) {
    errorMessage.value = '操作人姓名不能为空'
    okMessage.value = ''
    return
  }
  session.setOperator(name)
  restored.value = false
  refreshActive(true)
  okMessage.value = activeRow.value
    ? `已切换为「${name}」，恢复其名下的执行现场`
    : `已切换为「${name}」，名下没有进行中的批次`
  errorMessage.value = ''
}

function claimRow(row: EntryRow) {
  restored.value = false
  showResult(claimBatch(Number(row.id), session.operator))
}

function enterConsole(row: EntryRow) {
  setActiveTaskId(session.operator, Number(row.id))
  restored.value = false
  refreshActive()
  okMessage.value = `批次 ${row['批次编号']} 已进入执行台`
  errorMessage.value = ''
}

function doClaim() {
  if (!activeRow.value) return
  restored.value = false
  showResult(claimBatch(Number(activeRow.value.id), session.operator))
}

function doStart() {
  if (!activeRow.value) return
  restored.value = false
  showResult(startInspection(Number(activeRow.value.id), session.operator))
}

function doComplete() {
  if (!activeRow.value) return
  showResult(completeInspection(Number(activeRow.value.id), session.operator))
}

function doAnomaly() {
  if (!activeRow.value) return
  showResult(reportAnomaly(Number(activeRow.value.id), session.operator))
}

function doReassign() {
  if (!activeRow.value) return
  const result = reassignBatch(Number(activeRow.value.id), session.operator, nextOperator.value)
  if (result.ok) {
    nextOperator.value = ''
  }
  showResult(result)
}

function doCancel() {
  if (!activeRow.value) return
  showResult(cancelBatch(Number(activeRow.value.id), session.operator))
}

function leaveConsole() {
  setActiveTaskId(session.operator, null)
  activeRow.value = null
  handovers.value = []
  restored.value = false
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '巡检任务登记入口尚未接入审批流'
  okMessage.value = ''
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '巡检任务列表读取失败'
  }
}

onMounted(() => {
  reload()
  refreshActive(true)
})
</script>
