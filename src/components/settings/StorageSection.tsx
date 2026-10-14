/**
 * 存储信息区块
 *
 * 静态说明页：说明"单库多表 + 独立图片资产"的存储模型，不读取任何 store / IPC。
 */
export function StorageSection() {
  return (
    <div className="space-y-5">
      <h2 className="text-base font-semibold">存储管理</h2>
      <p className="text-sm text-muted-foreground">
        全部作品统一存储在本机 SQLite 数据库中（单库多表，含文本、版本历史与向量索引），
        插图以独立资产文件保存在应用数据目录。
      </p>
    </div>
  )
}
