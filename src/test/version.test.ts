/**
 * lib/version 单元测试 —— 版本比较与「跳过此版本」判定
 *
 * 更新提示的触发条件直接决定用户是否被打扰，故对边界（等值、前缀 v、
 * 非法输入、0.0.0 占位、跳过后出现更新版本）逐条锁定。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseVersion,
  compareVersions,
  isNewerVersion,
  shouldNotifyUpdate,
  getSkippedVersion,
  setSkippedVersion,
  clearSkippedVersion,
  SKIP_VERSION_KEY,
} from '@/lib/version'

describe('parseVersion', () => {
  it('解析标准 semver', () => {
    expect(parseVersion('1.8.2')).toEqual([1, 8, 2])
  })

  it('忽略前导 v 与预发布/构建后缀', () => {
    expect(parseVersion('v1.8.2')).toEqual([1, 8, 2])
    expect(parseVersion('1.8.2-beta.1')).toEqual([1, 8, 2])
    expect(parseVersion('v2.0.0+build.7')).toEqual([2, 0, 0])
  })

  it('缺段补 0，非法输入归 0', () => {
    expect(parseVersion('1.8')).toEqual([1, 8, 0])
    expect(parseVersion('')).toEqual([0, 0, 0])
    expect(parseVersion(null)).toEqual([0, 0, 0])
    expect(parseVersion(undefined)).toEqual([0, 0, 0])
    expect(parseVersion('abc')).toEqual([0, 0, 0])
  })
})

describe('compareVersions', () => {
  it('按段位依次比较', () => {
    expect(compareVersions('1.8.1', '1.8.0')).toBe(1)
    expect(compareVersions('1.8.0', '1.8.1')).toBe(-1)
    expect(compareVersions('1.8.1', '1.8.1')).toBe(0)
    expect(compareVersions('v1.8.1', '1.8.1')).toBe(0)
  })

  it('大段位优先于小段位（1.10 > 1.9）', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1)
  })
})

describe('isNewerVersion', () => {
  it('远端更高才为真', () => {
    expect(isNewerVersion('1.8.2', '1.8.1')).toBe(true)
    expect(isNewerVersion('1.8.1', '1.8.1')).toBe(false)
    expect(isNewerVersion('1.8.0', '1.8.1')).toBe(false)
  })

  it('0.0.0 / dev 占位版本不触发更新提示', () => {
    expect(isNewerVersion('0.0.0', '0.0.0-dev')).toBe(false)
    expect(isNewerVersion('1.0.0', '0.0.0-dev')).toBe(false)
  })
})

describe('shouldNotifyUpdate（跳过此版本语义）', () => {
  it('无跳过记录时，更新版本正常提示', () => {
    expect(shouldNotifyUpdate('1.8.2', '1.8.1', null)).toBe(true)
  })

  it('已跳过该版本 → 不再提示', () => {
    expect(shouldNotifyUpdate('1.8.2', '1.8.1', '1.8.2')).toBe(false)
  })

  it('已跳过更旧的版本 → 仍提示（不吞掉新版本）', () => {
    expect(shouldNotifyUpdate('1.9.0', '1.8.1', '1.8.2')).toBe(true)
  })

  it('远端不比当前新时不提示（与跳过无关）', () => {
    expect(shouldNotifyUpdate('1.8.1', '1.8.1', null)).toBe(false)
    expect(shouldNotifyUpdate('1.8.0', '1.8.1', '1.8.0')).toBe(false)
  })
})

describe('跳过记录持久化', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('写入后可读回', () => {
    setSkippedVersion('1.8.2')
    expect(getSkippedVersion()).toBe('1.8.2')
    expect(localStorage.getItem(SKIP_VERSION_KEY)).toBe('1.8.2')
  })

  it('清除后为空', () => {
    setSkippedVersion('1.8.2')
    clearSkippedVersion()
    expect(getSkippedVersion()).toBeNull()
  })

  it('无记录时返回 null', () => {
    expect(getSkippedVersion()).toBeNull()
  })
})
