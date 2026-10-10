/**
 * 客户端束的形状与注册测试。
 *
 * 用一个假的 `window.__ModuleLoader__` + 假的 require 把 `lib/client.js` 当作
 * 浏览器里那样求值（装载体见 `helpers/client-bundle-harness.mjs`），验证：
 *   - 只注册 factory、导出 `apply` / `inject`
 *   - `apply` 注册字典、$mount 消费者贡献、把设置页注册进 settings.section
 *   - 消费者描述符覆盖全部七个端点（与宿主 manifest 的逐字段一致性见 manifest-parity.test.mjs）
 *   - `inject` 面拿到的七个方法引用稳定（否则 React 依赖会无限重跑）
 *   - $mount 失败时降级为页面内的错误提示而不是整块崩掉
 *
 * 运行：`node --test test/`
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { clientPath, evaluateBundle, plain } from './helpers/client-bundle-harness.mjs'

/** 宿主 manifest 与客户端贡献都必须声明的端点集合（`<namespace>/<method>`）。 */
const EXPECTED_ENDPOINTS = [
    'personalization/read',
    'personalization/save',
    'personalization/listScopes',
    'personalization/listVersions',
    'personalization/readVersion',
    'personalization/restoreVersion',
    'personalization/deleteVersion',
]

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
    assert.deepEqual(
        Object.keys(records.dicts[0].dicts.zh).sort(),
        Object.keys(records.dicts[0].dicts.en).sort(),
        '中英文字典的 key 必须一一对应',
    )

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
    for (const method of ['read', 'save', 'listScopes', 'listVersions', 'readVersion', 'restoreVersion', 'deleteVersion']) {
        assert.equal(typeof injected[method], 'function', `inject 面必须提供 ${method}`)
    }
    assert.equal(injected.remoteError, null)

    assert.equal(records.injections.length, 2, '字典与样式各一个 effect（manifest 在宿主半区）')
    assert.equal(typeof dispose, 'function', 'apply 必须返回卸载函数')
})

/** 每个方法应声明的载荷 typeSymbol；`listScopes` 是唯一的零参方法，不在表里。 */
const PAYLOAD_SYMBOLS = {
    read: 'dsh-personalization#ScopePayload',
    save: 'dsh-personalization#SavePayload',
    listVersions: 'dsh-personalization#ScopePayload',
    readVersion: 'dsh-personalization#VersionPayload',
    restoreVersion: 'dsh-personalization#VersionPayload',
    deleteVersion: 'dsh-personalization#VersionPayload',
}

test('消费者描述符覆盖全部七个端点，且参数形状正确', async () => {
    const { exports, ctx, records } = await evaluateBundle()
    await exports.apply(ctx)

    assert.equal(records.mounted.length, 1)
    const descriptors = records.mounted[0].descriptors
    assert.equal(descriptors.length, EXPECTED_ENDPOINTS.length)

    const endpoints = plain(descriptors.map((descriptor) => `${descriptor.namespace}/${descriptor.method}`)).sort()
    assert.deepEqual(endpoints, [...EXPECTED_ENDPOINTS].sort())
    assert.equal(new Set(endpoints).size, endpoints.length, '端点不得重复（宿主会整批拒绝）')
    assert.equal(
        new Set(descriptors.map((descriptor) => descriptor.id)).size,
        descriptors.length,
        'invocation id 不得重复',
    )

    for (const descriptor of descriptors) {
        assert.equal(descriptor.service, 'personalization')
        assert.equal(descriptor.namespace, 'personalization')
        assert.deepEqual(plain(descriptor.invocation), { kind: 'direct' })
        // 载荷分成两种形状：`{ scope }` 与 `{ scope, id }`；`listScopes` 零参。
        const expectedSymbol = PAYLOAD_SYMBOLS[descriptor.method]
        if (expectedSymbol === undefined) {
            assert.equal(descriptor.parameters.length, 0, `${descriptor.method} 必须是零参方法`)
        } else {
            assert.equal(descriptor.parameters.length, 1, `${descriptor.method} 的参数个数`)
            assert.equal(descriptor.parameters[0].name, 'payload')
            assert.equal(descriptor.parameters[0].wire, 'payload')
            assert.equal(descriptor.parameters[0].source, 'json')
            assert.equal(descriptor.parameters[0].codec.typeSymbol, expectedSymbol)
        }
        for (const codec of [descriptor.result, ...descriptor.parameters.map((parameter) => parameter.codec)]) {
            assert.equal(codec.mode, 'strict')
            assert.equal(typeof codec.typeSymbol, 'string')
            assert.equal(typeof codec.create, 'function')
        }
    }
})

