/**
 * `lib/scopes.js` 的纯逻辑测试：作用域归一化、id → 路径解析、作用域枚举。
 *
 * 不碰文件系统、不需要 DSH：工作区注册表用一个最小替身传进去，
 * 全局作用域的目录由 `DSH_HOME` 决定（指向临时目录，不碰真实 `~/.dsh`）。
 * 运行：`node --test test/`
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** 每个用例一个隔离的 DSH_HOME。 */
async function withSandbox(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-personalization-scopes-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const module = await import('../lib/scopes.js')
    await run({ home, module })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

/** 最小工作区注册表替身（只需要 `list` / `get`）。 */
const registryOf = (rows) => ({
  list: () => rows,
  get: (id) => rows.find((row) => row.id === id),
})

test('scopeKey 把两个作用域映射成稳定键', async () => {
  await withSandbox(async ({ module }) => {
    assert.equal(module.scopeKey({ kind: 'global' }), 'global')
    assert.equal(module.scopeKey({ kind: 'workspace', workspaceId: 'ws-1' }), 'workspace:ws-1')
  })
})

test('normalizeScope 只接受两个分支，其余一律拒绝', async () => {
  await withSandbox(async ({ module }) => {
    assert.deepEqual(module.normalizeScope({ kind: 'global' }), { kind: 'global', workspaceId: null })
    assert.deepEqual(
      module.normalizeScope({ kind: 'workspace', workspaceId: 'ws-1' }),
      { kind: 'workspace', workspaceId: 'ws-1' },
    )
    const bad = [
      null, undefined, [], 'global', 42, {},
      { kind: 'nope' },
      { kind: 'workspace' },
      { kind: 'workspace', workspaceId: '' },
      { kind: 'workspace', workspaceId: 7 },
    ]
    for (const value of bad) {
      assert.throws(() => module.normalizeScope(value), TypeError, `应拒绝 ${JSON.stringify(value)}`)
    }
  })
})

test('resolveScopeFile 由宿主解析：全局是 $DSH_HOME，工作区是 <path>/AGENTS.md', async () => {
  await withSandbox(async ({ home, module }) => {
    const registry = registryOf([{ id: 'ws-1', title: 'demo', path: join(home, 'demo') }])
    assert.equal(module.resolveScopeFile({ kind: 'global' }, registry), join(home, 'AGENTS.md'))
    assert.equal(
      module.resolveScopeFile({ kind: 'workspace', workspaceId: 'ws-1' }, registry),
      join(home, 'demo', 'AGENTS.md'),
    )
  })
})

test('resolveScopeFile 对未知工作区与缺失注册表抛错，绝不退回默认路径', async () => {
  await withSandbox(async ({ home, module }) => {
    const registry = registryOf([{ id: 'ws-1', title: 'demo', path: join(home, 'demo') }])
    // 静默退回全局文件会把用户的编辑写进别的文件 —— 这是最坏的一种失败。
    assert.throws(
      () => module.resolveScopeFile({ kind: 'workspace', workspaceId: 'nope' }, registry),
      /unknown workspace/,
    )
    assert.throws(
      () => module.resolveScopeFile({ kind: 'workspace', workspaceId: 'ws-1' }, undefined),
      /registry is unavailable/,
    )
    assert.throws(
      () => module.resolveScopeFile({ kind: 'workspace', workspaceId: 'ws-1' }, {}),
      /registry is unavailable/,
    )
    // 全局作用域不依赖注册表。
    assert.equal(module.resolveScopeFile({ kind: 'global' }, undefined), join(home, 'AGENTS.md'))
  })
})

test('scopeTargets 全局在前，工作区按注册表顺序，标题可为空', async () => {
  await withSandbox(async ({ home, module }) => {
    const registry = registryOf([
      { id: 'ws-1', title: 'demo', path: join(home, 'demo') },
      { id: 'ws-2', title: undefined, path: join(home, 'other') },
    ])
    assert.deepEqual(module.scopeTargets(registry), [
      { kind: 'global', workspaceId: null, title: null, path: join(home, 'AGENTS.md') },
      { kind: 'workspace', workspaceId: 'ws-1', title: 'demo', path: join(home, 'demo', 'AGENTS.md') },
      { kind: 'workspace', workspaceId: 'ws-2', title: null, path: join(home, 'other', 'AGENTS.md') },
    ])
  })
})

test('scopeTargets 在注册表缺失时退化成只有全局', async () => {
  await withSandbox(async ({ home, module }) => {
    for (const registry of [undefined, null, {}]) {
      assert.deepEqual(module.scopeTargets(registry), [
        { kind: 'global', workspaceId: null, title: null, path: join(home, 'AGENTS.md') },
      ])
    }
  })
})
