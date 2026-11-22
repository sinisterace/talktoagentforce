#!/usr/bin/env node
/**
 * Provision the channel stack for one industry template on the public voice demo.
 *
 * Given an already-published-and-activated Agentforce agent, this creates the
 * three pieces of metadata that let an anonymous browser talk to it:
 *
 *   1. RoutingFlow      — one routeWork call handing the session to the agent
 *   2. MessagingChannel — EmbeddedMessaging channel pointing at that flow
 *   3. EmbeddedServiceConfig (deploymentType API) — the MIAW Custom Client
 *
 * It then activates the channel (IsActive is read-only via the Metadata API, so
 * that step goes through anonymous Apex), publishes the ESC (an API-type config
 * returns HTTP 412 from scrt2 until Published, and there is no public API for the
 * Publish button, so publish-esd.mjs clicks it headlessly), and verifies the live
 * scrt2 config reports authMode UnAuth, which is what the Heroku app depends on.
 *
 * Prereq for the publish step: Playwright Chromium must be installed
 *   (npm install playwright && npx playwright install chromium).
 *
 * Usage:
 *   node scripts/provision-industry.mjs --key retail --agent Retail_Service_Voice_Agent
 *   node scripts/provision-industry.mjs --key retail --agent Retail_Service_Voice_Agent --dry-run
 *
 * Flags:
 *   --key      short industry key, lowercase, used in the Heroku AGENTS array   (required)
 *   --agent    BotDefinition DeveloperName of the published agent               (required)
 *   --label    human label for the channel/ESC; defaults to a title-cased key
 *   --org      target org alias                          (default talktoAgentforceSDO)
 *   --queue    Omni-Channel queue DeveloperName          (default SDO_Service_Messaging)
 *   --dry-run  render the files and print the plan, deploy nothing
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const PKG = join(REPO, 'salesforce', 'force-app', 'main', 'default')
const TEMPLATES = join(HERE, 'templates')

// ---------------------------------------------------------------- arg parsing

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) continue
  const name = a.slice(2)
  if (name === 'dry-run') args.dryRun = true
  else args[name] = process.argv[++i]
}

const KEY = args.key
const AGENT = args.agent
const ORG = args.org ?? 'talktoAgentforceSDO'
const QUEUE = args.queue ?? 'SDO_Service_Messaging'

if (!KEY || !AGENT) {
  console.error('Usage: node scripts/provision-industry.mjs --key <industry> --agent <BotDeveloperName> [--label "..."] [--org alias] [--dry-run]')
  process.exit(1)
}
if (!/^[a-z][a-z0-9_]*$/.test(KEY)) {
  console.error(`--key must be lowercase letters, digits and underscores. Got "${KEY}".`)
  process.exit(1)
}

const Pascal = KEY.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('_')
const LABEL = args.label ?? Pascal.replace(/_/g, ' ')

const NAMES = {
  flow: `${Pascal}_Route_To_Agent`,
  flowLabel: `${LABEL} Route To Agent`,
  channel: `${Pascal}_Web`,
  channelLabel: `${LABEL} Web`,
  esc: `${Pascal}_Api`,
  escLabel: `${LABEL} API`,
}

// ------------------------------------------------------------------- helpers

/** Run an sf command and return its parsed JSON. The CLI sometimes prepends an
 *  update banner to stdout, so slice from the first brace. */
