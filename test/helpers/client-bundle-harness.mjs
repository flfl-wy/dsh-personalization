/**
 * 客户端束的装载 harness：把 `lib/client.js` 当作浏览器里那样在隔离 vm 中求值。
 *
 * 由 `test/client-bundle.test.mjs` 与 `test/manifest-parity.test.mjs` 共用，
 * 避免两处各自维护一份假 `window.__ModuleLoader__`。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
export const clientPath = join(here, '..', '..', 'lib', 'client.js')

/**
 * 跨 vm realm 比较用：束里造出来的对象/数组来自另一个 realm，原型不同，
 * `deepStrictEqual` 会判为「结构相同但非同一引用」。过一遍 JSON 归一化。
 * @param value - 任意来自 vm 的值。
 * @returns 宿主 realm 的纯 JSON 副本。
 */
export const plain = (value) => JSON.parse(JSON.stringify(value))

/**
 * 在隔离的 vm 上下文里求值客户端束，返回被注册的模块导出与观察记录。
 * @param options.mount - 可替换的 $mount 行为；给定值时命名空间不会被安装。
 * @returns 束导出、假上下文、以及 slots/locale 的调用记录。
 */
export async function evaluateBundle({ mount } = {}) {
    const source = await readFile(clientPath, 'utf8')
    const records = { loaded: [], mounted: [], getKeys: [], dicts: [], slots: [], injections: [], calls: [] }

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
        save: async () => ({ ok: true, value: { path: '/tmp/AGENTS.md', bytes: 3, mtimeMs: 2, backupPath: null, backupId: null } }),
        list: async () => ({ ok: true, value: { dir: '/tmp', versions: [] } }),
        readVersion: async (payload) => ({
            ok: true,
            value: { id: payload.id, path: `/tmp/AGENTS.md.bak-${payload.id}`, content: 'old', bytes: 3, mtimeMs: 1, at: 1 },
        }),
        restore: async (payload) => ({
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
        remove: async (payload) => ({ ok: true, value: { id: payload.id, path: `/tmp/AGENTS.md.bak-${payload.id}` } }),
    }
    // 记录每个方法的调用入参，用来验证代理没有丢参数或改形状。
    for (const method of ['read', 'save', 'list', 'readVersion', 'restore', 'remove']) {
        const original = namespace[method]
        namespace[method] = async (payload) => {
            records.calls.push({ method, payload })
            return original(payload)
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