test('locale 字典与 t() 引用双向覆盖', async () => {
    // 两个方向都会出问题：字典里没人用的 key 是死代码；代码里引用了但字典没有的 key
    // 会直接显示成原始 key 名（locale 的 bind 在缺 key 时回退到 key 本身）。
    const { exports, ctx, records } = await evaluateBundle()
    await exports.apply(ctx)
    const { zh, en } = records.dicts[0].dicts
    const source = await readFile(clientPath, 'utf8')

    const referenced = new Set()
    for (const match of source.matchAll(/\bt\("([^"]+)"\)/g)) referenced.add(match[1])

    assert.deepEqual(
        Object.keys(zh).filter((key) => !referenced.has(key)),
        [],
        '字典里有未被任何 t() 引用的死 key',
    )
    assert.deepEqual(
        [...referenced].filter((key) => !Object.hasOwn(zh, key) || !Object.hasOwn(en, key)),
        [],
        't() 引用了字典里不存在的 key',
    )
})

test('inject 面拿到的七个方法引用在多次读取间保持稳定', async () => {
    const { exports, ctx, records } = await evaluateBundle()
    await exports.apply(ctx)
    const section = records.slots.find((entry) => entry.options !== undefined)

    const first = section.options.inject()
    const second = section.options.inject()
    for (const method of ['read', 'save', 'listScopes', 'listVersions', 'readVersion', 'restoreVersion', 'deleteVersion']) {
        assert.equal(first[method], second[method], `${method} 每次新建会让组件的 useCallback 依赖失效`)
    }
    assert.equal(first.t, second.t)
})

test('七个方法都代理到远程命名空间，并原样传递载荷', async () => {
    const { exports, ctx, records } = await evaluateBundle()
    await exports.apply(ctx)
    const section = records.slots.find((entry) => entry.options !== undefined)
    const injected = section.options.inject()
    const global = { kind: 'global' }
    const workspace = { kind: 'workspace', workspaceId: 'ws-1' }

    const readResult = await injected.read({ scope: global })
    assert.equal(readResult.ok, true)
    assert.equal(readResult.value.path, '/tmp/AGENTS.md')

    const saveResult = await injected.save({ scope: workspace, content: 'new' })
    assert.equal(saveResult.ok, true)
    assert.equal(saveResult.value.backupPath, null)

    const scopesResult = await injected.listScopes()
    assert.equal(scopesResult.ok, true)
    assert.equal(scopesResult.value.scopes.length, 2, '全局 + 一个工作区')
    assert.equal(scopesResult.value.scopes[0].kind, 'global')
    assert.equal(scopesResult.value.scopes[0].workspaceId, null)
    assert.equal(scopesResult.value.scopes[1].workspaceId, 'ws-1')

    const listVersionsResult = await injected.listVersions({ scope: global })
    assert.equal(listVersionsResult.ok, true)
    assert.deepEqual(plain(listVersionsResult.value.versions), [])

    const detail = await injected.readVersion({ scope: global, id: '20261010-085310' })
    assert.equal(detail.ok, true)
    assert.equal(detail.value.content, 'old')

    const restored = await injected.restoreVersion({ scope: workspace, id: '20261010-085310' })
    assert.equal(restored.ok, true)
    assert.equal(restored.value.restoredFrom, '20261010-085310')

    const deleted = await injected.deleteVersion({ scope: workspace, id: '20261010-085310' })
    assert.equal(deleted.ok, true)
    assert.equal(deleted.value.id, '20261010-085310')

    // 参数必须原样透传 —— 尤其是 `{ scope, id }`：丢掉 scope 就会写错文件。
    // 这里不能用 plain()：零参调用的 payload 是 undefined，JSON 归一化会把它抹掉。
    assert.deepEqual(records.calls, [
        { method: 'read', payload: { scope: global } },
        { method: 'save', payload: { scope: workspace, content: 'new' } },
        { method: 'listScopes', payload: undefined },
        { method: 'listVersions', payload: { scope: global } },
        { method: 'readVersion', payload: { scope: global, id: '20261010-085310' } },
        { method: 'restoreVersion', payload: { scope: workspace, id: '20261010-085310' } },
        { method: 'deleteVersion', payload: { scope: workspace, id: '20261010-085310' } },
    ])
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
    const global = { kind: 'global' }
    await injected.read({ scope: global })
    await injected.save({ scope: global, content: 'x' })
    await injected.listScopes()
    await injected.listVersions({ scope: global })
    await injected.readVersion({ scope: global, id: '20261010-085310' })
    await injected.restoreVersion({ scope: global, id: '20261010-085310' })
    await injected.deleteVersion({ scope: global, id: '20261010-085310' })
    const after = records.getKeys.filter((key) => key === 'remote.personalization').length
    assert.equal(after - before, 7, '七个方法各自重新取一次命名空间服务')
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
    await assert.rejects(() => injected.read({ scope: { kind: 'global' } }), /远程服务未就绪|not ready/)
    await assert.rejects(() => injected.listScopes(), /远程服务未就绪|not ready/)
    await assert.rejects(() => injected.listVersions({ scope: { kind: 'global' } }), /远程服务未就绪|not ready/)
})
