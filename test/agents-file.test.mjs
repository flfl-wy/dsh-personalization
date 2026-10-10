/**
 * `lib/agents-file.js` 的往返测试。
 *
 * 全程把 `DSH_HOME` 指向临时目录，因此不会碰真实的 `~/.dsh/AGENTS.md`。
 * 运行：`node --test test/`
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** 每个用例一个隔离的 DSH_HOME。 */
async function withSandbox(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-personalization-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // 必须在设置 DSH_HOME 之后 import：模块本身无状态，但保持顺序让意图明确。
    const module = await import('../lib/agents-file.js')
    await run({ home, file: join(home, 'AGENTS.md'), module })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('backupPathFor 生成 AGENTS.md.bak-YYYYMMDD-HHmmss', async () => {
  await withSandbox(async ({ module }) => {
    const at = new Date(2026, 9, 10, 8, 53, 10) // 2026-10-10 08:53:10 本地时间
    assert.equal(
      module.backupPathFor('/tmp/x/AGENTS.md', at),
      '/tmp/x/AGENTS.md.bak-20261010-085310',
    )
  })
})

test('文件不存在时 read 返回空内容而不是抛错', async () => {
  await withSandbox(async ({ home, file, module }) => {
    const result = await module.readAgentsFile()
    assert.equal(result.path, file)
    assert.equal(result.exists, false)
    assert.equal(result.content, '')
    assert.equal(result.bytes, 0)
    assert.equal(result.mtimeMs, 0)
    assert.deepEqual(await readdir(home), [], '不存在的文件不应产生任何副作用')
  })
})

test('首次写入创建文件且不产生备份', async () => {
  await withSandbox(async ({ home, file, module }) => {
    const saved = await module.writeAgentsFile('# 偏好\n\n用中文回答。\n')
    assert.equal(saved.path, file)
    assert.equal(saved.backupPath, null)
    assert.equal(saved.bytes, Buffer.byteLength('# 偏好\n\n用中文回答。\n', 'utf8'))
    assert.ok(saved.mtimeMs > 0)
    assert.equal(await readFile(file, 'utf8'), '# 偏好\n\n用中文回答。\n')
    assert.deepEqual(await readdir(home), ['AGENTS.md'])
  })
})

test('再次写入会先备份上一版，且备份内容等于上一版', async () => {
  await withSandbox(async ({ home, file, module }) => {
    const first = '# 第一版\n'
    const second = '# 第二版\n'
    await module.writeAgentsFile(first)

    const saved = await module.writeAgentsFile(second)
    assert.notEqual(saved.backupPath, null)
    assert.match(saved.backupPath, /^.*AGENTS\.md\.bak-\d{8}-\d{6}$/)
    assert.equal(await readFile(saved.backupPath, 'utf8'), first, '备份必须是上一版内容')
    assert.equal(await readFile(file, 'utf8'), second, '主文件必须是新版内容')

    const entries = (await readdir(home)).sort()
    assert.equal(entries.length, 2)
    assert.deepEqual(entries, ['AGENTS.md', saved.backupPath.split('/').pop()])
  })
})

test('read 能读回刚写入的内容并给出真实字节数', async () => {
  await withSandbox(async ({ file, module }) => {
    const payload = '# 偏好\n\n- 用中文回答\n- 先给结论\n'
    await module.writeAgentsFile(payload)

    const result = await module.readAgentsFile()
    assert.equal(result.exists, true)
    assert.equal(result.content, payload)
    assert.equal(result.bytes, Buffer.byteLength(payload, 'utf8'))
    assert.ok(result.mtimeMs > 0)
    assert.equal(await readFile(file, 'utf8'), payload)
  })
})

test('保留既有文件内容原样，包括 BOM 之外的空白与结尾换行缺失', async () => {
  await withSandbox(async ({ file, module }) => {
    const payload = 'no trailing newline'
    await module.writeAgentsFile(payload)
    assert.equal(await readFile(file, 'utf8'), payload)
    assert.equal((await module.readAgentsFile()).content, payload)
  })
})

test('超过上限的内容被拒绝且不落盘', async () => {
  await withSandbox(async ({ home, file, module }) => {
    await writeFile(file, 'keep me\n', 'utf8')
    const tooLong = 'x'.repeat(module.MAX_CONTENT_LENGTH + 1)

    await assert.rejects(() => module.writeAgentsFile(tooLong), RangeError)
    assert.equal(await readFile(file, 'utf8'), 'keep me\n', '被拒绝的写入不得改动原文件')
    assert.deepEqual(await readdir(home), ['AGENTS.md'], '被拒绝的写入不得留下备份')
  })
})

test('非字符串内容被拒绝', async () => {
  await withSandbox(async ({ module }) => {
    await assert.rejects(() => module.writeAgentsFile(null), TypeError)
  })
})
