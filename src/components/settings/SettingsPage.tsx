/**
 * SettingsPage — 设置页面（入口壳）
 *
 * 标签页由文件内的 `TABS` 注册表单一驱动：新增设置页只需往注册表加一条，
 * 内容区再补一个分支即可，避免"后端有能力、前端无入口"的不对称。
 * 「系统检查」通过 `visible` 谓词声明"仅开发者模式可见"，而非散落的条件判断。
 *
 * 数据来源：AI 配置与连接状态来自 useAiStore；外观/编辑偏好来自
 * usePreferencesStore（各 setter 内部持久化到后端 config）；
 * 「AI 配置」的测试连接由本页动态 import aiApi.testConnection 执行。
 */
import { useEffect, useMemo, useState } from 'react'
import { errText } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { useNavigate } from 'react-router-dom'
import { ArrowLeftIcon, BotIcon, PaletteIcon, DatabaseIcon, ArrowUpCircleIcon, PenLineIcon, WrenchIcon, MonitorCheckIcon, PackageIcon } from 'lucide-react'
import { useAiStore } from '@/stores/aiStore'
import { usePreferencesStore } from '@/stores/preferencesStore'
import { AiConfigSection } from './AiConfigSection'
import { AiToolboxSection } from './AiToolboxSection'
import { AppearanceSection } from './AppearanceSection'
import { EditorConfigSection } from './EditorConfigSection'
import { PluginSection } from './PluginSection'
import { StorageSection } from './StorageSection'
import { VersionSection } from './VersionSection'
import { SystemCheckSection } from './SystemCheckSection'
import { ResetDefaultsCard } from './shared'

type Tab = 'ai' | 'toolbox' | 'plugins' | 'appearance' | 'editor' | 'storage' | 'version' | 'system'

interface TabDef {
  id: Tab
  label: string
  icon: React.FC<{ className?: string }>
  /** 可见性谓词：缺省恒可见，例如「系统检查」仅在开发者模式开启时出现 */
  visible?: (ctx: { developerMode: boolean }) => boolean
}

/** 设置标签页注册表（单一真源） */
const TABS: readonly TabDef[] = [
  { id: 'ai', label: 'AI 配置', icon: BotIcon },
  { id: 'toolbox', label: 'AI 工具箱', icon: WrenchIcon },
  { id: 'plugins', label: 'Agent 插件', icon: PackageIcon },
  { id: 'appearance', label: '外观', icon: PaletteIcon },
  { id: 'editor', label: '编辑', icon: PenLineIcon },
  { id: 'storage', label: '存储', icon: DatabaseIcon },
  { id: 'version', label: '版本', icon: ArrowUpCircleIcon },
  {
    id: 'system',
    label: '系统检查',
    icon: MonitorCheckIcon,
    visible: ({ developerMode }) => developerMode,
  },
]

export default function SettingsPage() {
  const navigate = useNavigate()
  const { aiConfig, setAiConfig, aiConnectionStatus, aiConnectionDetail, setAiConnectionStatus } = useAiStore()
  const {
    theme, setTheme,
    eyeCareMode, setEyeCareMode,
    gridSize, setGridSize,
    editorWidth, setEditorWidth,
    fontFamily, setFontFamily,
    fontSize, setFontSize,
    developerMode,
    resetToDefaults,
  } = usePreferencesStore()
  const [activeTab, setActiveTab] = useState<Tab>('ai')
  const [resetBusy, setResetBusy] = useState(false)

  const tabs = useMemo(
    () => TABS.filter((tab) => !tab.visible || tab.visible({ developerMode })),
    [developerMode],
  )

  // 当前标签页变为不可见后（如关闭开发者模式）回退到版本页，避免内容区空白
  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) setActiveTab('version')
  }, [tabs, activeTab])

  const handleResetDefaults = async () => {
    setResetBusy(true)
    try {
      await resetToDefaults()
      toast.success('已恢复默认设置')
    } catch (err) {
      toast.error(errText(err, '恢复默认设置失败'))
    } finally {
      setResetBusy(false)
    }
  }

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
            {tabs.map(({ id, label, icon: Icon }) => (
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
                    setAiConnectionStatus('error', errText(err, '未知错误'))
                  }
                }}
              />
            )}
            {activeTab === 'toolbox' && <AiToolboxSection />}
            {activeTab === 'plugins' && <PluginSection />}
            {activeTab === 'appearance' && (
              <div className="space-y-6">
                <AppearanceSection
                  theme={theme}
                  eyeCareMode={eyeCareMode}
                  gridSize={gridSize}
                  onThemeChange={setTheme}
                  onEyeCareChange={setEyeCareMode}
                  onGridSizeChange={setGridSize}
                />
                <ResetDefaultsCard
                  busy={resetBusy}
                  onReset={handleResetDefaults}
                  scopeHint="将主题、护眼、字体、字号、网格大小、编辑器宽度与书库布局恢复为默认值（不影响作品数据）"
                />
              </div>
            )}
            {activeTab === 'editor' && (
              <EditorConfigSection
                editorWidth={editorWidth}
                fontFamily={fontFamily}
                fontSize={fontSize}
                onEditorWidthChange={setEditorWidth}
                onFontFamilyChange={setFontFamily}
                onFontSizeChange={setFontSize}
              />
            )}
            {activeTab === 'storage' && <StorageSection />}
            {activeTab === 'version' && <VersionSection />}
            {activeTab === 'system' && developerMode && <SystemCheckSection />}
          </div>
        </div>
      </div>
    </div>
  )
}
