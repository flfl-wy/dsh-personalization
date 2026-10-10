/**
 * 跨半区契约测试：宿主 `lib/index.js` 的 `MANIFEST` 与客户端 `lib/client.js` 的
 * `CONTRIBUTION` 是**手写的两份清单**，README 要求它们逐字段一致。
 *
 * 这两份清单一旦错位，只在真实浏览器里以 `gateway/definition-unavailable` /
 * `gateway/input-invalid` 这种难懂的错误暴露，宿主启动时不会报任何东西 —— 所以
 * 这里把它变成可执行断言。
 *
 * 同时校验四件事：
 *   1. `MANIFEST` 满足 `dsh-typert-loader` 的 `requireInvocation` 结构规则
 *      （id 与端点唯一、参数 wire 不重复、codec 必须是 strict 且带 create()）。
 *   2. 每个端点在两半区之间的契约字段完全一致。
 *   3. `MANIFEST` 里声明的 zod 结果 schema 能解析 `lib/agents-file.js` 的**真实返回值**
 *      （出参不在网关上校验，schema 只用于类型生成，所以只能在这里盯住它别漂）。
 *   4. 方法名不与客户端命名空间服务的自身成员冲突（撞上会整组挂载失败，见 helper）。
 *
 * 运行：`node --test test/`
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { evaluateBundle, plain } from './helpers/client-bundle-harness.mjs'
import {
  DSH_ASAR_PATH,
  RESERVED_NAMESPACE_METHODS,
  deriveReservedNamesFromAsar,
} from './helpers/gateway-reserved-names.mjs'

// 真实 dsh-typert-protocol import 了未安装的 @deepseek-ai/cordis（本插件故意不装，
// 见 .npmrc 的 autoInstallPeers=false），所以把该包重定向到测试替身，只为取到
// 真实的 MANIFEST。hooks 必须在 import 业务模块之前注册。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-typert-protocol') {
      return { url: new URL('./fixtures/typert-protocol-stub.mjs', import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { MANIFEST } = await import('../lib/index.js')

/** 复刻 dsh-typert-loader 的 `requireStrictCodec`：strict + typeSymbol + create()。 */
function assertStrictCodec(codec, subject) {
  assert.equal(codec.mode, 'strict', `${subject} 必须是 strict codec`)
  assert.equal(typeof codec.typeSymbol, 'string', `${subject} 缺 typeSymbol`)
  assert.ok(codec.typeSymbol.length > 0, `${subject} 的 typeSymbol 不得为空`)
  assert.equal(typeof codec.create, 'function', `${subject} 缺 create() 工厂`)
  assert.equal(typeof codec.create().parse, 'function', `${subject} 的 create() 必须给出可 parse 的 schema`)
}

/** 复刻 `dsh-typert-loader/lib/index.js` 的 `requireInvocation` 结构校验。 */
function assertLoaderAccepted(manifest) {
  assert.equal(manifest.face, 'host')
  assert.equal(typeof manifest.package, 'string')
  assert.deepEqual(manifest.schemas, [])
  assert.ok(Array.isArray(manifest.invocations))

  const ids = new Set()
  const endpoints = new Set()
  for (const invocation of manifest.invocations) {
    for (const key of ['id', 'service', 'namespace', 'method']) {
      assert.equal(typeof invocation[key], 'string', `invocation.${key} 必须是字符串`)
    }
    const endpoint = `${invocation.namespace}/${invocation.method}`
    assert.equal(endpoints.has(endpoint), false, `端点重复注册会被整批拒绝：${endpoint}`)
    assert.equal(ids.has(invocation.id), false, `invocation id 重复：${invocation.id}`)
    endpoints.add(endpoint)
    ids.add(invocation.id)

    assert.ok(
      ['direct', 'context'].includes(invocation.invocation.kind),
      `receiver kind 非法：${invocation.invocation.kind}`,
    )
    const wires = new Set()
    for (const parameter of invocation.parameters) {
      assert.equal(typeof parameter.name, 'string')
      assert.equal(typeof parameter.wire, 'string')
      assert.equal(wires.has(parameter.wire), false, `wire 字段重复：${parameter.wire}`)
      wires.add(parameter.wire)
      assert.ok(['json', 'lookup'].includes(parameter.source), `参数 source 非法：${parameter.source}`)
      if (parameter.source === 'json') assert.equal(parameter.lookup, undefined, 'JSON 参数不得声明 lookup')
      assertStrictCodec(parameter.codec, `${invocation.id} 参数 ${parameter.wire}`)
    }
    assertStrictCodec(invocation.result, `${invocation.id} 结果`)
  }
  return { ids, endpoints }
}

/** 只取两半区必须逐字段一致的部分。zod schema 本身是类实例，不参与比较。 */
function contractOf(descriptor) {
  return {
    id: descriptor.id,
    service: descriptor.service,
    namespace: descriptor.namespace,
    method: descriptor.method,
    invocationKind: descriptor.invocation.kind,
    parameters: (descriptor.parameters ?? []).map((parameter) => ({
      name: parameter.name,
      wire: parameter.wire,
      source: parameter.source,
      mode: parameter.codec.mode,
      typeSymbol: parameter.codec.typeSymbol,
    })),
    result: { mode: descriptor.result.mode, typeSymbol: descriptor.result.typeSymbol },
  }
}

