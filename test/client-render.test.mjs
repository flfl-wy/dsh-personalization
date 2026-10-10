/**
 * 设置页**渲染**测试。
 *
 * `test/client-bundle.test.mjs` 只验证注册与代理，从不执行 `PersonalizationSection`，
 * 于是「页面长什么样」完全没有覆盖 —— 而界面改动恰恰只动这一段。这里用装载体里的
 * 微型 React 运行时把页面真正挂起来，断言：
 *   - 结构：`h2.dsp-title` 标题、说明、带 `aria-label` 的编辑器、状态行、历史版本列表
 *   - 原语缺席时仍然渲染，退回兜底按钮
 *   - dirty 时回滚禁用、保存可用
 *   - 破坏性操作要行内二次确认，确认后真的发起了远程调用
 *   - 远程未就绪时整页提示且按钮全禁用
 *   - 样式只引用真实存在的 token、不留死样式类名
 *
 * **关于外观取值**：2026-10-10 用户看过「对齐原生」的改版后明确表示不好看，要求回滚到
 * 改造之前（`90bfb9d`）的样子。因此下面若干条断言刻意钉住的是**回滚后**的取值 ——
 * 24px 大标题、内容区 760px 居中、操作按钮用较小的 `sm`、绝对时间、写死的等宽字体栈。
 * 这些不是疏漏，是用户的选择；改之前先问，别「顺手修好」。
 *
 * 运行：`node --test test/`
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { clientPath, evaluateBundle, hostsOf, mountSection, textOf } from './helpers/client-bundle-harness.mjs'
import { DSH_ASAR_PATH } from './helpers/asar.mjs'
import { themeTokenNames } from './helpers/theme-tokens.mjs'

/** 一个历史版本，时间固定，体积固定为 1635 B。 */
const VERSION_ID = '20261010-104529'
const versionAt = () => Date.now() - 120_000

/**
 * 装好束并把历史版本列表替换成一条固定记录。
 * @returns `{ bundle, page }`：束上下文与渲染句柄。
 */
async function mountWithOneVersion(primitives) {
    const bundle = await evaluateBundle(primitives === undefined ? {} : { primitives })
    await bundle.exports.apply(bundle.ctx)
    const at = versionAt()
    bundle.namespace.listVersions = async () => ({
        ok: true,
        value: {
            dir: '/tmp',
            versions: [{ id: VERSION_ID, path: `/tmp/AGENTS.md.bak-${VERSION_ID}`, bytes: 1635, mtimeMs: at, at }],
        },
    })
    const page = await mountSection(bundle)
    return { bundle, page }
}

/** 取样式数组的源码片段，供静态检查用。 */
async function styleSource() {
    const source = await readFile(clientPath, 'utf8')
    const start = source.indexOf('const STYLE = [')
    const end = source.indexOf('].join("")', start)
    assert.ok(start !== -1 && end !== -1, '找不到 STYLE 数组')
    return { style: source.slice(start, end), rest: source.slice(0, start) + source.slice(end) }
}

test('设置页渲染出标题 / 说明 / 编辑器 / 状态行', async () => {
    const bundle = await evaluateBundle()
    await bundle.exports.apply(bundle.ctx)
    const page = await mountSection(bundle)

    const [title] = hostsOf(page.tree, 'h2')
    assert.equal(textOf(title), '个性化', '页面自绘标题（外壳的 header 只放 action 与关闭按钮）')
    assert.equal(title.props.className, 'dsp-title')

    const [intro] = hostsOf(page.tree, 'p')
    assert.match(textOf(intro), /AGENTS\.md/, '说明文案要讲清这个文件是什么')

    const [editor] = hostsOf(page.tree, 'textarea')
    assert.equal(editor.props['aria-label'], '全局 AGENTS.md 内容')
    assert.equal(editor.props.value, 'hi', '挂载后应载入文件内容')
    assert.equal(editor.props.disabled, false)

    // 元信息行：路径 + 字符数 + 修改时间；路径走 `code.dsp-path`。
    const [path] = hostsOf(page.tree, 'code')
    assert.equal(path.props.className, 'dsp-path')
    assert.equal(textOf(path), '/tmp/AGENTS.md')
    assert.match(textOf(page.tree), /2 字符/)
})

test('版本行显示绝对时间与原样字节数（回滚后的取值）', async () => {
    const { page } = await mountWithOneVersion()
    const at = versionAt()
    const text = textOf(page.tree)

    // 这一版用 formatTime() = toLocaleString()，不是原生的相对时间分桶。
    // 用同样的算法算期望值，避免测试依赖本机 locale。
    assert.ok(text.includes(new Date(at).toLocaleString()), `时间应由 formatTime 渲染，实际文本：${text}`)
    assert.doesNotMatch(text, /分钟前/, '这一版没有相对时间')
    assert.match(text, /1635 B/, '这一版直接显示字节原文，不走 fileSizeText')

    // id 走 `code.dsp-version-id`。
    const [id] = hostsOf(page.tree, 'code').filter((node) => node.props.className === 'dsp-version-id')
    assert.equal(textOf(id), VERSION_ID)

    const empty = hostsOf(page.tree, 'p').map(textOf)
    assert.ok(!empty.some((line) => /还没有历史版本/.test(line)), '有版本时不该显示空态')
})

