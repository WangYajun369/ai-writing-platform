/**
 * math-symbols — 数学符号常量表（全面版）
 *
 * 参考标准 KaTeX 支持的全部符号与常用模板，按 11 个一级分类组织。
 * 每个符号包含：
 *  - label: KaTeX 渲染预览用的 LaTeX（可能含占位符示例）
 *  - insert: 点击后插入到输入框的实际源码（光标占位用 {}）
 *  - name: 中文提示
 */

export interface MathSymbol {
  label: string
  insert: string
  name: string
}

export interface MathSymbolCategory {
  key: string
  title: string
  /** 英文副标题（分类标题行展示用） */
  titleEn: string
  symbols: MathSymbol[]
}

/* ─────────────────────────────────────────────── */

/** 1. 常用 — 分数、根式、上下标、求和、极限、微积分核心模板 */
const COMMON: MathSymbol[] = [
  // 分数
  { label: '\\frac{a}{b}', insert: '\\frac{}{}', name: '分数' },
  { label: '\\tfrac{a}{b}', insert: '\\tfrac{}{}', name: '行内小分数' },
  { label: '\\dfrac{a}{b}', insert: '\\dfrac{}{}', name: '显示大分数' },
  { label: 'x\\frac{a}{b}', insert: 'x\\frac{}{}', name: '带前置变量的分数' },
  { label: '\\frac{\\mathrm{d}y}{\\mathrm{d}x}', insert: '\\frac{\\,\\mathrm{d}}{\\,\\mathrm{d}x}', name: '导数（莱布尼茨记法）' },
  { label: '\\frac{\\partial f}{\\partial x}', insert: '\\frac{\\partial }{\\partial x}', name: '偏导' },
  { label: '\\frac{\\partial^2 y}{\\partial x_1 \\partial x_2}', insert: '\\frac{\\partial^2 }{\\partial x_1 \\partial x_2}', name: '二阶偏导' },
  // 根式
  { label: '\\sqrt{x}', insert: '\\sqrt{}', name: '平方根' },
  { label: '\\sqrt[n]{x}', insert: '\\sqrt[]{}', name: 'n 次根号' },
  // 上下标
  { label: 'x^{n}', insert: '^{}', name: '上标' },
  { label: 'x_{n}', insert: '_{}', name: '下标' },
  { label: 'x_{a}^{b}', insert: '_{}^{}', name: '上下标' },
  { label: '{}_{a}^{b}x', insert: '{}_{}^{}x', name: '前置上下标' },
  { label: 'x^{\\prime}', insert: '^{\\prime}', name: '撇号' },
  { label: 'x^{\\prime\\prime}', insert: '^{\\prime\\prime}', name: '双撇号' },
  { label: 'f^{(n)}', insert: 'f^{(n)}', name: 'n 阶导' },
  // 求和/积/极限
  { label: '\\sum', insert: '\\sum', name: '求和符号' },
  { label: '\\sum_{i=1}^{n}', insert: '\\sum_{i=1}^{n}', name: '求和（带限）' },
  { label: '\\prod', insert: '\\prod', name: '连乘积' },
  { label: '\\prod_{i=1}^{n}', insert: '\\prod_{i=1}^{n}', name: '连乘积（带限）' },
  { label: '\\lim_{x \\to \\infty}', insert: '\\lim_{x \\to \\infty}', name: '极限' },
  { label: '\\lim_{x \\to 0}', insert: '\\lim_{x \\to 0}', name: '极限（x→0）' },
  { label: '\\lim_{x \\to 0^{+}}', insert: '\\lim_{x \\to 0^{+}}', name: '右极限' },
  // 积分
  { label: '\\int', insert: '\\int', name: '不定积分' },
  { label: '\\int_{a}^{b}', insert: '\\int_{}^{}', name: '定积分' },
  { label: '\\iint', insert: '\\iint', name: '二重积分' },
  { label: '\\iint_{D}', insert: '\\iint_{D}', name: '二重积分（区域）' },
  { label: '\\iiint', insert: '\\iiint', name: '三重积分' },
  { label: '\\oint', insert: '\\oint', name: '环路积分' },
  { label: '\\oint_{C}', insert: '\\oint_{C}', name: '曲线积分' },
  { label: '\\oiint', insert: '\\oiint', name: '面积分' },
  { label: '\\oiiint', insert: '\\oiiint', name: '体积分' },
  // 向量/导数/微分
  { label: '\\vec{a}', insert: '\\vec{}', name: '向量' },
  { label: '\\overline{AB}', insert: '\\overline{}', name: '上横线' },
  { label: '\\overrightarrow{AB}', insert: '\\overrightarrow{}', name: '向量箭头' },
  { label: '\\hat{a}', insert: '\\hat{}', name: '单位向量（尖帽）' },
  { label: '\\bar{a}', insert: '\\bar{}', name: '共轭（短横）' },
  { label: '\\dot{a}', insert: '\\dot{}', name: '时间导数（点）' },
  { label: '\\ddot{a}', insert: '\\ddot{}', name: '二阶时间导数（双点）' },
  { label: '\\,\\mathrm{d}x', insert: '\\,\\mathrm{d}x', name: '微分 dx' },
  { label: '\\nabla', insert: '\\nabla', name: '梯度算子' },
  // 二项式/组合
  { label: '\\binom{n}{k}', insert: '\\binom{}{}', name: '二项式系数' },
  { label: '\\dbinom{n}{k}', insert: '\\dbinom{}{}', name: '二项式（显示模式）' },
  // 自适应括号
  { label: '\\left( x \\right)', insert: '\\left(  \\right)', name: '自适应圆括号' },
  { label: '\\left[ x \\right]', insert: '\\left[  \\right]', name: '自适应方括号' },
  { label: '\\left\\{ x \\right\\}', insert: '\\left\\{  \\right\\}', name: '自适应花括号' },
  { label: '\\left| x \\right|', insert: '\\left|  \\right|', name: '自适应绝对值' },
  // 对数/指数
  { label: '\\log_{a}{b}', insert: '\\log_{}{}', name: '对数' },
  { label: '\\ln x', insert: '\\ln ', name: '自然对数' },
  { label: '\\lg x', insert: '\\lg ', name: '常用对数' },
  { label: '\\exp x', insert: '\\exp ', name: '指数函数' },
  { label: '\\mathrm{e}^{x}', insert: '\\mathrm{e}^{}', name: '自然指数' },
  // 模算术
  { label: 'a \\bmod b', insert: ' \\bmod ', name: '模运算' },
  { label: 'a \\equiv b \\pmod{m}', insert: ' \\equiv  \\pmod{}', name: '同余式' },
  { label: '\\gcd(m,n)', insert: '\\gcd()', name: '最大公约数' },
  { label: '\\operatorname{lcm}(m,n)', insert: '\\operatorname{lcm}()', name: '最小公倍数' },
  // 杂项
  { label: '\\infty', insert: '\\infty', name: '无穷' },
  { label: '\\partial', insert: '\\partial', name: '偏微分' },
  { label: '\\mathrm{i}', insert: '\\mathrm{i}', name: '虚数单位 i' },
  { label: '\\mathrm{j}', insert: '\\mathrm{j}', name: '虚数单位 j' },
  { label: '\\hbar', insert: '\\hbar', name: '约化普朗克常数' },
  { label: '\\degree', insert: '\\degree', name: '度' },
  { label: '\\angle', insert: '\\angle', name: '角' },
  { label: '\\triangle', insert: '\\triangle', name: '三角形' },
  { label: '\\square', insert: '\\square', name: '正方形' },
]

