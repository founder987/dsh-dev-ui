#!/usr/bin/env node
/**
 * dsh-develop-ui 一键发布脚本
 *
 * 作用：把插件发布到 npm，并保证发布后的包能通过 DSH Desktop 插件市场
 * （dsh-community-market）的"可安装"复核，从而让用户在市场里直接一键安装，
 * 无需终端。脚本内的校验规则与 dsh-community-market/src/install/service.ts
 * 及 src/adapters/dsh-1024store.ts 保持一致：
 *
 *   1. 版本为稳定 semver（X.Y.Z，无 prerelease / build 元数据）
 *   2. package.json 的 repository 回链到 GitHub 仓库（repository_backlink）
 *   3. npm manifest 含 dsh.bundle.patch（DSH bundle 产物）
 *   4. 无 preinstall/install/postinstall/prepare 生命周期脚本
 *   5. 未标记 deprecated
 *   6. 依赖不含旧版 cordis；@deepseek-ai/cordis 满足 4.0.1、
 *      @deepseek-ai/dsh* 满足 0.1.0-rc.7、engines.node 接受 24.18.1
 *   7. dist.integrity 为 sha512、tarball 来自官方 registry.npmjs.org
 *
 * 用法（Windows 下请用 npm.cmd）：
 *   node scripts/publish.mjs            # 默认 patch 升版发布
 *   node scripts/publish.mjs minor      # minor 升版发布
 *   node scripts/publish.mjs 0.3.0      # 指定精确版本发布
 *   node scripts/publish.mjs --dry-run  # 只预检 + 打印计划，不写文件不发布
 *   node scripts/publish.mjs --no-publish  # 完成构建/升版/市场同步，跳过 npm publish
 *   node scripts/publish.mjs --skip-build  # 跳过 build/typecheck
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_PATH = join(ROOT, 'package.json')
const MARKET_PLUGINS = join(ROOT, 'market', 'v1', 'plugins')
const MARKET_SOURCE = join(ROOT, 'market', 'catalog-source.json')
const ENTRY_1024 = join(ROOT, 'market', '1024store', 'founder987--dsh-dev-ui.json')
const BUNDLE_PATCH = join(ROOT, 'cordis.patch.yml')

/** DSH Desktop 内置运行时版本（与市场安装复核一致，勿改） */
const RUNTIME = { dsh: '0.1.0-rc.7', cordis: '4.0.1', node: '24.18.1' }
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']
const NPM_REGISTRY = 'https://registry.npmjs.org'
const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const STABLE_SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

// ---------------------------------------------------------------- 小工具

