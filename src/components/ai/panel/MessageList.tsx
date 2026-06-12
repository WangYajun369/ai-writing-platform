/**
 * AI 聊天模式消息列表
 */
import { memo } from 'react'
import { BotIcon } from 'lucide-react'
import { useCurrentAiMessages } from '@/stores/appStore'
import type { ChatRequestPayload } from '@/types'
import { MessageBubble } from '../MessageBubble'

interface MessageListProps {
  messages: ReturnType<typeof useCurrentAiMessages>
  bottomRef: React.RefObject<HTMLDivElement | null>
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  onDelete: (id: string) => void
  onShowDetail: (payload: ChatRequestPayload) => void
  bookId?: string
}

export const MessageList = memo(function MessageList({
  messages, bottomRef, scrollContainerRef, onDelete, onShowDetail, bookId,
}: MessageListProps) {
  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 space-y-3 min-w-0">
      {messages.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <BotIcon className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-xs">向 AI 描述你的创作需求</p>
          <p className="text-xs opacity-70 mt-1">续写、润色、角色设计…</p>
        </div>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} onDelete={onDelete} onShowDetail={onShowDetail} bookId={bookId} />
      ))}
      <div ref={bottomRef} />
    </div>
  )
})
