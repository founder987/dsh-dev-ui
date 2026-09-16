#!/usr/bin/env node
/**
 * dsh-develop-ui 一键安装 / 卸载脚本（DSH Desktop · Windows）
 *
 * 把本插件装进 DSH Desktop 的 profile（默认 C:\Users\User\.dsh\profiles\desktop），
 * 完成 4 件事：装包 → 注册 bundle → 校验产物 → 打印重启与验证指引。
 *
 * 用法：
 *   node scripts/install-plugin.mjs                          # 有匹配 tarball 就用它，否则回落到 npm 上的已发布版
 *   node scripts/install-plugin.mjs --from local             # 强制重新构建 + pnpm pack 后装本地 tarball
 *   node scripts/install-plugin.mjs --from npm               # 装 npm 上已发布版本（不构建）
 *   node scripts/install-plugin.mjs --version 0.1.5          # 指定 npm 版本（隐含 --from npm）
 *   node scripts/install-plugin.mjs --force                  # 先 pnpm remove 再装，清掉旧版残留
 *   node scripts/install-plugin.mjs --dry-run                # 只打印将要执行的动作，不落盘
 *   node scripts/install-plugin.mjs --uninstall              # 从 profile 卸载（包 + bundle 注册）
 *   node scripts/install-plugin.mjs --profile "D:\x\profiles\desktop"   # 换 profile 目录
 *   node scripts/install-plugin.mjs --registry https://registry.npmjs.org   # 指定 registry（默认沿用环境 .npmrc）
 *
 * 说明：
 *  - 安装后必须**完全退出并重启 DSH Desktop**，bundle 才会加载；
 *    重启会中断正在进行的会话，脚本不代为重启（避免把自己所在的会话杀掉）。
 *  - profile 为 nodeLinker: hoisted + autoInstallPeers: false：
 *    peerDeps（react、@deepseek-ai/*）由 DSH 运行时提供，dependencies 由 pnpm add 装入。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_PATH = join(ROOT, 'package.json')
const DEFAULT_PROFILE = join(process.env.USERPROFILE ?? 'C:\\Users\\User', '.dsh', 'profiles', 'desktop')
const BUNDLE_PATCH_FILE = 'cordis.patch.yml'

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2)
function flag(name) { return argv.includes(`--${name}`) }
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

const wantVersion = opt('version', undefined)
let from = opt('from', wantVersion ? 'npm' : 'auto')
if (wantVersion) from = 'npm'
const dryRun = flag('dry-run')
const force = flag('force')
const uninstall = flag('uninstall')
const profileDir = resolve(opt('profile', DEFAULT_PROFILE))
const profilePkgPath = join(profileDir, 'package.json')
// 默认不指定 registry：沿用用户/环境的 npm 配置（本机为 registry.npmmirror.com）。
// 用 --registry 显式覆盖时才会带 --registry 参数。
const registry = opt('registry', undefined)

// ---------------------------------------------------------------- 输出
const log = (step, msg) => console.log(`[${step}] ${msg}`)
const ok = (msg) => console.log(`[ OK ] ${msg}`)
const warn = (msg) => console.log(`[WARN] ${msg}`)
const fail = (msg) => { console.log(`[ERR ] ${msg}`); process.exitCode = 1 }
const plan = (msg) => console.log(`  · ${msg}`)
const die = (msg) => { fail(msg); process.exit(1) }

// ---------------------------------------------------------------- 子进程
function pnpmCmd() { return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm' }
/** 跑一条 shell 命令，成功返回，失败退出 */
function shellRun(command, cwd) {
  const res = spawnSync(command, { stdio: 'inherit', cwd, shell: true })
  if (res.error) die(`无法执行 ${command}: ${res.error.message}`)
  if (res.status !== 0) die(`命令失败: ${command}（退出码 ${res.status}）`)
}
/** 跑一条 pnpm 命令，返回退出码（不自动退出；有些"非 0"其实安装已成功，见 isPluginInstalled） */
function pnpm(args, cwd) {
  const line = `${pnpmCmd()} ${args.join(' ')}`
  log('执行', line)
  const res = spawnSync(line, { stdio: 'inherit', cwd, shell: true })
  if (res.error) die(`无法执行 ${line}: ${res.error.message}`)
  return res.status ?? 1
}

const installedPkgPath = () => join(profileDir, 'node_modules', pluginName, 'package.json')
const isPluginInstalled = () => existsSync(installedPkgPath())

