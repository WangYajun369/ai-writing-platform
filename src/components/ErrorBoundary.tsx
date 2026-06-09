/**
 * ErrorBoundary — React 错误边界组件
 *
 * 捕获子组件渲染期间的未处理错误，避免整个应用白屏。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangleIcon, RefreshCwIcon } from 'lucide-react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] 组件渲染异常:', error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-8">
          <div className="text-center max-w-md">
            <AlertTriangleIcon className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-lg font-semibold mb-2">应用出现异常</h2>
            <p className="text-sm text-muted-foreground mb-4 break-all">
              {this.state.error?.message || '未知错误'}
            </p>
            <button
              onClick={this.handleReset}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm hover:opacity-90 transition-opacity"
            >
              <RefreshCwIcon className="w-4 h-4" />
              重试
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
