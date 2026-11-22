#!/usr/bin/env node
/**
 * Resize the industry icon art in assets/industry-icons/ down to the sizes the
 * browser actually paints, into public/icons/.
 *
 * Why this exists: the source renders are 1024x1024 PNGs at ~1.5MB each. The
 * home grid draws them at 56px and the call topbar at 30px, so shipping the
 * originals would spend 4.5MB of a phone's first paint on three tiles — more
 * than the rest of the app put together. A 2x asset for the largest slot is
 * 40-60KB and indistinguishable on screen.
 *
 * Two sizes rather than one: `--tile` (112px, 2x of 56) for the grid, and
 * `--chip` (60px, 2x of 30) for the call topbar. Downscaling 112 to 30 in the
 * browser blurs the fine geometry in these renders; a purpose-built small one
 * stays crisp.
 *
 * Usage:
 *   node scripts/render-icons.mjs              # only missing/changed files
 *   node scripts/render-icons.mjs --force      # re-render everything
 *   node scripts/render-icons.mjs --check      # verify only, write nothing
 *
 * Run it after adding or replacing art in assets/industry-icons/. Commit the
 * output — like the greeting MP3s these are build inputs, not build output, and
 * a Heroku release must not need image tooling to serve them.
 *
 * `sips` is macOS-only, which is fine: this runs on a laptop, never on a dyno.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC_DIR = join(REPO, 'assets', 'industry-icons')
const OUT_DIR = join(REPO, 'public', 'icons')

/** Slot name -> pixel size. 2x the largest CSS box each slot is drawn in. */
const SIZES = { tile: 112, chip: 60 }

const args = new Set(process.argv.slice(2))
const FORCE = args.has('--force')
const CHECK = args.has('--check')

if (!existsSync(SRC_DIR)) {
  console.error(`No source directory: ${SRC_DIR}`)
  process.exit(1)
}

const sources = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.png'))
  .sort()

if (sources.length === 0) {
  console.error(`No .png files in ${SRC_DIR}`)
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })

let wrote = 0
let stale = 0

for (const file of sources) {
  const key = file.replace(/\.png$/, '')
  const srcPath = join(SRC_DIR, file)
  // Hash the source so a replaced render re-generates but an unchanged one is
  // skipped, the same contract render-greetings.mjs uses for its .sha files.
  const sha = createHash('sha256').update(readFileSync(srcPath)).digest('hex').slice(0, 16)

  for (const [slot, size] of Object.entries(SIZES)) {
    const outPath = join(OUT_DIR, `${key}-${slot}.png`)
    const shaPath = join(OUT_DIR, `${key}-${slot}.sha`)
    const stamp = `${sha}-${size}`
    const current = existsSync(shaPath) ? readFileSync(shaPath, 'utf8').trim() : null
    const fresh = existsSync(outPath) && current === stamp

    if (fresh && !FORCE) continue

    if (CHECK) {
      console.error(`stale: icons/${key}-${slot}.png`)
      stale++
      continue
    }

    execFileSync('sips', ['-Z', String(size), srcPath, '--out', outPath], { stdio: 'pipe' })
    writeFileSync(shaPath, `${stamp}\n`)
    const kb = (statSync(outPath).size / 1024).toFixed(1)
    console.log(`wrote icons/${key}-${slot}.png  ${size}px  ${kb}KB`)
    wrote++
  }
}

if (CHECK) {
  if (stale > 0) {
    console.error(`\n${stale} icon(s) stale. Run: npm run icons`)
    process.exit(1)
  }
  console.log(`All ${sources.length * Object.keys(SIZES).length} icons up to date.`)
} else {
  console.log(wrote === 0 ? 'All icons already up to date.' : `\nWrote ${wrote} file(s).`)
}
