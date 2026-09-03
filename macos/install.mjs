#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('Aplikacja wymaga macOS.')

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const home = os.homedir()
const packageMode = process.argv.includes('--dmg')
const configFile = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? path.join(home, '.jira-time-copy.env')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const arch = process.arch === 'x64' ? 'x86_64' : process.arch
const minimumMacOS = '13.5'
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'this-is-logged-'))
let app = path.join(temporary, 'This Is Logged.app')
const contents = path.join(app, 'Contents')
const resources = path.join(contents, 'Resources')
const runtime = path.join(resources, 'runtime')
const menuBinary = path.join(contents, 'MacOS', 'ThisIsLogged')
const source = path.join(root, 'macos', 'JiraTimeCopyMenu.swift')
const iconSource = path.join(root, 'macos', 'AppIcon.png')
const iconBundle = path.join(root, 'macos', 'AppIcon.icns')
const cache = path.join(temporary, 'ModuleCache')
const buildBinary = path.join(cache, 'ThisIsLogged')

const writePlist = (file, value) => {
  fs.writeFileSync(file, JSON.stringify(value))
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', file])
}

const bundlePackage = (name, from = path.join(root, 'package.json'), seen = new Set()) => {
  if (seen.has(name)) return
  seen.add(name)
  const require = createRequire(from)
  let directory = path.dirname(require.resolve(name))
  while (!fs.existsSync(path.join(directory, 'package.json')) || JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name !== name) {
    if (path.dirname(directory) === directory) throw new Error(`Nie znaleziono pakietu ${name}`)
    directory = path.dirname(directory)
  }
  const manifest = path.join(directory, 'package.json')
  const value = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  fs.cpSync(directory, path.join(runtime, 'node_modules', name), { recursive: true })
  for (const dependency of Object.keys(value.dependencies ?? {})) bundlePackage(dependency, manifest, seen)
}

try {
  for (const directory of [path.dirname(menuBinary), resources, runtime, cache]) fs.mkdirSync(directory, { recursive: true })

  const compile = (sdk) => {
    return spawnSync(
      '/usr/bin/xcrun',
      [
        'swiftc',
        ...(sdk ? ['-sdk', sdk] : []),
        '-target',
        `${arch}-apple-macosx${minimumMacOS}`,
        '-O',
        '-framework',
        'AppKit',
        '-framework',
        'UserNotifications',
        source,
        '-o',
        buildBinary,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, SWIFT_MODULECACHE_PATH: cache, CLANG_MODULE_CACHE_PATH: cache },
      },
    )
  }
  const sdkDir = '/Library/Developer/CommandLineTools/SDKs'
  const sdks = fs.existsSync(sdkDir)
    ? fs.readdirSync(sdkDir).filter((name) => /^MacOSX\d+\.\d+\.sdk$/.test(name)).map((name) => path.join(sdkDir, name))
    : []
  let build = compile()
  for (const sdk of sdks) {
    if (build.status === 0) break
    build = compile(sdk)
  }
  if (build.status !== 0) throw new Error(build.stderr.trim() || 'Nie udało się zbudować aplikacji.')
  execFileSync(buildBinary, ['--selfcheck'])
  execFileSync(buildBinary, ['--layout-selfcheck'])
  execFileSync(buildBinary, ['--layout-selfcheck-monitoring'])
  fs.copyFileSync(buildBinary, menuBinary)

  fs.copyFileSync(iconBundle, path.join(resources, 'AppIcon.icns'))
  fs.copyFileSync(iconSource, path.join(resources, 'AppIcon.png'))

  fs.copyFileSync(process.execPath, path.join(runtime, 'node'))
  fs.chmodSync(path.join(runtime, 'node'), 0o755)
  for (const file of ['jira-time-copy.mjs', 'package.json']) fs.copyFileSync(path.join(root, file), path.join(runtime, file))
  fs.cpSync(path.join(root, 'lib'), path.join(runtime, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(runtime, 'macos'), { recursive: true })
  fs.copyFileSync(path.join(root, 'macos', 'install-agents.mjs'), path.join(runtime, 'macos', 'install-agents.mjs'))
  bundlePackage('@clack/prompts')
  const nodeLicense = path.resolve(path.dirname(process.execPath), '..', 'LICENSE')
  if (fs.existsSync(nodeLicense)) fs.copyFileSync(nodeLicense, path.join(runtime, 'NODE-LICENSE'))
  execFileSync(path.join(runtime, 'node'), [path.join(runtime, 'macos', 'install-agents.mjs'), '--selfcheck'])

  writePlist(path.join(contents, 'Info.plist'), {
    CFBundleDevelopmentRegion: 'pl',
    CFBundleDisplayName: 'This Is Logged',
    CFBundleExecutable: 'ThisIsLogged',
    CFBundleIconFile: 'AppIcon.icns',
    CFBundleIdentifier: 'dev.this-is-fine.jira-time-copy',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: 'This Is Logged',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: pkg.version,
    CFBundleVersion: String(Math.floor(Date.now() / 1000)),
    LSUIElement: true,
    LSMinimumSystemVersion: minimumMacOS,
    NSHighResolutionCapable: true,
    NSUserNotificationAlertStyle: 'alert',
  })
  const identity = process.env.MACOS_SIGN_IDENTITY || '-'
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', identity, app], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])

  if (packageMode) {
    fs.rmSync(cache, { recursive: true, force: true })
    fs.symlinkSync('/Applications', path.join(temporary, 'Applications'))
    const dist = path.join(root, 'dist')
    const dmg = path.join(dist, 'This Is Logged.dmg')
    fs.mkdirSync(dist, { recursive: true })
    fs.rmSync(dmg, { force: true })
    execFileSync('/usr/bin/hdiutil', ['create', '-volname', 'This Is Logged', '-srcfolder', temporary, '-ov', '-format', 'UDZO', dmg], { stdio: 'inherit' })
    console.log(dmg)
  } else {
    const installedApp = path.join(home, 'Applications', 'This Is Logged.app')
    spawnSync('/usr/bin/pkill', ['-x', 'ThisIsLogged'], { stdio: 'ignore' })
    fs.mkdirSync(path.dirname(installedApp), { recursive: true })
    fs.rmSync(installedApp, { recursive: true, force: true })
    fs.renameSync(app, installedApp)
    app = installedApp
    const installedRuntime = path.join(app, 'Contents', 'Resources', 'runtime')
    execFileSync(path.join(installedRuntime, 'node'), [path.join(installedRuntime, 'macos', 'install-agents.mjs'), configFile, app], { stdio: 'inherit' })
    execFileSync(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', app],
      { stdio: 'ignore' },
    )
    execFileSync('/usr/bin/open', ['-g', app])
    console.log(app)
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
