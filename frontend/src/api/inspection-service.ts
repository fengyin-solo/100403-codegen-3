import {
  BATCH_FLOW,
  clearActiveBatchId,
  readActiveBatchId,
  readBatches,
  resetBatchRows,
  writeActiveBatchId,
  writeBatches,
} from '@/data/inspection-batches'
import type { BatchStatus, InspectionBatch } from '@/data/inspection-batches'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

export type AnomalyPayload = {
  缺陷类型: string
  严重等级: string
  缺陷描述: string
}

export type CreateBatchPayload = {
  路线名称: string
  巡检区域: string
  关联管线: string
}

function now(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function today(): string {
  const date = new Date()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function findBatch(batches: InspectionBatch[], id: number): InspectionBatch | undefined {
  return batches.find((batch) => batch.id === id)
}

function notFound(id: number): ActionResult {
  return { ok: false, message: `没有找到编号为 ${id} 的巡检批次` }
}

function appendLog(batch: InspectionBatch, text: string): void {
  batch.日志 = [...batch.日志, { time: now(), text }]
}

// 顺序校验：批次只能沿 待分配→已分配→执行中→已完成 逐格推进，跳级或回退都拒绝。
function flowError(current: BatchStatus, target: BatchStatus): string | null {
  const from = BATCH_FLOW.indexOf(current)
  const to = BATCH_FLOW.indexOf(target)
  if (to === from) {
    return `批次已经是「${target}」，不用重复操作`
  }
  if (to < from) {
    return `巡检批次必须按顺序推进，不能从「${current}」回到「${target}」`
  }
  if (to > from + 1) {
    return `巡检批次必须依次经过${BATCH_FLOW.join('、')}，不能从「${current}」跳到「${target}」`
  }
  return null
}

function ownerError(batch: InspectionBatch, operator: string): string | null {
  if (batch.负责人 !== operator.trim()) {
    return `批次「${batch.批次编号}」当前由「${batch.负责人}」负责，请改用负责人身份操作，或先切换人员记录责任变更`
  }
  return null
}

export function listBatches(): InspectionBatch[] {
  return readBatches()
}

export function createBatch(payload: CreateBatchPayload): ActionResult {
  const batches = readBatches()
  const nextId = batches.reduce((max, batch) => Math.max(max, batch.id), 0) + 1
  const batch: InspectionBatch = {
    id: nextId,
    批次编号: `BATCH-2026-${String(nextId).padStart(3, '0')}`,
    路线名称: payload.路线名称.trim() || `巡检路线${nextId}`,
    巡检区域: payload.巡检区域.trim() || '未指定区域',
    关联管线: payload.关联管线,
    status: '待分配',
    负责人: '',
    interrupted: false,
    中断次数: 0,
    责任变更记录: [],
    日志: [{ time: now(), text: '批次已生成，等待领取' }],
  }
  writeBatches([...batches, batch])
  return { ok: true, message: `批次「${batch.批次编号}」已登记，当前状态「待分配」` }
}

// 领取即 待分配→已分配：以存储里的最新状态判定，同一批次仅一人能领取成功。
export function claimBatch(id: number, operator: string): ActionResult {
  const name = operator.trim()
  if (!name) {
    return { ok: false, message: '请先填写领取人姓名再领取批次' }
  }
  const batches = readBatches()
  const batch = findBatch(batches, id)
  if (!batch) {
    return notFound(id)
  }
  if (batch.status !== '待分配' || batch.负责人) {
    return { ok: false, message: `领取失败：批次「${batch.批次编号}」已被「${batch.负责人}」领取，同一批次仅允许一人领取` }
  }
  batch.status = '已分配'
  batch.负责人 = name
  appendLog(batch, `${name} 领取了批次，状态推进为「已分配」`)
  writeBatches(batches)
  return { ok: true, message: `批次「${batch.批次编号}」已由 ${name} 领取，当前状态「已分配」` }
}

export function startBatch(id: number, operator: string): ActionResult {
  const batches = readBatches()
  const batch = findBatch(batches, id)
  if (!batch) {
    return notFound(id)
  }
  const blocked = flowError(batch.status, '执行中')
  if (blocked) {
    return { ok: false, message: blocked }
  }
  const wrongOwner = ownerError(batch, operator)
  if (wrongOwner) {
    return { ok: false, message: wrongOwner }
  }
  batch.status = '执行中'
  batch.interrupted = false
  appendLog(batch, `${batch.负责人} 开始巡检，状态推进为「执行中」`)
  writeBatches(batches)
  writeActiveBatchId(batch.id)
  return { ok: true, message: `批次「${batch.批次编号}」开始巡检，当前状态「执行中」` }
}

// 中断不改动状态链：批次仍是「执行中」，只记录中断并保留恢复指针。
export function interruptBatch(id: number): ActionResult {
  const batches = readBatches()
  const batch = findBatch(batches, id)
  if (!batch) {
    return notFound(id)
  }
  if (batch.status !== '执行中') {
    return { ok: false, message: `批次「${batch.批次编号}」当前状态「${batch.status}」，只有执行中的批次才能中断` }
  }
  if (batch.interrupted) {
    return { ok: false, message: `批次「${batch.批次编号}」已经处于中断状态` }
  }
  batch.interrupted = true
  batch.中断次数 += 1
  appendLog(batch, `执行中断（第 ${batch.中断次数} 次），再次进入时将恢复原批次和当前状态`)
  writeBatches(batches)
  writeActiveBatchId(batch.id)
  return { ok: true, message: `批次「${batch.批次编号}」已中断，进度已保留，再次进入会自动恢复` }
}

export function resumeBatch(id: number): ActionResult {
  const batches = readBatches()
  const batch = findBatch(batches, id)
  if (!batch) {
    return notFound(id)
  }
  if (batch.status !== '执行中') {
    return { ok: false, message: `批次「${batch.批次编号}」当前状态「${batch.status}」，无法继续执行` }
  }
  if (!batch.interrupted) {
    return { ok: false, message: `批次「${batch.批次编号}」正在执行中，无需恢复` }
  }
  batch.interrupted = false
  appendLog(batch, `${batch.负责人} 恢复执行，继续巡检`)
  writeBatches(batches)
  writeActiveBatchId(batch.id)
  return { ok: true, message: `批次「${batch.批次编号}」已恢复执行，当前状态「执行中」` }
}

export function completeBatch(id: number, operator: string): ActionResult {
  const batches = readBatches()
  const batch = findBatch(batches, id)
  if (!batch) {
    return notFound(id)
  }
  const blocked = flowError(batch.status, '已完成')
  if (blocked) {
    return { ok: false, message: blocked }
  }
  const wrongOwner = ownerError(batch, operator)
  if (wrongOwner) {
    return { ok: false, message: wrongOwner }
  }
  batch.status = '已完成'
  batch.interrupted = false
  appendLog(batch, `${batch.负责人} 确认完成，状态推进为「已完成」`)
  writeBatches(batches)
  if (readActiveBatchId() === batch.id) {
    clearActiveBatchId()
  }
  return { ok: true, message: `批次「${batch.批次编号}」已完成，状态链已走到终点` }
}

// 现场异常：缺陷记录新增一条待确认缺陷，管线登记页给关联管线留下覆盖标记。
export function reportAnomaly(id: number, payload: AnomalyPayload): ActionResult {
  const batches = readBatches()
  const batch = findBatch(batches, id)
  if (!batch) {
    return notFound(id)
  }
  if (batch.status !== '执行中') {
    return { ok: false, message: `批次「${batch.批次编号}」当前状态「${batch.status}」，只有执行中的批次才能上报现场异常` }
  }
  if (!payload.缺陷描述.trim()) {
    return { ok: false, message: '请填写缺陷描述再上报异常' }
  }

  const defects = listRows('defect')
  const nextId = defects.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const defect: EntryRow = {
    id: nextId,
    status: '待确认',
    pending: true,
    abnormal: false,
    缺陷编号: `DEFE-${String(nextId).padStart(4, '0')}`,
    所属管线: batch.关联管线,
    缺陷类型: payload.缺陷类型,
    发现位置: `${batch.路线名称}（${batch.巡检区域}）`,
    严重等级: payload.严重等级,
    发现日期: today(),
    缺陷描述: payload.缺陷描述.trim(),
    记录状态: '巡检现场上报',
  }
  saveRows('defect', [...defects, defect])

  const pipes = listRows('pipeline')
  const index = pipes.findIndex((row) => String(row['管线编号']) === batch.关联管线)
  let pipelineNote: string
  if (index >= 0) {
    const next = [...pipes]
    next[index] = {
      ...next[index],
      abnormal: true,
      pending: true,
      覆盖标记: `批次${batch.批次编号}于${today()}上报异常，登记信息待复核覆盖`,
    }
    saveRows('pipeline', next)
    pipelineNote = `，管线「${batch.关联管线}」已留下覆盖标记`
  } else {
    pipelineNote = `，但未找到关联管线「${batch.关联管线}」，覆盖标记未写入`
  }

  appendLog(batch, `现场上报异常：${payload.缺陷类型}（${payload.严重等级}），已生成待确认缺陷 ${defect.缺陷编号}`)
  writeBatches(batches)
  return { ok: true, message: `已新增待确认缺陷「${defect.缺陷编号}」${pipelineNote}` }
}

// 切换人员必须留下责任变更记录。
export function handoverBatch(id: number, nextOperator: string, note: string): ActionResult {
  const name = nextOperator.trim()
  if (!name) {
    return { ok: false, message: '请填写接任人员姓名' }
  }
  const batches = readBatches()
  const batch = findBatch(batches, id)
  if (!batch) {
    return notFound(id)
  }
  if (batch.status !== '已分配' && batch.status !== '执行中') {
    return { ok: false, message: `批次「${batch.批次编号}」当前状态「${batch.status}」，只有已分配或执行中的批次才能切换人员` }
  }
  if (batch.负责人 === name) {
    return { ok: false, message: `批次「${batch.批次编号}」负责人已经是「${name}」，无需切换` }
  }
  const record = {
    time: now(),
    原负责人: batch.负责人,
    新负责人: name,
    说明: note.trim() || '例行交接',
  }
  batch.责任变更记录 = [...batch.责任变更记录, record]
  batch.负责人 = name
  appendLog(batch, `负责人由「${record.原负责人}」变更为「${name}」（${record.说明}）`)
  writeBatches(batches)
  return { ok: true, message: `批次「${batch.批次编号}」负责人已变更为「${name}」，责任变更已记录` }
}

// 取消只释放未完成的批次；失败时说明原因，调用方可以原样重试。
export function cancelBatch(id: number): ActionResult {
  const batches = readBatches()
  const batch = findBatch(batches, id)
  if (!batch) {
    return notFound(id)
  }
  if (batch.status === '已完成') {
    return { ok: false, message: `取消失败：批次「${batch.批次编号}」已完成，状态不可回退` }
  }
  if (batch.status === '待分配') {
    return { ok: false, message: `取消失败：批次「${batch.批次编号}」尚未被领取，没有可取消的分配` }
  }
  if (batch.status === '执行中' && !batch.interrupted) {
    return { ok: false, message: `取消失败：批次「${batch.批次编号}」正在执行中，请先中断执行再重试取消` }
  }
  const previous = batch.status
  batch.status = '待分配'
  batch.负责人 = ''
  batch.interrupted = false
  appendLog(batch, `取消批次：由「${previous}」回到「待分配」，释放领取名额`)
  writeBatches(batches)
  if (readActiveBatchId() === batch.id) {
    clearActiveBatchId()
  }
  return { ok: true, message: `批次「${batch.批次编号}」已取消，回到「待分配」，可重新领取` }
}

// 页面加载时调用：有未走完的执行批次就恢复出来，连同当前状态一起交还给界面。
export function restoreActiveBatch(): InspectionBatch | null {
  const id = readActiveBatchId()
  if (id === null) {
    return null
  }
  const batch = findBatch(readBatches(), id)
  if (!batch || batch.status !== '执行中') {
    clearActiveBatchId()
    return null
  }
  return batch
}

export function openExecution(id: number): ActionResult {
  const batch = findBatch(readBatches(), id)
  if (!batch) {
    return notFound(id)
  }
  if (batch.status !== '执行中') {
    return { ok: false, message: `批次「${batch.批次编号}」当前状态「${batch.status}」，不在执行中` }
  }
  writeActiveBatchId(batch.id)
  return { ok: true, message: `已进入批次「${batch.批次编号}」的执行工作台` }
}

export function resetBatches(): InspectionBatch[] {
  return resetBatchRows()
}