function sf(argv) {
  let out
  try {
    out = execFileSync('sf', [...argv, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    out = e.stdout ?? ''
    if (!out) throw e
  }
  const brace = out.indexOf('{')
  if (brace === -1) throw new Error(`sf ${argv[0]} returned no JSON:\n${out}`)
  return JSON.parse(out.slice(brace))
}

function queryOne(soql, { tooling = false } = {}) {
  const argv = ['data', 'query', '-o', ORG, '-q', soql]
  if (tooling) argv.push('--use-tooling-api')
  const res = sf(argv)
  if (!res.result) throw new Error(`Query failed: ${res.message ?? JSON.stringify(res)}`)
  return res.result.records[0]
}

function render(templateFile, outFile, subs) {
  let body = readFileSync(join(TEMPLATES, templateFile), 'utf8')
  for (const [k, v] of Object.entries(subs)) body = body.replaceAll(`{{${k}}}`, v)
  const left = body.match(/\{\{[A-Z_]+\}\}/g)
  if (left) throw new Error(`${templateFile}: unsubstituted placeholders ${[...new Set(left)].join(', ')}`)
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, body)
  return outFile
}

function deploy(sourceDirs) {
  const argv = ['project', 'deploy', 'start', '-o', ORG]
  for (const d of sourceDirs) argv.push('--source-dir', d)
  const res = sf(argv)
  const r = res.result ?? {}
  if (r.status !== 'Succeeded') {
    const fails = r.details?.componentFailures ?? []
    for (const f of fails) console.error(`  ✗ ${f.fullName}: ${f.problem}`)
    if (!fails.length) console.error(`  ✗ ${res.message ?? JSON.stringify(res).slice(0, 500)}`)
    throw new Error(`Deploy failed (${r.numberComponentErrors ?? '?'} errors)`)
  }
  for (const f of r.files ?? []) console.log(`  ✓ ${f.state} ${f.type} ${f.fullName}`)
}

// -------------------------------------------------------------- 1. discovery

console.log(`\nProvisioning "${KEY}" (${LABEL}) in ${ORG}\n`)

const bot = queryOne(
  `SELECT Id, MasterLabel FROM BotDefinition WHERE DeveloperName = '${AGENT}'`
)
if (!bot) throw new Error(`No BotDefinition named ${AGENT}. Publish and activate the agent first.`)

const channelSvc = queryOne(
  `SELECT Id FROM ServiceChannel WHERE DeveloperName = 'sfdc_livemessage'`
)
if (!channelSvc) throw new Error('No sfdc_livemessage ServiceChannel in this org.')

const queue = queryOne(
  `SELECT Id, Name, QueueRoutingConfigId FROM Group WHERE Type = 'Queue' AND DeveloperName = '${QUEUE}'`
)
if (!queue) throw new Error(`No queue named ${QUEUE}.`)
if (!queue.QueueRoutingConfigId) {
  throw new Error(
    `Queue ${QUEUE} has no QueueRoutingConfig, so it is a plain Salesforce queue, not an ` +
    `Omni-Channel queue. Routing will fail with "agents are not available".`
  )
}

console.log(`  agent  ${bot.MasterLabel} (${bot.Id})`)
console.log(`  queue  ${queue.Name} (${queue.Id})`)

// ---------------------------------------------------------------- 2. render

const written = [
  render('route.flow-meta.xml', join(PKG, 'flows', `${NAMES.flow}.flow-meta.xml`), {
    AGENT_LABEL: bot.MasterLabel,
    FLOW_LABEL: NAMES.flowLabel,
    SERVICE_CHANNEL_ID: channelSvc.Id,
    QUEUE_ID: queue.Id,
    QUEUE_LABEL: queue.Name,
    BOT_ID: bot.Id,
  }),
  render('channel.messagingChannel-meta.xml', join(PKG, 'messagingChannels', `${NAMES.channel}.messagingChannel-meta.xml`), {
    CHANNEL_LABEL: NAMES.channelLabel,
    FLOW_NAME: NAMES.flow,
    QUEUE_DEV_NAME: QUEUE,
  }),
  render('api.EmbeddedServiceConfig-meta.xml', join(PKG, 'embeddedServiceConfigs', `${NAMES.esc}.EmbeddedServiceConfig-meta.xml`), {
    CHANNEL_NAME: NAMES.channel,
    ESC_LABEL: NAMES.escLabel,
  }),
]

console.log('\nRendered:')
for (const f of written) console.log(`  ${f.replace(REPO + '/', '')}`)

if (args.dryRun) {
  console.log('\n--dry-run: nothing deployed. Heroku AGENTS entry would be:')
  console.log(`  { key: '${KEY}', label: '${LABEL}', esConfigName: '${NAMES.esc}' }\n`)
  process.exit(0)
}

// ---------------------------------------------------------------- 3. deploy

// Flow first: the channel references it by developer name. ESC last: it
// references the channel. Salesforce resolves these in a single deploy, but
// splitting them keeps failures readable.
console.log('\nDeploying flow + channel...')
deploy([
  join(PKG, 'flows', `${NAMES.flow}.flow-meta.xml`),
  join(PKG, 'messagingChannels', `${NAMES.channel}.messagingChannel-meta.xml`),
])

// MessagingChannel.IsActive is read-only through the Metadata API.
console.log('\nActivating channel...')
const apex = `
List<MessagingChannel> cs = [SELECT Id, IsActive FROM MessagingChannel WHERE DeveloperName = '${NAMES.channel}'];
if (cs.isEmpty()) { throw new CalloutException('channel ${NAMES.channel} not found'); }
if (!cs[0].IsActive) { cs[0].IsActive = true; update cs; }
System.debug('ACTIVE=' + [SELECT IsActive FROM MessagingChannel WHERE Id = :cs[0].Id].IsActive);
`
const apexFile = join(REPO, 'scripts', '.activate-channel.apex')
writeFileSync(apexFile, apex)
const apexRes = sf(['apex', 'run', '-o', ORG, '-f', apexFile])
if (!apexRes.result?.success) {
  throw new Error(`Channel activation failed: ${apexRes.result?.compileProblem || apexRes.result?.exceptionMessage || 'unknown'}`)
}
console.log('  ✓ IsActive = true')

console.log('\nDeploying API-type EmbeddedServiceConfig...')
deploy([join(PKG, 'embeddedServiceConfigs', `${NAMES.esc}.EmbeddedServiceConfig-meta.xml`)])

// -------------------------------------------------------------- 3b. publish

// Deploying and activating the channel is NOT enough for an API-type ESC: until
// the deployment is Published, the scrt2 endpoint answers every request with
// HTTP 412 "Embedded Messaging Config is not Published" and the demo is dead on
// arrival. There is no public API for the Publish button (confirmed in the
// channel-deployment skill), so publish-esd.mjs drives a headless browser to
// click it. Publish is idempotent — clicking an already-published deployment is
// harmless — so re-running the provisioner is safe.
console.log('\nPublishing EmbeddedServiceConfig (headless browser click)...')
try {
  execFileSync(
    'node',
    [join(HERE, 'publish-esd.mjs'), '--target-org', ORG, '--deployment-name', NAMES.esc],
    { stdio: 'inherit' }
  )
} catch (e) {
  throw new Error(
    `Publish step failed. The channel is deployed and active but not published, ` +
    `so scrt2 will return HTTP 412. Fix the cause above, then re-run:\n` +
    `  node scripts/publish-esd.mjs --target-org ${ORG} --deployment-name ${NAMES.esc}`
  )
}

// ---------------------------------------------------------------- 4. verify

// The Heroku app reads this same endpoint at runtime. If authMode is not UnAuth,
// anonymous visitors cannot get a guest token and the demo is dead on arrival.
console.log('\nVerifying live scrt2 config...')
const org = sf(['org', 'display', '-o', ORG]).result
const scrt2 = process.env.SF_SCRT2_URL ?? org.instanceUrl.replace(/^https:\/\/([^.]+)\..*$/, 'https://$1.my.salesforce-scrt.com')
const orgId15 = org.id.slice(0, 15)
const url = `${scrt2}/embeddedservice/v1/embedded-service-config?orgId=${orgId15}&esConfigName=${NAMES.esc}&language=en_US`

// Publish can take up to ~10 minutes to propagate to scrt2, and the endpoint
// answers 412 "not Published" until it does. Poll rather than fail on the first
// read, so provisioning doesn't flake on propagation lag right after the click.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let res
for (let attempt = 1; ; attempt++) {
  res = await fetch(url)
  if (res.ok) break
  if (attempt >= 40) {
    throw new Error(
      `scrt2 config still HTTP ${res.status} after ${attempt} attempts (~${Math.round((attempt * 15) / 60)} min). ` +
      `A 412 here means the Publish has not propagated; a 404 means the ESC name is wrong.`
    )
  }
  if (attempt === 1) console.log(`  scrt2 not ready yet (HTTP ${res.status}), polling every 15s (up to 10 min)...`)
  await sleep(15_000)
}
const cfg = (await res.json()).embeddedServiceConfig
const chan = cfg.embeddedServiceMessagingChannel ?? {}
if (chan.authMode !== 'UnAuth') {
  throw new Error(`authMode is "${chan.authMode}", expected UnAuth. Check areGuestUsersAllowed on the ESC.`)
}
if (cfg.deploymentType !== 'API') {
  throw new Error(`deploymentType is "${cfg.deploymentType}", expected API.`)
}
console.log(`  ✓ authMode ${chan.authMode}`)
console.log(`  ✓ deploymentType ${cfg.deploymentType}`)
console.log(`  ✓ channelAddressIdentifier ${chan.channelAddressIdentifier}`)

console.log(`\nDone. Add to the Heroku AGENTS array:`)
console.log(`  { key: '${KEY}', label: '${LABEL}', esConfigName: '${NAMES.esc}' }\n`)
