/** Download only a pinned official uv archive, verify before extraction or execution. */
import { spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync, readdirSync, copyFileSync, chmodSync, rmSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Digests from the official astral-sh/uv v0.13.6 GitHub release asset metadata.
// Changing version requires reviewing and updating all six independent pinned digests.
export const UV_VERSION = '0.13.6'
export const UV_ASSETS = Object.freeze({
  'darwin-arm64': ['uv-aarch64-apple-darwin.tar.gz', '60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472'],
  'darwin-x64': ['uv-x86_64-apple-darwin.tar.gz', '63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02'],
  'win32-arm64': ['uv-aarch64-pc-windows-msvc.zip', 'c2426c0c8e28b53d8c440e47a18d96ad4db51e159866c0e81435b196d7f0081c'],
  'win32-x64': ['uv-x86_64-pc-windows-msvc.zip', 'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f'],
  'linux-arm64': ['uv-aarch64-unknown-linux-gnu.tar.gz', '229e194255c7958d86d56e8790d969a6f74736592133f0dfd0076f754c642c1d'],
  'linux-x64': ['uv-x86_64-unknown-linux-gnu.tar.gz', 'f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645'],
})
const sha256Of = file => createHash('sha256').update(readFileSync(file)).digest('hex')
export function verifyArchive(file, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected || '') || sha256Of(file) !== expected) throw new Error('uv SHA-256 校验失败，已拒绝解压和执行')
}

export function findBin(name, dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { const hit = findBin(name, path); if (hit) return hit }
    else if (entry.isFile() && entry.name === name) return path
  }
  return null
}
export function extractArchive(binName, archive, into) {
  for (const [cmd, args] of [['tar', ['-xf', archive, '-C', into]], ['unzip', ['-o', archive, '-d', into]]]) {
    const result = spawnSync(cmd, args, { stdio: 'ignore', timeout: 60000, windowsHide: true })
    if (result.status === 0) { const hit = findBin(binName, into); if (hit) return hit }
  }
  return null
}

/** Cache metadata binds the installed binary to the verified archive; unmarked old caches are never executed. */
export async function ensureUv({ dir, log = () => {}, platform = process.platform, arch = process.arch,
  fetcher = fetch, extract = extractArchive, run = spawnSync }) {
  const asset = UV_ASSETS[`${platform}-${arch}`]
  if (!asset) { log(`uv 不支持自动安装到 ${platform}/${arch}，请自行安装 uv 并加入 PATH`); return null }
  const [name, digest] = asset
  const bin = platform === 'win32' ? 'uv.exe' : 'uv'
  const target = join(dir, bin), marker = join(dir, 'verified.json')
  try {
    const cached = JSON.parse(readFileSync(marker, 'utf8'))
    if (cached.version === UV_VERSION && cached.archive === digest && cached.binary === sha256Of(target)) return target
  } catch { /* Missing or unverified cache: download and verify again. */ }
  mkdirSync(dir, { recursive: true })
  const tmp = mkdtempSync(join(dir, '.uv-'))
  try {
    log(`正在从 GitHub 官方下载 uv ${UV_VERSION} (${platform}/${arch})`)
    const response = await fetcher(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${name}`, { signal: AbortSignal.timeout(120000) })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const archive = join(tmp, name)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive))
    verifyArchive(archive, digest)
    const hit = extract(bin, archive, tmp)
    if (!hit) throw new Error('无法解压 uv，请检查 tar / unzip')
    chmodSync(hit, 0o755)
    const result = run(hit, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    if (result.status !== 0 || !String(result.stdout).startsWith(`uv ${UV_VERSION}`)) throw new Error('uv 版本检查失败')
    copyFileSync(hit, target); chmodSync(target, 0o755)
    writeFileSync(marker, JSON.stringify({ version: UV_VERSION, archive: digest, binary: sha256Of(target) }))
    log('uv 官方归档校验通过，安装完成')
    return target
  } catch (error) {
    log(`uv 安装中止：${error.message}；可自行安装 uv 到 PATH 后重试`)
    return null
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}
