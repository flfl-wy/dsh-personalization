#!/usr/bin/env node
/**
 * 静态视觉预览：不开 DSH，也能看到设置页长什么样。
 *
 * 为什么要有这个工具：`npm test` 只能断言结构、原语调用和 token 是否存在 ——
 * 「按钮是不是原生那个尺寸」这类问题它答不了。本插件曾经在全部测试通过的情况下
 * 把原生 36px 的 `Button` 传成了 `size="sm"`（28px / radius-sm / 12px 字），
 * 屏幕上和原生一眼就不一致，而测试全绿。**样式对不对最终是像素问题。**
 *
 * 做法：把真实渲染树序列化成 HTML，配上——
 *   - 主题包的 408 个 `:root` token（`theme-tokens.mjs`）
 *   - 本束自己的 `.dsp-*`（从 `lib/client.js` 现取，不会和实现漂移）
 * 然后用无头 Chromium 截图。
 *
 * **故意不注入 primitives 的 CSS**：插件按官方指南自带了按钮/提示样式
 * （不 require Harness Client 包），所以这里若再喂原语的 CSS 就会掩盖「自己没写样式」
 * 这个错误 —— 少写一条规则，预览里就会露出浏览器默认按钮的样子。
 *
 * **必须在 DPR 2 下截图**：原生大量使用 `0.5px` 发丝边，1x 下会渲染成 0 像素，
 * 看起来「边框全丢了」，会得出错误结论。
 *
 * 用法：
 *   node tools/visual-preview.mjs            # 只生成 HTML，并打印截图命令
 *   node tools/visual-preview.mjs --shoot    # 顺带调用本机 Chromium 截图
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DSH_ASAR_PATH, openAsar } from '../test/helpers/asar.mjs'
import { themeTokenCss } from '../test/helpers/theme-tokens.mjs'
import { evaluateBundle, mountSection } from '../test/helpers/client-bundle-harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'tools', 'preview')

/** 本机 Chromium 内核浏览器（macOS 上一定有其一）。 */
const CHROMIUM_CANDIDATES = [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]


/** 在 JS 源码里扫出双引号字符串字面量（正确跳过 `\"`）。 */
function jsStringLiterals(source) {
    const out = []
    for (let i = 0; i < source.length; i += 1) {
        if (source[i] !== '"') continue
        let j = i + 1
        while (j < source.length) {
            if (source[j] === '\\') { j += 2; continue }
            if (source[j] === '"') break
            j += 1
        }
        out.push(source.slice(i + 1, j))
        i = j
    }
    return out
}

/** 现取本束的 `.dsp-*` 样式，保证预览不落后于实现。 */
function bundleStyle() {
    const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
    const start = source.indexOf('const STYLE = [')
    const end = source.indexOf('].join("")', start)
    if (start < 0 || end < 0) throw new Error('没找到 lib/client.js 里的 STYLE 数组')
    const chunk = source.slice(source.indexOf('[', start), end + 1)
    return jsStringLiterals(chunk)
        .map((literal) => JSON.parse(`"${literal}"`))
        .join('')
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input'])
const escapeText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 把 harness 的归一化渲染树序列化成 HTML。 */
function toHtml(node) {
    if (node === null || node === undefined) return ''
    if (node.type === 'empty') return ''
    if (node.type === 'text') return escapeText(node.text)
    if (node.type === 'fragment') return (node.children ?? []).map(toHtml).join('')
    if (node.type === 'component') return toHtml(node.node)

    const attrs = []
    for (const [key, value] of Object.entries(node.props ?? {})) {
        if (value === undefined || value === null || typeof value === 'function') continue
        if (typeof value === 'boolean') { if (value) attrs.push(` ${key}`); continue }
        if (key === 'children') continue
        const name = key === 'className' ? 'class' : key
        attrs.push(` ${name}="${String(value).replace(/"/g, '&quot;')}"`)
    }
    const open = `<${node.tag}${attrs.join('')}>`
    if (VOID_TAGS.has(node.tag)) return open
    if (node.tag === 'textarea') return `${open}${escapeText(String(node.props.value ?? ''))}</textarea>`
    return `${open}${node.children.map(toHtml).join('')}</${node.tag}>`
}

/** 造两条历史版本，让版本行与操作按钮都出现在预览里。 */
function seedVersions(bundle) {
    const now = Date.now()
    bundle.namespace.listVersions = async () => ({
        ok: true,
        value: {
            dir: '/tmp',
            versions: [
                { id: '20261010-104529', path: '/tmp/AGENTS.md.bak-20261010-104529', bytes: 1635, mtimeMs: now - 43 * 60_000, at: now - 43 * 60_000 },
                { id: '20261010-085310', path: '/tmp/AGENTS.md.bak-20261010-085310', bytes: 1089, mtimeMs: now - 3 * 86_400_000, at: now - 3 * 86_400_000 },
            ],
        },
    })
}

const asar = openAsar(DSH_ASAR_PATH)
let html
try {
    const css = {
        tokens: themeTokenCss(DSH_ASAR_PATH),
        bundle: bundleStyle(),
    }

    const bundle = await evaluateBundle()
    await bundle.exports.apply(bundle.ctx)
    seedVersions(bundle)
    const page = await mountSection(bundle)

    html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
${css.tokens}
*{box-sizing:border-box;}
body{margin:0;background:var(--dsw-alias-bg-base);font:14px/22px -apple-system,"PingFang SC",sans-serif;color:var(--dsw-alias-label-primary);}
/* 复刻外壳的 section 容器：.Dws9Sa_options{padding:0 24px 24px;overflow-y:auto} */
.options{padding:0 24px 24px;}
</style>
<style>${css.bundle}</style>
</head><body><div class="options">${toHtml(page.tree)}</div></body></html>`
} finally {
    asar.close()
}

mkdirSync(OUT, { recursive: true })
const htmlPath = join(OUT, 'panel.html')
writeFileSync(htmlPath, html)
console.log(`已生成 ${htmlPath}（${html.length} bytes）`)

const browser = CHROMIUM_CANDIDATES.find((path) => existsSync(path))
const shotPath = join(OUT, 'panel.png')
const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--force-device-scale-factor=2', // 0.5px 发丝边在 1x 下会消失
    `--user-data-dir=${join(OUT, 'browser-profile')}`,
    '--window-size=780,1080',
    `--screenshot=${shotPath}`,
    `file://${htmlPath}`,
]

if (process.argv.includes('--shoot')) {
    if (browser === undefined) {
        console.error('没找到 Chromium 内核浏览器，无法截图。可用命令：')
        console.error(`  "${CHROMIUM_CANDIDATES[0]}" ${args.join(' ')}`)
        process.exit(1)
    }
    execFileSync(browser, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    console.log(`已截图 ${shotPath}`)
} else if (browser !== undefined) {
    console.log('截图命令（--shoot 可直接执行）：')
    console.log(`  "${browser}" ${args.join(' ')}`)
} else {
    console.log('没找到 Chromium 内核浏览器；HTML 已生成，可用任意浏览器打开。')
}
