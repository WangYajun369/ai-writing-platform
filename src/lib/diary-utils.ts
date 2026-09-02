/**
 * 日记模块工具函数
 *
 * 提供日记日期格式化、日历计算与关键字提取等纯函数，
 * 供 DiaryPanel（日历 + 列表）与 DiaryDialog（编辑器）复用。
 */

/** 补零 */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 将 Date 转为本地日期键 YYYY-MM-DD */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 解析 YYYY-MM-DD 为 { year, month, day } */
export function parseDateKey(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split('-').map(Number)
  return { year, month, day }
}

/** 周标签（周一开始，索引 0 = 周一） */
export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const

/** 周标签（完整，索引 0 = 周日，用于标题展示） */
const FULL_WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/** 获取某日期在“周一起始”一周中的下标（0 = 周一） */
export function getMondayBasedWeekday(year: number, month: number, day: number): number {
  const wd = new Date(year, month - 1, day).getDay()
  return (wd + 6) % 7
}

/** 某月的天数 */
export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/** 展示为「2026年9月」 */
export function formatMonthTitle(year: number, month: number): string {
  return `${year}年${month}月`
}

/** 展示为「9月2日」 */
export function formatShortDate(key: string): string {
  const { month, day } = parseDateKey(key)
  return `${month}月${day}日`
}

/** 展示为「9月2日 星期三」（若为今天则追加“今天”标记前缀由调用方处理） */
export function formatWeekdaySuffix(key: string): string {
  const { year, month, day } = parseDateKey(key)
  const wd = new Date(year, month - 1, day).getDay()
  return `星期${FULL_WEEKDAY[wd]}`
}

/** 展示为「2026年9月2日 星期三」 */
export function formatFullDateLabel(key: string): string {
  const { year, month, day } = parseDateKey(key)
  const wd = new Date(year, month - 1, day).getDay()
  return `${year}年${month}月${day}日 星期${FULL_WEEKDAY[wd]}`
}

/** 从 ISO 时间戳提取本地时间 HH:mm */
export function formatDiaryTime(iso: string): string {
  const d = new Date(iso)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 生成当月日历需要渲染的日期数组（含前后月补齐的 0 占位） */
export function buildMonthCells(year: number, month: number): number[] {
  const offset = getMondayBasedWeekday(year, month, 1)
  const days = getDaysInMonth(year, month)
  const total = Math.ceil((offset + days) / 7) * 7
  const cells: number[] = []
  for (let i = 0; i < total; i++) {
    const d = i - offset + 1
    cells.push(d >= 1 && d <= days ? d : 0)
  }
  return cells
}

/** 常见停用词（日记关键字提取用，避免产出无意义词） */
const DIARY_STOP_WORDS = new Set([
  '今天', '昨天', '明天', '我们', '你们', '他们', '大家', '自己', '这个', '那个',
  '这些', '那些', '没有', '什么', '怎么', '怎样', '为什么', '因为', '所以', '但是',
  '可是', '然而', '如果', '虽然', '可以', '能够', '应该', '已经', '现在', '然后',
  '接着', '还有', '就是', '真的', '非常', '特别', '比较', '有点', '一些', '一下',
  '起来', '出来', '过去', '时候', '时间', '事情', '工作', '生活', '问题', '感觉',
  '觉得', '知道', '开始', '一直', '可能', '大概', '突然', '后来', '不过', '不仅',
  '而且', '以及', '或者', '还是', '只是', '一样', '两个', '一个', '主要', '需要',
])

/**
 * 从纯文本中提取高频关键字
 *
 * 策略：
 * 1. 按标点/空白切块，统计 2~10 字块的出现频率
 * 2. 对无分隔的长文本，补充统计二元字组（bigram）最高频片段
 * 3. 去停用词、去重复，按频率降序、字数升序取前 max 个
 */
export function extractKeywords(text: string, max = 4): string[] {
  if (!text) return []
  const freq = new Map<string, number>()
  const bump = (raw: string) => {
    const clean = raw
      .replace(/[\d\s，。；、：！？,.!?;:""''()（）\[\]【】《》<>\/\\|·~～—…-]+/g, '')
      .trim()
    const len = Array.from(clean).length
    if (len < 2 || len > 10) return
    if (DIARY_STOP_WORDS.has(clean)) return
    freq.set(clean, (freq.get(clean) ?? 0) + 1)
  }

  // 1) 按分隔符切块
  const blocks = text.split(/[\s，。；、：！？,.!?;:""''()（）\[\]【】《》<>\/\\|·~～—…\-\n\r\t]+/)
  for (const b of blocks) bump(b)

  // 2) 长连续文本的二元组补充
  const runs = text.match(/[\u4e00-\u9fa5A-Za-z0-9]+/g) ?? []
  const bigram = new Map<string, number>()
  for (const run of runs) {
    const chars = Array.from(run)
    if (chars.length <= 12) continue
    for (let i = 0; i < chars.length - 1; i++) {
      // 跳过中英数字混合边界
      const a = /[a-zA-Z0-9]/.test(chars[i])
      const b2 = /[a-zA-Z0-9]/.test(chars[i + 1])
      if (a !== b2) continue
      const g = chars[i] + chars[i + 1]
      bigram.set(g, (bigram.get(g) ?? 0) + 1)
    }
  }
  for (const [g] of [...bigram.entries()].sort((a, b) => b[1] - a[1]).slice(0, max)) {
    bump(g)
  }

  return [...freq.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1] ||
        Array.from(a[0]).length - Array.from(b[0]).length,
    )
    .slice(0, max)
    .map(([k]) => k)
}