test('按钮用抄进来的原生几何（dsp-btn + md / outline / primary）', async () => {
    const { page } = await mountWithOneVersion()
    const buttons = hostsOf(page.tree, 'button')
    assert.ok(buttons.length >= 4, `页面级与行级按钮都应渲染，实际 ${buttons.length}`)

    // 官方指南禁止 require Harness Client 包，所以 Button 是抄进来的（见 lib/client.js）。
    // 不传 size 即 dsp-btn--md：36px 高 / radius-md 12px / 14px 字 —— 与原生标准按钮同尺寸。
    for (const button of buttons) {
        assert.match(button.props.className, /(^| )dsp-btn( |$)/, '按钮要走抄进来的原生按钮')
        assert.match(button.props.className, /dsp-btn--md( |$)/, '默认 md，与原生标准按钮同尺寸')
        assert.equal(button.props.type, 'button', '与原生一样显式声明 type')
    }
    assert.ok(buttons.some((node) => /dsp-btn--primary/.test(node.props.className)), '保存 / 确认走 primary')
    assert.ok(buttons.some((node) => /dsp-btn--outline/.test(node.props.className)), '次级操作走 outline')
    assert.ok(buttons.some((node) => /dsp-danger/.test(node.props.className)), '删除按钮保留红字（唯一刻意偏离）')
})

test('只 require react，不 require 任何 Harness Client 包', async () => {
    // `dsh-agent-preset/skills/cordis-plugin-development/references/practices.md` 的 UI 段：
    // "Do not require('@deepseek-ai/dsh-client-ui-primitives') or load any other Harness
    //  Client package as a module" —— 它们会无预警变更，纯 JS 插件没有类型检查，
    //  一个抛错的组件会让整个 slot 条目变空白。原语要抄进来，不是引进来。
    const source = await readFile(clientPath, 'utf8')
    const required = [...new Set([...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]))]
    assert.deepEqual(required, ['react'], `插件只能 require react，实际：${required.join(', ')}`)
})

test('编辑器有未保存改动时状态转 dirty，回滚被禁用而保存可用', async () => {
    const { page } = await mountWithOneVersion()

    const [editor] = hostsOf(page.tree, 'textarea')
    editor.props.onChange({ target: { value: 'changed' } })
    await page.update()

    assert.match(textOf(page.tree), /未保存的改动/)
    const buttons = hostsOf(page.tree, 'button')
    const restore = buttons.find((node) => textOf(node).includes('回滚'))
    const save = buttons.find((node) => textOf(node).includes('保存'))
    assert.equal(restore.props.disabled, true, '回滚会重读文件，必须挡住未保存改动')
    assert.equal(save.props.disabled, false, '有改动时保存要可用')
    assert.match(textOf(page.tree), /保存或重新加载/, '提示里要说清怎么解除')
})

test('破坏性操作要行内二次确认，取消可退回', async () => {
    const { bundle, page } = await mountWithOneVersion()

    await page.press('删除')
    let labels = hostsOf(page.tree, 'button').map(textOf)
    assert.ok(labels.some((line) => line.includes('确认删除')), '第一次点击只应进入确认态')
    assert.ok(labels.some((line) => line.includes('取消')))
    assert.equal(
        bundle.records.calls.some((call) => call.method === 'deleteVersion'),
        false,
        '确认之前不得发起远程调用',
    )

    await page.press('取消')
    labels = hostsOf(page.tree, 'button').map(textOf)
    assert.ok(!labels.some((line) => line.includes('确认删除')), '取消后回到常规操作')

    await page.press('删除')
    await page.press('确认删除')
    const deleted = bundle.records.calls.filter((call) => call.method === 'deleteVersion')
    assert.equal(deleted.length, 1)
    assert.equal(deleted[0].payload.id, VERSION_ID, 'id 要原样传给宿主')
    assert.equal(hostsOf(page.tree, 'div').some((node) => node.props['data-toast'] === 'success'), true, '成功后给一次原生 Toast')
})

test('远程服务未就绪时整页提示，且所有按钮禁用', async () => {
    const bundle = await evaluateBundle({ mount: async () => { throw new Error('gateway offline') } })
    await bundle.exports.apply(bundle.ctx)
    const page = await mountSection(bundle)

    assert.match(textOf(page.tree), /远程服务未就绪/)
    const buttons = hostsOf(page.tree, 'button')
    assert.ok(buttons.length >= 3, '按钮仍要渲染出来，用户才知道有什么功能')
    for (const button of buttons) assert.equal(button.props.disabled, true, '离线时不该让用户点到无效操作')
})

