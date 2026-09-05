/**
 * 收录 / 编辑生词对话框
 *
 * - 输入单词 → 点击「DeepSeek 翻译」一键生成完整学习卡片：
 *   英式音标 / 词性释义 / 记忆例句 / 词根词缀 / 近反义词 / 常用词组 / 动词变形 / 按词性例句
 * - 离线词库已安装时，输入单词会先自动带出基础释义（可编辑）
 * - 手动补录也可以完全自定义
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  XIcon,
  SparklesIcon,
  LoaderIcon,
  BookMarkedIcon,
  DatabaseIcon,
  CheckIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react'
import { dictApi, vocabApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'
import { errText } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useAiStore } from '@/stores/aiStore'
import { getChatApiKey } from '@/types'
import type { VocabKnowledge, VocabMeaning, VocabWord, WordCheckKind } from '@/types'
import { parseDictTranslation, normalizeAiMeaning } from '../vocab-utils'
import { useVocabStore } from '@/stores/vocabStore'
import VocabKnowledgeView from '../VocabKnowledgeView'
import SpeakButton from '../SpeakButton'

const inputCls =
  'rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-zinc-100 placeholder-zinc-500 outline-none transition focus:border-sky-500/60 focus:bg-white/8'

/** 单词形态检查用轻量模型（仅 DeepSeek 服务商；完整释义仍用设置里的对话模型） */
const AI_CHECK_MODEL = 'deepseek-v4-flash'

interface Props {
  open: boolean
  /** 编辑模式传入词条，否则为新增 */
  editing?: VocabWord | null
  onClose: () => void
}

