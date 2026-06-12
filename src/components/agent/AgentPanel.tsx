/**
 * Agent Skills 面板
 *
 * 核心交互组件，提供技能选择、对话历史和流式输出展示。
 */

import React, { useState, useRef, useEffect } from 'react'
import { BrainIcon } from 'lucide-react'
import { useAgent } from './useAgent'
import { SKILLS, type SkillType } from './types'
import { useCurrentBook } from '@/stores/appStore'
import { AgentMessageBubble } from './AgentMessageBubble'
import { AgentMemoryPanel } from './AgentMemoryPanel'
import { getAgentQuickActions } from '@/components/ai/panel/constants'
import '@/styles/AgentPanel.css'

interface AgentPanelProps {
  onClose?: () => void
}

export const AgentPanel: React.FC<AgentPanelProps> = ({ onClose }) => {
  const book = useCurrentBook()
  const {
    status,
    messages,
    isStreaming,
    error,
    startAgent,
    stopAgent,
    executeSkill,
    cancelSkill,
    clearMessages,
  } = useAgent()

  const [input, setInput] = useState('')
  const [selectedSkill, setSelectedSkill] = useState<SkillType>('writing')
  const [showMemory, setShowMemory] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 自动聚焦输入框
  useEffect(() => {
    if (status === 'running') {
      inputRef.current?.focus()
    }
  }, [status])

  const handleSubmit = async () => {
    const trimmed = input.trim()
    if (!trimmed || !book?.id || isStreaming) return

    setInput('')

    // 构建对话历史
    const history = messages
      .filter((m) => m.role !== 'system')
      .slice(-20) // 最近 20 条
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))

    await executeSkill(selectedSkill, book.id, trimmed, history)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const selectedSkillMeta = SKILLS.find((s) => s.type === selectedSkill)

  return (
    <div className="agent-panel">
      {/* Header */}
      <div className="agent-header">
        <div className="agent-header-left">
          <h3 className="agent-title">AI 写作助手</h3>
          <span className={`agent-status-badge agent-status-${status}`}>
            {status === 'running'
              ? '已连接'
              : status === 'starting'
                ? '启动中...'
                : status === 'crashed'
                  ? '异常'
                  : '未启动'}
          </span>
        </div>
        <div className="agent-header-actions">
          {status === 'stopped' || status === 'crashed' ? (
            <button className="agent-btn agent-btn-primary" onClick={startAgent} title="启动 Agent 服务">
              启动
            </button>
          ) : (
            <button className="agent-btn agent-btn-ghost" onClick={stopAgent} title="停止 Agent 服务">
              停止
            </button>
          )}
          <button
            className={`agent-btn ${showMemory ? 'agent-btn-primary' : 'agent-btn-ghost'}`}
            onClick={() => setShowMemory(!showMemory)}
            title="Agent 记忆管理"
          >
            <BrainIcon className="w-3.5 h-3.5 mr-1 inline" />
            记忆
          </button>
          <button className="agent-btn agent-btn-ghost" onClick={clearMessages} title="清空对话">
            清空
          </button>
          {onClose && (
            <button className="agent-btn agent-btn-ghost" onClick={onClose} title="关闭面板">
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 记忆管理面板 / 主界面切换 */}
      {showMemory ? (
        <AgentMemoryPanel bookId={book?.id} onClose={() => setShowMemory(false)} />
      ) : (
        <>
          {/* Skill Selector */}
          <div className="agent-skills">
            {SKILLS.map((skill) => (
              <button
                key={skill.type}
                className={`agent-skill-btn ${selectedSkill === skill.type ? 'active' : ''}`}
                onClick={() => setSelectedSkill(skill.type)}
                style={{
                  '--skill-color': skill.color,
                } as React.CSSProperties}
                title={skill.description}
              >
                <span className="agent-skill-icon">{getSkillIcon(skill.type)}</span>
                <span className="agent-skill-label">{skill.label}</span>
              </button>
            ))}
          </div>

          {/* Messages */}
          <div className="agent-messages">
            {messages.length === 0 && status === 'running' && (
              <div className="agent-welcome">
                <div className="agent-welcome-icon">✨</div>
                <h4>你好，我是你的 AI 写作助手</h4>
                <p>
                  当前模式：
                  <strong style={{ color: selectedSkillMeta?.color }}>
                    {selectedSkillMeta?.label}
                  </strong>
                </p>
                <p>{selectedSkillMeta?.description}</p>
                <div className="agent-quick-actions">
                  {getAgentQuickActions(selectedSkill).map((action, i) => (
                    <button
                      key={i}
                      className="agent-quick-btn"
                      onClick={() => setInput(action)}
                    >
                      {action}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <AgentMessageBubble key={msg.id} message={msg} />
            ))}

            {error && (
              <div className="agent-error-banner">
                ⚠️ {error}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="agent-input-area">
            <textarea
              ref={inputRef}
              className="agent-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                status !== 'running'
                  ? '请先启动 Agent 服务...'
                  : `输入指令，${selectedSkillMeta?.label}模式...`
              }
              rows={2}
              disabled={status !== 'running'}
            />
            <div className="agent-input-actions">
              <span className="agent-input-hint">Enter 发送 · Shift+Enter 换行</span>
              <div>
                {isStreaming ? (
                  <button className="agent-btn agent-btn-danger" onClick={cancelSkill}>
                    停止生成
                  </button>
                ) : (
                  <button
                    className="agent-btn agent-btn-primary"
                    onClick={handleSubmit}
                    disabled={!input.trim() || status !== 'running'}
                  >
                    发送
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ─── 辅助函数 ───

function getSkillIcon(skill: SkillType): string {
  switch (skill) {
    case 'writing':
      return '✍️'
    case 'analysis':
      return '🔍'
    case 'research':
      return '📖'
    case 'polish':
      return '✨'
  }
}


