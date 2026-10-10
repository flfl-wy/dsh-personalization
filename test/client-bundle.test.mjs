/**
 * 客户端束的形状与注册测试。
 *
 * 用一个假的 `window.__ModuleLoader__` + 假的 require 把 `lib/client.js` 当作
 * 浏览器里那样求值，验证：
 *   - 只注册 factory、导出 `apply` / `inject`
 *   - `apply` 注册字典、$mount 消费者贡献、把设置页注册进 settings.section
 *   - `inject` 面拿到的 read/save 引用稳定（否则 React 依赖会无限重跑）
 *   - $mount 失败时降级为页面内的错误提示而不是整块崩掉
 *
 * 运行：`node --test test/`
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

/**
 * 在隔离的 vm 上下文里求值客户端束，返回被注册的模块导出与观察记录。
 * @param options.mount - 可替换的 $mount 行为。
 * @returns 束导出、假上下文、以及 slots/locale 的调用记录。
 */
async function evaluateBundle({ mount } = {}) {
    const source = await readFile(clientPath, 'utf8')
    const records = { loaded: [], mounted: [], getKeys: [], dicts: [], slots: [], injections: [] }

    const seed = {
        'react': {
            createElement: (...args) => ({ type: args[0], props: args[1] ?? {}, children: args.slice(2) }),
            useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
            useCallback: (fn) => fn,
            useEffect: () => {},
        },
        '@deepseek-ai/dsh-client-ui-primitives': {
            Button: function Button() { return null },
            Toast: function Toast() { return null },
        },
    }

    const head = { children: [], appendChild(node) { this.children.push(node) } }
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        Date,
        JSON,
        Error,
        Node: class Node {},
        document: {
            head,
            createElement: (tag) => ({ tag, dataset: {}, textContent: '', remove() {} }),
            querySelector: () => null,
        },
        window: {
            __ModuleLoader__: {
                load(registration) { records.loaded.push(registration) },
            },
        },
    }
    sandbox.window.document = sandbox.document
    const context = vm.createContext(sandbox)
    vm.runInContext(source, context, { filename: clientPath })

    assert.equal(records.loaded.length, 1, 'client.js 必须恰好注册一个模块')
    const registration = records.loaded[0]
    const exports = registration.factory((specifier) => {
        if (seed[specifier] === undefined) throw new Error(`unexpected require(${specifier})`)
        return seed[specifier]
    })

    const namespace = {
        read: async () => ({ ok: true, value: { path: '/tmp/AGENTS.md', exists: true, content: 'hi', bytes: 2, mtimeMs: 1 } }),
        save: async () => ({ ok: true, value: { path: '/tmp/AGENTS.md', bytes: 3, mtimeMs: 2, backupPath: null } }),
    }
    // 命名空间服务由挂载过程安装：默认 mount 会装上，替换 mount（例如失败用例）则没有。
    let namespaceInstalled = mount === undefined
    const ctx = {
        effect(callback, label) { records.injections.push({ label, dispose: callback() }) },
        locale: {
            register(ns, dicts) { records.dicts.push({ ns, dicts }) },
            bind(ns) { return (key) => records.dicts.find((entry) => entry.ns === ns)?.dicts.zh[key] ?? key },
        },
        get(key) {
            records.getKeys.push(key)
            // 真实的 api-gateway 把命名空间注册成名为 `remote.<namespace>` 的 Cordis 服务
            // （`remoteServiceKey`），而不是 remote 对象上的同名属性 —— 严格照此仿真，
            // 否则「在 remote 上找属性」这种错误写法会被测试放过。
            if (key === 'remote') {
                return {
                    $mount: mount ?? (async (contribution) => {
                        records.mounted.push(contribution)
                        namespaceInstalled = true
                        return () => {}
                    }),
                }
            }
            if (key === 'remote.personalization') return namespaceInstalled ? namespace : undefined
            return undefined
        },
        slots: {
            inject(name, register) { records.slots.push({ name }); return register() },
            register(options, component) { records.slots.push({ options, component }); return () => {} },
        },
    }

    return { registration, exports, ctx, records, namespace }
}

test('束导出 apply / inject，且 inject 是宿主服务键数组', async () => {
    const { registration, exports } = await evaluateBundle()
    assert.equal(registration.id, 'dsh-personalization')
    assert.equal(typeof exports.apply, 'function')
    assert.deepEqual([...exports.inject], ['slots', 'locale', 'remote'])
})

