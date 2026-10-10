/**
 * 读 DSH 安装包里（app.asar）自带源码的最小工具。
 *
 * 「我们的实现是否仍然符合框架真正的规则」这类测试需要拿实例自带的源码当依据，
 * 所以这里只做 asar 头部解析与单文件读取，不做任何缓存。
 */

import fs from 'node:fs'

/** DSH 的安装位置；不存在时依赖它的测试应当跳过。 */
export const DSH_ASAR_PATH = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/**
 * 打开 asar，返回单文件读取句柄。
 * @param archive - `app.asar` 路径。
 * @returns `{ read(path), close() }`；`read` 传 asar 内以 `/` 开头的路径。
 */
export function openAsar(archive) {
    const fd = fs.openSync(archive, 'r')
    const sizeBuf = Buffer.alloc(8)
    fs.readSync(fd, sizeBuf, 0, 8, 0)
    const headerSize = sizeBuf.readUInt32LE(4)
    const headerBuf = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuf, 0, headerSize, 8)
    const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + headerBuf.readUInt32LE(4)))
    const dataStart = 8 + headerSize
    return {
        read(path) {
            const node = path.split('/').filter(Boolean).reduce((n, seg) => n?.files?.[seg], header)
            if (node === undefined || node.files !== undefined) throw new Error(`asar 里没有文件 ${path}`)
            const buf = Buffer.alloc(node.size)
            fs.readSync(fd, buf, 0, node.size, dataStart + Number(node.offset))
            return buf.toString('utf8')
        },
        close() { fs.closeSync(fd) },
    }
}
