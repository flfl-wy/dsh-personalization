/**
 * 客户端束的装载 harness：把 `lib/client.js` 当作浏览器里那样在隔离 vm 中求值。
 *
 * 由 `test/client-bundle.test.mjs` 与 `test/manifest-parity.test.mjs` 共用，
 * 避免两处各自维护一份假 `window.__ModuleLoader__`。
 *
 * 它还提供一个**微型 React 运行时**：束里的 `PersonalizationSection` 平时只被注册、
 * 从不执行，于是整段渲染代码（含原语缺席时的兜底）没有任何覆盖。`renderSection()`
 * 用这个运行时把设置页真正渲染出来，让「页面长什么样」也能被断言。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { assertMethodAvailable } from './gateway-reserved-names.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const clientPath = join(here, '..', '..', 'lib', 'client.js')

/**
 * 跨 vm realm 比较用：束里造出来的对象/数组来自另一个 realm，原型不同，
 * `deepStrictEqual` 会判为「结构相同但非同一引用」。过一遍 JSON 归一化。
 * @param value - 任意来自 vm 的值。
 * @returns 宿主 realm 的纯 JSON 副本。
 */
export const plain = (value) => JSON.parse(JSON.stringify(value))

/** 依赖数组浅比较，`useMemo` / `useEffect` 共用。 */
function sameDeps(a, b) {
    if (a === undefined || b === undefined) return false
    if (a.length !== b.length) return false
    return a.every((value, index) => Object.is(value, b[index]))
}

/** 把可能嵌套的 children 拉平成一维。 */
function flatten(value) {
    if (Array.isArray(value)) return value.flatMap((item) => flatten(item))
    return value === null || value === undefined || typeof value === 'boolean' ? [] : [value]
}

/**
 * 建一个够用的 React 运行时：函数组件、`useState` / `useMemo` / `useCallback` /
 * `useEffect`（带依赖比较）、以及「渲染 → 跑 effect → 等微任务 → 再渲染」的收敛循环。
 *
 * 简化之处（对这份束是安全的）：按**渲染顺序**给组件实例编号，因此有状态的组件
 * 顺序必须稳定；本束只有设置页本身有状态，它的子组件都是无状态的。
 *
 * @returns `{ React, render }`：可注入沙箱的 React 门面，与取最终树的 `render`。
 */
export function createReactRuntime() {
    let root = null
    let current = null
    let cursor = 0
    let instances = []
    let index = 0
    let dirty = false
    let pending = []

    const takeSlot = (create) => {
        const instance = current
        const slot = instance.hooks[cursor] ?? (instance.hooks[cursor] = create())
        cursor += 1
        return slot
    }

    const React = {
        // 真实 React 会把 `key` 摘出去、不留在 props 里，这里照做，避免「靠 props.key 拿到 key」这种写法被放过。
        createElement: (type, props, ...children) => {
            const { key, ...rest } = props ?? {}
            return { type, key, props: rest, children }
        },
        useState(initial) {
            const slot = takeSlot(() => ({ value: typeof initial === 'function' ? initial() : initial, set: null }))
            if (slot.set === null) {
                slot.set = (next) => {
                    slot.value = typeof next === 'function' ? next(slot.value) : next
                    dirty = true
                }
            }
            return [slot.value, slot.set]
        },
        useMemo(factory, deps) {
            const slot = takeSlot(() => ({ deps: undefined, value: undefined }))
            if (!sameDeps(slot.deps, deps)) {
                slot.deps = deps
                slot.value = factory()
            }
            return slot.value
        },
        useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
        useEffect(fn, deps) {
            const slot = takeSlot(() => ({ deps: undefined }))
            if (!sameDeps(slot.deps, deps)) {
                slot.deps = deps
                pending.push(fn)
            }
        },
    }

    /**
     * 渲染一个节点。
     * @param element - `createElement` 造出的元素、字符串、数组或空值。
     * @returns 供断言使用的归一化树。
     */
    function renderNode(element) {
        if (element === null || element === undefined || typeof element === 'boolean') return { type: 'empty' }
        if (typeof element === 'string' || typeof element === 'number') return { type: 'text', text: String(element) }
        if (Array.isArray(element)) return { type: 'fragment', children: element.map(renderNode) }

        const { type, props } = element
        const positional = flatten(element.children)
        const kids = positional.length > 0 ? positional : flatten(props.children)

        if (typeof type === 'function') {
            const instance = instances[index] ?? (instances[index] = { hooks: [] })
            index += 1
            const previous = current
            const previousCursor = cursor
            current = instance
            cursor = 0
            let produced
            try {
                produced = type({ ...props, children: kids.length === 1 ? kids[0] : kids })
            } finally {
                current = previous
                cursor = previousCursor
            }
            return { type: 'component', name: type.name || 'anonymous', node: renderNode(produced) }
        }

        return { type: 'host', tag: String(type), props, children: kids.map(renderNode) }
    }

    /** 渲染一轮；实例按渲染顺序复用，游标归零。 */
    function pass() {
        index = 0
        return renderNode(root)
    }

    /**
     * 渲染到稳定：反复「渲染 → 跑 effect → 等微任务」，直到没有新的状态变更。
     * @returns 稳定后的归一化树。
     */
    async function settle() {
        let tree = pass()
        for (let round = 0; round < 20; round++) {
            const effects = pending
            pending = []
            for (const effect of effects) effect()
            // 让已发出的 promise 链推进到下一次 setState。
            for (let turn = 0; turn < 12; turn++) await Promise.resolve()
            if (!dirty) break
            dirty = false
            tree = pass()
        }
        return tree
    }

    /**
     * 首次挂载。之后用 `update()` 重新渲染，实例（含 hooks 状态）会保留。
     * @param element - 根元素。
     * @returns 稳定后的归一化树。
     */
    function mount(element) {
        root = element
        instances = []
        dirty = false
        pending = []
        return settle()
    }

    /** 重新渲染并收敛，状态保留；用于驱动一次交互之后的变化。 */
    function update() {
        dirty = false
        return settle()
    }

    return { React, mount, update }
}

