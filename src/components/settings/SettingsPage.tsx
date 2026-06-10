/**
 * SettingsPage — 设置页面（入口壳）
 *
 * 提供五个设置标签页：
 * - AI 配置（服务商/API/模型/Temperature）
 * - 外观（浅色/深色/跟随系统）
 * - 编辑（编辑器显示宽度）
 * - 存储（占位，后续版本推出统计功能）
 * - 版本（当前版本 / 检查更新）
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeftIcon, BotIcon, PaletteIcon, DatabaseIcon, ArrowUpCircleIcon, PenLineIcon, WrenchIcon } from 'lucide-react'
import { useAppStore } from '@/stores/appStore'
import { AiConfigSection } from './AiConfigSection'
import { AiToolboxSection } from './AiToolboxSection'
import { AppearanceSection } from './AppearanceSection'
import { EditorConfigSection } from './EditorConfigSection'
import { StorageSection } from './StorageSection'
import { VersionSection } from './VersionSection'

type Tab = 'ai' | 'toolbox' | 'appearance' | 'editor' | 'storage' | 'version'

const TABS: { id: Tab; label: string; icon: React.FC<{ className?: string }> }[] = [
  { id: 'ai', label: 'AI 配置', icon: BotIcon },
  { id: 'toolbox', label: 'AI 工具箱', icon: WrenchIcon },
  { id: 'appearance', label: '外观', icon: PaletteIcon },
  { id: 'editor', label: '编辑', icon: PenLineIcon },
  { id: 'storage', label: '存储', icon: DatabaseIcon },
  { id: 'version', label: '版本', icon: ArrowUpCircleIcon },
]

export default function SettingsPage() {
  const navigate = useNavigate()
  const { aiConfig, setAiConfig, aiConnectionStatus, aiConnectionDetail, setAiConnectionStatus, theme, setTheme, eyeCareMode, setEyeCareMode, fontFamily, setFontFamily, fontSize, setFontSize, gridSize, setGridSize, editorWidth, setEditorWidth } = useAppStore()
  const [activeTab, setActiveTab] = useState<Tab>('ai')

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* 顶栏 */}
      <header className="border-b bg-card px-6 py-4 flex items-center gap-3 shrink-0">
        <button
          onClick={() => navigate(-1)}
          className="p-2 rounded-lg hover:bg-muted transition-colors"
        >
          <ArrowLeftIcon className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-semibold">设置</h1>
      </header>

      <div className="flex-1 overflow-hidden">
        <div className="max-w-3xl mx-auto p-6 flex gap-6 h-full">
          {/* 侧边选项卡 */}
          <nav className="w-48 flex flex-col gap-1 shrink-0">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  activeTab === id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </nav>

          {/* 内容区（独立滚动） */}
          <div className="flex-1 bg-card border rounded-xl p-6 overflow-y-auto min-h-0">
            {activeTab === 'ai' && (
              <AiConfigSection
                config={aiConfig}
                onChange={setAiConfig}
                connectionStatus={aiConnectionStatus}
                connectionDetail={aiConnectionDetail}
                onTestConnection={async (endpoint: string, apiKey?: string) => {
                  setAiConnectionStatus('testing')
                  try {
                    const { aiApi } = await import('@/lib/tauri-bridge')
                    const result = await aiApi.testConnection(
                      aiConfig.chat.provider,
                      endpoint,
                      apiKey,
                    )
                    setAiConnectionStatus(result.ok ? 'connected' : 'error', result.detail)
                  } catch (err) {
                    setAiConnectionStatus('error', String(err))
                  }
                }}
              />
            )}
            {activeTab === 'toolbox' && <AiToolboxSection />}
            {activeTab === 'appearance' && (
              <AppearanceSection
                theme={theme}
                eyeCareMode={eyeCareMode}
                fontFamily={fontFamily}
                fontSize={fontSize}
                gridSize={gridSize}
                onThemeChange={(t) => setTheme(t as 'light' | 'dark' | 'system')}
                onEyeCareChange={(m) => setEyeCareMode(m as 'off' | 'warm' | 'green')}
                onFontFamilyChange={(f) => setFontFamily(f as 'simhei' | 'simsun' | 'kaiti' | 'yahei')}
                onFontSizeChange={setFontSize}
                onGridSizeChange={(s) => setGridSize(s as 'small' | 'medium' | 'large')}
              />
            )}
            {activeTab === 'editor' && (
              <EditorConfigSection
                editorWidth={editorWidth}
                onEditorWidthChange={(w) => setEditorWidth(w as 'mobile' | 'standard' | 'wide')}
              />
            )}
            {activeTab === 'storage' && <StorageSection />}
            {activeTab === 'version' && <VersionSection />}
          </div>
        </div>
      </div>
    </div>
  )
}
