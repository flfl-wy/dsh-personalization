/**
 * 设置页**渲染**测试。
 *
 * `test/client-bundle.test.mjs` 只验证注册与代理，从不执行 `PersonalizationSection`，
 * 于是「页面长什么样」完全没有覆盖 —— 而界面改造恰恰只动这一段。这里用装载体里的
 * 微型 React 运行时把页面真正挂起来，断言：
 *   - 原生结构：18px/600 标题（`h2.dsp-title`）、说明、带 `aria-label` 的编辑器、状态行
 *   - 原生原语确实被调用：时间走 `relativeTime`、体积走 `fileSizeText`、id 走 `Tag`
 *   - 原语整个缺席时仍然渲染，退回兜底文案与 `<button>`
 *   - dirty 时回滚禁用、保存可用
 *   - 破坏性操作要行内二次确认，确认后真的发起了远程调用
 *   - 远程未就绪时整页提示且按钮全禁用
 *   - 样式只引用真实存在的 token、不写死颜色、不留死样式类名
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

/** 一个历史版本，时间固定为「2 分钟前」，体积固定为 1635 B（-> 1.6KB）。 */
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

    // 元信息行：路径 + 字符数 + 修改时间，且路径走原生 PathLabel（替身渲染成 <code>）。
    const [path] = hostsOf(page.tree, 'code')
    assert.equal(textOf(path), '/tmp/AGENTS.md')
    assert.match(textOf(page.tree), /2 字符/)
})

test('版本行的相对时间与体积走原生原语', async () => {
    const { page } = await mountWithOneVersion()

    const text = textOf(page.tree)
    assert.match(text, /2 分钟前/, '时间应由原生 relativeTime 分桶、文案由本地字典补齐')
    assert.match(text, /1\.6KB/, '体积应由原生 fileSizeText 渲染')
    assert.match(text, new RegExp(VERSION_ID))

    // id 走原生 Tag（真实 Tag 挂的是 data-tone），不是裸 <code>。
    const idTags = hostsOf(page.tree, 'span').filter((node) => node.props['data-tone'] === 'outline')
    assert.equal(idTags.length, 1)
    assert.equal(textOf(idTags[0]), VERSION_ID)

    const empty = hostsOf(page.tree, 'p').map(textOf)
    assert.ok(!empty.some((line) => /还没有历史版本/.test(line)), '有版本时不该显示空态')
})

test('按钮走原生 Button 的默认尺寸，且不额外挂图标', async () => {
    const { page } = await mountWithOneVersion()
    const buttons = hostsOf(page.tree, 'button')
    assert.ok(buttons.length >= 4, `页面级与行级按钮都应渲染，实际 ${buttons.length}`)

    // 原生设置页的操作按钮是 .md（36px / radius-md / 14px），传 size 就会退化成 .sm（28px / radius-sm / 12px）。
    // 原生「查询用量 / 充值」那一行也不带图标，所以不传 icon。
    for (const button of buttons) {
        assert.equal(button.props['data-size'], undefined, '不应传 size，否则偏离原生标准 Button 尺寸')
        assert.equal(button.props['data-has-icon'], undefined, '原生设置页操作行是纯文字按钮')
    }
    assert.ok(buttons.some((node) => node.props['data-variant'] === 'primary'), '保存 / 确认走 primary')
    assert.ok(buttons.some((node) => node.props['data-variant'] === 'outline'), '次级操作走 outline')
})

test('原语整个缺席时整页仍能渲染，并退回兜底文案', async () => {
    const { page } = await mountWithOneVersion('none')

    const text = textOf(page.tree)
    assert.match(text, /个性化/, '标题要在')
    assert.match(text, /1635 B/, 'fileSizeText 缺席时退回字节原文')
    assert.ok(!/分钟前/.test(text), 'relativeTime 缺席时不该出现相对时间文案')
    const buttons = hostsOf(page.tree, 'button')
    assert.ok(buttons.length >= 3, '兜底 Button 仍然渲染成 <button>')
    assert.ok(buttons.some((node) => node.props['data-variant'] === 'outline') &&
        buttons.some((node) => node.props['data-variant'] === 'primary'), '兜底按钮保留 variant 语义')

    const fallbackTag = hostsOf(page.tree, 'span').find((node) => node.props['data-tone'] === 'outline')
    assert.ok(fallbackTag !== undefined && textOf(fallbackTag) === VERSION_ID, '兜底 Tag 保留 data-tone 与内容')
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
    assert.ok(used.size >= 20, `束应大量使用 token，实际 ${used.size}`)
    const missing = [...used].filter((name) => !declared.has(name)).sort()
    assert.deepEqual(missing, [], `这些 token 在 @deepseek-ai/dsh-client-ui-theme 里不存在：${missing.join(', ')}`)
})

