/**
 * TTS 全局播放器
 *
 * 全窗口共享单个 <audio> 实例：任意时刻只有一个发音在播；
 * 新内容会打断上一条。文件须位于 assetProtocol scope 内（<app_data>/**），
 * 用 convertFileSrc 转成 asset URL 后交给 audio 播放。
 */
import { convertFileSrc } from '@tauri-apps/api/core'

let sharedAudio: HTMLAudioElement | null = null

function getSharedAudio(): HTMLAudioElement {
  if (!sharedAudio) {
    sharedAudio = new Audio()
    sharedAudio.preload = 'auto'
  }
  return sharedAudio
}

/** 播放本地音频文件（打断当前发音）。调用方应在用户手势（点击）内触发。 */
export function playAudioFile(filePath: string): void {
  const audio = getSharedAudio()
  audio.pause()
  audio.currentTime = 0
  audio.src = convertFileSrc(filePath)
  audio.play().catch(() => {
    /* 极少数系统禁止自动播放时忽略；通常点击手势内可直接播放 */
  })
}

/** 停止当前发音 */
export function stopAudio(): void {
  if (sharedAudio) {
    sharedAudio.pause()
    sharedAudio.currentTime = 0
  }
}
