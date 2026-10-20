/**
 * Compiles canonical plugin sources (src/plugins/<name>/, tutor.config.yaml,
 * *.jig templates) into per-platform distributable trees.
 *
 *   bun run build           # regenerate every dist tree + the root catalog
 *   bun run build:check     # verify committed outputs are fresh (CI)
 *
 * For every platform in tutor.config.yaml's `platforms:` map the build owns
 * dist/<id>/ entirely: it is wiped and regenerated from src/, so no stale
 * output can survive. Each plugin lands at dist/<id>/plugins/<name>/ with its
 * *.jig files rendered (extension stripped, `{ platform, plugin }` scope) and
 * everything else copied verbatim, plus the platform's plugin manifest:
 *
 *   claude — .claude-plugin/plugin.json. The Claude catalog stays at the repo
 *            root (.claude-plugin/marketplace.json, a Claude requirement) and
 *            points local plugins at ./dist/claude/plugins/<name>.
 *   kimi   — kimi.plugin.json, plus a dist/kimi/marketplace.json catalog.
 *   omni   — no manifest, no catalog. dist/omni/skills/<skill-name>/ holds
 *            only the public skills (tutor.config.yaml's skills.public),
 *            rendered with the omni platform's vars (no `models` key).
 *
 * skills.sh.json (repo root, committed) is generated from skills.groups.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import edge from '@jig-lang/jig'

edge.registerFilter('json', (value: unknown) => JSON.stringify(value))

const ROOT = join(import.meta.dir, '..')
const BUILD = import.meta.dir
const SRC = join(ROOT, 'src', 'plugins')
const DIST = join(ROOT, 'dist')
const CHECK = process.argv.includes('--check')

edge.mount(join(BUILD, 'templates'))

const readYaml = (path: string) => parseYaml(readFileSync(path, 'utf8'))

const config = readYaml(join(ROOT, 'tutor.config.yaml'))
for (const section of ['marketplace', 'platforms', 'skills']) {
  if (config[section] === undefined || config[section] === null) {
    console.error(`tutor.config.yaml: missing required top-level section "${section}"`)
    process.exit(1)
  }
}
const marketplace = config.marketplace
const platforms: Record<string, Record<string, any>> = config.platforms
const pluginConfig: Record<string, { platforms?: string[] }> = config.plugins ?? {}
const skillsConfig: { public?: string[]; groups?: any[] } = config.skills

const pluginNames = readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(SRC, d.name, 'plugin.yaml')))
  .map((d) => d.name)
  .sort()
const plugins = Object.fromEntries(pluginNames.map((name) => [name, readYaml(join(SRC, name, 'plugin.yaml'))]))

// Templates assume these keys exist; fail here with a readable message instead
// of a raw template error. Output dirs use the directory name while catalogs
// render plugin.name, so the two must agree.
const REQUIRED_KEYS = ['name', 'version', 'description', 'author', 'interface.displayName', 'interface.shortDescription']
for (const name of pluginNames) {
  const file = relative(ROOT, join(SRC, name, 'plugin.yaml'))
  const plugin = plugins[name]
  for (const key of REQUIRED_KEYS) {
    const value = key.split('.').reduce<any>((obj, part) => obj?.[part], plugin)
    if (value === undefined || value === null || value === '') {
      console.error(`${file}: missing required key "${key}"`)
      process.exit(1)
    }
  }
  if (plugin.name !== name) {
    console.error(`${file}: name "${plugin.name}" does not match its directory "${name}"`)
    process.exit(1)
  }
}

for (const name of Object.keys(pluginConfig)) {
  if (!pluginNames.includes(name)) {
    console.error(`tutor.config.yaml: plugins."${name}" does not match any plugin under src/plugins/`)
    process.exit(1)
  }
  for (const platformId of pluginConfig[name]?.platforms ?? []) {
    if (!(platformId in platforms)) {
      console.error(`tutor.config.yaml: plugins.${name}.platforms names unknown platform "${platformId}"`)
      process.exit(1)
    }
  }
}

function platformsFor(pluginName: string): string[] {
  const restriction = pluginConfig[pluginName]?.platforms
  return restriction ?? Object.keys(platforms)
}

const COMPONENT_DIRS = ['skills', 'agents', 'commands']
const componentsOf = (pluginDir: string) =>
  COMPONENT_DIRS.filter((c) => existsSync(join(pluginDir, c))).map((c) => ({
    key: c,
    value: `./${c}/`,
  }))

// Never shipped: the canonical metadata (compiled into manifests instead),
// maintainer notes (TODO.md), dependency/VCS dirs, and local Python/OS junk
// that .gitignore already hides.
const SKIP_NAMES = new Set(['plugin.yaml', 'TODO.md', 'node_modules', '.git', '.venv', '__pycache__', '.DS_Store'])
const SKIP_EXTS = ['.pyc']

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_NAMES.has(entry.name) || SKIP_EXTS.some((ext) => entry.name.endsWith(ext))) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
    else if (entry.isSymbolicLink()) {
      console.error(`symlinks are not supported in src/plugins: ${relative(ROOT, path)}`)
      process.exit(1)
    }
  }
}

// --- Render everything in memory: absolute path -> { content, mode } ---

type Output = { content: Buffer; mode: number }
const outputs = new Map<string, Output>()

function add(path: string, content: string | Buffer, { json = false, mode = 0o644 } = {}) {
  if (outputs.has(path)) {
    console.error(`two sources produce ${relative(ROOT, path)} (a file next to its own .jig template?)`)
    process.exit(1)
  }
  let data: Buffer
  if (typeof content === 'string') {
    let text = content.trimEnd() + '\n'
    if (json) {
      try {
        // Parse and re-print: templates control data, not whitespace.
        text = JSON.stringify(JSON.parse(content), null, 2) + '\n'
      } catch (error) {
        console.error(`INVALID JSON rendered for ${relative(ROOT, path)}: ${error}`)
        process.exit(1)
      }
    }
    data = Buffer.from(text)
  } else {
    data = content
  }
  outputs.set(path, { content: data, mode })
}

// Platform-specific plugin manifests and catalogs. Omni has neither — it is
// skill-scoped and skips manifest/catalog rendering entirely.
const MANIFESTS: Record<string, { path: string; template: string }> = {
  claude: { path: join('.claude-plugin', 'plugin.json'), template: 'claude-plugin.jig' },
  kimi: { path: 'kimi.plugin.json', template: 'kimi-plugin.jig' },
}
const CATALOGS: Record<string, string> = { kimi: 'kimi-marketplace.jig' }
const NO_MANIFEST = new Set(['omni'])

for (const [platformId, platform] of Object.entries(platforms)) {
  if (NO_MANIFEST.has(platformId)) continue

  const manifest = MANIFESTS[platformId]
  if (!manifest) {
    console.error(`no manifest defined for platform "${platformId}" in build/compile.ts`)
    process.exit(1)
  }

  const namesForPlatform = pluginNames.filter((name) => platformsFor(name).includes(platformId))

  for (const name of namesForPlatform) {
    const pluginDir = join(SRC, name)
    const plugin = plugins[name]
    const outDir = join(DIST, platformId, 'plugins', name)

    for (const file of walk(pluginDir)) {
      const rel = relative(pluginDir, file)
      if (file.endsWith('.jig')) {
        const rendered = edge.renderRawSync(readFileSync(file, 'utf8'), { platform, plugin }, file)
        add(join(outDir, rel.slice(0, -'.jig'.length)), rendered)
      } else {
        const executable = statSync(file).mode & 0o111
        add(join(outDir, rel), readFileSync(file), { mode: executable ? 0o755 : 0o644 })
      }
    }

    add(join(outDir, manifest.path), edge.renderSync(manifest.template, { plugin, components: componentsOf(pluginDir) }), {
      json: true,
    })
  }

  const catalog = CATALOGS[platformId]
  if (catalog) {
    add(
      join(DIST, platformId, 'marketplace.json'),
      edge.renderSync(catalog, { plugins: namesForPlatform.map((n) => plugins[n]) }),
      { json: true },
    )
  }
}

const marketplaceEntries = [
  ...pluginNames
    .filter((n) => platformsFor(n).includes('claude'))
    .map((n) => ({ name: plugins[n].name, description: plugins[n].description, external: false })),
  ...(marketplace.external ?? []).map((entry: Record<string, any>) => ({ ...entry, external: true })),
]
const ROOT_CATALOG = join(ROOT, '.claude-plugin', 'marketplace.json')
add(
  ROOT_CATALOG,
  edge.renderSync('marketplace.jig', { marketplace, plugins: marketplaceEntries, sourcePrefix: './dist/claude/plugins' }),
  { json: true },
)

// --- Skill discovery: every skills/<dir>/SKILL.md(.jig) across all plugins ---

function parseFrontmatter(text: string): Record<string, any> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  return parseYaml(match[1]) ?? {}
}

type SkillEntry = { name: string; pluginName: string; skillDirName: string; skillDir: string; internal: boolean }
const skillsByName = new Map<string, SkillEntry>()

for (const pluginName of pluginNames) {
  const skillsDir = join(SRC, pluginName, 'skills')
  if (!existsSync(skillsDir)) continue
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      console.error(`symlinks are not supported in src/plugins: ${relative(ROOT, join(skillsDir, entry.name))}`)
      process.exit(1)
    }
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsDir, entry.name)
    const skillMdPath = existsSync(join(skillDir, 'SKILL.md'))
      ? join(skillDir, 'SKILL.md')
      : existsSync(join(skillDir, 'SKILL.md.jig'))
        ? join(skillDir, 'SKILL.md.jig')
        : null
    if (!skillMdPath) continue
    const frontmatter = parseFrontmatter(readFileSync(skillMdPath, 'utf8'))
    const name = frontmatter.name ?? entry.name
    const existing = skillsByName.get(name)
    if (existing) {
      console.error(`skill "${name}" is defined by both ${existing.pluginName} and ${pluginName}`)
      process.exit(1)
    }
    skillsByName.set(name, {
      name,
      pluginName,
      skillDirName: entry.name,
      skillDir,
      internal: frontmatter.metadata?.internal === true,
    })
  }
}

// --- skills.sh.json validation + generation ---

const publicSkills: string[] = skillsConfig.public ?? []
const groups = skillsConfig.groups ?? []

groups.forEach((g: any, i: number) => {
  if (!g.title) {
    console.error(`tutor.config.yaml: skills.groups[${i}] is missing a non-empty "title"`)
    process.exit(1)
  }
  if (!Array.isArray(g.skills) || g.skills.length === 0) {
    console.error(`tutor.config.yaml: skills.groups[${i}] ("${g.title}") is missing a non-empty "skills" array`)
    process.exit(1)
  }
})

const namedSkills = new Set<string>([...publicSkills, ...groups.flatMap((g: any) => g.skills ?? [])])

for (const skillName of namedSkills) {
  const skill = skillsByName.get(skillName)
  if (!skill) {
    console.error(`tutor.config.yaml: skill "${skillName}" is not defined by any plugin's skills/<name>/SKILL.md`)
    process.exit(1)
  }
  if (skill.internal) {
    console.error(`tutor.config.yaml: skill "${skillName}" has metadata.internal: true and cannot be listed under public/groups`)
    process.exit(1)
  }
}

for (const g of groups) {
  for (const skillName of g.skills) {
    if (!publicSkills.includes(skillName)) {
      console.error(`tutor.config.yaml: skills.groups["${g.title}"] lists "${skillName}", which is not in skills.public`)
      process.exit(1)
    }
  }
}

add(
  join(ROOT, 'skills.sh.json'),
  JSON.stringify(
    {
      $schema: 'https://skills.sh/schemas/skills.sh.schema.json',
      notGrouped: 'bottom',
      groupings: groups,
    },
    null,
    2,
  ),
  { json: true },
)

// --- Omni: dist/omni/skills/<skill-name>/, public skills only ---

if (platforms.omni) {
  const omniPlatform = platforms.omni
  for (const skillName of publicSkills) {
    const skill = skillsByName.get(skillName)!
    const outDir = join(DIST, 'omni', 'skills', skillName)
    const plugin = plugins[skill.pluginName]

    for (const file of walk(skill.skillDir)) {
      const rel = relative(skill.skillDir, file)
      if (file.endsWith('.jig')) {
        const rendered = edge.renderRawSync(readFileSync(file, 'utf8'), { platform: omniPlatform, plugin }, file)
        add(join(outDir, rel.slice(0, -'.jig'.length)), rendered)
      } else {
        const executable = statSync(file).mode & 0o111
        add(join(outDir, rel), readFileSync(file), { mode: executable ? 0o755 : 0o644 })
      }
    }
  }
}

// --- Check or write ---

const ownedDirs = Object.keys(platforms).map((id) => join(DIST, id))

function* filesUnder(dir: string): Generator<string> {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* filesUnder(path)
    else yield path
  }
}

if (CHECK) {
  const stale: string[] = []
  for (const [path, { content, mode }] of outputs) {
    const label = relative(ROOT, path)
    if (!existsSync(path)) stale.push(`missing     ${label}`)
    else if (!readFileSync(path).equals(content)) stale.push(`outdated    ${label}`)
    else if ((statSync(path).mode & 0o111) !== (mode & 0o111)) stale.push(`mode        ${label}`)
  }
  for (const dir of ownedDirs) {
    for (const path of filesUnder(dir)) {
      if (!outputs.has(path)) stale.push(`unexpected  ${relative(ROOT, path)}`)
    }
  }
  // A removed platform leaves its whole dist tree behind; the build never
  // touches it again, so it must be deleted by hand.
  for (const entry of existsSync(DIST) ? readdirSync(DIST) : []) {
    if (!(entry in platforms)) stale.push(`orphaned    dist/${entry}: no "${entry}" entry under platforms: in tutor.config.yaml (delete it)`)
  }
  if (stale.length) {
    console.error(`stale generated files (run \`bun run build\`):\n  ${stale.sort().join('\n  ')}`)
    process.exit(1)
  }
  console.log(`all ${outputs.size} generated files up to date`)
} else {
  for (const dir of ownedDirs) rmSync(dir, { recursive: true, force: true })
  for (const [path, { content, mode }] of outputs) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, { mode })
  }
  console.log(`${outputs.size} file(s) written to ${ownedDirs.map((d) => relative(ROOT, d)).join(', ')} and ${relative(ROOT, ROOT_CATALOG)}`)
}