/**
 * 从 "pkg@1.2.3" / "@scope/pkg@^1.2.3" 里取出版本部分（含范围前缀）；
 * 取不到（如 "pkg@latest" 之外的标签）返回 undefined。
 */
function versionPartOf(spec) {
  const i = spec.lastIndexOf('@')
  if (i <= 0) return undefined
  const v = spec.slice(i + 1).trim()
  return /^(?:\^|~|>=|<=|>|<|=)?\s*v?\d/.test(v) ? v : undefined
}

/**
 * pnpm add 在"装完包但之后崩掉"时（例如某个依赖的原生构建脚本 spawn 失败）
 * 可能只写了 lock 文件、没写 package.json 的 dependencies。那样后续 pnpm remove
 * 会报 ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS，profile 处于半成品状态。
 * 这里做一次清单自愈：补上 dependencies 并用 --lockfile-only 对齐锁文件。
 */
function ensureManifestDependency() {
  const manifest = readJson(profilePkgPath)
  if (!manifest.dependencies?.[pluginName]) {
    log('②b 自愈', `package.json 缺少 dependencies.${pluginName}，补写并对齐锁文件`)
    // 依赖声明必须是合法 spec：
    //  - 本地 tarball → file: 前缀的 POSIX 路径（裸 Windows 路径非法）
    //  - registry 版本 → 只保留版本部分（把 "pkg@1.2.3" 整个写成值会变成非法 spec）
    const depSpec = spec.endsWith('.tgz') || spec.startsWith(profileDir)
      ? `file:${spec.replace(/\\/g, '/')}`
      : versionPartOf(spec) ?? '*'
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [pluginName]: depSpec }
    writeJson(profilePkgPath, manifest)
    const status = pnpm(['install', '--lockfile-only'], profileDir)
    if (status !== 0) warn(`pnpm install --lockfile-only 返回 ${status}，锁文件可能未对齐`)
    // 对齐过程可能再次改写 package.json：复核一次，必要时回写
    const after = readJson(profilePkgPath)
    if (!after.dependencies?.[pluginName]) {
      after.dependencies = { ...(after.dependencies ?? {}), [pluginName]: depSpec }
      writeJson(profilePkgPath, after)
      warn('pnpm 对齐时又删掉了该依赖声明，已按 file: 规范回写')
    }
    ok(`已写入 dependencies.${pluginName}: ${depSpec}`)
  }
  // 关键：让内存对象与磁盘一致。否则后面"注册 bundle"会用开头的旧快照回写 package.json，
  // 把刚补上的 dependencies 覆盖掉（陈旧读-改-写）。
  Object.assign(profilePkg, readJson(profilePkgPath))
}

/** 读 JSON 时剥掉 UTF-8 BOM：Windows 编辑器（记事本/PowerShell 重定向）很容易写进 BOM */
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8')

// ---------------------------------------------------------------- 预检
if (!existsSync(PKG_PATH)) die(`找不到 ${PKG_PATH}`)
const pkg = readJson(PKG_PATH)
const pluginName = pkg.name
const pluginVersion = pkg.version
const tarballName = `${pluginName}-${pluginVersion}.tgz`
const tarballPath = join(ROOT, tarballName)

if (!existsSync(profileDir)) {
  die(`找不到 profile 目录: ${profileDir}\n`
    + '  DSH Desktop 至少启动过一次才会生成该目录；或用 --profile <dir> 指定其他 profile。')
}
if (!existsSync(profilePkgPath)) die(`找不到 ${profilePkgPath}（不是有效的 DSH profile）`)

/** pnpm add 的 registry 参数：未显式指定时留空，pnpm 沿用环境/用户 .npmrc 配置 */
const registryArgs = registry ? ['--registry', registry] : []
const registryLabel = registry ?? '(沿用环境 npm 配置)'

console.log('============================================================')
console.log(` ${pluginName} 一键${uninstall ? '卸载' : '安装'}`)
console.log(` 插件源码 : ${ROOT}`)
console.log(` 本地版本 : ${pluginVersion}`)
console.log(` 目标 profile: ${profileDir}`)
console.log(` registry : ${registryLabel}`)
console.log(` 模式     : ${uninstall ? 'uninstall' : from}${force ? ' +force' : ''}${dryRun ? ' +dry-run' : ''}`)
console.log('============================================================')