/* ─────────────────────────────────────────────── */

/** 2. 希腊字母 — 小写 / 大写 / 变体（全量） */
const GREEK: MathSymbol[] = [
  // 小写
  { label: '\\alpha', insert: '\\alpha', name: 'alpha' },
  { label: '\\beta', insert: '\\beta', name: 'beta' },
  { label: '\\gamma', insert: '\\gamma', name: 'gamma' },
  { label: '\\delta', insert: '\\delta', name: 'delta' },
  { label: '\\epsilon', insert: '\\epsilon', name: 'epsilon' },
  { label: '\\varepsilon', insert: '\\varepsilon', name: 'varepsilon' },
  { label: '\\zeta', insert: '\\zeta', name: 'zeta' },
  { label: '\\eta', insert: '\\eta', name: 'eta' },
  { label: '\\theta', insert: '\\theta', name: 'theta' },
  { label: '\\vartheta', insert: '\\vartheta', name: 'vartheta' },
  { label: '\\iota', insert: '\\iota', name: 'iota' },
  { label: '\\kappa', insert: '\\kappa', name: 'kappa' },
  { label: '\\lambda', insert: '\\lambda', name: 'lambda' },
  { label: '\\mu', insert: '\\mu', name: 'mu' },
  { label: '\\nu', insert: '\\nu', name: 'nu' },
  { label: '\\xi', insert: '\\xi', name: 'xi' },
  { label: '\\pi', insert: '\\pi', name: 'pi' },
  { label: '\\varpi', insert: '\\varpi', name: 'varpi' },
  { label: '\\rho', insert: '\\rho', name: 'rho' },
  { label: '\\varrho', insert: '\\varrho', name: 'varrho' },
  { label: '\\sigma', insert: '\\sigma', name: 'sigma' },
  { label: '\\varsigma', insert: '\\varsigma', name: 'varsigma' },
  { label: '\\tau', insert: '\\tau', name: 'tau' },
  { label: '\\upsilon', insert: '\\upsilon', name: 'upsilon' },
  { label: '\\phi', insert: '\\phi', name: 'phi' },
  { label: '\\varphi', insert: '\\varphi', name: 'varphi' },
  { label: '\\chi', insert: '\\chi', name: 'chi' },
  { label: '\\psi', insert: '\\psi', name: 'psi' },
  { label: '\\omega', insert: '\\omega', name: 'omega' },
  // 大写（与拉丁同形的用普通字母）
  { label: 'A', insert: 'A', name: 'Alpha（大写）' },
  { label: 'B', insert: 'B', name: 'Beta（大写）' },
  { label: '\\Gamma', insert: '\\Gamma', name: 'Gamma' },
  { label: '\\Delta', insert: '\\Delta', name: 'Delta' },
  { label: 'E', insert: 'E', name: 'Epsilon（大写）' },
  { label: 'Z', insert: 'Z', name: 'Zeta（大写）' },
  { label: 'H', insert: 'H', name: 'Eta（大写）' },
  { label: '\\Theta', insert: '\\Theta', name: 'Theta' },
  { label: 'I', insert: 'I', name: 'Iota（大写）' },
  { label: 'K', insert: 'K', name: 'Kappa（大写）' },
  { label: '\\Lambda', insert: '\\Lambda', name: 'Lambda' },
  { label: 'M', insert: 'M', name: 'Mu（大写）' },
  { label: 'N', insert: 'N', name: 'Nu（大写）' },
  { label: '\\Xi', insert: '\\Xi', name: 'Xi' },
  { label: 'O', insert: 'O', name: 'Omicron（大写）' },
  { label: '\\Pi', insert: '\\Pi', name: 'Pi' },
  { label: 'P', insert: 'P', name: 'Rho（大写）' },
  { label: '\\Sigma', insert: '\\Sigma', name: 'Sigma' },
  { label: 'T', insert: 'T', name: 'Tau（大写）' },
  { label: '\\Upsilon', insert: '\\Upsilon', name: 'Upsilon' },
  { label: '\\Phi', insert: '\\Phi', name: 'Phi' },
  { label: 'X', insert: 'X', name: 'Chi（大写）' },
  { label: '\\Psi', insert: '\\Psi', name: 'Psi' },
  { label: '\\Omega', insert: '\\Omega', name: 'Omega' },
  // 斜体大写变体
  { label: '\\varGamma', insert: '\\varGamma', name: 'Gamma（斜体）' },
  { label: '\\varDelta', insert: '\\varDelta', name: 'Delta（斜体）' },
  { label: '\\varTheta', insert: '\\varTheta', name: 'Theta（斜体）' },
  { label: '\\varLambda', insert: '\\varLambda', name: 'Lambda（斜体）' },
  { label: '\\varXi', insert: '\\varXi', name: 'Xi（斜体）' },
  { label: '\\varPi', insert: '\\varPi', name: 'Pi（斜体）' },
  { label: '\\varSigma', insert: '\\varSigma', name: 'Sigma（斜体）' },
  { label: '\\varUpsilon', insert: '\\varUpsilon', name: 'Upsilon（斜体）' },
  { label: '\\varPhi', insert: '\\varPhi', name: 'Phi（斜体）' },
  { label: '\\varPsi', insert: '\\varPsi', name: 'Psi（斜体）' },
  { label: '\\varOmega', insert: '\\varOmega', name: 'Omega（斜体）' },
  // 其他字母变体
  { label: '\\ell', insert: '\\ell', name: '手写体 l' },
  { label: '\\hbar', insert: '\\hbar', name: '约化普朗克常数' },
  { label: '\\imath', insert: '\\imath', name: '无点 i' },
  { label: '\\jmath', insert: '\\jmath', name: '无点 j' },
  { label: '\\aleph', insert: '\\aleph', name: '阿列夫' },
  { label: '\\beth', insert: '\\beth', name: 'beth' },
  { label: '\\gimel', insert: '\\gimel', name: 'gimel' },
  { label: '\\daleth', insert: '\\daleth', name: 'daleth' },
  { label: '\\eth', insert: '\\eth', name: 'eth' },
  { label: '\\Bbbk', insert: '\\Bbbk', name: '黑板粗体 k' },
  { label: '\\mho', insert: '\\mho', name: '电导（倒 Ω）' },
  { label: '\\Finv', insert: '\\Finv', name: '倒 F' },
  { label: '\\Game', insert: '\\Game', name: 'Game' },
  { label: '\\complement', insert: '\\complement', name: '补集' },
]

