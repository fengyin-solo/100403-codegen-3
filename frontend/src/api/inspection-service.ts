import { listRows, readFreshRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 巡检任务的路线批次流转：待分配→已分配→执行中→已完成，逐级推进。
// 领取、变更、取消都要读 localStorage 最新快照再写，避免两个值班人员同时操作互相覆盖。
const MODULE_KEY = 'inspection'
const DEFECT_KEY = 'defect'
const PIPELINE_KEY = 'pipeline'
const HANDOVER_KEY = 'inspection_handover'
const ACTIVE_STORAGE_KEY = 'underground-pipeline-inspection:inspection-active'

export const INSPECTION_FLOW = ['待分配', '已分配', '执行中', '已完成'] as const

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function now(): string {
  const date = new Date()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function today(): string {
  return now().slice(0, 10)
}

function batchLabel(row: EntryRow): string {
  return String(row['批次编号'] ?? row['任务编号'] ?? row.id)
}

function findFresh(id: number): { rows: EntryRow[]; index: number; row: EntryRow } | null {
  const rows = readFreshRows(MODULE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return null
  }
  return { rows, index, row: rows[index] }
}

function ownerOf(row: EntryRow): string {
  return String(row['巡检人员'] ?? '').trim()
}

// 责任人校验：批次已被人领取时，开始、完成、上报异常只能由本人操作。
function ownerDeny(row: EntryRow, operator: string): string | null {
  const owner = ownerOf(row)
  if (owner && owner !== operator) {
    return `批次 ${batchLabel(row)} 当前由「${owner}」负责，如需换人请先变更责任人`
  }
  return null
}

function notFound(id: number): ActionResult {
  return { ok: false, message: `没有找到编号为 ${id} 的巡检任务` }
}

// ---- 执行台（中断恢复）----

function readActiveMap(): Record<string, number> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  try {
    return JSON.parse(window.localStorage.getItem(ACTIVE_STORAGE_KEY) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

export function getActiveTaskId(operator: string): number | null {
  const id = readActiveMap()[operator]
  return typeof id === 'number' ? id : null
}

export function setActiveTaskId(operator: string, id: number | null): void {
  const map = readActiveMap()
  if (id === null) {
    delete map[operator]
  } else {
    map[operator] = id
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(ACTIVE_STORAGE_KEY, JSON.stringify(map))
  }
}

export function getTask(id: number): EntryRow | null {
  return listRows(MODULE_KEY).find((row) => Number(row.id) === id) ?? null
}

// ---- 责任变更记录 ----

function appendHandover(entry: Record<string, string>): void {
  const rows = readFreshRows(HANDOVER_KEY)
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  saveRows(HANDOVER_KEY, [
    ...rows,
    { id: nextId, status: '已记录', pending: false, abnormal: false, ...entry },
  ])
}

export function listHandovers(taskNo?: string): EntryRow[] {
  const rows = listRows(HANDOVER_KEY)
  const matched = taskNo ? rows.filter((row) => String(row['任务编号']) === taskNo) : rows
  return [...matched].sort((a, b) => Number(b.id) - Number(a.id))
}

// ---- 批次流转 ----

// 领取批次：待分配→已分配。多人同时领取同一批次时，先读最新快照校验，写入后再复核，只有一人能成功。
export function claimBatch(id: number, operator: string): ActionResult {
  const found = findFresh(id)
  if (!found) {
    return notFound(id)
  }
  const { rows, index, row } = found
  const owner = ownerOf(row)
  if (String(row.status) !== '待分配' || owner) {
    return {
      ok: false,
      message: `批次 ${batchLabel(row)} 已被 ${owner || '其他人'} 领取，当前状态「${row.status}」，同一批次只能一人领取`,
    }
  }
  const next = [...rows]
  next[index] = {
    ...row,
    status: '已分配',
    pending: true,
    abnormal: false,
    巡检人员: operator,
    领取时间: now(),
    任务状态: '已分配',
  }
  saveRows(MODULE_KEY, next)
  // 写后复核：另一个窗口若同时写入，以最终落盘的领取人为准。
  const persisted = readFreshRows(MODULE_KEY).find((item) => Number(item.id) === id)
  if (!persisted || ownerOf(persisted) !== operator) {
    return {
      ok: false,
      message: `批次 ${batchLabel(row)} 刚被 ${persisted ? ownerOf(persisted) : '其他人'} 领取，本次领取未生效`,
    }
  }
  setActiveTaskId(operator, id)
  return { ok: true, message: `批次 ${batchLabel(row)} 领取成功，责任人：${operator}，当前状态「已分配」` }
}

export function startInspection(id: number, operator: string): ActionResult {
  const found = findFresh(id)
  if (!found) {
    return notFound(id)
  }
  const { rows, index, row } = found
  const status = String(row.status)
  if (status === '已完成') {
    return { ok: false, message: `批次 ${batchLabel(row)} 已完成，流程已终结，不能再开始巡检` }
  }
  if (status !== '已分配') {
    return { ok: false, message: `巡检任务必须按 ${INSPECTION_FLOW.join('→')} 顺序推进，当前「${status}」不能开始巡检` }
  }
  const deny = ownerDeny(row, operator)
  if (deny) {
    return { ok: false, message: deny }
  }
  const next = [...rows]
  next[index] = { ...row, status: '执行中', pending: true, 完成情况: '巡检中', 任务状态: '执行中' }
  saveRows(MODULE_KEY, next)
  setActiveTaskId(operator, id)
  return { ok: true, message: `批次 ${batchLabel(row)} 开始巡检，当前状态「执行中」` }
}

export function completeInspection(id: number, operator: string): ActionResult {
  const found = findFresh(id)
  if (!found) {
    return notFound(id)
  }
  const { rows, index, row } = found
  const status = String(row.status)
  if (status === '已完成') {
    return { ok: false, message: `批次 ${batchLabel(row)} 已经是「已完成」，不用重复确认` }
  }
  if (status !== '执行中') {
    return { ok: false, message: `巡检任务必须按 ${INSPECTION_FLOW.join('→')} 顺序推进，当前「${status}」不能确认完成` }
  }
  const deny = ownerDeny(row, operator)
  if (deny) {
    return { ok: false, message: deny }
  }
  const next = [...rows]
  next[index] = { ...row, status: '已完成', pending: false, 完成情况: `已完成（${today()}）`, 任务状态: '已完成' }
  saveRows(MODULE_KEY, next)
  return { ok: true, message: `批次 ${batchLabel(row)} 已确认完成，流程终结，状态不可再回退` }
}

// 上报异常：执行中批次现场发现异常时，缺陷记录新增一条待确认缺陷，路线覆盖的管线留下覆盖标记。
export function reportAnomaly(id: number, operator: string): ActionResult {
  const found = findFresh(id)
  if (!found) {
    return notFound(id)
  }
  const { row } = found
  const status = String(row.status)
  if (status !== '执行中') {
    return { ok: false, message: `只有「执行中」的批次才能上报异常，当前状态「${status}」` }
  }
  const deny = ownerDeny(row, operator)
  if (deny) {
    return { ok: false, message: deny }
  }
  const routeCodes = String(row['巡检路线'] ?? '')
    .split(/[→,，、;；\s]+/)
    .filter(Boolean)
  const pipelines = readFreshRows(PIPELINE_KEY)
  const covered: string[] = []
  const nextPipelines = pipelines.map((pipeline) => {
    const code = String(pipeline['管线编号'] ?? '')
    if (!routeCodes.includes(code)) {
      return pipeline
    }
    covered.push(code)
    const previous = String(pipeline['覆盖标记'] ?? '未覆盖')
    const taskNo = String(row['任务编号'] ?? '')
    const mark = previous.startsWith('已覆盖')
      ? previous.includes(taskNo)
        ? previous
        : `${previous}、${taskNo}`
      : `已覆盖·${taskNo}`
    return { ...pipeline, 覆盖标记: mark }
  })
  const defects = readFreshRows(DEFECT_KEY)
  const defectId = defects.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const defect: EntryRow = {
    id: defectId,
    status: '待确认',
    pending: true,
    abnormal: true,
    缺陷编号: `DEFE-${String(defectId).padStart(4, '0')}`,
    所属管线: covered[0] ?? '待关联',
    缺陷类型: '现场异常',
    发现位置: String(row['巡检区域'] ?? ''),
    严重等级: '待评估',
    发现日期: today(),
    缺陷描述: `巡检任务 ${row['任务编号']}（批次 ${batchLabel(row)}）现场发现异常，待确认`,
    记录状态: '待确认',
  }
  saveRows(DEFECT_KEY, [...defects, defect])
  if (covered.length > 0) {
    saveRows(PIPELINE_KEY, nextPipelines)
  }
  const markText = covered.length
    ? `，管线 ${covered.join('、')} 已留下覆盖标记`
    : '，巡检路线上没有匹配到已登记管线，未留下覆盖标记'
  return { ok: true, message: `已上报异常：缺陷记录新增待确认缺陷 ${defect['缺陷编号']}${markText}` }
}

// 变更责任人：已分配/执行中可换人，全程留痕；执行现场跟着新责任人走。
export function reassignBatch(id: number, operator: string, nextOperator: string): ActionResult {
  const target = nextOperator.trim()
  if (!target) {
    return { ok: false, message: '请先填写新的责任人姓名' }
  }
  const found = findFresh(id)
  if (!found) {
    return notFound(id)
  }
  const { rows, index, row } = found
  const status = String(row.status)
  if (status === '待分配') {
    return { ok: false, message: `批次 ${batchLabel(row)} 尚未领取，没有责任人可变更` }
  }
  if (status === '已完成') {
    return { ok: false, message: `批次 ${batchLabel(row)} 已完成，流程已终结，不能再变更责任人` }
  }
  const previous = ownerOf(row)
  if (previous === target) {
    return { ok: false, message: `「${target}」已是当前责任人，无需变更` }
  }
  const next = [...rows]
  next[index] = { ...row, 巡检人员: target }
  saveRows(MODULE_KEY, next)
  appendHandover({
    类型: '责任变更',
    任务编号: String(row['任务编号'] ?? ''),
    批次编号: batchLabel(row),
    原责任人: previous || '—',
    新责任人: target,
    操作人: operator,
    时间: now(),
  })
  if (previous && getActiveTaskId(previous) === id) {
    setActiveTaskId(previous, null)
  }
  setActiveTaskId(target, id)
  return { ok: true, message: `批次 ${batchLabel(row)} 责任人已由「${previous || '—'}」变更为「${target}」，已记录责任变更` }
}

// 取消任务：已分配/执行中可取消并释放回待分配；已完成不能取消。失败会说明原因，可再次尝试。
export function cancelBatch(id: number, operator: string): ActionResult {
  const found = findFresh(id)
  if (!found) {
    return notFound(id)
  }
  const { rows, index, row } = found
  const status = String(row.status)
  if (status === '已完成') {
    return { ok: false, message: `批次 ${batchLabel(row)} 已完成，流程已终结，不能取消；如需复查请重新登记巡检任务` }
  }
  if (status === '待分配') {
    return { ok: false, message: `批次 ${batchLabel(row)} 尚未领取，无需取消` }
  }
  const previous = ownerOf(row)
  const next = [...rows]
  next[index] = {
    ...row,
    status: '待分配',
    pending: true,
    巡检人员: '',
    领取时间: '',
    完成情况: '已取消待重新领取',
    任务状态: '待分配',
  }
  saveRows(MODULE_KEY, next)
  appendHandover({
    类型: '取消释放',
    任务编号: String(row['任务编号'] ?? ''),
    批次编号: batchLabel(row),
    原责任人: previous || '—',
    新责任人: '—',
    操作人: operator,
    时间: now(),
  })
  return { ok: true, message: `批次 ${batchLabel(row)} 已取消，回到「待分配」，可重新领取` }
}
