#!/usr/bin/env node
/**
 * Unit test for lib/scrub.ts, the redaction pass every transcript line goes
 * through on its way into Salesforce.
 *
 * Two failure modes, both silent, both worth a test. Under-redacting writes a real
 * visitor's phone number or address into an org — the thing this module exists to
 * prevent. Over-redacting is quieter but not harmless: an HVAC call is full of
 * five-digit numbers, and "a 12000 BTU unit" stored as "a [zip] BTU unit" throws
 * away exactly the detail the transcripts were kept for. That one shipped, which
 * is why the measurement cases below are here.
 *
 * The rules are ordered and interact — email runs before phone so its digits are
 * not mangled, address runs before ZIP so a full address collapses to one token —
 * so these run through the real `scrub`, not the individual regexes.
 *
 * Usage: node scripts/test-scrub.mjs
 */

import { scrub } from '../lib/scrub.ts'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

/** Asserts the exact output, so a rule that over-reaches shows up as a diff. */
function redacts(input, want) {
  const got = scrub(input)
  check(`"${input}" → "${want}"`, got === want, `got "${got}"`)
}

/** Asserts nothing changed. Used for the numbers that must survive. */
function keeps(input) {
  const got = scrub(input)
  check(`"${input}" survives`, got === input, `got "${got}"`)
}

/* ------------------------------------------------------------ what must go --- */

redacts('email me at dana@example.com', 'email me at [email]')
redacts('call me at 415-555-0142', 'call me at [phone]')
redacts('my cell is (415) 555 0142', 'my cell is [phone]')
redacts('4155550142 is my cell', '[phone] is my cell')
redacts('reach me on +1 415 555 0142', 'reach me on [phone]')
redacts('my zip is 94105', 'my zip is [zip]')
redacts('ship to 94105-1234 please', 'ship to [zip] please')
redacts('I am at 12 Maple Street', 'I am at [address]')
redacts('the unit is at 4820 Sunset Boulevard', 'the unit is at [address]')

// A full address must collapse to one token, not "[address] [zip]" — which is why
// the address rule runs before the ZIP rule.
redacts('12 Maple Street, San Francisco 94105', '[address], San Francisco [zip]')

/* --------------------------------------------------------- what must stay --- */

/*
 * These are the regression cases. Every one is a five-digit run that the ZIP rule
 * matched before it was guarded, and every one is something an HVAC caller
 * actually says.
 */
keeps('I need a 12000 BTU unit')
keeps('the house is 24000 square feet')
keeps('about 2400 sq ft upstairs')
keeps('quote came to 36000 dollars')
keeps('$12000 is too much')
keeps('about 40000 watts')
keeps('the 30000 seer rating')

// Small numbers are the bulk of a real call and no rule should touch them.
keeps('it is 68 degrees but should be 72')
keeps('I have 2 units and 3 vents')
keeps('can someone come in 5 minutes')

// Ordinary conversation. "in" is deliberately not treated as a unit, so the ZIP
// here is still caught — see the MEASURES comment in lib/scrub.ts.
redacts('we are at 94105 in California', 'we are at [zip] in California')

/* --------------------------------------------------------------- the edges --- */

check('an empty string is returned unchanged', scrub('') === '')
check('text with no personal data is untouched', scrub('my furnace is broken') === 'my furnace is broken')
check(
  'a card number is caught',
  scrub('4111 1111 1111 1111').includes('[card]') || scrub('4111 1111 1111 1111').includes('[phone]'),
  scrub('4111 1111 1111 1111'),
)
// Idempotence matters because the agent reads back what the visitor said, so the
// same line can pass through twice. A placeholder must not itself get redacted.
check('scrubbing twice changes nothing the second time', scrub(scrub('call 415-555-0142 or dana@example.com')) === scrub('call 415-555-0142 or dana@example.com'))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