/* ─────────────────────────────────────────────── */

/** 3. 运算符 — 算术、集合、逻辑、代数 */
const OPERATORS: MathSymbol[] = [
  // 算术
  { label: '+', insert: '+', name: '加' },
  { label: '-', insert: '-', name: '减' },
  { label: '\\times', insert: '\\times', name: '乘' },
  { label: '\\div', insert: '\\div', name: '除' },
  { label: '\\cdot', insert: '\\cdot', name: '点乘' },
  { label: '\\pm', insert: '\\pm', name: '加减' },
  { label: '\\mp', insert: '\\mp', name: '减加' },
  { label: '\\ast', insert: '\\ast', name: '星号' },
  { label: '\\star', insert: '\\star', name: '五角星' },
  { label: '\\circ', insert: '\\circ', name: '圆圈' },
  { label: '\\bullet', insert: '\\bullet', name: '实心点' },
  { label: '\\diamond', insert: '\\diamond', name: '菱形' },
  { label: '\\bigcirc', insert: '\\bigcirc', name: '大圆圈' },
  { label: '\\oplus', insert: '\\oplus', name: '圈加' },
  { label: '\\ominus', insert: '\\ominus', name: '圈减' },
  { label: '\\otimes', insert: '\\otimes', name: '圈乘' },
  { label: '\\oslash', insert: '\\oslash', name: '圈除' },
  { label: '\\odot', insert: '\\odot', name: '圈点' },
  { label: '\\circledast', insert: '\\circledast', name: '圈星' },
  { label: '\\circledcirc', insert: '\\circledcirc', name: '圈圆' },
  { label: '\\bigtriangleup', insert: '\\bigtriangleup', name: '大三角' },
  { label: '\\bigtriangledown', insert: '\\bigtriangledown', name: '倒大三角' },
  { label: '\\triangleleft', insert: '\\triangleleft', name: '左三角' },
  { label: '\\triangleright', insert: '\\triangleright', name: '右三角' },
  { label: '\\dagger', insert: '\\dagger', name: '匕首' },
  { label: '\\ddagger', insert: '\\ddagger', name: '双匕首' },
  { label: '\\amalg', insert: '\\amalg', name: '合并' },
  // 集合
  { label: '\\cup', insert: '\\cup', name: '并集' },
  { label: '\\cap', insert: '\\cap', name: '交集' },
  { label: '\\sqcup', insert: '\\sqcup', name: '方形并' },
  { label: '\\sqcap', insert: '\\sqcap', name: '方形交' },
  { label: '\\uplus', insert: '\\uplus', name: '不交并' },
  { label: '\\setminus', insert: '\\setminus', name: '差集' },
  { label: '\\smallsetminus', insert: '\\smallsetminus', name: '小差集' },
  { label: '\\wr', insert: '\\wr', name: '圈积' },
  { label: '\\bigcup', insert: '\\bigcup', name: '大并集' },
  { label: '\\bigcap', insert: '\\bigcap', name: '大交集' },
  { label: '\\bigsqcup', insert: '\\bigsqcup', name: '大方形并' },
  // 逻辑
  { label: '\\land', insert: '\\land', name: '逻辑与' },
  { label: '\\lor', insert: '\\lor', name: '逻辑或' },
  { label: '\\lnot', insert: '\\lnot', name: '逻辑非' },
  { label: '\\forall', insert: '\\forall', name: '任意' },
  { label: '\\exists', insert: '\\exists', name: '存在' },
  { label: '\\nexists', insert: '\\nexists', name: '不存在' },
  // 代数
  { label: '\\oplus', insert: '\\oplus', name: '直和' },
  { label: '\\otimes', insert: '\\otimes', name: '张量积' },
  { label: '\\bigoplus', insert: '\\bigoplus', name: '大直和' },
  { label: '\\bigotimes', insert: '\\bigotimes', name: '大张量积' },
]

/* ─────────────────────────────────────────────── */