/**
 * 一个「大致像原生」的原语替身：形状与真实导出一致，但不带原生样式。
 * 用它可以断言束**真的去调了**这些原语（例如时间走了 `relativeTime`）。
 * @returns 原语替身对象。
 */
function nativeLikePrimitives(React) {
    const icon = (name) => function Icon({ size = 16 }) { return React.createElement('svg', { 'data-icon': name, width: size, height: size }) }
    return {
        Button: function Button({ variant, size, icon: leading, className, children, ...rest }) {
            return React.createElement('button', {
                'data-variant': variant,
                'data-size': size,
                className,
                disabled: rest.disabled,
                onClick: rest.onClick,
                children: [leading ?? null, children],
            })
        },
        Toast: function Toast({ text, tone }) { return React.createElement('div', { 'data-toast': tone }, text) },
        Tag: function Tag({ tone, className, children }) {
            return React.createElement('span', { 'data-tag': tone, className }, children)
        },
        PathLabel: function PathLabel({ path, className }) { return React.createElement('code', { className }, path) },
        relativeTime: (at, now) => {
            const diff = Math.max(0, now - at)
            if (diff < 60_000) return { unit: 'now', n: 0 }
            if (diff < 3_600_000) return { unit: 'minutes', n: Math.floor(diff / 60_000) }
            if (diff < 86_400_000) return { unit: 'hours', n: Math.floor(diff / 3_600_000) }
            return { unit: 'days', n: Math.floor(diff / 86_400_000) }
        },
        fileSizeText: (bytes) => (bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`),
        IconBrowseOutlineRegular: icon('browse'),
        IconUnarchiveOutlineRegular: icon('unarchive'),
        IconTrashOutlineRegular: icon('trash'),
        IconRefreshOutlineRegular: icon('refresh'),
    }
}

/**
 * 在隔离的 vm 上下文里求值客户端束，返回被注册的模块导出与观察记录。
 * @param options.mount - 可替换的 $mount 行为；给定值时命名空间不会被安装。
 * @param options.primitives - `'native'`（默认，用形状近似的替身）或 `'none'`（模拟原语缺席，走兜底）。
 * @returns 束导出、假上下文、slots/locale 调用记录、命名空间替身与 React 运行时。
 */
export async function evaluateBundle({ mount, primitives = 'native' } = {}) {
    const source = await readFile(clientPath, 'utf8')
    const records = { loaded: [], mounted: [], getKeys: [], dicts: [], slots: [], injections: [], calls: [] }
    const runtime = createReactRuntime()
    const React = runtime.React

    const seed = {
        'react': React,
        '@deepseek-ai/dsh-client-ui-primitives': primitives === 'none' ? {} : nativeLikePrimitives(React),
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
        save: async () => ({ ok: true, value: { path: '/tmp/AGENTS.md', bytes: 3, mtimeMs: 2, backupPath: null, backupId: null } }),
        listVersions: async () => ({ ok: true, value: { dir: '/tmp', versions: [] } }),
        readVersion: async (payload) => ({
            ok: true,
            value: { id: payload.id, path: `/tmp/AGENTS.md.bak-${payload.id}`, content: 'old', bytes: 3, mtimeMs: 1, at: 1 },
        }),
        restoreVersion: async (payload) => ({
            ok: true,
            value: {
                path: '/tmp/AGENTS.md',
                bytes: 3,
                mtimeMs: 4,
                backupPath: '/tmp/AGENTS.md.bak-20261010-090000',
                backupId: '20261010-090000',
                restoredFrom: payload.id,
                versionPath: `/tmp/AGENTS.md.bak-${payload.id}`,
            },
        }),
        deleteVersion: async (payload) => ({ ok: true, value: { id: payload.id, path: `/tmp/AGENTS.md.bak-${payload.id}` } }),
    }
    // 记录每个方法的调用入参，用来验证代理没有丢参数或改形状。
    for (const method of ['read', 'save', 'listVersions', 'readVersion', 'restoreVersion', 'deleteVersion']) {
        const original = namespace[method]
        namespace[method] = async (payload) => {
            records.calls.push({ method, payload })
            return original(payload)
        }
    }

    /**
     * 照着真实网关的挂载前校验走一遍：方法名不得撞命名空间服务自身成员、
     * 入参必须带 strict codec、同一命名空间不得重复声明同一方法。
     * 真网关这些检查任何一条不过都会**整组回滚**，所以这里也必须抛。
     * @param contribution - 客户端贡献（`CONTRIBUTION`）。
     */
    const validateContribution = (contribution) => {
        const seen = new Map()
        for (const descriptor of contribution.descriptors) {
            assertMethodAvailable(descriptor.namespace, descriptor.method)
            const methods = seen.get(descriptor.namespace) ?? new Set()
            if (methods.has(descriptor.method)) {
                throw new Error(`client api: contribution repeats direct method ${descriptor.namespace}/${descriptor.method}`)
            }
            methods.add(descriptor.method)
            seen.set(descriptor.namespace, methods)
            for (const parameter of descriptor.parameters) {
                if (parameter.codec?.mode !== 'strict') {
                    throw new Error(`client api: generated Remote ${descriptor.namespace}/${descriptor.method} field ${JSON.stringify(parameter.wire)} has no strict codec`)
                }
            }
        }
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
                        validateContribution(contribution)
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

    return { registration, exports, ctx, records, namespace, React, runtime }
}

/**
 * 真正把设置页挂起来，返回归一化树与驱动交互的句柄。
 *
 * 用注册时那条 `inject` 面作为 props（外壳就是这么喂的），再挂上 `settings.section`
 * 给一行 `close`。
 *
 * @param bundle - `evaluateBundle()` 的返回值。
 * @param overrides - 覆盖注入面的字段，例如伪造 `remoteError`。
 * @returns `{ tree, update, press }`：当前树、重新渲染、按文案点按钮。
 */
export async function mountSection(bundle, overrides = {}) {
    const { records, React, runtime } = bundle
    const entry = records.slots.find((item) => item?.options?.name === 'settings.section')
    assert.ok(entry !== undefined, '束必须注册 settings.section')
    const injected = entry.options.inject()
    const handle = { tree: null, update: null, press: null }
    handle.tree = await runtime.mount(React.createElement(entry.component, { ...injected, close() {}, ...overrides }))
    handle.update = async () => { handle.tree = await runtime.update(); return handle.tree }
    /**
     * 按文案点一个可点按钮，然后重新渲染。
     * @param label - 按钮文案（子串匹配）。
     * @returns 交互之后的树。
     */
    handle.press = async (label) => {
        const button = hostsOf(handle.tree, 'button')
            .find((node) => textOf(node).includes(label) && typeof node.props.onClick === 'function' && node.props.disabled !== true)
        assert.ok(button !== undefined, `找不到可点击的按钮：${label}`)
        button.props.onClick({ preventDefault() {}, stopPropagation() {} })
        return handle.update()
    }
    return handle
}

/** 收集树里所有宿主元素的标签名，便于断言结构。 */
export function tagsOf(tree) {
    const out = []
    const walk = (node) => {
        if (node?.type === 'host') {
            out.push(node.tag)
            node.children.forEach(walk)
            return
        }
        if (node?.node !== undefined) walk(node.node)
        if (node?.children !== undefined) node.children.forEach(walk)
    }
    walk(tree)
    return out
}

/** 收集树里所有文本（含叶子），拼成一整串，便于按内容断言。 */
export function textOf(tree) {
    const out = []
    const walk = (node) => {
        if (node?.type === 'text') { out.push(node.text); return }
        if (node?.type === 'host') { node.props?.value !== undefined && out.push(String(node.props.value)); node.children.forEach(walk); return }
        if (node?.node !== undefined) walk(node.node)
        if (node?.children !== undefined) node.children.forEach(walk)
    }
    walk(tree)
    return out.join(' ')
}

/** 按标签名找出所有宿主元素。 */
export function hostsOf(tree, tag) {
    const out = []
    const walk = (node) => {
        if (node?.type === 'host') {
            if (node.tag === tag) out.push(node)
            node.children.forEach(walk)
            return
        }
        if (node?.node !== undefined) walk(node.node)
        if (node?.children !== undefined) node.children.forEach(walk)
    }
    walk(tree)
    return out
}