const profilePkg = readJson(profilePkgPath)
const bundles = profilePkg?.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  die(`${profilePkgPath} 缺少 dsh.profile.bundles 数组，无法注册插件`
    + '（该文件可能被改坏，请先还原成 DSH 生成的默认内容）')
}

// ---------------------------------------------------------------- 卸载
if (uninstall) {
  log('卸载', '从 profile 移除插件包与 bundle 注册')
  const pkgDir = join(profileDir, 'node_modules', pluginName)
  const willRemovePkg = existsSync(pkgDir)
  const recorded = Boolean(profilePkg.dependencies?.[pluginName])
  const willUnregister = bundles.includes(pluginName)
  if (!willRemovePkg && !willUnregister && !recorded) {
    warn(`${pluginName} 未安装，无需卸载`)
  } else {
    if (dryRun) {
      if (willRemovePkg) plan(`pnpm remove ${pluginName}`)
      if (recorded) plan(`从 dependencies 移除 "${pluginName}"`)
      if (willUnregister) plan(`从 dsh.profile.bundles 移除 "${pluginName}"`)
    } else {
      if (willRemovePkg && recorded) {
        pnpm(['remove', pluginName], profileDir)
        // pnpm remove 在"之前有过构建失败"等中间态下可能退出 0 却不删目录 —— 兜底清掉
        if (existsSync(pkgDir)) {
          rmSync(pkgDir, { recursive: true, force: true })
          warn('pnpm remove 未清掉 node_modules 中的插件目录，已手动删除')
        }
      } else if (willRemovePkg) {
        // 半成品状态：包装上了但清单没记（见 ensureManifestDependency 注释），pnpm remove 会直接报错
        warn(`package.json 未记录 ${pluginName} 依赖（半成品安装），直接清理目录`)
        rmSync(pkgDir, { recursive: true, force: true })
      } else {
        warn('profile node_modules 中已无该包，跳过删除')
      }
      if (recorded) {
        const nextDeps = { ...profilePkg.dependencies }
        delete nextDeps[pluginName]
        if (Object.keys(nextDeps).length === 0) delete profilePkg.dependencies
        else profilePkg.dependencies = nextDeps
      }
      if (willUnregister) {
        profilePkg.dsh.profile.bundles = bundles.filter((b) => b !== pluginName)
      }
      if (recorded || willUnregister) {
        const backup = `${profilePkgPath}.bak`
        copyFileSync(profilePkgPath, backup)
        writeJson(profilePkgPath, profilePkg)
        ok(`已更新 ${profilePkgPath}（备份: ${backup}）`)
        ok(`bundles: ${JSON.stringify(profilePkg.dsh.profile.bundles)}`)
        ok(`dependencies: ${JSON.stringify(profilePkg.dependencies ?? {})}`)
      }
    }
  }
  console.log('------------------------------------------------------------')
  console.log('卸载完成。完全退出并重启 DSH Desktop 后，官方布局（ui-layout）自动恢复。')
  process.exit(process.exitCode ?? 0)
}

// ---------------------------------------------------------------- 安装：① 确定安装源
let spec // pnpm add 的包说明符
let sourceLabel
if (from === 'local') {
  log('① 构建', 'node build.mjs && tsc --emitDeclarationOnly')
  if (dryRun) plan('node build.mjs')
  else shellRun('node build.mjs', ROOT)
  if (dryRun) plan('tsc --emitDeclarationOnly')
  else shellRun('tsc --emitDeclarationOnly', ROOT)
  ok('构建完成（lib/index.js + lib/client.js）')

  log('① 打包', `pnpm pack → ${tarballName}`)
  if (dryRun) plan(`pnpm pack`)
  else pnpm(['pack'], ROOT)
  if (!dryRun && !existsSync(tarballPath)) die(`打包后仍找不到 ${tarballPath}，请检查 pnpm pack 输出`)
  spec = tarballPath
  sourceLabel = `本地 tarball（${pluginVersion}）`
} else if (from === 'npm') {
  const version = wantVersion ?? pluginVersion
  spec = `${pluginName}@${version}`
  sourceLabel = `npm registry（${spec}）`
  if (wantVersion && wantVersion !== pluginVersion) {
    warn(`将安装 npm 上的 ${wantVersion}，与本地 package.json 的 ${pluginVersion} 不同`)
  }
} else if (from === 'auto') {
  if (existsSync(tarballPath)) {
    spec = tarballPath
    sourceLabel = `已存在的本地 tarball（${tarballName}，未重新构建；如需重建请用 --from local）`
  } else {
    spec = `${pluginName}@${pluginVersion}`
    sourceLabel = `npm registry（本地无 ${tarballName}，回落 npm）`
  }
} else {
  die(`未知 --from 取值: ${from}（应为 auto|local|npm）`)
}
log('① 安装源', sourceLabel)

