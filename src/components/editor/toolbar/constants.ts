/**
 * EditorToolbar 共享常量
 */

/** 预设字体颜色 */
export const PRESET_COLORS = [
  '#1a1a1a', '#4a4a4a', '#8c8c8c', '#bfbfbf',
  '#e03131', '#e8590c', '#f08c00', '#2f9e44',
  '#1971c2', '#7048e8', '#9c36b5', '#c2255c',
] as const

/** 代码块支持的语言列表 */
export const CODE_LANGUAGES: { value: string; label: string }[] = [
  { value: 'plaintext', label: '纯文本' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'rust', label: 'Rust' },
  { value: 'java', label: 'Java' },
  { value: 'go', label: 'Go' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'php', label: 'PHP' },
  { value: 'swift', label: 'Swift' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'scala', label: 'Scala' },
  { value: 'bash', label: 'Bash' },
  { value: 'shell', label: 'Shell' },
  { value: 'sql', label: 'SQL' },
  { value: 'json', label: 'JSON' },
  { value: 'xml', label: 'XML' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'scss', label: 'SCSS' },
  { value: 'less', label: 'Less' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'yaml', label: 'YAML' },
  { value: 'toml', label: 'TOML' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'nginx', label: 'Nginx' },
  { value: 'makefile', label: 'Makefile' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'ini', label: 'INI' },
  { value: 'diff', label: 'Diff' },
  { value: 'powershell', label: 'PowerShell' },
]