/** 4. 关系符 — 比较、序、集合关系、几何 */
const RELATIONS: MathSymbol[] = [
  { label: '=', insert: '=', name: '等于' },
  { label: '\\neq', insert: '\\neq', name: '不等于' },
  { label: '\\approx', insert: '\\approx', name: '约等于' },
  { label: '\\equiv', insert: '\\equiv', name: '恒等于' },
  { label: '\\sim', insert: '\\sim', name: '相似' },
  { label: '\\simeq', insert: '\\simeq', name: '相似等于' },
  { label: '\\cong', insert: '\\cong', name: '全等' },
  { label: '\\approxeq', insert: '\\approxeq', name: '近似等于' },
  { label: '\\asymp', insert: '\\asymp', name: '渐近等于' },
  { label: '\\doteq', insert: '\\doteq', name: '点等于' },
  { label: '\\propto', insert: '\\propto', name: '正比于' },
  { label: '<', insert: '<', name: '小于' },
  { label: '>', insert: '>', name: '大于' },
  { label: '\\leq', insert: '\\leq', name: '小于等于' },
  { label: '\\geq', insert: '\\geq', name: '大于等于' },
  { label: '\\ll', insert: '\\ll', name: '远小于' },
  { label: '\\gg', insert: '\\gg', name: '远大于' },
  { label: '\\nless', insert: '\\nless', name: '不小于' },
  { label: '\\ngtr', insert: '\\ngtr', name: '不大于' },
  { label: '\\nleq', insert: '\\nleq', name: '不小于等于' },
  { label: '\\ngeq', insert: '\\ngeq', name: '不大于等于' },
  { label: '\\prec', insert: '\\prec', name: '先于' },
  { label: '\\succ', insert: '\\succ', name: '后于' },
  { label: '\\preceq', insert: '\\preceq', name: '先等于' },
  { label: '\\succeq', insert: '\\succeq', name: '后等于' },
  { label: '\\nprec', insert: '\\nprec', name: '不先于' },
  { label: '\\nsucc', insert: '\\nsucc', name: '不后于' },
  { label: '\\perp', insert: '\\perp', name: '垂直' },
  { label: '\\parallel', insert: '\\parallel', name: '平行' },
  { label: '\\nparallel', insert: '\\nparallel', name: '不平行' },
  { label: '\\mid', insert: '\\mid', name: '整除' },
  { label: '\\nmid', insert: '\\nmid', name: '不整除' },
  // 集合关系
  { label: '\\in', insert: '\\in', name: '属于' },
  { label: '\\notin', insert: '\\notin', name: '不属于' },
  { label: '\\ni', insert: '\\ni', name: '包含于（反）' },
  { label: '\\subset', insert: '\\subset', name: '真子集' },
  { label: '\\supset', insert: '\\supset', name: '真超集' },
  { label: '\\subseteq', insert: '\\subseteq', name: '子集' },
  { label: '\\supseteq', insert: '\\supseteq', name: '超集' },
  { label: '\\subsetneq', insert: '\\subsetneq', name: '真子集（不等）' },
  { label: '\\supsetneq', insert: '\\supsetneq', name: '真超集（不等）' },
  { label: '\\sqsubset', insert: '\\sqsubset', name: '方形子集' },
  { label: '\\sqsupset', insert: '\\sqsupset', name: '方形超集' },
  { label: '\\sqsubseteq', insert: '\\sqsubseteq', name: '方形子等于' },
  { label: '\\sqsupseteq', insert: '\\sqsupseteq', name: '方形超等于' },
  // 几何
  { label: '\\angle', insert: '\\angle', name: '角' },
  { label: '\\measuredangle', insert: '\\measuredangle', name: '测量角' },
  { label: '\\sphericalangle', insert: '\\sphericalangle', name: '球面角' },
  { label: '\\triangle', insert: '\\triangle', name: '三角形' },
  { label: '\\square', insert: '\\square', name: '正方形' },
  { label: '\\blacksquare', insert: '\\blacksquare', name: '实心方块' },
  { label: '\\trianglelefteq', insert: '\\trianglelefteq', name: '正规子群' },
  { label: '\\trianglerighteq', insert: '\\trianglerighteq', name: '反正规子群' },
]

/* ─────────────────────────────────────────────── */

/** 5. 箭头 — 各种方向与类型 */
const ARROWS: MathSymbol[] = [
  { label: '\\to', insert: '\\to', name: '右箭头' },
  { label: '\\rightarrow', insert: '\\rightarrow', name: '右箭头' },
  { label: '\\leftarrow', insert: '\\leftarrow', name: '左箭头' },
  { label: '\\leftrightarrow', insert: '\\leftrightarrow', name: '双向箭头' },
  { label: '\\Rightarrow', insert: '\\Rightarrow', name: '蕴含' },
  { label: '\\Leftarrow', insert: '\\Leftarrow', name: '反蕴含' },
  { label: '\\Leftrightarrow', insert: '\\Leftrightarrow', name: '等价' },
  { label: '\\mapsto', insert: '\\mapsto', name: '映射' },
  { label: '\\longmapsto', insert: '\\longmapsto', name: '长映射' },
  { label: '\\longrightarrow', insert: '\\longrightarrow', name: '长右箭头' },
  { label: '\\longleftarrow', insert: '\\longleftarrow', name: '长左箭头' },
  { label: '\\longleftrightarrow', insert: '\\longleftrightarrow', name: '长双向箭头' },
  { label: '\\Longrightarrow', insert: '\\Longrightarrow', name: '长蕴含' },
  { label: '\\Longleftarrow', insert: '\\Longleftarrow', name: '长反蕴含' },
  { label: '\\Longleftrightarrow', insert: '\\Longleftrightarrow', name: '长等价' },
  { label: '\\uparrow', insert: '\\uparrow', name: '上箭头' },
  { label: '\\downarrow', insert: '\\downarrow', name: '下箭头' },
  { label: '\\updownarrow', insert: '\\updownarrow', name: '上下箭头' },
  { label: '\\Uparrow', insert: '\\Uparrow', name: '双上箭头' },
  { label: '\\Downarrow', insert: '\\Downarrow', name: '双下箭头' },
  { label: '\\Updownarrow', insert: '\\Updownarrow', name: '双上下箭头' },
  { label: '\\nearrow', insert: '\\nearrow', name: '东北箭头' },
  { label: '\\searrow', insert: '\\searrow', name: '东南箭头' },
  { label: '\\nwarrow', insert: '\\nwarrow', name: '西北箭头' },
  { label: '\\swarrow', insert: '\\swarrow', name: '西南箭头' },
  { label: '\\hookrightarrow', insert: '\\hookrightarrow', name: '右钩箭头' },
  { label: '\\hookleftarrow', insert: '\\hookleftarrow', name: '左钩箭头' },
  { label: '\\rightharpoonup', insert: '\\rightharpoonup', name: '右上鱼叉' },
  { label: '\\rightharpoondown', insert: '\\rightharpoondown', name: '右下鱼叉' },
  { label: '\\leftharpoonup', insert: '\\leftharpoonup', name: '左上鱼叉' },
  { label: '\\leftharpoondown', insert: '\\leftharpoondown', name: '左下鱼叉' },
  { label: '\\rightleftharpoons', insert: '\\rightleftharpoons', name: '双向鱼叉' },
  { label: '\\leftrightharpoons', insert: '\\leftrightharpoons', name: '反双向鱼叉' },
  // 可扩展箭头（带上下文字）
  { label: '\\xrightarrow{\\text{above}}', insert: '\\xrightarrow{}', name: '带上文右箭头' },
  { label: '\\xleftarrow{\\text{above}}', insert: '\\xleftarrow{}', name: '带上文左箭头' },
  { label: '\\xRightarrow{\\text{above}}', insert: '\\xRightarrow{}', name: '带上文右双箭头' },
  { label: '\\xLeftarrow{\\text{above}}', insert: '\\xLeftarrow{}', name: '带上文左双箭头' },
  { label: '\\xleftrightarrow{\\text{above}}', insert: '\\xleftrightarrow{}', name: '带上文双向箭头' },
  { label: '\\xLeftrightarrow{\\text{above}}', insert: '\\xLeftrightarrow{}', name: '带上文双向双箭头' },
  { label: '\\xhookrightarrow{\\text{above}}', insert: '\\xhookrightarrow{}', name: '带上文右钩箭头' },
  { label: '\\xmapsto{\\text{above}}', insert: '\\xmapsto{}', name: '带上文映射' },
]