test('样式只引用真实存在的设计 token', async (t) => {
    if (!fs.existsSync(DSH_ASAR_PATH)) {
        t.skip(`本机没有 DSH 安装包：${DSH_ASAR_PATH}`)
        return
    }
    const source = await readFile(clientPath, 'utf8')
    const declared = themeTokenNames()
    assert.ok(declared.size > 300, `权威 token 名单应远大于 300，实际 ${declared.size}`)

    const used = new Set([...source.matchAll(/var\((--dsw-[a-z0-9-]+|--ds-[a-z0-9-]+)/g)].map((match) => match[1]))
    // 回滚后的样式比改造版克制得多，只用到个位数 token。
    assert.ok(used.size >= 8, `束应使用 token，实际 ${used.size}`)
    const missing = [...used].filter((name) => !declared.has(name)).sort()
    assert.deepEqual(missing, [], `这些 token 在 @deepseek-ai/dsh-client-ui-theme 里不存在：${missing.join(', ')}`)
})

test('样式沿用回滚前的取值（用户要求的外观）', async () => {
    const { style } = await styleSource()

    // 页宽与居中：这一版自己把内容限制在 760px 并居中。
    // 外壳虽然已经给了左右 24px 内边距，但用户要的就是这个观感，不要再动。
    assert.match(style, /\.dsp-root\{[^}]*width:min\(100%,760px\)/)
    assert.match(style, /\.dsp-root\{[^}]*margin:0 auto/)
    assert.match(style, /\.dsp-title\{[^}]*font-size:24px/)

    // 等宽字体栈是写死的（没用 --ds-font-family-code），也是这一版的一部分。
    assert.match(style, /ui-monospace,SFMono-Regular,Menlo,monospace/)
    assert.doesNotMatch(style, /--ds-font-family-code/)

    // 编辑器与版本行的取值。
    assert.match(style, /\.dsp-editor\{[^}]*border:1px solid var\(--dsw-alias-border-l2\)/)
    assert.match(style, /\.dsp-editor\{[^}]*border-radius:12px/)
    assert.match(style, /\.dsp-version\{[^}]*border-radius:10px/)
    assert.match(style, /\.dsp-actions\{[^}]*gap:8px/)

    // 抄进来的按钮几何必须和原生 Button.module.css 逐值一致（md = 36px / radius-md）。
    assert.match(style, /\.dsp-btn\{[^}]*border-radius:var\(--dsw-radius-md\)/)
    assert.match(style, /\.dsp-btn\{[^}]*padding:0 14px/)
    assert.match(style, /\.dsp-btn--md\{height:36px\}/)
    assert.match(style, /\.dsp-btn--sm\{[^}]*height:28px/)
    assert.match(style, /\.dsp-btn--outline\{border:\.5px solid var\(--dsw-alias-border-l3\)/)
    assert.match(style, /\.dsp-btn--primary\{[^}]*var\(--dsw-alias-button-primary-fill\)/)
    assert.match(style, /\.dsp-btn:disabled\{[^}]*opacity:\.4\}/)

    // 唯一保留的底线：不写死颜色（颜色全部走 token，改主题才不会花）。
    assert.doesNotMatch(style, /#[0-9a-fA-F]{3,8}\b/, '不该出现写死的十六进制颜色')
    assert.doesNotMatch(style, /\brgba?\(|\bhsla?\(/, '不该出现写死的 rgb/hsl 颜色')
})

test('样式类名与渲染代码双向一致（没有死样式，也没有裸类名）', async () => {
    const { style, rest } = await styleSource()
    // 只要在**任何选择器位置**出现过就算已定义：`.dsp-btn--ghost` 和原生 `.ghost` 一样
    // 只有 `:hover` / `:active` 规则，没有紧跟 `{` 的基础规则。
    const defined = new Set([...style.matchAll(/\.(dsp-[a-z0-9-]+)/g)].map((match) => match[1]))
    assert.ok(defined.size >= 20, `样式类名数量异常：${defined.size}`)

    const dead = [...defined].filter((name) => !rest.includes(name)).sort()
    assert.deepEqual(dead, [], `定义了但没用到：${dead.join(', ')}`)

    // 只看类名：`--dsp-toast-hold` 这类自定义属性左边是 `-`，不算类名。
    const used = new Set([...rest.matchAll(/(?<!-)(dsp-[a-z0-9-]+)/g)].map((match) => match[1]))
    const naked = [...used].filter((name) => !defined.has(name)).sort()
    assert.deepEqual(naked, [], `用到但没有样式：${naked.join(', ')}`)
})
