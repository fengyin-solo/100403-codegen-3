// 巡检路线批次：独立于通用条目存储，每次操作都从 localStorage 现读现写。
// 多人（或多个标签页）同时领取同一批次时，以存储里的最新状态判定，只有一人能成功。

export type BatchStatus = '待分配' | '已分配' | '执行中' | '已完成'

// 批次状态只能沿这条链逐格推进。
export const BATCH_FLOW: BatchStatus[] = ['待分配', '已分配', '执行中', '已完成']

export type HandoverRecord = {
  time: string
  原负责人: string
  新负责人: string
  说明: string
}

export type BatchLog = {
  time: string
  text: string
}

export type InspectionBatch = {
  id: number
  批次编号: string
  路线名称: string
  巡检区域: string
  关联管线: string
  status: BatchStatus
  负责人: string
  interrupted: boolean
  中断次数: number
  责任变更记录: HandoverRecord[]
  日志: BatchLog[]
}

const STORAGE_KEY = 'underground-pipeline-inspection:inspection-batches'
const ACTIVE_KEY = 'underground-pipeline-inspection:inspection-active-batch'

const SEED_BATCHES: InspectionBatch[] = [
  {
    id: 1,
    批次编号: 'BATCH-2026-001',
    路线名称: '城东主干道巡检路线',
    巡检区域: '城东区',
    关联管线: 'PIPE-0001',
    status: '待分配',
    负责人: '',
    interrupted: false,
    中断次数: 0,
    责任变更记录: [],
    日志: [{ time: '2026-10-06 08:00:00', text: '批次已生成，等待领取' }],
  },
  {
    id: 2,
    批次编号: 'BATCH-2026-002',
    路线名称: '城西支路巡检路线',
    巡检区域: '城西区',
    关联管线: 'PIPE-0002',
    status: '已分配',
    负责人: '张工',
    interrupted: false,
    中断次数: 0,
    责任变更记录: [],
    日志: [{ time: '2026-10-06 08:10:00', text: '张工 领取了批次，状态推进为「已分配」' }],
  },
  {
    id: 3,
    批次编号: 'BATCH-2026-003',
    路线名称: '滨河路下穿段巡检路线',
    巡检区域: '滨河区',
    关联管线: 'PIPE-0003',
    status: '执行中',
    负责人: '李工',
    interrupted: false,
    中断次数: 0,
    责任变更记录: [],
    日志: [
      { time: '2026-10-06 08:05:00', text: '李工 领取了批次，状态推进为「已分配」' },
      { time: '2026-10-06 08:30:00', text: '李工 开始巡检，状态推进为「执行中」' },
    ],
  },
]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function readBatches(): InspectionBatch[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(SEED_BATCHES)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = clone(SEED_BATCHES)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    return JSON.parse(raw) as InspectionBatch[]
  } catch {
    const seeded = clone(SEED_BATCHES)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

export function writeBatches(batches: InspectionBatch[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(batches))
  }
}

export function resetBatchRows(): InspectionBatch[] {
  const seeded = clone(SEED_BATCHES)
  writeBatches(seeded)
  clearActiveBatchId()
  return seeded
}

// 执行中断后，这个指针记住「原批次」，再次进入页面时连同当前状态一起恢复。
export function readActiveBatchId(): number | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(ACTIVE_KEY)
  if (!raw) {
    return null
  }
  const id = Number(raw)
  return Number.isFinite(id) ? id : null
}

export function writeActiveBatchId(id: number): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(ACTIVE_KEY, String(id))
  }
}

export function clearActiveBatchId(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(ACTIVE_KEY)
  }
}