/* ─────────────────────────────────────────────── */

/** 6. 括号 — 各类定界符 */
const BRACKETS: MathSymbol[] = [
  { label: '(x)', insert: '()', name: '圆括号' },
  { label: '[x]', insert: '[]', name: '方括号' },
  { label: '\\{x\\}', insert: '\\{\\}', name: '花括号' },
  { label: '|x|', insert: '||', name: '绝对值' },
  { label: '\\|x\\|', insert: '\\|\\|', name: '范数' },
  { label: '\\langle x \\rangle', insert: '\\langle  \\rangle', name: '尖括号' },
  { label: '\\lfloor x \\rfloor', insert: '\\lfloor  \\rfloor', name: '下取整' },
  { label: '\\lceil x \\rceil', insert: '\\lceil  \\rceil', name: '上取整' },
  { label: '\\lgroup x \\rgroup', insert: '\\lgroup  \\rgroup', name: 'lgroup' },
  { label: '\\ulcorner x \\urcorner', insert: '\\ulcorner  \\urcorner', name: '角括号' },
  { label: '\\llcorner x \\lrcorner', insert: '\\llcorner  \\lrcorner', name: '倒角括号' },
  { label: '\\lmoustache x \\rmoustache', insert: '\\lmoustache  \\rmoustache', name: '胡子括号' },
  // 自适应大括号
  { label: '\\left( \\right)', insert: '\\left(  \\right)', name: '自适应圆括号' },
  { label: '\\left[ \\right]', insert: '\\left[  \\right]', name: '自适应方括号' },
  { label: '\\left\\{ \\right\\}', insert: '\\left\\{  \\right\\}', name: '自适应花括号' },
  { label: '\\left| \\right|', insert: '\\left|  \\right|', name: '自适应绝对值' },
  { label: '\\left\\| \\right\\|', insert: '\\left\\|  \\right\\|', name: '自适应范数' },
  { label: '\\left\\langle \\right\\rangle', insert: '\\left\\langle  \\right\\rangle', name: '自适应尖括号' },
  { label: '\\left\\lfloor \\right\\rfloor', insert: '\\left\\lfloor  \\right\\rfloor', name: '自适应下取整' },
  { label: '\\left\\lceil \\right\\rceil', insert: '\\left\\lceil  \\right\\rceil', name: '自适应上取整' },
]

/* ─────────────────────────────────────────────── */

