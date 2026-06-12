/**
 * Agent 记忆管理面板
 *
 * 展示/编辑/删除/清空当前书籍的 Agent 记忆。
 */
import React, { useState, useCallback, useEffect } from 'react'
import { XIcon, Trash2Icon, PencilIcon, SaveIcon, RotateCcwIcon, BrainIcon } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import type { MemoryInfo, MemoryListResponse } from './types'
import { MEMORY_TYPE_LABELS, MEMORY_TYPE_COLORS } from './types'

interface AgentMemoryPanelProps {
  bookId: string | undefined
  onClose: () => void
}

export const AgentMemoryPanel: React.FC<AgentMemoryPanelProps> = ({ bookId, onClose }) => {
  const [memories, setMemories] = useState<MemoryInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editKeywords, setEditKeywords] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  // 加载记忆列表
  const loadMemories = useCallback(async () => {
    if (!bookId) return
    setLoading(true)
    setError(null)
    try {
      const resp = await invoke<MemoryListResponse>('list_agent_memories', {
        bookId,
        skillType: null,
      })
      setMemories(resp.memories)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [bookId])

  useEffect(() => {
    loadMemories()
  }, [loadMemories])

  // 开始编辑
  const startEdit = (m: MemoryInfo) => {
    setEditingId(m.id)
    setEditContent(m.content)
    setEditKeywords(m.keywords)
  }

  // 取消编辑
  const cancelEdit = () => {
    setEditingId(null)
    setEditContent('')
    setEditKeywords('')
  }

  // 保存编辑
  const saveEdit = async (memoryId: number) => {
    try {
      await invoke('update_agent_memory', {
        memoryId,
        content: editContent.trim() || null,
        keywords: editKeywords.trim() || null,
        memoryType: null,
      })
      setMemories((prev) =>
        prev.map((m) =>
          m.id === memoryId
            ? { ...m, content: editContent.trim() || m.content, keywords: editKeywords.trim() || m.keywords }
            : m
        )
      )
      cancelEdit()
    } catch (e) {
      setError(String(e))
    }
  }

  // 删除单条记忆
  const deleteMemory = async (memoryId: number) => {
    try {
      await invoke('delete_agent_memory', { memoryId })
      setMemories((prev) => prev.filter((m) => m.id !== memoryId))
      if (editingId === memoryId) cancelEdit()
    } catch (e) {
      setError(String(e))
    }
  }

  // 清空所有记忆
  const clearAllMemories = async () => {
    if (!bookId) return
    try {
      await invoke<number>('clear_agent_memories', { bookId })
      setMemories([])
      setConfirmClear(false)
    } catch (e) {
      setError(String(e))
    }
  }

  // 暂无记忆时的空状态
  if (!loading && memories.length === 0 && !error) {
    return (
      <div className="agent-memory-panel">
        <div className="agent-memory-header">
          <div className="agent-memory-header-left">
            <BrainIcon className="w-4 h-4" />
            <span>Agent 记忆管理</span>
          </div>
          <button className="agent-memory-close-btn" onClick={onClose} title="关闭">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="agent-memory-empty">
          <BrainIcon className="w-10 h-10 mb-3 opacity-20" />
          <p className="text-sm text-muted-foreground">暂无 Agent 记忆</p>
          <p className="text-xs text-muted-foreground/50 mt-1">
            与 Agent 助手对话后，系统会自动提取偏好、决策和经验作为记忆
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="agent-memory-panel">
      {/* Header */}
      <div className="agent-memory-header">
        <div className="agent-memory-header-left">
          <BrainIcon className="w-4 h-4" />
          <span>Agent 记忆管理</span>
          <span className="agent-memory-count">{memories.length} 条记忆</span>
        </div>
        <div className="agent-memory-header-actions">
          <button className="agent-memory-refresh-btn" onClick={loadMemories} title="刷新">
            <RotateCcwIcon className="w-3.5 h-3.5" />
          </button>
          <button className="agent-memory-close-btn" onClick={onClose} title="关闭">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="agent-memory-error">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">关闭</button>
        </div>
      )}

      {/* 记忆列表 */}
      <div className="agent-memory-list">
        {loading ? (
          <div className="agent-memory-loading">
            <div className="agent-memory-spinner" />
            <span className="text-xs text-muted-foreground">加载中...</span>
          </div>
        ) : (
          memories.map((mem) => (
            <div key={mem.id} className="agent-memory-item">
              {/* 类型标签和操作按钮 */}
              <div className="agent-memory-item-header">
                <span
                  className="agent-memory-type-tag"
                  style={{
                    backgroundColor: (MEMORY_TYPE_COLORS[mem.memory_type] || '#6366f1') + '20',
                    color: MEMORY_TYPE_COLORS[mem.memory_type] || '#6366f1',
                  }}
                >
                  {MEMORY_TYPE_LABELS[mem.memory_type] || mem.memory_type}
                </span>
                <span className="agent-memory-skill-tag">{mem.skill_type}</span>
                <span className="agent-memory-relevance" title="相关性分数">
                  相关度: {(mem.relevance_score * 100).toFixed(0)}%
                </span>
                <div className="agent-memory-item-actions">
                  {editingId === mem.id ? (
                    <>
                      <button className="agent-memory-action-btn save" onClick={() => saveEdit(mem.id)} title="保存">
                        <SaveIcon className="w-3.5 h-3.5" />
                      </button>
                      <button className="agent-memory-action-btn" onClick={cancelEdit} title="取消">
                        <XIcon className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="agent-memory-action-btn" onClick={() => startEdit(mem)} title="编辑">
                        <PencilIcon className="w-3.5 h-3.5" />
                      </button>
                      <button className="agent-memory-action-btn danger" onClick={() => deleteMemory(mem.id)} title="删除">
                        <Trash2Icon className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* 记忆内容 */}
              {editingId === mem.id ? (
                <div className="agent-memory-edit-area">
                  <textarea
                    className="agent-memory-edit-input"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={3}
                    placeholder="记忆内容..."
                  />
                  <input
                    className="agent-memory-keywords-input"
                    value={editKeywords}
                    onChange={(e) => setEditKeywords(e.target.value)}
                    placeholder="关键词（逗号分隔）"
                  />
                </div>
              ) : (
                <>
                  <p className="agent-memory-content">{mem.content}</p>
                  {mem.keywords && (
                    <div className="agent-memory-keywords">
                      {mem.keywords.split(',').filter(Boolean).map((kw, i) => (
                        <span key={i} className="agent-memory-keyword">{kw.trim()}</span>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* 时间 */}
              <div className="agent-memory-time">
                {mem.updated_at && mem.updated_at !== mem.created_at ? `更新于 ${mem.updated_at}` : `创建于 ${mem.created_at}`}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 底部操作：清空全部 */}
      {memories.length > 0 && (
        <div className="agent-memory-footer">
          {confirmClear ? (
            <div className="agent-memory-clear-confirm">
              <span className="text-xs text-destructive">确认清空全部 {memories.length} 条记忆？此操作不可撤销</span>
              <div className="flex gap-2">
                <button className="agent-memory-clear-btn danger" onClick={clearAllMemories}>
                  确认清空
                </button>
                <button className="agent-memory-clear-btn" onClick={() => setConfirmClear(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button className="agent-memory-clear-btn danger" onClick={() => setConfirmClear(true)}>
              <Trash2Icon className="w-3.5 h-3.5" />
              清空全部记忆
            </button>
          )}
        </div>
      )}
    </div>
  )
}
