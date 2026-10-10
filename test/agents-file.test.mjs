/**
 * `lib/agents-file.js` 的往返测试，覆盖主文件读写与历史版本（枚举 / 读取 / 回滚 / 删除）。
 *
 * 全程把 `DSH_HOME` 指向临时目录，因此不会碰真实的 `~/.dsh/AGENTS.md`。
 * 运行：`node --test test/`
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
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

/** 写 n 个连续版本，返回每一版的内容与每次写入的结果。 */
async function writeSeries(module, count) {
  const contents = []
  const results = []
  for (let index = 1; index <= count; index += 1) {
    const text = `# 第 ${index} 版\n`
    contents.push(text)
    results.push(await module.writeAgentsFile(text))
  }
  return { contents, results }
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
    assert.equal(saved.backupId, null)
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

test('同一秒内的连续写入不会互相覆盖备份', async () => {
  await withSandbox(async ({ home, file, module }) => {
    // 先占住「当前秒 ± 若干秒」的基准名字，这样无论写入落在哪一秒，
    // nextBackupPath 都必须走到追加后缀的分支。避免依赖真实时钟的抖动。
    const reserved = []
    for (let offset = -1; offset <= 3; offset += 1) {
      const path = module.backupPathFor(file, new Date(Date.now() + offset * 1000))
      await writeFile(path, `reserved-${offset}`, 'utf8')
      reserved.push(path)
    }
    await writeFile(file, '# 上一版\n', 'utf8')

    const saved = await module.writeAgentsFile('# 新版\n')

    assert.equal(reserved.includes(saved.backupPath), false, '不得复用已占用的备份名')
    assert.match(saved.backupPath, /^.*AGENTS\.md\.bak-\d{8}-\d{6}-\d+$/, '冲突时应追加后缀')
    assert.equal(await readFile(saved.backupPath, 'utf8'), '# 上一版\n')
    assert.equal(await readFile(file, 'utf8'), '# 新版\n')
    for (const [index, path] of reserved.entries()) {
      assert.equal(await readFile(path, 'utf8'), `reserved-${index - 1}`, '已占用的备份不得被改写')
    }
    assert.equal(await readFile(file, 'utf8'), '# 新版\n')
    void home
  })
})

test('连续写入产生互不相同的备份，且每份等于写入前的那一版', async () => {
  await withSandbox(async ({ module }) => {
    const { contents, results } = await writeSeries(module, 4)
    const backups = results.map((result) => result.backupPath).filter((path) => path !== null)
    assert.equal(backups.length, 3, '首次写入无备份，其后每次一份')
    assert.equal(new Set(backups).size, 3, '三份备份路径必须互不相同')
    for (const [index, path] of backups.entries()) {
      assert.equal(await readFile(path, 'utf8'), contents[index], '第 n 份备份等于第 n 版内容')
    }
  })
})

test('versionIdOf 只认本文件的备份名', async () => {
  await withSandbox(async ({ file, module }) => {
    assert.equal(module.versionIdOf(`${file}.bak-20261010-085310`), '20261010-085310')
    assert.equal(module.versionIdOf(`${file}.bak-20261010-085310-2`), '20261010-085310-2')
    assert.equal(module.versionIdOf(file), null, '主文件不是版本')
    assert.equal(module.versionIdOf(`${file}.bak-not-a-stamp`), null)
    assert.equal(module.versionIdOf(`${file}.bak-20261010-085310.bak-20261011-000000`), null)
    assert.equal(module.versionIdOf('/tmp/other.md.bak-20261010-085310'), null, '别的文件名不算')
    void module.agentsFile()
  })
})

test('versionPathFor 拒绝任何越界 id', async () => {
  await withSandbox(async ({ home, file, module }) => {
    assert.equal(module.versionPathFor('20261010-085310'), `${file}.bak-20261010-085310`)
    for (const bad of [
      '../../etc/passwd',
      '..',
      '20261010-085310/../../x',
      '/etc/passwd',
      '20261010-085310\n',
      '',
      'AGENTS.md',
      null,
      undefined,
      42,
    ]) {
      assert.throws(() => module.versionPathFor(bad), RangeError, `应拒绝 ${JSON.stringify(bad)}`)
    }
    assert.deepEqual(await readdir(home), [], '被拒绝的 id 不得产生任何文件')
  })
})

test('versionTimeOf 还原本地时间戳，非法前缀返回 0', async () => {
  await withSandbox(async ({ module }) => {
    assert.equal(
      module.versionTimeOf('20261010-085310'),
      new Date(2026, 9, 10, 8, 53, 10).getTime(),
    )
    assert.equal(
      module.versionTimeOf('20261010-085310-2'),
      new Date(2026, 9, 10, 8, 53, 10).getTime(),
      '冲突后缀不影响时间解析',
    )
    assert.equal(module.versionTimeOf('nope'), 0)
    assert.equal(module.versionTimeOf(null), 0)
  })
})

test('目录不存在时 listVersions 返回空列表而不是抛错', async () => {
  await withSandbox(async ({ home, module }) => {
    const listed = await module.listVersions()
    assert.equal(listed.dir, home)
    assert.deepEqual(listed.versions, [])
  })
})

test('listVersions 按新到旧列出全部版本，并忽略无关文件', async () => {
  await withSandbox(async ({ home, module }) => {
    const { results } = await writeSeries(module, 3)
    await writeFile(join(home, 'notes.txt'), 'unrelated', 'utf8')
    await writeFile(join(home, 'AGENTS.md.old'), 'unrelated', 'utf8')

    const listed = await module.listVersions()
    const ids = listed.versions.map((version) => version.id)
    assert.equal(ids.length, 2, '三次写入只留两份备份')
    assert.deepEqual(ids, [...ids].sort().reverse(), '必须新 → 旧')
    assert.deepEqual(ids, [results[2].backupId, results[1].backupId])
    for (const version of listed.versions) {
      assert.ok(version.bytes > 0)
      assert.ok(version.mtimeMs > 0)
      assert.ok(version.at > 0, 'id 应能还原出时刻')
      assert.equal(version.path, `${home}/AGENTS.md.bak-${version.id}`)
    }
  })
})

test('listVersions 跳过符号链接', async () => {
  await withSandbox(async ({ home, file, module }) => {
    const outside = join(home, 'secret.txt')
    await writeFile(outside, 'do not expose\n', 'utf8')
    await symlink(outside, `${file}.bak-20261010-085310`)

    const listed = await module.listVersions()
    assert.deepEqual(listed.versions, [], '符号链接可能指向目录外，不得列出')
    await assert.rejects(() => module.readVersion('20261010-085310'), /not a regular file/)
    await assert.rejects(() => module.removeVersion('20261010-085310'), /not a regular file/)
    assert.equal(await readFile(outside, 'utf8'), 'do not expose\n', '目标文件不得被动到')
  })
})

test('readVersion 返回指定版本的完整内容', async () => {
  await withSandbox(async ({ module }) => {
    const { contents, results } = await writeSeries(module, 2)
    const detail = await module.readVersion(results[1].backupId)

    assert.equal(detail.id, results[1].backupId)
    assert.equal(detail.content, contents[0], '第二次写入的备份是第一版内容')
    assert.equal(detail.bytes, Buffer.byteLength(contents[0], 'utf8'))
    assert.equal(detail.path, results[1].backupPath)
    assert.ok(detail.at > 0)
  })
})

test('readVersion 对不存在的版本给出可读错误', async () => {
  await withSandbox(async ({ module }) => {
    await assert.rejects(() => module.readVersion('20261010-085310'), /does not exist/)
  })
})

test('restoreVersion 回滚内容，并先把回滚前的内容存成新版本', async () => {
  await withSandbox(async ({ file, module }) => {
    const first = '# 第一版\n'
    const second = '# 第二版\n'
    await module.writeAgentsFile(first)
    const saved = await module.writeAgentsFile(second) // 备份 = first
    const targetId = saved.backupId

    const restored = await module.restoreVersion(targetId)

    assert.equal(await readFile(file, 'utf8'), first, '主文件应回到目标版本')
    assert.equal(restored.restoredFrom, targetId)
    assert.equal(restored.versionPath, saved.backupPath)
    assert.notEqual(restored.backupPath, null, '回滚本身也必须留下备份')
    assert.equal(
      await readFile(restored.backupPath, 'utf8'),
      second,
      '回滚前的当前内容必须被保住 —— 否则回滚不可逆',
    )
    assert.equal(restored.backupId, module.versionIdOf(restored.backupPath))

    const ids = (await module.listVersions()).versions.map((version) => version.id)
    assert.equal(ids.includes(targetId), true, '源版本不删除，历史链完整')
    assert.equal(ids.includes(restored.backupId), true)
  })
})

test('restoreVersion 之后可以再回滚回滚动作本身', async () => {
  await withSandbox(async ({ file, module }) => {
    await module.writeAgentsFile('A\n')
    const second = await module.writeAgentsFile('B\n') // 备份 A
    await module.restoreVersion(second.backupId) // 主文件回到 A，同时备份 B
    assert.equal(await readFile(file, 'utf8'), 'A\n')

    const versions = (await module.listVersions()).versions
    const backToB = versions.find((version) => version.id !== second.backupId)
    assert.ok(backToB !== undefined, '回滚应产生一份可再回滚的版本')
    await module.restoreVersion(backToB.id)
    assert.equal(await readFile(file, 'utf8'), 'B\n')
  })
})

test('restoreVersion 对不存在的版本报错且不改动主文件', async () => {
  await withSandbox(async ({ file, module }) => {
    await module.writeAgentsFile('keep\n')
    await assert.rejects(() => module.restoreVersion('20261010-085310'), /does not exist/)
    assert.equal(await readFile(file, 'utf8'), 'keep\n')
  })
})

test('removeVersion 只删备份，不动主文件', async () => {
  await withSandbox(async ({ file, module }) => {
    const first = '# 第一版\n'
    const second = '# 第二版\n'
    await module.writeAgentsFile(first)
    const saved = await module.writeAgentsFile(second)

    const removed = await module.removeVersion(saved.backupId)
    assert.equal(removed.id, saved.backupId)
    assert.equal(removed.path, saved.backupPath)
    assert.equal(await readFile(file, 'utf8'), second, '主文件不受影响')
    assert.deepEqual((await module.listVersions()).versions, [])
    await assert.rejects(() => readFile(saved.backupPath, 'utf8'), { code: 'ENOENT' })
  })
})

test('removeVersion 对不存在的版本给出可读错误', async () => {
  await withSandbox(async ({ module }) => {
    await assert.rejects(() => module.removeVersion('20261010-085310'), /does not exist/)
  })
})

test('readVersion 拒绝超过上限的版本，不把大文件读进内存', async () => {
  await withSandbox(async ({ file, module }) => {
    const path = `${file}.bak-20261010-085310`
    await writeFile(path, 'x'.repeat(module.MAX_CONTENT_LENGTH + 1), 'utf8')
    await assert.rejects(() => module.readVersion('20261010-085310'), RangeError)
  })
})