/** 7. 函数 — 三角、反三角、双曲、对数、界限、特殊函数 */
const FUNCTIONS: MathSymbol[] = [
  // 三角函数
  { label: '\\sin', insert: '\\sin ', name: '正弦' },
  { label: '\\cos', insert: '\\cos ', name: '余弦' },
  { label: '\\tan', insert: '\\tan ', name: '正切' },
  { label: '\\cot', insert: '\\cot ', name: '余切' },
  { label: '\\sec', insert: '\\sec ', name: '正割' },
  { label: '\\csc', insert: '\\csc ', name: '余割' },
  // 反三角
  { label: '\\arcsin', insert: '\\arcsin ', name: '反正弦' },
  { label: '\\arccos', insert: '\\arccos ', name: '反余弦' },
  { label: '\\arctan', insert: '\\arctan ', name: '反正切' },
  { label: '\\operatorname{arccot}', insert: '\\operatorname{arccot}', name: '反余切' },
  { label: '\\operatorname{arcsec}', insert: '\\operatorname{arcsec}', name: '反正割' },
  { label: '\\operatorname{arccsc}', insert: '\\operatorname{arccsc}', name: '反余割' },
  { label: '\\sin^{-1}', insert: '\\sin^{-1}', name: 'sin⁻¹' },
  { label: '\\cos^{-1}', insert: '\\cos^{-1}', name: 'cos⁻¹' },
  { label: '\\tan^{-1}', insert: '\\tan^{-1}', name: 'tan⁻¹' },
  // 双曲函数
  { label: '\\sinh', insert: '\\sinh ', name: '双曲正弦' },
  { label: '\\cosh', insert: '\\cosh ', name: '双曲余弦' },
  { label: '\\tanh', insert: '\\tanh ', name: '双曲正切' },
  { label: '\\coth', insert: '\\coth ', name: '双曲余切' },
  { label: '\\operatorname{sech}', insert: '\\operatorname{sech}', name: '双曲正割' },
  { label: '\\operatorname{csch}', insert: '\\operatorname{csch}', name: '双曲余割' },
  // 反双曲
  { label: '\\operatorname{arsinh}', insert: '\\operatorname{arsinh}', name: '反双曲正弦' },
  { label: '\\operatorname{arcosh}', insert: '\\operatorname{arcosh}', name: '反双曲余弦' },
  { label: '\\operatorname{artanh}', insert: '\\operatorname{artanh}', name: '反双曲正切' },
  { label: '\\operatorname{arcoth}', insert: '\\operatorname{arcoth}', name: '反双曲余切' },
  { label: '\\sinh^{-1}', insert: '\\sinh^{-1}', name: 'sinh⁻¹' },
  { label: '\\cosh^{-1}', insert: '\\cosh^{-1}', name: 'cosh⁻¹' },
  { label: '\\tanh^{-1}', insert: '\\tanh^{-1}', name: 'tanh⁻¹' },
  // 对数/指数
  { label: '\\log', insert: '\\log ', name: '对数' },
  { label: '\\ln', insert: '\\ln ', name: '自然对数' },
  { label: '\\lg', insert: '\\lg ', name: '常用对数' },
  { label: '\\exp', insert: '\\exp ', name: '指数函数' },
  // 界限/极值
  { label: '\\max', insert: '\\max ', name: '最大值' },
  { label: '\\min', insert: '\\min ', name: '最小值' },
  { label: '\\sup', insert: '\\sup ', name: '上确界' },
  { label: '\\inf', insert: '\\inf ', name: '下确界' },
  { label: '\\limsup', insert: '\\limsup', name: '上极限' },
  { label: '\\liminf', insert: '\\liminf', name: '下极限' },
  // 代数
  { label: '\\gcd', insert: '\\gcd ', name: '最大公约数' },
  { label: '\\det', insert: '\\det ', name: '行列式' },
  { label: '\\dim', insert: '\\dim ', name: '维数' },
  { label: '\\ker', insert: '\\ker ', name: '核' },
  { label: '\\operatorname{im}', insert: '\\operatorname{im}', name: '像' },
  { label: '\\operatorname{coker}', insert: '\\operatorname{coker}', name: '余核' },
  { label: '\\operatorname{rank}', insert: '\\operatorname{rank}', name: '秩' },
  { label: '\\operatorname{tr}', insert: '\\operatorname{tr}', name: '迹' },
  { label: '\\operatorname{sgn}', insert: '\\operatorname{sgn}', name: '符号函数' },
  { label: '\\operatorname{diag}', insert: '\\operatorname{diag}', name: '对角矩阵' },
  { label: '\\operatorname{arg}', insert: '\\operatorname{arg}', name: '辐角' },
  { label: '\\operatorname{Re}', insert: '\\operatorname{Re}', name: '实部' },
  { label: '\\operatorname{Im}', insert: '\\operatorname{Im}', name: '虚部' },
]

/* ─────────────────────────────────────────────── */

/** 8. 积分 — 各类积分符号与组合 */
const INTEGRALS: MathSymbol[] = [
  { label: '\\int', insert: '\\int', name: '不定积分' },
  { label: '\\int_{a}^{b}', insert: '\\int_{}^{}', name: '定积分' },
  { label: '\\oint', insert: '\\oint', name: '环路积分' },
  { label: '\\oint_{C}', insert: '\\oint_{}', name: '曲线积分' },
  { label: '\\iint', insert: '\\iint', name: '二重积分' },
  { label: '\\iint_{D}', insert: '\\iint_{}', name: '二重积分（区域）' },
  { label: '\\iiint', insert: '\\iiint', name: '三重积分' },
  { label: '\\iiint_{V}', insert: '\\iiint_{}', name: '三重积分（体）' },
  { label: '\\oiint', insert: '\\oiint', name: '面积分' },
  { label: '\\oiint_{S}', insert: '\\oiint_{}', name: '面积分（面）' },
  { label: '\\oiiint', insert: '\\oiiint', name: '体积分' },
  // 微分组合
  { label: '\\,\\mathrm{d}x', insert: '\\,\\mathrm{d}x', name: '微分 dx' },
  { label: '\\,\\mathrm{d}y', insert: '\\,\\mathrm{d}y', name: '微分 dy' },
  { label: '\\,\\mathrm{d}z', insert: '\\,\\mathrm{d}z', name: '微分 dz' },
  { label: '\\,\\mathrm{d}t', insert: '\\,\\mathrm{d}t', name: '微分 dt' },
  { label: '\\,\\mathrm{d}s', insert: '\\,\\mathrm{d}s', name: '弧长微分' },
  { label: '\\,\\mathrm{d}\\theta', insert: '\\,\\mathrm{d}\\theta', name: '角度微分' },
  { label: '\\,\\mathrm{d}\\phi', insert: '\\,\\mathrm{d}\\phi', name: '极角微分' },
  // 常用积分公式模板
  { label: '\\int_{a}^{b} f(x) \\,\\mathrm{d}x', insert: '\\int_{}^{} f(x) \\,\\mathrm{d}x', name: '积分模板' },
  { label: '\\int_{-\\infty}^{+\\infty}', insert: '\\int_{-\\infty}^{+\\infty}', name: '无穷积分限' },
]

/* ─────────────────────────────────────────────── */