test('apply 注册字典、挂载贡献并注册 settings.section', async () => {
    const { exports, ctx, records } = await evaluateBundle()
    const dispose = await exports.apply(ctx)

    assert.equal(records.dicts.length, 1)
    assert.equal(records.dicts[0].ns, 'dsh-personalization')
    assert.deepEqual(Object.keys(records.dicts[0].dicts).sort(), ['en', 'zh'])
    for (const dict of Object.values(records.dicts[0].dicts)) {
        for (const [key, value] of Object.entries(dict)) {
            assert.equal(typeof value, 'string', `${key} 必须是字符串，locale 字典不接受函数`)
        }
    }

    const section = records.slots.find((entry) => entry.options !== undefined)
    assert.ok(section !== undefined, '必须注册一个插槽条目')
    assert.equal(section.options.name, 'settings.section')
    assert.equal(section.options.id, 'personalization')
    assert.equal(section.options.order, 25)
    assert.equal(section.options.locale, 'dsh-personalization')
    assert.equal(section.options.label(), '个性化', 'label 是 thunk，读出来应是当前语言的标题')
    assert.equal(typeof section.component, 'function', '条目必须带一个组件')

    const injected = section.options.inject()
    assert.equal(typeof injected.t, 'function')
    assert.equal(typeof injected.read, 'function')
    assert.equal(typeof injected.save, 'function')
    assert.equal(injected.remoteError, null)

    assert.equal(records.injections.length, 2, '字典与样式各一个 effect（manifest 在宿主半区）')
    assert.equal(typeof dispose, 'function', 'apply 必须返回卸载函数')
})

test('inject 面拿到的 read / save 引用在多次读取间保持稳定', async () => {
    const { exports, ctx, records } = await evaluateBundle()
    await exports.apply(ctx)
    const section = records.slots.find((entry) => entry.options !== undefined)

    const first = section.options.inject()
    const second = section.options.inject()
    assert.equal(first.read, second.read, 'read 每次新建会让组件的 useCallback 依赖失效')
    assert.equal(first.save, second.save, 'save 同理')
    assert.equal(first.t, second.t)
})

test('read / save 代理到远程命名空间', async () => {
    const { exports, ctx, records } = await evaluateBundle()
    await exports.apply(ctx)
    const section = records.slots.find((entry) => entry.options !== undefined)
    const injected = section.options.inject()

    const readResult = await injected.read()
    assert.equal(readResult.ok, true)
    assert.equal(readResult.value.path, '/tmp/AGENTS.md')

    const saveResult = await injected.save({ content: 'new' })
    assert.equal(saveResult.ok, true)
    assert.equal(saveResult.value.backupPath, null)
})

test('命名空间走 ctx.get("remote.<name>")，而不是 remote 上的同名属性', async () => {
    // 回归测试：早先写成 remote[SERVICE_KEY]，而 api-gateway 实际把命名空间注册成
    // 名为 `remote.personalization` 的服务（见 remoteServiceKey），于是永远取到
    // undefined，页面只显示「远程服务未就绪」。
    const { exports, ctx, records } = await evaluateBundle()
    await exports.apply(ctx)

    assert.equal(records.mounted.length, 1, '$mount 必须被调用一次')
    assert.equal(records.mounted[0].package, 'dsh-personalization')
    assert.ok(
        records.getKeys.includes('remote.personalization'),
        `必须按服务键取命名空间，实际请求过：${JSON.stringify(records.getKeys)}`,
    )
    assert.equal(
        ctx.get('remote').personalization,
        undefined,
        '假远程对象上不该有同名属性，否则这个回归测试形同虚设',
    )

    // 每次调用都重新取服务：模拟连接重置后旧引用失效，重新 get 仍应拿到可用服务。
    const section = records.slots.find((entry) => entry.options !== undefined)
    const injected = section.options.inject()
    const before = records.getKeys.filter((key) => key === 'remote.personalization').length
    await injected.read()
    await injected.save({ content: 'x' })
    const after = records.getKeys.filter((key) => key === 'remote.personalization').length
    assert.equal(after - before, 2, 'read 与 save 各自重新取一次命名空间服务')
})

test('$mount 失败时降级为页面内错误，而不是抛穿', async () => {
    const { exports, ctx, records } = await evaluateBundle({
        mount: async () => { throw new Error('gateway offline') },
    })
    await exports.apply(ctx)

    const section = records.slots.find((entry) => entry.options !== undefined)
    assert.ok(section !== undefined, '即使挂载失败也必须注册设置页，否则用户看不到任何提示')
    const injected = section.options.inject()
    assert.equal(injected.remoteError, 'gateway offline')
    await assert.rejects(() => injected.read(), /远程服务未就绪|not ready/)
})
