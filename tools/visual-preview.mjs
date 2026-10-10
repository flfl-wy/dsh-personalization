#!/usr/bin/env node
/**
 * 静态视觉预览：不开 DSH，也能看到设置页长什么样。
 *
 * 为什么要有这个工具：`npm test` 只能断言结构、原语调用和 token 是否存在 ——
 * 「按钮是不是原生那个尺寸」这类问题它答不了。本插件曾经在全部测试通过的情况下
 * 把原生 36px 的 `Button` 传成了 `size="sm"`（28px / radius-sm / 12px 字），
 * 屏幕上和原生一眼就不一致，而测试全绿。**样式对不对最终是像素问题。**
 *
 * 做法：把真实渲染树序列化成 HTML，配上**运行时的真实 CSS**——
 *   - 主题包的 408 个 `:root` token（`theme-tokens.mjs`）
 *   - primitives 真实的 `Button.module.css` / `Tag.module.css` / `Input.module.css`
 *   - 原生设置页参照物 `dsh-client-ui-settings-account` 的 `.linkButton`（≡ `Button size=md`）
 *   - 本束自己的 `.dsp-*`（从 `lib/client.js` 现取，不会和实现漂移）
 * 然后用无头 Chromium 截图。
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

/** 原生设置页里那段 `.linkButton` 的 CSS 所在（用作对照物）。 */
const ACCOUNT_CLIENT_PATH = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js'
const PRIMITIVE_CSS = {
    button: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/Button.module.css',
    tag: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/Tag.module.css',
    input: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/Input.module.css',
}

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

/** 从 asar 里取出一段 CSS：优先整文件，否则在客户端束里按标记找字面量。 */
function readCss(asar, path, marker) {
    if (!marker) return asar.read(path)
    const literal = jsStringLiterals(asar.read(path)).find((text) => text.includes(marker))
    if (literal === undefined) throw new Error(`${path} 里没找到含 ${marker} 的 CSS`)
    return literal
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
        button: readCss(asar, PRIMITIVE_CSS.button),
        tag: readCss(asar, PRIMITIVE_CSS.tag),
        input: readCss(asar, PRIMITIVE_CSS.input),
        account: readCss(asar, ACCOUNT_CLIENT_PATH, '.B10aXW_section{'),
        bundle: bundleStyle(),
    }

    const bundle = await evaluateBundle()
    await bundle.exports.apply(bundle.ctx)
    seedVersions(bundle)
    const page = await mountSection(bundle)

    // 从渲染树里截出「状态行 + 按钮」与历史版本组，作为本实现的对照条。
    const panel = toHtml(page.tree)
    const from = panel.indexOf('<div class="dsp-bar">')
    const to = panel.indexOf('</section>')
    const mine = from >= 0 && to > from ? `${panel.slice(from, to)}</section>` : panel

    html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
${css.tokens}
*{box-sizing:border-box;}
body{margin:0;padding:24px 0;background:var(--dsw-alias-bg-base);font:14px/22px -apple-system,"PingFang SC",sans-serif;color:var(--dsw-alias-label-primary);}
.caption{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0 0 12px;}
.frame{padding:0 24px;}
hr{border:none;border-top:.5px solid var(--dsw-alias-border-l2);margin:26px 24px;}
</style>
<style>${css.button}</style><style>${css.tag}</style><style>${css.account}</style><style>${css.bundle}</style>
</head><body>
<div><p class="caption">① 原生参照物 dsh-client-ui-settings-account —— .linkButton 与 Button size=md 同尺寸</p>
<div class="frame"><div class="B10aXW_section"><div class="B10aXW_card"><div class="B10aXW_row">
  <span class="B10aXW_secondary">更多</span>
  <div class="B10aXW_links"><a class="B10aXW_linkButton">查询用量</a><a class="B10aXW_linkButton B10aXW_primary">充值</a></div>
</div></div></div></div></div>
<hr>
<div><p class="caption">② 个性化页（本实现的真实渲染树）</p>
<div class="frame"><div class="dsp-root">${mine}</div></div></div>
</body></html>`
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
    '--window-size=780,640',
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
