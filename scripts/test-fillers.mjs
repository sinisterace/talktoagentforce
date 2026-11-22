#!/usr/bin/env node
/**
 * Unit test for lib/fillers.ts and the rendered manifest.
 *
 * Small surface, but worth testing, because both failure modes are silent. A
 * rotation bug does not throw, it just plays the same recording four turns in a
 * row. A missing MP3 does not throw either — drain() swallows filler fetch errors
 * on purpose, so a clip listed in the manifest with no file behind it is heard as
 * silence and nothing anywhere reports it.
 *
 * The real manifest is used rather than a fixture, deliberately: it is generated
 * from the lines in scripts/render-fillers.mjs, so a fixture would keep passing
 * while what actually ships was stale.
 *
 * There is no test for *which* line is chosen for a given utterance, because the
 * lines no longer depend on the utterance. That was the previous design and it is
 * what broke — see lib/fillers.ts. The utterance does decide *whether* a line
 * plays at all, though, which `isClosingTurn` handles and this file covers.
 *
 * Usage: node scripts/test-fillers.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isClosingTurn, nextFiller } from '../lib/fillers.ts'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

/* -------------------------------------------------------------- rotation --- */

{
  const clips = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  check(
    'consecutive turns give consecutive clips',
    [0, 1, 2].map((t) => nextFiller(clips, t).id).join('') === 'abc',
  )
  check('the counter wraps rather than running off the end', nextFiller(clips, 3).id === 'a')
  check(
    'no clip ever repeats back to back across a long call',
    Array.from({ length: 40 }, (_, t) => nextFiller(clips, t).id).every(
      (id, i, all) => i === 0 || id !== all[i - 1],
    ),
  )

  // The counter is a plain ref incremented by two different timers, so it is worth
  // knowing it cannot index out of bounds if it ever arrives odd.
  check('a negative counter still returns a clip', nextFiller(clips, -1)?.id === 'b')
  check('a fractional counter still returns a clip', nextFiller(clips, 2.7)?.id === 'c')

  check('an empty list returns null rather than throwing', nextFiller([], 0) === null)
  check('a single clip is returned every time', nextFiller([{ id: 'x' }], 9).id === 'x')
}

/* --------------------------------------------------------- closing turns --- */

{
  /*
   * The filler is suppressed on a goodbye, because the reply to one is a sign-off
   * and "let me pull that up" ahead of "thanks for calling" is what the user
   * reported as awkward.
   *
   * Both directions matter, but not equally. A missed goodbye costs one stray
   * clip, which is what shipped before. A false positive silences a turn that
   * really was a lookup, which is the worse of the two — so the not-a-closing
   * list below is the one to keep long.
   */
  const CLOSINGS = [
    'goodbye',
    'bye',
    'thanks, goodbye',
    "no that's all thanks",
    "that's everything, thank you",
    "that'll be all",
    'nothing else',
    "we're all good",
    "i'm all set",
    'all set thanks',
    'no thank you',
    'no thanks',
    'have a good day',
    'thank you so much',
    'appreciate your help',
    'THAT IS IT, THANKS',
    '  thanks  ',
  ]
  const failed = CLOSINGS.filter((t) => !isClosingTurn(t))
  check('every way of ending a call suppresses the filler', failed.length === 0, failed.join(' | '))
}

{
  const NOT_CLOSINGS = [
    // A bare no answers a question at least as often as it ends a call, and those
    // turns do run a lookup.
    'no',
    'nope',
    'no it is residential',
    'no, the furnace not the AC',
    'yes',
    'my furnace stopped working',
    'i need to reschedule',
    'the address is 40 Rideau Street, Ottawa',
    'M5V 3L9',
    // Polite, and a real request. The word "thanks" cannot be enough on its own.
    'thanks, can you also tell me what the visit costs',
    'thank you, but i also wanted to ask about the filter',
    // Long turns are requests that happen to contain a closing phrase.
    'thanks, my furnace is done for and nothing else in the house is heating up at all',
    "that's all i know about the model number, can you still book someone",
  ]
  const failed = NOT_CLOSINGS.filter((t) => isClosingTurn(t))
  check('a mid-call turn still gets its filler', failed.length === 0, failed.join(' | '))
}

{
  check('an empty turn is not treated as a goodbye', isClosingTurn('') === false)
  check('whitespace alone is not treated as a goodbye', isClosingTurn('   ') === false)
}

/* ------------------------------------------------ the manifest itself holds --- */

const manifestFile = join(REPO, 'public', 'fillers', 'manifest.json')
if (!existsSync(manifestFile)) {
  console.error('\npublic/fillers/manifest.json is missing. Run: npm run fillers')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
const all = [...(manifest.openers ?? []), ...(manifest.waits ?? [])]

{
  check('both groups have clips', manifest.openers?.length > 0 && manifest.waits?.length > 0)
  // With one clip per group every turn hears the same recording, which is the
  // thing rotation exists to avoid.
  check(
    'each group has enough clips to rotate',
    manifest.openers.length > 1 && manifest.waits.length > 1,
  )
  check(
    'every clip has text and an audio path',
    all.every((c) => c.text?.trim() && c.audio?.startsWith('/fillers/')),
  )
  // The text is also shown as the caption, so a duplicate would look like the UI
  // had frozen mid-wait.
  check('no two clips say the same thing', new Set(all.map((c) => c.text)).size === all.length)

  const missing = all.map((c) => c.audio).filter((rel) => !existsSync(join(REPO, 'public', rel)))
  check('every clip in the manifest has its MP3 on disk', missing.length === 0, missing.join(', '))
}

{
  /*
   * These play inside a four-to-eight second gap, the first at 2.2s and the second
   * at 6.5s. A long clip would still be talking when the reply arrives, delaying
   * it. 40 characters is roughly two seconds of speech at this voice's rate, which
   * is the most that fits between those two timers.
   */
  const long = all.filter((c) => c.text.length > 40).map((c) => c.text)
  check('every line is short enough to fit the gap', long.length === 0, long.join(' | '))
}

{
  /*
   * The whole point of the rewrite: nothing spoken here may claim the agent has
   * decided anything. "Booking your visit" was the bug the user hit in production
   * — it was true only if the planner happened to book, and it did not.
   */
  const CLAIMS = /\b(book(ing|ed)?|schedul(e|ing|ed)|cancel(l?ing|l?ed)?|dispatch(ing|ed)?|creat(e|ing|ed)|updat(e|ing|ed)|confirm(ing|ed)?)\b/i
  const claiming = all.filter((c) => CLAIMS.test(c.text)).map((c) => c.text)
  check('no line commits the agent to an action', claiming.length === 0, claiming.join(' | '))
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