function npmCmd() {
  // Windows 上直接 spawnSync('npm.cmd', args) 会 EINVAL（Node >= 20.12 不再隐式走 cmd.exe），
  // 因此用 shell:true 并把参数拼成命令行字符串；本项目参数均为固定字面量，无注入面。
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function npmCommand(args) {
  const cmd = npmCmd()
  return process.platform === 'win32' ? `${cmd} ${args.join(' ')}` : cmd
}

function run(args, opts = {}) {
  const win = process.platform === 'win32'
  const res = spawnSync(npmCommand(args), win ? [] : args, {
    stdio: 'inherit',
    ...(win ? { shell: true } : {}),
    ...opts,
  })
  if (res.error) throw Object.assign(new Error(`无法执行 ${npmCommand(args)}: ${res.error.message}`), { exitCode: 1 })
  if (res.status !== 0) throw Object.assign(new Error(`命令失败: ${npmCommand(args)}（退出码 ${res.status}）`), { exitCode: res.status ?? 1 })
}

function runCapture(args) {
  const win = process.platform === 'win32'
  return spawnSync(npmCommand(args), win ? [] : args, {
    encoding: 'utf8',
    ...(win ? { shell: true } : {}),
  })
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function log(step, msg) {
  console.log(`[${step}] ${msg}`)
}

function warn(msg) {
  console.log(`[WARN] ${msg}`)
}

function ok(msg) {
  console.log(`[ OK ] ${msg}`)
}

function fail(msg) {
  console.log(`[ERR ] ${msg}`)
  process.exitCode = 1
}

// ---------------------------------------------------------------- 迷你 semver

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/.exec(String(v).trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1 // release > prerelease
  if (b.pre.length === 0) return -1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) { if (+x !== +y) return +x - +y; continue }
    if (xn) return -1
    if (yn) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function matchComparator(v, tok) {
  const m = /^(<=|>=|<|>|\^|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tok)
  if (!m) return false
  const op = m[1] ?? '='
  const rv = parseVersion(m[2])
  if (!rv) return false
  switch (op) {
    case '=': return compareVersions(v, rv) === 0
    case '<': return compareVersions(v, rv) < 0
    case '>': return compareVersions(v, rv) > 0
    case '<=': return compareVersions(v, rv) <= 0
    case '>=': return compareVersions(v, rv) >= 0
    case '^': {
      if (compareVersions(v, rv) < 0) return false
      let upper
      if (rv.major > 0) upper = { major: rv.major + 1, minor: 0, patch: 0, pre: [] }
      else if (rv.minor > 0) upper = { major: 0, minor: rv.minor + 1, patch: 0, pre: [] }
      else upper = { major: 0, minor: 0, patch: rv.patch + 1, pre: [] }
      return compareVersions(v, upper) < 0
    }
    default: return false
  }
}

/** 极简 satisfies：支持 ^、>=、<=、>、<、=、裸版本与 || 组合（本项目依赖范围足够） */
function satisfies(version, range) {
  const v = parseVersion(version)
  if (!v) return false
  const alts = String(range).trim().split(/\s*\|\|\s*/)
  return alts.some((alt) => {
    const tokens = alt.trim().split(/\s+/).filter(Boolean)
    return tokens.length > 0 && tokens.every((tok) => matchComparator(v, tok))
  })
}

function bumpVersion(current, target) {
  const v = parseVersion(current)
  if (!v) throw new Error(`当前版本不是合法 semver: ${current}`)
  if (STABLE_SEMVER_PATTERN.test(target)) return target // 精确版本
  switch (target) {
    case 'patch': v.patch += 1; break
    case 'minor': v.minor += 1; v.patch = 0; break
    case 'major': v.major += 1; v.minor = 0; v.patch = 0; break
    default: throw new Error(`未知升版目标: ${target}（应为 patch|minor|major 或 X.Y.Z）`)
  }
  return `${v.major}.${v.minor}.${v.patch}`
}

// ---------------------------------------------------------------- 校验（与市场一致）

function normalizeRepoUrl(value) {
  let url = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && typeof value.url === 'string' ? value.url : undefined
  if (!url) return undefined
  if (url.startsWith('git+')) url = url.slice(4)
  url = url.replace(/\.git$/i, '')
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') return undefined
    return u.href.replace(/\/$/, '')
  } catch {
    return undefined
  }
}

function safeBundlePatch(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) return false
  const path = value.startsWith('./') ? value.slice(2) : value
  return path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && path.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && !seg.includes(':'))
}

/** 对一份 npm manifest 执行市场安装复核，返回错误列表（空数组 = 可安装） */
function verifyInstallable(manifest, expected) {
  const errors = []
  if (manifest.name !== expected.name || manifest.version !== expected.version) {
    errors.push(`npm 身份不匹配: 期望 ${expected.name}@${expected.version}，实际 ${manifest.name}@${manifest.version}`)
  }
  if (manifest.deprecated !== undefined) errors.push('npm 上已标记 deprecated，市场拒绝安装')
  const scripts = manifest.scripts
  if (scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)) {
    for (const s of LIFECYCLE_SCRIPTS) if (typeof scripts[s] === 'string' && scripts[s].length > 0) {
      errors.push(`存在生命周期脚本 ${s}，市场拒绝安装`)
    }
  }
  const repoUrl = normalizeRepoUrl(manifest.repository)
  if (!repoUrl || repoUrl !== expected.repositoryUrl) {
    errors.push(`repository 回链不匹配: 期望 ${expected.repositoryUrl}，实际 ${repoUrl ?? '(缺失)'}`)
  }
  const patch = manifest.dsh && typeof manifest.dsh === 'object' && !Array.isArray(manifest.dsh)
    ? manifest.dsh.bundle && typeof manifest.dsh.bundle === 'object' ? manifest.dsh.bundle.patch : undefined
    : undefined
  if (!safeBundlePatch(patch)) errors.push('缺少合法的 dsh.bundle.patch（DSH bundle 产物）')
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = manifest[field]
    if (deps === undefined) continue
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) { errors.push(`${field} 元数据非法`); continue }
    for (const [name, range] of Object.entries(deps)) {
      if (name === 'cordis') { errors.push('依赖了旧版 cordis，与 DSH Desktop 不兼容'); continue }
      const runtime = name === '@deepseek-ai/cordis' ? RUNTIME.cordis
        : name.startsWith('@deepseek-ai/dsh') ? RUNTIME.dsh : undefined
      if (runtime !== undefined && !satisfies(runtime, String(range))) {
        errors.push(`${name} ${range} 不满足内置运行时 ${runtime}`)
      }
    }
  }
  const nodeRange = manifest.engines && typeof manifest.engines === 'object' ? manifest.engines.node : undefined
  if (nodeRange !== undefined && !satisfies(RUNTIME.node, String(nodeRange))) {
    errors.push(`engines.node ${nodeRange} 不接受内置 Node ${RUNTIME.node}`)
  }
  const dist = manifest.dist
  if (dist === null || typeof dist !== 'object' || Array.isArray(dist)) {
    errors.push('缺少 dist 元数据')
  } else {
    if (typeof dist.integrity !== 'string' || !dist.integrity.startsWith('sha512-')) errors.push('dist.integrity 非 sha512')
    const tarball = dist.tarball
    if (typeof tarball !== 'string' || !tarball.startsWith(`${NPM_REGISTRY}/`) || !tarball.endsWith('.tgz')) {
      errors.push('dist.tarball 非官方 npm registry 产物')
    }
  }
  return errors
}

