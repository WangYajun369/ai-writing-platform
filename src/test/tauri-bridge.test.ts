/**
 * tauri-bridge 契约测试
 *
 * 桥接层是前端唯一 invoke 入口（18 个 API 对象 / 173 个 IPC 命令），
 * 本测试锁定三件事：命令名正确、参数按 camelCase 透传、返回值与错误原样传递。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { bookApi, volumeApi, chapterApi, diaryApi, taskCardApi } from '@/lib/tauri-bridge'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const mockInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockInvoke.mockReset()
})

describe('bookApi', () => {
  it('list 调用 list_books 并透传返回值', async () => {
    const books = [{ id: 'b1', title: '书' }]
    mockInvoke.mockResolvedValue(books)
    const out = await bookApi.list()
    expect(mockInvoke).toHaveBeenCalledWith('list_books')
    expect(out).toBe(books)
  })

  it('create 以 { params } 包装载荷', async () => {
    mockInvoke.mockResolvedValue({ id: 'b1' })
    await bookApi.create({ title: '新书' } as never)
    expect(mockInvoke).toHaveBeenCalledWith('create_book', {
      params: { title: '新书' },
    })
  })

  it('update 同时传 id 与 params', async () => {
    mockInvoke.mockResolvedValue({ id: 'b1' })
    await bookApi.update('b1', { title: '改名' } as never)
    expect(mockInvoke).toHaveBeenCalledWith('update_book', {
      id: 'b1',
      params: { title: '改名' },
    })
  })

  it('delete 为软删除命令', async () => {
    mockInvoke.mockResolvedValue(undefined)
    await bookApi.delete('b1')
    expect(mockInvoke).toHaveBeenCalledWith('delete_book', { id: 'b1' })
  })

  it('setCoverData 透传 base64 dataUrl', async () => {
    mockInvoke.mockResolvedValue({ id: 'b1' })
    await bookApi.setCoverData('b1', 'data:image/png;base64,xx')
    expect(mockInvoke).toHaveBeenCalledWith('set_book_cover_data', {
      id: 'b1',
      dataUrl: 'data:image/png;base64,xx',
    })
  })

  it('后端错误原样抛给调用方', async () => {
    mockInvoke.mockRejectedValue({ code: 'E_IO_BUSY', message: '已有操作进行中' })
    await expect(bookApi.clearTrash()).rejects.toEqual({
      code: 'E_IO_BUSY',
      message: '已有操作进行中',
    })
  })
})

describe('volumeApi / chapterApi', () => {
  it('listByBook 传 bookId', async () => {
    mockInvoke.mockResolvedValue([])
    await volumeApi.listByBook('b1')
    expect(mockInvoke).toHaveBeenCalledWith('list_volumes', { bookId: 'b1' })
  })

  it('章节保存传 contentHtml 与 wordCount', async () => {
    mockInvoke.mockResolvedValue({ wordCount: 2, bookWordCount: 100 })
    const out = await chapterApi.save('c1', '<p>正文</p>', 2)
    expect(mockInvoke).toHaveBeenCalledWith('save_chapter', {
      chapterId: 'c1',
      contentHtml: '<p>正文</p>',
      wordCount: 2,
    })
    expect(out.bookWordCount).toBe(100)
  })
})

describe('diaryApi / taskCardApi', () => {
  it('日记按日期查询', async () => {
    mockInvoke.mockResolvedValue(null)
    await diaryApi.get('2026-09-24')
    expect(mockInvoke).toHaveBeenCalledWith('get_diary', { date: '2026-09-24' })
  })

  it('任务卡列表命令存在且走桥接层', async () => {
    mockInvoke.mockResolvedValue([])
    await taskCardApi.listProjects()
    expect(mockInvoke).toHaveBeenCalledWith('project_list', { status: null })
  })
})