if (!dryRun && spec === tarballPath && !existsSync(spec)) die(`找不到 ${spec}`)
if (!dryRun && spec.startsWith(profileDir)) die('安装源不能位于 profile 目录内')

// ---------------------------------------------------------------- 安装：② 装包
log('② 装包', `pnpm add（registry: ${registryLabel}）`)
if (dryRun) {
  plan(`pnpm remove ${pluginName}  （仅 --force，清理旧版残留）`)
  plan(`pnpm add "${spec}" ${registryArgs.join(' ')}`.trim())
} else {
  const alreadyInstalled = isPluginInstalled()
  const manifestDeps = readJson(profilePkgPath).dependencies ?? {}
  if (alreadyInstalled && !manifestDeps[pluginName]) {
    // 目录在、清单没记 = 上次安装的半成品：先清掉。
    // 否则本次 pnpm add 失败时会被这个残留目录误判成"已装好"。
    warn('检测到上次安装的半成品（有目录无依赖声明），先清理再装')
    rmSync(join(profileDir, 'node_modules', pluginName), { recursive: true, force: true })
  } else if (alreadyInstalled && force) {
    pnpm(['remove', pluginName], profileDir)
    rmSync(join(profileDir, 'node_modules', pluginName), { recursive: true, force: true })
  } else if (alreadyInstalled) {
    warn(`profile 中已存在 ${pluginName}，将直接覆盖（如遇旧版残留可加 --force 先 remove）`)
  }
  // 只有"这次真的装上了"才算成功：pnpm 失败时可能留下空目录，
  // 用"装前不存在 → 装后存在"判断，避免把残留误判为成功。
  const existedBefore = isPluginInstalled()
  const status = pnpm(['add', spec, ...registryArgs], profileDir)
  const existedAfter = isPluginInstalled()
  if (status !== 0) {
    // pnpm 在"安装成功但有被忽略/失败的构建脚本"时也可能返回非 0：此时包确实装上了，不能当硬失败。
    if (!existedBefore && existedAfter) {
      warn(`pnpm add 返回 ${status}，但包已装入 profile —— 按成功继续`)
    } else {
      die(`pnpm add 失败（退出码 ${status}）；请检查上面的 pnpm 报错后再重试`)
    }
  } else if (!existedAfter) {
    die('pnpm add 返回 0，但 profile 中找不到插件目录 —— 安装未生效')
  }
  ensureManifestDependency()
}

// ---------------------------------------------------------------- 安装：③ 注册 bundle
log('③ 注册', '把插件写入 dsh.profile.bundles')
if (bundles.includes(pluginName)) {
  ok(`bundles 中已存在 ${pluginName}，无需改动`)
} else if (dryRun) {
  plan(`bundles 追加 "${pluginName}" → ${JSON.stringify([...bundles, pluginName])}`)
} else {
  const backup = `${profilePkgPath}.bak`
  copyFileSync(profilePkgPath, backup)
  profilePkg.dsh.profile.bundles = [...bundles, pluginName]
  writeJson(profilePkgPath, profilePkg)
  ok(`已注册 ${pluginName}（备份: ${backup}）`)
  ok(`当前 bundles: ${JSON.stringify(profilePkg.dsh.profile.bundles)}`)
}

