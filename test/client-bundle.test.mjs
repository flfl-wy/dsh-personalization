/**
 * 客户端束的形状与注册测试。
 *
 * 用一个假的 `window.__ModuleLoader__` + 假的 require 把 `lib/client.js` 当作
 * 浏览器里那样求值（装载体见 `helpers/client-bundle-harness.mjs`），验证：
 *   - 只注册 factory、导出 `apply` / `inject`
 *   - `apply` 注册字典、$mount 消费者贡献、把设置页注册进 settings.section
 *   - 消费者描述符覆盖全部六个端点（与宿主 manifest 的逐字段一致性见 manifest-parity.test.mjs）
 *   - `inject` 面拿到的六个方法引用稳定（否则 React 依赖会无限重跑）
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
    'personalization/list',
    'personalization/readVersion',
    'personalization/restore',
    'personalization/remove',
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
    for (const method of ['read', 'save', 'list', 'readVersion', 'restore', 'remove']) {
        assert.equal(typeof injected[method], 'function', `inject 面必须提供 ${method}`)
    }
    assert.equal(injected.remoteError, null)

    assert.equal(records.injections.length, 2, '字典与样式各一个 effect（manifest 在宿主半区）')
    assert.equal(typeof dispose, 'function', 'apply 必须返回卸载函数')
})

test('消费者描述符覆盖全部六个端点，且参数形状正确', async () => {
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
        // 零参方法必须声明空数组，其余方法一律收一个 `{ id }` 载荷。
        const expectsPayload = descriptor.method !== 'read' && descriptor.method !== 'list'
        assert.equal(descriptor.parameters.length, expectsPayload ? 1 : 0, `${descriptor.method} 的参数个数`)
        if (expectsPayload) {
            assert.equal(descriptor.parameters[0].name, 'payload')
            assert.equal(descriptor.parameters[0].wire, 'payload')
            assert.equal(descriptor.parameters[0].source, 'json')
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

test('inject 面拿到的六个方法引用在多次读取间保持稳定', async () => {
    const { exports, ctx, records } = await evaluateBundle()
    await exports.apply(ctx)
    const section = records.slots.find((entry) => entry.options !== undefined)

    const first = section.options.inject()
    const second = section.options.inject()
    for (const method of ['read', 'save', 'list', 'readVersion', 'restore', 'remove']) {
        assert.equal(first[method], second[method], `${method} 每次新建会让组件的 useCallback 依赖失效`)
    }
    assert.equal(first.t, second.t)
})

test('六个方法都代理到远程命名空间，并原样传递载荷', async () => {
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

    const listResult = await injected.list()
    assert.equal(listResult.ok, true)
    assert.deepEqual(plain(listResult.value.versions), [])

    const detail = await injected.readVersion({ id: '20261010-085310' })
    assert.equal(detail.ok, true)
    assert.equal(detail.value.content, 'old')

    const restored = await injected.restore({ id: '20261010-085310' })
    assert.equal(restored.ok, true)
    assert.equal(restored.value.restoredFrom, '20261010-085310')

    const removed = await injected.remove({ id: '20261010-085310' })
    assert.equal(removed.ok, true)
    assert.equal(removed.value.id, '20261010-085310')

    // 参数必须原样透传 —— 尤其是 `{ id }`，否则宿主会因为 zod 校验失败而整批报错。
    // 这里不能用 plain()：零参调用的 payload 是 undefined，JSON 归一化会把它抹掉。
    assert.deepEqual(records.calls, [
        { method: 'read', payload: undefined },
        { method: 'save', payload: { content: 'new' } },
        { method: 'list', payload: undefined },
        { method: 'readVersion', payload: { id: '20261010-085310' } },
        { method: 'restore', payload: { id: '20261010-085310' } },
        { method: 'remove', payload: { id: '20261010-085310' } },
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
    await injected.read()
    await injected.save({ content: 'x' })
    await injected.list()
    await injected.readVersion({ id: '20261010-085310' })
    await injected.restore({ id: '20261010-085310' })
    await injected.remove({ id: '20261010-085310' })
    const after = records.getKeys.filter((key) => key === 'remote.personalization').length
    assert.equal(after - before, 6, '六个方法各自重新取一次命名空间服务')
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
    await assert.rejects(() => injected.list(), /远程服务未就绪|not ready/)
})
