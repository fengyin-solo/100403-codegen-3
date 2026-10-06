<template>
  <section class="page" data-module="inspection">
    <header class="page-head">
      <div>
        <h2>巡检任务管理</h2>
        <p class="page-desc">维护巡检任务，围绕任务编号、巡检区域、巡检人员、巡检日期做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检任务</button>
        <button class="btn" type="button" @click="exportRows">导出巡检任务清单</button>
      </div>
    </header>

    <section class="batch-board">
      <div class="batch-board-head">
        <div>
          <h3>路线批次状态流转</h3>
          <p class="page-desc">
            批次必须依次经过 待分配 → 已分配 → 执行中 → 已完成，跳级或完成后回到前态都会被拒绝；多人领取同一批次仅一人成功。
          </p>
        </div>
        <label class="filter-item">
          <span>当前操作人</span>
          <input v-model="operator" placeholder="领取与操作批次的人员姓名" />
        </label>
      </div>

      <form v-if="createOpen" class="batch-form" @submit.prevent="submitCreate">
        <h4>登记巡检路线批次</h4>
        <label class="filter-item">
          <span>路线名称</span>
          <input v-model="createForm.路线名称" placeholder="例如：城东主干道巡检路线" />
        </label>
        <label class="filter-item">
          <span>巡检区域</span>
          <input v-model="createForm.巡检区域" placeholder="例如：城东区" />
        </label>
        <label class="filter-item">
          <span>关联管线</span>
          <select v-model="createForm.关联管线">
            <option v-for="code in pipelineOptions" :key="code" :value="code">{{ code }}</option>
          </select>
        </label>
        <button class="btn primary" type="submit">提交登记</button>
        <button class="btn ghost" type="button" @click="createOpen = false">收起</button>
      </form>

      <article v-if="activeBatch" class="batch-active">
        <header class="batch-active-head">
          <strong>执行工作台</strong>
          <span v-if="restored">已恢复原批次「{{ activeBatch.批次编号 }}」和当前状态「{{ activeBatch.status }}」，中断前的进度已保留</span>
          <span v-else>批次「{{ activeBatch.批次编号 }}」当前状态「{{ activeBatch.status }}」</span>
        </header>
        <p class="batch-active-meta">
          路线：{{ activeBatch.路线名称 }} · 区域：{{ activeBatch.巡检区域 }} · 关联管线：{{ activeBatch.关联管线 }} · 负责人：{{ activeBatch.负责人 }}
          <template v-if="activeBatch.interrupted"> · 执行已中断（第 {{ activeBatch.中断次数 }} 次）</template>
        </p>
        <div class="row-actions">
          <button v-if="activeBatch.interrupted" class="btn primary" type="button" @click="resumeActive">继续执行</button>
          <button v-else class="btn" type="button" @click="interruptActive">中断执行</button>
          <button class="btn" type="button" @click="openAnomaly(activeBatch)">上报异常</button>
          <button class="btn" type="button" @click="completeActive">确认完成</button>
        </div>
      </article>

      <table class="data-table">
        <thead>
          <tr>
            <th>批次编号</th>
            <th>路线名称</th>
            <th>巡检区域</th>
            <th>关联管线</th>
            <th>当前状态</th>
            <th>负责人</th>
            <th>中断次数</th>
            <th>批次操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="batch.id">
            <td>{{ batch.批次编号 }}</td>
            <td>{{ batch.路线名称 }}</td>
            <td>{{ batch.巡检区域 }}</td>
            <td>{{ batch.关联管线 }}</td>
            <td>{{ batch.status }}<template v-if="batch.interrupted">（已中断）</template></td>
            <td>{{ batch.负责人 || '—' }}</td>
            <td>{{ batch.中断次数 }}</td>
            <td class="row-actions">
              <button v-if="batch.status === '待分配'" class="link" type="button" @click="claim(batch)">领取批次</button>
              <button v-if="batch.status === '已分配'" class="link" type="button" @click="start(batch)">开始巡检</button>
              <button v-if="batch.status === '执行中'" class="link" type="button" @click="enterExecution(batch)">进入执行</button>
              <button
                v-if="batch.status === '已分配' || batch.status === '执行中'"
                class="link"
                type="button"
                @click="openHandover(batch)"
              >
                切换人员
              </button>
              <button v-if="batch.status !== '已完成'" class="link" type="button" @click="cancel(batch)">取消批次</button>
              <button class="link" type="button" @click="toggleLog(batch)">
                {{ logFor === batch.id ? '收起记录' : '流转记录' }}
              </button>
            </td>
          </tr>
          <tr v-if="!batches.length">
            <td colspan="8" class="empty-state">暂无路线批次，可点击「登记巡检任务」生成批次</td>
          </tr>
        </tbody>
      </table>

      <p v-if="cancelFailure" class="cancel-failure">
        <span class="error-text">{{ cancelFailure.message }}</span>
        <button class="btn ghost" type="button" @click="retryCancel">重试取消</button>
      </p>

      <form v-if="anomalyFor" class="batch-form" @submit.prevent="submitAnomaly">
        <h4>上报现场异常 — 批次「{{ anomalyFor.批次编号 }}」</h4>
        <p class="page-desc form-desc">
          提交后将在缺陷记录中新增一条待确认缺陷，并在管线登记页为「{{ anomalyFor.关联管线 }}」留下覆盖标记。
        </p>
        <label class="filter-item">
          <span>缺陷类型</span>
          <select v-model="anomalyForm.缺陷类型">
            <option>管道破裂</option>
            <option>接口渗漏</option>
            <option>管壁腐蚀</option>
            <option>异物堵塞</option>
            <option>井盖破损</option>
          </select>
        </label>
        <label class="filter-item">
          <span>严重等级</span>
          <select v-model="anomalyForm.严重等级">
            <option>一般</option>
            <option>较大</option>
            <option>重大</option>
          </select>
        </label>
        <label class="filter-item">
          <span>缺陷描述</span>
          <input v-model="anomalyForm.缺陷描述" placeholder="现场异常情况描述" />
        </label>
        <button class="btn primary" type="submit">提交异常</button>
        <button class="btn ghost" type="button" @click="anomalyFor = null">取消</button>
      </form>

      <form v-if="handoverFor" class="batch-form" @submit.prevent="submitHandover">
        <h4>切换人员 — 批次「{{ handoverFor.批次编号 }}」</h4>
        <p class="page-desc form-desc">当前负责人：{{ handoverFor.负责人 }}，切换后将记录一条责任变更。</p>
        <label class="filter-item">
          <span>接任人员</span>
          <input v-model="handoverForm.next" placeholder="接任人员姓名" />
        </label>
        <label class="filter-item">
          <span>变更说明</span>
          <input v-model="handoverForm.note" placeholder="例如：班次交接" />
        </label>
        <button class="btn primary" type="submit">确认切换</button>
        <button class="btn ghost" type="button" @click="handoverFor = null">取消</button>
      </form>

      <div v-if="logBatch" class="batch-log">
        <h4>批次「{{ logBatch.批次编号 }}」流转记录</h4>
        <template v-if="logBatch.责任变更记录.length">
          <h5>责任变更</h5>
          <ul>
            <li v-for="(item, index) in logBatch.责任变更记录" :key="`handover-${index}`">
              {{ item.time }}：{{ item.原负责人 }} → {{ item.新负责人 }}（{{ item.说明 }}）
            </li>
          </ul>
        </template>
        <h5>状态日志</h5>
        <ul>
          <li v-for="(item, index) in logBatch.日志" :key="`log-${index}`">{{ item.time }}：{{ item.text }}</li>
        </ul>
      </div>

      <p v-if="batchNotice" class="batch-notice">{{ batchNotice }}</p>
      <p v-if="batchError" class="error-text">{{ batchError }}</p>
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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无巡检任务数据，可先登记巡检任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡检任务记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  cancelBatch,
  claimBatch,
  completeBatch,
  createBatch,
  handoverBatch,
  interruptBatch,
  listBatches,
  openExecution,
  reportAnomaly,
  restoreActiveBatch,
  resumeBatch,
  startBatch,
} from '@/api/inspection-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import type { InspectionBatch } from '@/data/inspection-batches'
import type { ActionResult, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('inspection')
const columns = ["任务编号", "巡检区域", "巡检人员", "巡检日期", "巡检路线", "计划时长", "完成情况", "任务状态"]
const actions = ["分配任务", "开始巡检", "确认完成"]
const statuses = ["待分配", "已分配", "执行中", "已完成"]
const stats = [{"label": "今日任务", "value": 0}, {"label": "待分配任务", "value": 0}, {"label": "已完成任务", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const session = useSessionStore()
const operator = ref(session.operator)
const batches = ref<InspectionBatch[]>([])
const activeBatch = ref<InspectionBatch | null>(null)
const restored = ref(false)
const batchNotice = ref('')
const batchError = ref('')
const cancelFailure = ref<{ id: number; message: string } | null>(null)
const createOpen = ref(false)
const createForm = ref({ 路线名称: '', 巡检区域: '', 关联管线: 'PIPE-0001' })
const pipelineOptions = listRows('pipeline').map((row) => String(row['管线编号']))
const anomalyFor = ref<InspectionBatch | null>(null)
const anomalyForm = ref({ 缺陷类型: '管道破裂', 严重等级: '一般', 缺陷描述: '' })
const handoverFor = ref<InspectionBatch | null>(null)
const handoverForm = ref({ next: '', note: '' })
const logFor = ref<number | null>(null)
const logBatch = computed(() => batches.value.find((batch) => batch.id === logFor.value) ?? null)

function refreshBatches() {
  batches.value = listBatches()
  activeBatch.value = restoreActiveBatch()
}

function applyResult(result: ActionResult) {
  restored.value = false
  if (result.ok) {
    batchNotice.value = result.message
    batchError.value = ''
  } else {
    batchError.value = result.message
    batchNotice.value = ''
  }
  refreshBatches()
}

function openCreate() {
  createOpen.value = !createOpen.value
}

function submitCreate() {
  const result = createBatch(createForm.value)
  if (result.ok) {
    createOpen.value = false
    createForm.value = { 路线名称: '', 巡检区域: '', 关联管线: createForm.value.关联管线 }
  }
  applyResult(result)
}

function claim(batch: InspectionBatch) {
  applyResult(claimBatch(batch.id, operator.value))
}

function start(batch: InspectionBatch) {
  applyResult(startBatch(batch.id, operator.value))
}

function enterExecution(batch: InspectionBatch) {
  applyResult(openExecution(batch.id))
}

function interruptActive() {
  if (!activeBatch.value) return
  applyResult(interruptBatch(activeBatch.value.id))
}

function resumeActive() {
  if (!activeBatch.value) return
  applyResult(resumeBatch(activeBatch.value.id))
}

function completeActive() {
  if (!activeBatch.value) return
  applyResult(completeBatch(activeBatch.value.id, operator.value))
}

function openAnomaly(batch: InspectionBatch) {
  anomalyFor.value = batch
  anomalyForm.value = { 缺陷类型: '管道破裂', 严重等级: '一般', 缺陷描述: '' }
}

function submitAnomaly() {
  if (!anomalyFor.value) return
  const result = reportAnomaly(anomalyFor.value.id, anomalyForm.value)
  if (result.ok) {
    anomalyFor.value = null
  }
  applyResult(result)
}

function openHandover(batch: InspectionBatch) {
  handoverFor.value = batch
  handoverForm.value = { next: '', note: '' }
}

function submitHandover() {
  if (!handoverFor.value) return
  const result = handoverBatch(handoverFor.value.id, handoverForm.value.next, handoverForm.value.note)
  if (result.ok) {
    handoverFor.value = null
  }
  applyResult(result)
}

function cancel(batch: InspectionBatch) {
  const result = cancelBatch(batch.id)
  restored.value = false
  if (result.ok) {
    cancelFailure.value = null
    batchNotice.value = result.message
    batchError.value = ''
  } else {
    cancelFailure.value = { id: batch.id, message: result.message }
    batchNotice.value = ''
  }
  refreshBatches()
}

function retryCancel() {
  if (!cancelFailure.value) return
  const result = cancelBatch(cancelFailure.value.id)
  restored.value = false
  if (result.ok) {
    cancelFailure.value = null
    batchNotice.value = result.message
    batchError.value = ''
  } else {
    cancelFailure.value = { id: cancelFailure.value.id, message: result.message }
    batchNotice.value = ''
  }
  refreshBatches()
}

function toggleLog(batch: InspectionBatch) {
  logFor.value = logFor.value === batch.id ? null : batch.id
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
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
  batches.value = listBatches()
  activeBatch.value = restoreActiveBatch()
  restored.value = activeBatch.value !== null
})
</script>