// ---------------------------------------------------------------- 安装：④ 校验产物
/** 校验装入 profile 的产物，返回已安装版本（null = 校验未通过） */
function verifyInstalled() {
  const installedAt = join(profileDir, 'node_modules', pluginName)
  const checks = [
    ['host 半产物', join(installedAt, 'lib', 'index.js')],
    ['client 半产物', join(installedAt, 'lib', 'client.js')],
    ['bundle patch', join(installedAt, BUNDLE_PATCH_FILE)],
  ]
  let good = true
  for (const [label, file] of checks) {
    if (existsSync(file)) ok(`${label}: ${file}`)
    else { fail(`${label} 缺失: ${file}`); good = false }
  }
  if (!good) {
    fail('产物不完整，多半是打包内容缺失：用 --from local 重建后重装')
    return null
  }
  let installedPkg = {}
  try { installedPkg = readJson(installedPkgPath()) } catch { /* 忽略 */ }
  const installedVersion = installedPkg.version ?? '(未知)'
  ok(`profile 中已安装版本: ${installedVersion}`)

  // 本地 tarball 安装时，期望版本 = 本地 package.json 版本
  if (spec === tarballPath && installedVersion !== pluginVersion) {
    warn(`期望 ${pluginVersion}，实际 ${installedVersion}（pnpm 可能命中缓存；可加 --force 重装）`)
  }
  const patch = installedPkg?.dsh?.bundle?.patch
  if (patch && !existsSync(join(installedAt, patch))) warn(`dsh.bundle.patch 指向的文件不存在: ${patch}`)
  if (!patch) fail('装入包的 package.json 缺少 dsh.bundle.patch，DSH 不会把它当 bundle 加载')

  // node-pty 是原生模块：pnpm 默认拦截其构建脚本，未编译则终端面板不可用。
  // node-pty 的 loadNativeModule 依次看 build/Release → build/Debug → prebuilds/<platform>-<arch>；
  // 且 win32 加载 conpty / conpty_console_list，POSIX 加载 pty（2026-09-16：原先只看
  // build/Release/pty.node，在 win32 会误报“终端不可用”）。
  if (installedPkg.dependencies?.['node-pty']) {
    const nodePtyDir = join(profileDir, 'node_modules', 'node-pty')
    const nativeDirs = [
      join(nodePtyDir, 'build', 'Release'),
      join(nodePtyDir, 'build', 'Debug'),
      join(nodePtyDir, 'prebuilds', `${process.platform}-${process.arch}`),
    ]
    const nativeNames = process.platform === 'win32' ? ['conpty', 'conpty_console_list'] : ['pty']
    const missing = nativeNames.filter(
      (name) => !nativeDirs.some((dir) => existsSync(join(dir, `${name}.node`))),
    )
    if (missing.length > 0) {
      warn(`node-pty 原生模块缺失（${missing.join(', ')}）：终端面板会不可用。`
        + `\n         处理：cd "${profileDir}" 后执行 pnpm approve-builds（勾选 node-pty）再重跑本脚本，`
        + '\n         或让 profile 的 pnpm-workspace.yaml 含 onlyBuiltDependencies: [node-pty]。')
    } else {
      const built = existsSync(join(nativeDirs[0], `${nativeNames[0]}.node`))
      ok(`node-pty 原生模块可用（${built ? '本地构建产物' : '预编译产物'}：${nativeNames.join(', ')}）`)
    }
  }
  return installedVersion
}

log('④ 校验', '检查装入 profile 的产物是否完整')
if (dryRun) {
  plan('检查 node_modules/<pkg>/lib/index.js、lib/client.js、cordis.patch.yml')
  plan('检查 node-pty 原生模块（终端面板依赖）')
} else {
  verifyInstalled()
}

// ---------------------------------------------------------------- 后续指引
console.log('------------------------------------------------------------')
if (dryRun) {
  console.log('DRY-RUN 结束：未做任何修改。去掉 --dry-run 即执行。')
} else {
  console.log(`安装完成（${pluginName} → ${profileDir}）。接下来：`)
  console.log('  1. **完全退出并重启 DSH Desktop**（重启会中断当前会话，请先保存）')
  console.log('  2. host 半：日志应无 bundle 加载失败 / MissingClientBundleError')
  console.log('     Get-Content "$env:APPDATA\\DSH Desktop\\logs\\dsh-$(Get-Date -Format \'yyyy-MM-dd\').log" -Tail 50')
  console.log(`  3. client bundle 可达（端口取 GUI 实际端口：netstat -ano | Select-String LISTENING）`)
  console.log(`     Invoke-WebRequest "http://127.0.0.1:<端口>/plugins/${pluginName}/client.js" -UseBasicParsing | % StatusCode   # 期望 200`)
  console.log(`  4. GUI 控制台（Ctrl+Shift+I）应出现 [${pluginName}] client half loaded（无则硬刷新 Ctrl+Shift+R）`)
  console.log('  卸载：node scripts/install-plugin.mjs --uninstall')
}

// tarball 大小提示（便于判断产物是否被截断）
if (!dryRun && spec === tarballPath && existsSync(tarballPath)) {
  const kb = (statSync(tarballPath).size / 1024).toFixed(0)
  console.log(`  注：安装源 tarball 大小 ${kb} KB（正常应 > 800 KB）`)
}
