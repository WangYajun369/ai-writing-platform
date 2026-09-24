/**
 * 存储信息区块
 *
 * 当前为静态说明占位页：仅提示“每部作品一个 .db 文件”的存储模型，
 * 不读取任何 store / IPC，统计功能计划在后续版本接入。
 */
export function StorageSection() {
  return (
    <div className="space-y-5">
      <h2 className="text-base font-semibold">存储管理</h2>
      <p className="text-sm text-muted-foreground">
        每部作品以独立 <code className="bg-muted px-1 rounded text-xs">.db</code> 文件存储，包含文本、媒体、向量索引与版本历史。
      </p>
      <div className="p-4 bg-muted rounded-lg text-sm text-muted-foreground">
        存储统计功能将在后续版本中推出。
      </div>
    </div>
  )
}