/** 9. 重音符 — 各种上下划线、帽子、波浪线、箭头标注 */
const ACCENTS: MathSymbol[] = [
  // 单字符重音
  { label: '\\hat{a}', insert: '\\hat{}', name: '尖帽' },
  { label: '\\check{a}', insert: '\\check{}', name: '对号' },
  { label: '\\tilde{a}', insert: '\\tilde{}', name: '波浪' },
  { label: '\\acute{a}', insert: '\\acute{}', name: '锐音' },
  { label: '\\grave{a}', insert: '\\grave{}', name: '钝音' },
  { label: '\\dot{a}', insert: '\\dot{}', name: '点' },
  { label: '\\ddot{a}', insert: '\\ddot{}', name: '双点' },
  { label: '\\dddot{a}', insert: '\\dddot{}', name: '三点' },
  { label: '\\ddddot{a}', insert: '\\ddddot{}', name: '四点' },
  { label: '\\breve{a}', insert: '\\breve{}', name: '短音' },
  { label: '\\bar{a}', insert: '\\bar{}', name: '短横' },
  { label: '\\vec{a}', insert: '\\vec{}', name: '向量箭头' },
  // 扩展重音
  { label: '\\widehat{abc}', insert: '\\widehat{}', name: '宽尖帽' },
  { label: '\\widetilde{abc}', insert: '\\widetilde{}', name: '宽波浪' },
  { label: '\\overline{abc}', insert: '\\overline{}', name: '上横线' },
  { label: '\\underline{abc}', insert: '\\underline{}', name: '下横线' },
  { label: '\\overbrace{abc}', insert: '\\overbrace{}', name: '上花括号' },
  { label: '\\underbrace{abc}', insert: '\\underbrace{}', name: '下花括号' },
  { label: '\\overleftarrow{abc}', insert: '\\overleftarrow{}', name: '上左箭头' },
  { label: '\\overrightarrow{abc}', insert: '\\overrightarrow{}', name: '上右箭头' },
  { label: '\\overleftrightarrow{abc}', insert: '\\overleftrightarrow{}', name: '上双向箭头' },
  { label: '\\underleftarrow{abc}', insert: '\\underleftarrow{}', name: '下左箭头' },
  { label: '\\underrightarrow{abc}', insert: '\\underrightarrow{}', name: '下右箭头' },
  // 带文字的重音
  { label: '\\overbrace{abc}^{x}', insert: '\\overbrace{}^{}', name: '上花括号+文字' },
  { label: '\\underbrace{abc}_{x}', insert: '\\underbrace{}_{}', name: '下花括号+文字' },
  { label: '\\stackrel{a}{b}', insert: '\\stackrel{}{}', name: '堆叠' },
  { label: '\\overset{a}{b}', insert: '\\overset{}{}', name: '上叠' },
  { label: '\\underset{a}{b}', insert: '\\underset{}{}', name: '下叠' },
  // 更多扩展
  { label: '\\xleftarrow{a}', insert: '\\xleftarrow{}', name: '可扩展左箭头' },
  { label: '\\xrightarrow{a}', insert: '\\xrightarrow{}', name: '可扩展右箭头' },
  { label: '\\xleftrightarrow{a}', insert: '\\xleftrightarrow{}', name: '可扩展双向箭头' },
  // 删除线
  { label: '\\cancel{a}', insert: '\\cancel{}', name: '删除线' },
  { label: '\\bcancel{a}', insert: '\\bcancel{}', name: '反斜删除线' },
  { label: '\\xcancel{a}', insert: '\\xcancel{}', name: '叉删除线' },
]

/* ─────────────────────────────────────────────── */

/** 10. 矩阵 — 各类矩阵环境、分段函数、方程组 */
const MATRICES: MathSymbol[] = [
  // 矩阵
  { label: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', insert: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', name: '圆括号矩阵' },
  { label: '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}', insert: '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}', name: '方括号矩阵' },
  { label: '\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}', insert: '\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}', name: '行列式' },
  { label: '\\begin{Vmatrix} a & b \\\\ c & d \\end{Vmatrix}', insert: '\\begin{Vmatrix} a & b \\\\ c & d \\end{Vmatrix}', name: '范数矩阵' },
  { label: '\\begin{Bmatrix} a & b \\\\ c & d \\end{Bmatrix}', insert: '\\begin{Bmatrix} a & b \\\\ c & d \\end{Bmatrix}', name: '花括号矩阵' },
  { label: '\\begin{matrix} a & b \\\\ c & d \\end{matrix}', insert: '\\begin{matrix} a & b \\\\ c & d \\end{matrix}', name: '无括号矩阵' },
  // 常用矩阵模板
  { label: '\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}', insert: '\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}', name: '2×2 单位矩阵' },
  { label: '\\begin{pmatrix} a_{11} & a_{12} \\\\ a_{21} & a_{22} \\end{pmatrix}', insert: '\\begin{pmatrix} a_{11} & a_{12} \\\\ a_{21} & a_{22} \\end{pmatrix}', name: '2×2 一般矩阵' },
  { label: '\\begin{pmatrix} x_1 \\\\ x_2 \\\\ \\vdots \\\\ x_n \\end{pmatrix}', insert: '\\begin{pmatrix} x_1 \\\\ x_2 \\\\ \\vdots \\\\ x_n \\end{pmatrix}', name: '列向量' },
  { label: '\\begin{pmatrix} x_1 & x_2 & \\cdots & x_n \\end{pmatrix}', insert: '\\begin{pmatrix} x_1 & x_2 & \\cdots & x_n \\end{pmatrix}', name: '行向量' },
  // 分段函数（情况讨论 cases 环境）
  { label: '\\begin{cases} x & a \\\\ y & b \\end{cases}', insert: '\\begin{cases}  &  \\\\  &  \\end{cases}', name: '分段函数（2 段）' },
  { label: '\\begin{cases} a & x<0 \\\\ b & x=0 \\\\ c & x>0 \\end{cases}', insert: '\\begin{cases}  &  \\\\  &  \\\\  &  \\end{cases}', name: '分段函数（3 段）' },
  { label: '\\begin{cases} a & b \\\\ c & d \\\\ e & f \\\\ g & h \\end{cases}', insert: '\\begin{cases}  &  \\\\  &  \\\\  &  \\\\  &  \\end{cases}', name: '分段函数（4 段）' },
  { label: '\\begin{cases} x & \\text{if } x>0 \\\\ 0 & \\text{otherwise} \\end{cases}', insert: '\\begin{cases}  & \\text{if }  \\\\ 0 & \\text{otherwise} \\end{cases}', name: '条件分段' },
  // 对齐环境
  { label: '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}', insert: '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}', name: '对齐方程组' },
  { label: '\\begin{alignedat}{2} a &= b & c &= d \\\\ e &= f & g &= h \\end{alignedat}', insert: '\\begin{alignedat}{2} a &= b & c &= d \\\\ e &= f & g &= h \\end{alignedat}', name: '多列对齐' },
  { label: '\\begin{gathered} a = b \\\\ c = d \\end{gathered}', insert: '\\begin{gathered} a = b \\\\ c = d \\end{gathered}', name: '居中多行（gathered）' },
  // 省略号
  { label: '\\cdots', insert: '\\cdots', name: '居中省略号' },
  { label: '\\ldots', insert: '\\ldots', name: '底部省略号' },
  { label: '\\vdots', insert: '\\vdots', name: '垂直省略号' },
  { label: '\\ddots', insert: '\\ddots', name: '对角省略号' },
  { label: '\\dotsb', insert: '\\dotsb', name: '二元运算省略' },
  { label: '\\dotsc', insert: '\\dotsc', name: '逗号省略' },
  { label: '\\dotsi', insert: '\\dotsi', name: '积分省略' },
  { label: '\\dotsm', insert: '\\dotsm', name: '乘法省略' },
  // 阵列
  { label: '\\begin{array}{cc} a & b \\\\ c & d \\end{array}', insert: '\\begin{array}{cc} a & b \\\\ c & d \\end{array}', name: 'array 环境' },
]