test('MANIFEST 满足 typert-loader 的结构规则', () => {
  const { ids, endpoints } = assertLoaderAccepted(MANIFEST)
  assert.equal(endpoints.size, 6)
  assert.deepEqual(
    [...endpoints].sort(),
    [
      'personalization/deleteVersion',
      'personalization/listVersions',
      'personalization/read',
      'personalization/readVersion',
      'personalization/restoreVersion',
      'personalization/save',
    ],
  )
  assert.equal(ids.size, 6)
})

test('方法名不与命名空间服务自身成员冲突', () => {
  // 真实网关在装每个方法前调 assertMethodAvailable()，撞名的直接抛错，而且
  // installMethods() 是整组回滚 —— 一个名字撞车，六个方法全装不上，页面只剩
  // 「远程服务未就绪」。删除历史版本因此叫 deleteVersion 而不是 remove。
  const collisions = MANIFEST.invocations
    .map((invocation) => `${invocation.namespace}/${invocation.method}`)
    .filter((endpoint) => RESERVED_NAMESPACE_METHODS.has(endpoint.split('/')[1]))
  assert.deepEqual(collisions, [], '这些方法名与命名空间服务自身成员冲突，会导致整个命名空间挂载失败')
})

test('保留名快照与 DSH 自带源码仍然一致', (t) => {
  // 快照是硬编码的，框架升级可能新增成员名。本机装了 DSH 时直接重新推导来对账，
  // 免得快照悄悄过期、守卫变成摆设。没装 DSH 的机器（例如 CI）跳过。
  if (!existsSync(DSH_ASAR_PATH)) {
    t.skip('本机没有 DSH 安装，无法从源码推导保留名')
    return
  }
  // 推导是正则近似解析，会多抓出 catch / if / for 这类方法体内的关键字，
  // 所以只要求「真实保留名被快照包含」，不要求两者完全相等。
  const derived = deriveReservedNamesFromAsar(DSH_ASAR_PATH)
  const missed = [...derived].filter((name) => !RESERVED_NAMESPACE_METHODS.has(name))
  assert.deepEqual(missed.sort(), [], 'DSH 自带的命名空间服务多了这些成员，请更新保留名快照')
})

test('客户端描述符与宿主 MANIFEST 逐字段一致', async () => {
  const { exports, ctx, records } = await evaluateBundle()
  await exports.apply(ctx)
  assert.equal(records.mounted.length, 1)
  const contribution = records.mounted[0]

  assert.equal(contribution.package, MANIFEST.package, '两半区的包名必须一致')

  const host = new Map(MANIFEST.invocations.map((invocation) => [
    `${invocation.namespace}/${invocation.method}`,
    invocation,
  ]))
  const client = new Map(contribution.descriptors.map((descriptor) => [
    `${descriptor.namespace}/${descriptor.method}`,
    descriptor,
  ]))

  assert.deepEqual(
    [...client.keys()].sort(),
    [...host.keys()].sort(),
    '两半区声明的端点集合必须完全相同',
  )

  for (const [endpoint, descriptor] of client) {
    assert.deepEqual(
      plain(contractOf(descriptor)),
      plain(contractOf(host.get(endpoint))),
      `${endpoint} 的契约字段在宿主与客户端之间不一致`,
    )
  }
})

test('MANIFEST 的 zod 结果 schema 能解析 agents-file.js 的真实返回值', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-personalization-parity-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const file = await import('../lib/agents-file.js')
    /** 取某个端点声明的结果 schema。 */
    const resultSchemaOf = (method) => {
      const invocation = MANIFEST.invocations.find((entry) => entry.method === method)
      assert.ok(invocation !== undefined, `MANIFEST 缺少 ${method}`)
      return invocation.result.create()
    }
    const payloadSchemaOf = (method) => {
      const invocation = MANIFEST.invocations.find((entry) => entry.method === method)
      return invocation.parameters[0].codec.create()
    }

    // 主文件不存在时也能过 —— 这是首次使用者的路径。
    resultSchemaOf('read').parse(await file.readAgentsFile())

    const first = await file.writeAgentsFile('# 第一版\n')
    resultSchemaOf('save').parse(first)
    resultSchemaOf('read').parse(await file.readAgentsFile())

    const second = await file.writeAgentsFile('# 第二版\n')
    resultSchemaOf('save').parse(second)
    assert.notEqual(second.backupId, null, '第二次写入应产生备份，后续步骤才能跑')

    resultSchemaOf('listVersions').parse(await file.listVersions())
    resultSchemaOf('readVersion').parse(await file.readVersion(second.backupId))
    const restored = resultSchemaOf('restoreVersion').parse(await file.restoreVersion(second.backupId))
    resultSchemaOf('deleteVersion').parse(await file.removeVersion(restored.backupId))

    // 入参会被网关用 codec.create().parse() 强制校验，所以形状必须真的收得下。
    const payload = payloadSchemaOf('readVersion')
    assert.deepEqual(plain(payload.parse({ id: '20261010-085310' })), { id: '20261010-085310' })
    assert.throws(() => payload.parse({}), '缺 id 必须被拒')
    assert.throws(() => payload.parse({ id: 42 }), '非字符串 id 必须被拒')
    // zod v4 的 object 默认**剥离**未知字段而不是报错；多字段是在网关的
    // assertExactArguments 那一层被拒的（args 的字段必须与 descriptor 完全一致）。
    assert.deepEqual(plain(payload.parse({ id: 'x', extra: 1 })), { id: 'x' })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