export default function AddWordDialog({ open, editing, onClose }: Props) {
  const aiConfig = useAiStore((s) => s.aiConfig)
  const refreshAll = useVocabStore((s) => s.refreshAll)

  const [word, setWord] = useState('')
  const [phonetic, setPhonetic] = useState('')
  const [meanings, setMeanings] = useState<VocabMeaning[]>([{ pos: '', def: '' }])
  const [example, setExample] = useState('')
  /** 记忆例句的中文翻译 */
  const [exampleZh, setExampleZh] = useState('')
  /** DeepSeek 翻译附带的学习知识（词根词缀/近反义词/词组/动词变形/词性例句） */
  const [knowledge, setKnowledge] = useState<VocabKnowledge | null>(null)
  const [saving, setSaving] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [dictSource, setDictSource] = useState(false)
  /** 用户是否手动编辑过释义（手动编辑后不再自动带出覆盖） */
  const [touched, setTouched] = useState(false)
  const wordRef = useRef<HTMLInputElement>(null)

  const isEdit = Boolean(editing)

  // 打开时初始化
  useEffect(() => {
    if (!open) return
    if (editing) {
      setWord(editing.word)
      setPhonetic(editing.phonetic)
      setMeanings(editing.meanings.length ? editing.meanings.map((m) => ({ ...m })) : [{ pos: '', def: '' }])
      setExample(editing.example)
      setExampleZh(editing.exampleZh ?? '')
      setKnowledge(editing.knowledge ?? null)
    } else {
      setWord('')
      setPhonetic('')
      setMeanings([{ pos: '', def: '' }])
      setExample('')
      setExampleZh('')
      setKnowledge(null)
      setDictSource(false)
    }
    setSaving(false)
    setAiBusy(false)
    setAiError('')
    setTouched(false)
    const t = window.setTimeout(() => wordRef.current?.focus(), 60)
    return () => window.clearTimeout(t)
  }, [open, editing])

  const lookupWord = useMemo(() => word.trim().toLowerCase(), [word])

  // 单词变化后重置「已手动编辑」标记与 AI 知识/错误，恢复自动带出
  useEffect(() => {
    setTouched(false)
    setDictSource(false)
    setKnowledge(null)
    setAiError('')
  }, [lookupWord])

  // 新增模式：单词输入后从离线词典自动带出（防抖；用户手动编辑过则跳过）
  useEffect(() => {
    if (isEdit || !open || lookupWord.length < 1 || touched) return
    const timer = window.setTimeout(async () => {
      try {
        const res = await dictApi.lookup(lookupWord)
        if (!res.hit) return
        const parsed = parseDictTranslation(res.hit)
        if (parsed.length) {
          setMeanings(parsed)
          setDictSource(true)
        }
        setPhonetic((p) => (p ? p : res.hit!.phonetic))
      } catch {
        /* 词典不可用/查询失败时静默，用户可手动填或走 AI */
      }
    }, 450)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupWord, isEdit, open, touched])

  /** DeepSeek 翻译：一键整理完整学习卡片 */
  async function handleTranslate() {
    const w = lookupWord
    if (!w) {
      toast.warning('请先输入要翻译的单词')
      wordRef.current?.focus()
      return
    }
    const chatApiKey = getChatApiKey(aiConfig.chat)
    if (!chatApiKey) {
      console.warn(
        '[Vocab·翻译] 未取到 API Key。localStorage ai-config 是否存在:',
        Boolean(localStorage.getItem('time-write-ai-config')),
        '| provider =', aiConfig.chat.provider,
      )
      toast.warning('未检测到 API Key。请先在「设置 → AI 设置」中配置并确保已保存')
      return
    }
    console.info(
      '[Vocab·翻译] provider/model/endpoint =',
      aiConfig.chat.provider,
      aiConfig.chat.model,
      aiConfig.chat.endpoint,
      '| apiKey 长度 =', (chatApiKey ?? '').length,
    )
    setAiBusy(true)
    setAiError('')
    try {
      // ① 单词形态检查（轻量模型）：判定是完整单词 / 简写 / 缩写 / 不存在。
      //    检查服务不可用时降级为直接翻译，不阻断主流程。
      const endpoint = aiConfig.chat.endpoint
      const checkModel = aiConfig.chat.provider === 'deepseek' ? AI_CHECK_MODEL : aiConfig.chat.model
      let target = w
      try {
        const chk = await dictApi.checkWord({ word: w, endpoint, model: checkModel, apiKey: chatApiKey })
        if (chk.kind === 'not_a_word') {
          const msg = `没有这个单词「${w}」${chk.note ? `（${chk.note}）` : '，请检查拼写'}`
          setAiError(msg)
          toast.error(msg)
          return
        }
        if (chk.kind !== 'word' && chk.canonical) {
          const canonical = chk.canonical.trim().toLowerCase()
          if (canonical && canonical !== w) {
            target = canonical
            setWord(canonical)
            const map: Partial<Record<WordCheckKind, [string, string]>> = {
              inflected: ['变形词', '原形'],
              abbreviation: ['简写', '完整形式'],
              acronym: ['缩写', '全称'],
            }
            const [form, repl] = map[chk.kind] ?? []
            if (form && repl) {
              const note = chk.note ? `（${chk.note}）` : ''
              toast.info(`「${w}」是${form}${note}，已切换为${repl}「${canonical}」`)
            }
          }
        }
      } catch (err) {
        console.warn('[Vocab·翻译] 单词形态检查失败，降级为直接翻译:', err)
      }

      // ② 用主对话模型生成完整学习卡片
      const explain = await dictApi.explainAi({
        word: target,
        endpoint,
        model: aiConfig.chat.model,
        temperature: aiConfig.chat.temperature,
        apiKey: chatApiKey,
      })
      if (explain.phonetic) setPhonetic(explain.phonetic)
      if (explain.meanings.length) {
        setMeanings(
          explain.meanings
            .map((m) => normalizeAiMeaning({ pos: m.pos, def: m.def }))
            .filter((m) => m.def || m.pos)
        )
        setDictSource(false)
        setTouched(true)
      }
      if (explain.example && !example.trim()) setExample(explain.example)
      if (explain.exampleZh && !exampleZh.trim()) setExampleZh(explain.exampleZh)
      setKnowledge(explain.knowledge)
      toast.success('翻译完成：已整理音标 / 词根词缀 / 近反义词 / 常用搭配 / 词性例句')
    } catch (err) {
      console.error('[Vocab·翻译] 调用失败:', err)
      const detail = errText(err, '翻译失败，请检查网络或稍后重试')
      setAiError(detail.slice(0, 300))
      toast.error('翻译失败，详情见输入框下方提示')
    } finally {
      setAiBusy(false)
    }
  }

  async function handleSave() {
    const w = lookupWord
    if (!w) {
      toast.warning('请输入要收录的单词')
      wordRef.current?.focus()
      return
    }
    const clean = meanings
      .map((m) => ({ pos: (m.pos || '').trim(), def: (m.def || '').trim() }))
      .filter((m) => m.def.length > 0)
    if (clean.length === 0) {
      toast.warning('请先点「DeepSeek 翻译」生成释义，或手动填写')
      return
    }
    setSaving(true)
    try {
      if (isEdit && editing) {
        await vocabApi.update({ id: editing.id, phonetic: phonetic.trim(), meanings: clean, example: example.trim(), exampleZh: exampleZh.trim(), knowledge })
        toast.success(`已更新「${w}」`)
      } else {
        await vocabApi.add({
          word: w,
          phonetic: phonetic.trim(),
          meanings: clean,
          example: example.trim(),
          exampleZh: exampleZh.trim(),
          knowledge,
          source: 'manual',
        })
        toast.success(`已收录「${w}」，明天将进入首次复习`)
      }
      void refreshAll()
      onClose()
    } catch (err) {
      toast.error(errText(err, '保存失败，请重试'))
    } finally {
      setSaving(false)
    }
  }

  function updateMeaning(idx: number, patch: Partial<VocabMeaning>) {
    if ('def' in patch) {
      setTouched(true)
      setDictSource(false)
    }
    setMeanings((cur) => cur.map((m, i) => (i === idx ? { ...m, ...patch } : m)))
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[85vh] w-[660px] max-w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0d1526] shadow-2xl shadow-black/50">
        {/* 标题 */}
        <div className="flex items-center gap-2.5 border-b border-white/8 px-5 py-3.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-sky-500 to-indigo-600">
            <BookMarkedIcon className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-[14px] font-semibold">{isEdit ? `编辑「${editing?.word}」` : '收录新词'}</div>
            <div className="text-[10.5px] text-zinc-500">{isEdit ? '修改不影响已排期的复习进度' : '收录后将按艾宾浩斯曲线（SM-2）自动排期复习'}</div>
          </div>
          <div className="flex-1" />
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3.5 overflow-y-auto px-5 py-4 vocab-scroll">
          {/* 单词 / 音标 + DeepSeek 翻译主操作 */}
          <div className="grid grid-cols-[1fr_1.1fr_auto] items-stretch gap-2.5">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-[11px] font-medium text-zinc-400">单词 *</label>
                <SpeakButton text={word} size={12} />
              </div>
              <input
                ref={wordRef}
                value={word}
                disabled={isEdit}
                onChange={(e) => {
                  setWord(e.target.value)
                  if (!dictSource) setPhonetic('')
                }}
                placeholder="如：serendipity"
                className={cn(inputCls, 'w-full', isEdit && 'opacity-70')}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-zinc-400">音标（英式，可选）</label>
              <input value={phonetic} onChange={(e) => setPhonetic(e.target.value)} placeholder="/ˌserənˈdɪpəti/" className={cn(inputCls, 'w-full')} />
            </div>
            <div className="flex items-end">
              <button
                onClick={handleTranslate}
                disabled={aiBusy}
                title="一键整理英式音标、词根词缀、近反义词、常用词组、词性例句与动词变形"
                className="flex h-9 w-[112px] items-center justify-center gap-1.5 rounded-lg bg-linear-to-r from-violet-600 to-fuchsia-600 text-[12.5px] font-medium text-white shadow-lg shadow-violet-950/50 transition hover:opacity-90 disabled:opacity-50"
              >
                {aiBusy ? <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> : <SparklesIcon className="h-3.5 w-3.5" />}
                {aiBusy ? '生成中…' : 'DeepSeek 翻译'}
              </button>
            </div>
          </div>

          {!isEdit && !knowledge && !aiBusy && !aiError && (
            <p className="text-[11px] leading-relaxed text-zinc-500">
              输入单词后点击「DeepSeek 翻译」，一键生成：英式音标、词性释义、词根词缀、近反义词、常用搭配与按词性例句（动词还含变形）。也可手动录入。
            </p>
          )}

          {aiError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-red-300">AI 翻译失败</span>
                <button onClick={() => setAiError('')} className="text-[10px] text-red-300/70 hover:text-red-200">
                  关闭
                </button>
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed break-all text-red-200/90">{aiError}</p>
            </div>
          )}

          {/* 释义编辑区 */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-[11px] font-medium text-zinc-400">释义</label>
              <div className="flex items-center gap-1.5">
                {dictSource && !isEdit && (
                  <span className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300 border border-emerald-500/25">
                    <DatabaseIcon className="h-3 w-3" /> 离线词库带出
                  </span>
                )}
                {aiBusy && <span className="text-[10.5px] text-violet-300/70">AI 正在整理…</span>}
              </div>
            </div>
            <div className="space-y-1.5">
              {meanings.map((m, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  {meanings.length > 1 && (
                    <span className="w-4 shrink-0 text-center text-[10px] leading-none text-zinc-500">{i + 1}</span>
                  )}
                  <input
                    value={m.pos}
                    onChange={(e) => updateMeaning(i, { pos: e.target.value })}
                    placeholder="词性"
                    title="词性，如 n. / v. / adj."
                    className={cn(inputCls, 'w-12 shrink-0 px-1 text-center text-[11px]')}
                  />
                  <input
                    value={m.def}
                    onChange={(e) => updateMeaning(i, { def: e.target.value })}
                    placeholder="释义，如：意外的发现、机缘巧合"
                    className={cn(inputCls, 'min-w-0 flex-1')}
                  />
                  <button
                    onClick={() => setMeanings((cur) => cur.filter((_, j) => j !== i))}
                    title={meanings.length > 1 ? '删除该条释义' : '清空释义'}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-red-500/10 hover:text-red-300"
                  >
                    <Trash2Icon className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                onClick={() => setMeanings((cur) => [...cur, { pos: '', def: '' }])}
                className="flex items-center gap-1 text-[11.5px] text-sky-400 transition hover:text-sky-300"
              >
                <PlusIcon className="h-3 w-3" /> 添加一条释义
              </button>
            </div>
          </div>

          {/* 记忆例句（英文 + 中文翻译） */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-[11px] font-medium text-zinc-400">
                记忆例句<span className="ml-1 font-normal text-zinc-600">（可选，AI 会配好中文翻译）</span>
              </label>
              <SpeakButton text={example} size={12} />
            </div>
            <input value={example} onChange={(e) => setExample(e.target.value)} placeholder="英文例句，如：She left the note on the table." className={cn(inputCls, 'w-full')} />
            <input
              value={exampleZh}
              onChange={(e) => setExampleZh(e.target.value)}
              placeholder="例句中文翻译，如：她把便条留在了桌上。"
              className={cn(inputCls, 'w-full mt-1.5 bg-white/3 text-zinc-300/90')}
            />
          </div>

          {/* AI 词条精讲（词根词缀/近反义词/词组/动词变形/词性例句） */}
          <VocabKnowledgeView knowledge={knowledge} />
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-end gap-2 border-t border-white/8 bg-black/20 px-5 py-3">
          <button onClick={onClose} className="rounded-lg border border-white/10 px-4 py-1.5 text-[13px] text-zinc-300 transition hover:bg-white/5">
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-linear-to-r from-sky-500 to-indigo-500 px-5 py-1.5 text-[13px] font-medium text-white shadow-lg shadow-sky-900/40 transition hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> : <CheckIcon className="h-3.5 w-3.5" />}
            {saving ? '保存中…' : isEdit ? '保存修改' : '收录'}
          </button>
        </div>
      </div>
    </div>
  )
}