/* ─────────────────────────────────────────────── */

/** 11. 其他 — 特殊符号、花体、量子力学、杂项 */
const OTHERS: MathSymbol[] = [
  // 数集
  { label: '\\mathbb{R}', insert: '\\mathbb{R}', name: '实数集' },
  { label: '\\mathbb{C}', insert: '\\mathbb{C}', name: '复数集' },
  { label: '\\mathbb{Z}', insert: '\\mathbb{Z}', name: '整数集' },
  { label: '\\mathbb{N}', insert: '\\mathbb{N}', name: '自然数集' },
  { label: '\\mathbb{Q}', insert: '\\mathbb{Q}', name: '有理数集' },
  { label: '\\mathbb{P}', insert: '\\mathbb{P}', name: '素数集' },
  { label: '\\mathbb{H}', insert: '\\mathbb{H}', name: '四元数' },
  { label: '\\mathbb{1}', insert: '\\mathbb{1}', name: '单位矩阵符号' },
  // 花体
  { label: '\\mathcal{A}', insert: '\\mathcal{A}', name: '花体 A' },
  { label: '\\mathcal{B}', insert: '\\mathcal{B}', name: '花体 B' },
  { label: '\\mathcal{L}', insert: '\\mathcal{L}', name: '花体 L' },
  { label: '\\mathcal{H}', insert: '\\mathcal{H}', name: '花体 H（希尔伯特空间）' },
  { label: '\\mathcal{F}', insert: '\\mathcal{F}', name: '花体 F（傅里叶）' },
  { label: '\\mathscr{A}', insert: '\\mathscr{A}', name: '手写体 A' },
  { label: '\\mathscr{B}', insert: '\\mathscr{B}', name: '手写体 B' },
  { label: '\\mathfrak{A}', insert: '\\mathfrak{A}', name: '哥特体 A' },
  { label: '\\mathfrak{g}', insert: '\\mathfrak{g}', name: '哥特体 g（李代数）' },
  // 粗体
  { label: '\\mathbf{a}', insert: '\\mathbf{}', name: '粗体' },
  { label: '\\boldsymbol{\\alpha}', insert: '\\boldsymbol{}', name: '粗体希腊' },
  // 量子力学 / 物理
  { label: '\\langle \\psi |', insert: '\\langle  |', name: '左矢（bra）' },
  { label: '| \\psi \\rangle', insert: '|  \\rangle', name: '右矢（ket）' },
  { label: '\\langle \\psi | \\phi \\rangle', insert: '\\langle  |  \\rangle', name: '内积' },
  { label: '| \\psi \\rangle \\langle \\phi |', insert: '|  \\rangle \\langle  |', name: '外积' },
  { label: '\\langle \\psi | \\hat{H} | \\psi \\rangle', insert: '\\langle  | \\hat{H} |  \\rangle', name: '期望值' },
  // 特殊常数
  { label: '\\pi', insert: '\\pi', name: '圆周率' },
  { label: '\\mathrm{e}', insert: '\\mathrm{e}', name: '自然常数 e' },
  { label: '\\infty', insert: '\\infty', name: '无穷' },
  { label: '\\emptyset', insert: '\\emptyset', name: '空集' },
  { label: '\\varnothing', insert: '\\varnothing', name: '空集（变体）' },
  { label: '\\top', insert: '\\top', name: '真 / 上' },
  { label: '\\bot', insert: '\\bot', name: '假 / 底' },
  // 逻辑/证明
  { label: '\\therefore', insert: '\\therefore', name: '所以' },
  { label: '\\because', insert: '\\because', name: '因为' },
  { label: '\\qquad', insert: '\\qquad', name: '大空格' },
  { label: '\\quad', insert: '\\quad', name: '中空格' },
  { label: '\\;', insert: '\\;', name: '小空格' },
  { label: '\\,', insert: '\\,', name: '极小空格' },
  { label: '\\!', insert: '\\!', name: '负空格' },
  // 装饰
  { label: '\\ boxed{a}', insert: '\\boxed{}', name: '方框' },
  { label: '\\ fcolorbox{red}{yellow}{a}', insert: '\\fcolorbox{}{}{}', name: '彩色方框' },
  { label: '\\ textcolor{red}{a}', insert: '\\textcolor{}{}', name: '彩色文字' },
]

/* ─────────────────────────────────────────────── */

export const MATH_SYMBOL_CATEGORIES: MathSymbolCategory[] = [
  { key: 'common', title: '常用', titleEn: 'Common', symbols: COMMON },
  { key: 'greek', title: '希腊字母', titleEn: 'Greek letters', symbols: GREEK },
  { key: 'operators', title: '运算符', titleEn: 'Binary operations', symbols: OPERATORS },
  { key: 'relations', title: '关系符', titleEn: 'Binary relations', symbols: RELATIONS },
  { key: 'arrows', title: '箭头', titleEn: 'Arrows', symbols: ARROWS },
  { key: 'brackets', title: '括号', titleEn: 'Brackets', symbols: BRACKETS },
  { key: 'functions', title: '函数', titleEn: 'Functions', symbols: FUNCTIONS },
  { key: 'integrals', title: '积分', titleEn: 'Integrals', symbols: INTEGRALS },
  { key: 'accents', title: '重音符', titleEn: 'Accents', symbols: ACCENTS },
  { key: 'matrices', title: '矩阵', titleEn: 'Matrices & arrays', symbols: MATRICES },
  { key: 'others', title: '其他', titleEn: 'Others', symbols: OTHERS },
]
