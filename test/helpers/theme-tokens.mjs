/**
 * 原生设计 token 的**权威名单**，取自 DSH 自带的主题包：
 *
 *   dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js
 *
 * 里面 `base_css_default` 等字符串常量定义了全部 `--dsw-*` / `--ds-*` token。
 *
 * 为什么需要它：写错一个 token 名（例如 `--dsw-alias-label-quaternary`）在 CSS 里
 * **不报错**，`var()` 只是静默失效，颜色/字号退回继承值 —— 界面照样渲染，只是不对。
 * 束自带样式全靠 token，所以「用到的 token 必须真实存在」必须是一条可验证的约束。
 *
 * 注意主题包里的 CSS 是 **JS 字符串字面量**，字体名带转义引号（`\"Segoe UI\"`），
 * 简单的 `"[^"]*"` 正则会在这里截断、漏掉大量 token，所以必须按 JS 字符串规则扫描。
 */

import { DSH_ASAR_PATH, openAsar } from './asar.mjs'

/** 权威 token 定义所在的包内路径。 */
export const THEME_CLIENT_PATH = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'

/**
 * 扫出源码里所有 JS 双引号字符串字面量（正确跳过 `\"` 转义），只保留像 CSS 的那些。
 * @param source - 主题包源码。
 * @returns 拼接后的 CSS 文本。
 */
function cssLiteralsOf(source) {
    const out = []
    for (let i = 0; i < source.length; i += 1) {
        if (source[i] !== '"') continue
        let j = i + 1
        while (j < source.length) {
            if (source[j] === '\\') { j += 2; continue }
            if (source[j] === '"') break
            j += 1
        }
        const raw = source.slice(i + 1, j)
        i = j
        if (raw.includes('{') && raw.includes('--dsw-')) out.push(raw)
    }
    return out.join('\n')
}

/**
 * 取出权威 token 名单。
 * @param archive - `app.asar` 路径。
 * @returns 已定义的 token 名集合（含 `--` 前缀）。
 */
export function themeTokenNames(archive = DSH_ASAR_PATH) {
    const asar = openAsar(archive)
    try {
        const css = cssLiteralsOf(asar.read(THEME_CLIENT_PATH))
        const names = new Set()
        // 只认「定义」：`--token:value`。用法是 `var(--token)`，后面没有冒号，正好排除。
        for (const match of css.matchAll(/(--dsw-[a-z0-9-]+|--ds-[a-z0-9-]+)\s*:/g)) names.add(match[1])
        return names
    } finally {
        asar.close()
    }
}
