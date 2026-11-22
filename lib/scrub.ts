/**
 * Strips obvious personal data out of transcripts before they are stored.
 *
 * Visitors talk to a public demo agent and hand over names, phone numbers and
 * addresses. None of that is useful for the thing the transcripts exist to
 * answer — which template did they try, how long did each turn take, where did
 * they give up — so it does not need to be kept.
 *
 * This is deliberately a blunt regex pass, not a classifier. It runs on every
 * turn in the request path, so it has to be cheap and predictable. It will miss
 * unusual formats; the point is that the common cases (a spoken phone number, a
 * street address, an email) do not land in the database at all.
 */

type Rule = { re: RegExp; to: string }

/**
 * Units a five-digit number is far more likely to be measuring than a ZIP code.
 *
 * An HVAC call is full of these — "a 12000 BTU unit", "24000 square feet", "36000
 * dollars" — and every one of them is a five-digit run that the ZIP rule below
 * would otherwise redact, turning the transcript into "[zip] BTU". Losing a
 * capacity figure is worse than keeping one, because capacity is exactly the kind
 * of detail the transcripts exist to show.
 *
 * Ordered longest-first where prefixes overlap, so `sq ft` is not consumed by the
 * bare `ft` alternative.
 *
 * Deliberately excludes bare `in`. It reads as a unit in "40000 in" but it is also
 * one of the commonest words in English, and "we are at 94105 in California" would
 * then keep a real ZIP. A missed unit costs one redacted number; a missed ZIP
 * stores a visitor's location.
 */
const MEASURES =
  /(?:btus?|square\s+(?:feet|foot|ft)|sq\.?\s*ft\.?|ft\b|feet|inch(?:es)?|degrees?|°[fc]?|watts?|kwh?|amps?|volts?|seer|tons?|cfm|psi|rpm|gallons?|dollars?|bucks|percent|%|hours?|hrs?|minutes?|mins?|lbs?|pounds?|years?)/

const RULES: Rule[] = [
  // Email first: it contains dots and digits that later rules would mangle.
  { re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, to: '[email]' },

  // Phone numbers. Browser STT writes these as digits, usually with separators
  // but not always, and often with a country code.
  { re: /(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, to: '[phone]' },

  // A bare 10- or 11-digit run is a phone number with the separators dropped.
  { re: /\b\d{10,11}\b/g, to: '[phone]' },

  // Street addresses: a house number followed by a street name and a suffix.
  // Requires the suffix so that "5 minutes" and "2 units" survive.
  {
    re: /\b\d{1,6}\s+(?:[A-Za-z0-9'.-]+\s+){0,4}(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|cir|circle|way|pl|place|ter|terrace|pkwy|parkway|hwy|highway)\b\.?/gi,
    to: '[address]',
  },

  // US ZIP, optionally ZIP+4. Kept after the address rule so a full address
  // collapses to one token rather than "[address] [zip]".
  //
  // Guarded on both sides, because five digits on their own are not evidence of
  // anything: a following unit means it was a measurement, and a leading currency
  // symbol means it was a price. Without these, "a 12000 BTU unit" was stored as
  // "a [zip] BTU unit".
  {
    re: new RegExp(String.raw`(?<!\$\s*)\b\d{5}(?:-\d{4})?\b(?!\s*(?:${MEASURES.source}))`, 'gi'),
    to: '[zip]',
  },

  // Card-shaped digit runs. A demo should never see one, which is exactly why
  // it is worth catching if it does.
  { re: /\b(?:\d[ -]*?){13,19}\b/g, to: '[card]' },
]

/**
 * Redacts personal data from a transcript line.
 *
 * Applied to both speakers. Agent replies are scrubbed too because the agent
 * reads back what the visitor gave it, so the same data appears on both sides.
 */
export function scrub(text: string): string {
  let out = text
  for (const { re, to } of RULES) out = out.replace(re, to)
  return out
}