test('样式不写死颜色与字体栈，也不再重复外壳的内边距', async () => {
    const { style } = await styleSource()
    assert.doesNotMatch(style, /#[0-9a-fA-F]{3,8}\b/, '不该出现写死的十六进制颜色')
    assert.doesNotMatch(style, /\brgba?\(|\bhsla?\(/, '不该出现写死的 rgb/hsl 颜色')
    assert.doesNotMatch(style, /ui-monospace|SFMono|Menlo|Monaco|Consolas/, '代码字体必须走 --ds-font-family-code')
    assert.match(style, /--ds-font-family-code/)
    assert.match(style, /max-width:720px/, '页宽与原生设置页一致')
    assert.doesNotMatch(style, /margin:\s*0\s+auto/, '外壳已经是带内边距的列容器，无需自己居中')
    assert.doesNotMatch(style, /padding:\s*0\s+24px/, '外壳已给了左右 24px，重复加会变成 48px')
})

test('样式类名与渲染代码双向一致（没有死样式，也没有裸类名）', async () => {
    const { style, rest } = await styleSource()
    const defined = new Set([...style.matchAll(/\.(dsp-[a-z0-9-]+)\{/g)].map((match) => match[1]))
    assert.ok(defined.size >= 20, `样式类名数量异常：${defined.size}`)

    const dead = [...defined].filter((name) => !rest.includes(name)).sort()
    assert.deepEqual(dead, [], `定义了但没用到：${dead.join(', ')}`)

    const used = new Set([...rest.matchAll(/(dsp-[a-z0-9-]+)/g)].map((match) => match[1]))
    const naked = [...used].filter((name) => !defined.has(name)).sort()
    assert.deepEqual(naked, [], `用到但没有样式：${naked.join(', ')}`)
})

test('样式采用的尺寸与原生 Button / 设置卡片规范逐项一致', async () => {
    const { style } = await styleSource()

    // 原生 .card（dsh-client-ui-settings-account）：
    //   border:.5px solid var(--dsw-alias-settings-card-stroke); border-radius:var(--dsw-radius-xl);
    //   background:var(--dsw-alias-settings-card-fill); padding:12px 16px
    assert.match(style, /\.dsp-version\{[^}]*border:\.5px solid var\(--dsw-alias-settings-card-stroke\)/)
    assert.match(style, /\.dsp-version\{[^}]*border-radius:var\(--dsw-radius-xl\)/)
    assert.match(style, /\.dsp-version\{[^}]*var\(--dsw-alias-settings-card-fill\)/)
    assert.match(style, /\.dsp-version\{[^}]*padding:12px 16px/)

    // 原生 .links{gap:10px}（操作组内间距）
    assert.match(style, /\.dsp-actions\{[^}]*gap:10px/)

    // 原生 .divider{border-top:.5px solid var(--dsw-alias-border-l2)}
    assert.match(style, /\.dsp-group\{[^}]*border-top:\.5px solid var\(--dsw-alias-border-l2\)/)

    // 输入控件照 Input.module.css：.5px 发丝边 + radius-md + bg-layer-1
    assert.match(style, /\.dsp-editor\{[^}]*border:\.5px solid var\(--dsw-alias-border-l4\)/)
    assert.match(style, /\.dsp-editor\{[^}]*border-radius:var\(--dsw-radius-md\)/)
    assert.match(style, /\.dsp-editor\{[^}]*var\(--dsw-alias-bg-layer-1\)/)

    // 原生页面：标题 18px/600，页宽 720px（agent-preset 的 .section / .title）
    assert.match(style, /\.dsp-title\{[^}]*font-size:18px/)
    assert.match(style, /\.dsp-title\{[^}]*font-weight:600/)
})