async function fetchJson(url) {
  // 手动 AbortController + clearTimeout：避免 AbortSignal.timeout 的定时器在进程退出时
  // 仍挂起，触发 Windows 下 libuv 的 UV_HANDLE_CLOSING 断言崩溃（uv async handle race）。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'dsh-develop-ui-publish' },
    })
    const body = res.status === 200 ? await res.json() : undefined
    return { ok: res.ok, status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- 预检

function preflightLocal(pkg) {
  const errors = []
  const problems = []
  if (!NPM_PACKAGE_PATTERN.test(pkg.name)) problems.push(`包名非法: ${pkg.name}`)
  if (!STABLE_SEMVER_PATTERN.test(pkg.version)) problems.push(`版本不是稳定 semver: ${pkg.version}（市场要求 X.Y.Z）`)
  const repoUrl = normalizeRepoUrl(pkg.repository)
  if (!repoUrl) problems.push('缺少指向 GitHub 的 repository 字段（repository_backlink 必需）')
  if (!safeBundlePatch(pkg.dsh?.bundle?.patch)) problems.push('dsh.bundle.patch 缺失或非法')
  if (!existsSync(BUNDLE_PATCH)) problems.push(`dsh.bundle.patch 指向的文件不存在: ${pkg.dsh?.bundle?.patch ?? '(无)'}`)
  for (const s of LIFECYCLE_SCRIPTS) if (typeof pkg.scripts?.[s] === 'string' && pkg.scripts[s].length > 0) {
    problems.push(`存在生命周期脚本 ${s}`)
  }
  if (pkg.publishConfig?.registry && pkg.publishConfig.registry !== NPM_REGISTRY) {
    warn(`publishConfig.registry 为 ${pkg.publishConfig.registry}，将按此发布`)
  }
  const manifestErrors = verifyInstallable(pkg, {
    name: pkg.name,
    version: pkg.version,
    repositoryUrl: repoUrl ?? '',
  })
  problems.push(...manifestErrors.filter((e) => !e.includes('dist') && !e.includes('deprecated')))
  return { errors: problems, repoUrl }
}

// ---------------------------------------------------------------- 主流程

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const positional = args.find((a) => !a.startsWith('--'))
const dryRun = flags.has('--dry-run')
const noPublish = flags.has('--no-publish')
const skipBuild = flags.has('--skip-build')
const target = positional ?? 'patch'

async function main() {
console.log('============================================================')
console.log(' dsh-develop-ui 一键发布')
console.log(` 目标版本: ${target}   模式: ${dryRun ? 'DRY-RUN(只预检)' : noPublish ? '构建+升版+市场同步(不发布)' : '完整发布'}`)
console.log('============================================================')

// 1. 预检
log('预检', '读取 package.json')
const pkg = readJson(PKG_PATH)
const { errors, repoUrl } = preflightLocal(pkg)
if (repoUrl) ok(`repository 回链: ${repoUrl}`)
ok(`当前版本: ${pkg.version}`)
let nextVersion
if (STABLE_SEMVER_PATTERN.test(target)) {
  if (target === pkg.version) {
    fail(`目标版本 ${target} 与当前版本相同，请先升版`)
    return
  }
  nextVersion = target
} else if (['patch', 'minor', 'major'].includes(target)) {
  nextVersion = bumpVersion(pkg.version, target)
} else {
  fail(`非法目标: ${target}（应为 patch|minor|major 或 X.Y.Z）`)
  return
}
ok(`目标版本: ${nextVersion}`)

if (errors.length > 0) {
  for (const e of errors) fail(`预检失败: ${e}`)
  console.log('请修复后重试。若为误报，可检查 dsh-community-market 的安装复核规则。')
  return
} else {
  ok('本地清单预检通过（与市场安装复核一致）')
}

// 2. 线上预检（npm 身份 / 目标版本是否已存在）
const publishRegistry = pkg.publishConfig?.registry ?? NPM_REGISTRY
log('预检', `发布目标 registry: ${publishRegistry}`)
let defaultRegistry = ''
try {
  defaultRegistry = (runCapture(['config', 'get', 'registry']).stdout ?? '').trim()
} catch { /* 忽略 registry 读取失败 */ }
if (defaultRegistry && defaultRegistry !== publishRegistry) {
  warn(`npm 默认 registry 是 ${defaultRegistry}（镜像），发布目标是 ${publishRegistry}；` +
    '发布会走 publishConfig.registry 不受影响，但登录必须显式指定 --registry')
}
if (dryRun || noPublish) {
  warn('跳过 npm 身份检查（--dry-run / --no-publish）')
} else {
  log('预检', `npm 登录状态（${publishRegistry}）`)
  const who = runCapture(['whoami', '--registry', publishRegistry])
  if (who.status !== 0) {
    const detail = (who.stderr || who.stdout || '').trim()
    fail(`未登录到 ${publishRegistry}${detail ? `：${detail.slice(0, 300)}` : ''}`)
    console.log('请先登录官方 npm（你的默认 registry 可能是镜像，务必带 --registry）:')
    console.log(`  npm.cmd login --registry ${publishRegistry}`)
    console.log(`  （或: npm.cmd adduser --registry ${publishRegistry}）`)
    return
  }
  ok(`npm 身份: ${who.stdout.trim()}`)
}

log('预检', `检查 ${pkg.name}@${nextVersion} 是否已发布`)
try {
  const remote = await fetchJson(`${NPM_REGISTRY}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(nextVersion)}`)
  if (remote.status === 200) {
    fail(`npm 上已存在 ${pkg.name}@${nextVersion}，请选择更高版本`)
    if (!dryRun) return
  } else if (remote.ok || remote.status === 404) {
    ok(`${pkg.name}@${nextVersion} 尚未发布`)
  } else {
    warn(`registry 返回 ${remote.status}，无法确认版本占用（发布时会再次校验）`)
  }
} catch (e) {
  warn(`无法连接 npm registry（${e.message}），跳过线上版本检查`)
}

// 3. market 文件一致性预检
log('预检', 'market 目录一致性')
let marketPlugins
try {
  marketPlugins = readJson(MARKET_PLUGINS)
  const item = marketPlugins.items?.find?.((i) => i.package?.name === pkg.name)
  if (!item) {
    warn(`${MARKET_PLUGINS} 中找不到 ${pkg.name} 条目，将跳过 market/v1/plugins 同步`)
    marketPlugins = null
  } else {
    const itemRepo = normalizeRepoUrl(item.repository)
    if (itemRepo && repoUrl && itemRepo !== repoUrl) {
      warn(`v1/plugins 的 repository(${itemRepo}) 与 package.json(${repoUrl}) 不一致，安装复核可能失败`)
    } else {
      ok('v1/plugins 的 repository 与 package.json 回链一致')
    }
  }
} catch (e) {
  warn(`无法读取 ${MARKET_PLUGINS}: ${e.message}`)
  marketPlugins = null
}

let sourceManifest
try {
  sourceManifest = readJson(MARKET_SOURCE)
  const endpoint = sourceManifest.transport?.endpoint ?? ''
  if (endpoint.includes('YOUR-HOST')) {
    warn('catalog-source.json 的 transport.endpoint 仍是占位符 https://YOUR-HOST/v1/plugins，'
      + '用户将无法添加该标准来源；发布后请部署 market/ 并替换为真实域名')
  } else {
    ok(`标准来源 endpoint: ${endpoint}`)
  }
} catch (e) {
  warn(`无法读取 ${MARKET_SOURCE}: ${e.message}`)
}

if (dryRun) {
  console.log('------------------------------------------------------------')
  console.log('DRY-RUN 计划（未做任何修改）:')
  console.log(`  1. npm run build + typecheck（${skipBuild ? '已跳过' : '执行'}）`)
  console.log(`  2. package.json 版本 ${pkg.version} -> ${nextVersion}`)
  console.log(`  3. 同步 market/v1/plugins: latestVersion=${nextVersion}, updatedAt=今天`)
  console.log(`  4. npm publish（${noPublish ? '跳过' : '执行'}）`)
  console.log('  5. 对 registry.npmjs.org 上的发布产物执行市场安装复核')
  console.log('------------------------------------------------------------')
  return
}

// 4. 构建 + 类型检查
if (!skipBuild) {
  log('构建', 'npm run build')
  run(['run', 'build'])
  log('构建', 'npm run typecheck')
  run(['run', 'typecheck'])
  ok('构建与类型检查通过')
} else {
  warn('跳过构建（--skip-build）')
}

// 5. 升版 + 写入 package.json
log('升版', `${pkg.version} -> ${nextVersion}`)
pkg.version = nextVersion
writeJson(PKG_PATH, pkg)
ok(`package.json 已更新为 ${nextVersion}`)

// 6. 同步 market 文件
if (marketPlugins) {
  log('市场', '同步 market/v1/plugins')
  const item = marketPlugins.items.find((i) => i.package?.name === pkg.name)
  item.latestVersion = nextVersion
  item.updatedAt = new Date().toISOString()
  writeJson(MARKET_PLUGINS, marketPlugins)
  ok(`market/v1/plugins 已同步 latestVersion=${nextVersion}`)
} else {
  warn('跳过 market/v1/plugins 同步')
}

// 7. 发布
if (!noPublish) {
  log('发布', `npm publish（registry: ${publishRegistry}）`)
  run(['publish', '--registry', publishRegistry])
  ok('npm 发布成功')
} else {
  warn('跳过 npm publish（--no-publish）')
}

// 8. 线上复核（模拟市场安装验证）
log('复核', `对 ${pkg.name}@${nextVersion} 执行市场安装复核`)
try {
  const remote = await fetchJson(`${NPM_REGISTRY}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(nextVersion)}`)
  if (remote.status !== 200) {
    fail(`线上复核失败: registry 返回 ${remote.status}`)
  } else {
    const verifyErrors = verifyInstallable(remote.body, {
      name: pkg.name,
      version: nextVersion,
      repositoryUrl: repoUrl ?? '',
    })
    if (verifyErrors.length === 0) {
      ok('线上复核通过 —— 该版本可在 DSH Desktop 插件市场一键安装')
    } else {
      for (const e of verifyErrors) fail(`线上复核失败: ${e}`)
      console.log('注：本地预检通过但线上复核失败，通常意味着发布产物与本地不一致，请检查 files 字段。')
    }
  }
} catch (e) {
  warn(`无法连接 npm registry，跳过线上复核（${e.message}）`)
}

// 9. 后续步骤
console.log('------------------------------------------------------------')
console.log('发布完成。接下来：')
console.log('  1. 提交本次改动: git add package.json market/v1/plugins && git commit && git push')
console.log('  2. 若标准来源尚未上线: 部署 market/ 目录（Cloudflare Pages/Netlify/Vercel），')
console.log('     并把 catalog-source.json 的 https://YOUR-HOST/v1/plugins 替换为真实域名')
console.log('  3. 1024Store 上架: fork imsai-sh/awesome-deepseek-harness-plugins，')
console.log('     把 market/1024store/founder987--dsh-dev-ui.json 复制到 catalog/plugins/ 后提 PR（仅含该文件）')
console.log('  4. 验证收录: curl "https://deepseek1024.com/api/v1/plugins?q=dsh-dev-ui"')
console.log('     桌面端: 插件市场 -> 来源 -> 选 DSH 1024Store（或你的标准来源）-> 刷新 -> 搜索 dsh-dev-ui -> 安装')
console.log('------------------------------------------------------------')
}

main().then(
  () => {},
  (err) => {
    if (err && err.stack) console.error(err.stack)
    else console.error(err)
    process.exitCode = err && typeof err.exitCode === 'number' ? err.exitCode : 1
  },
)
