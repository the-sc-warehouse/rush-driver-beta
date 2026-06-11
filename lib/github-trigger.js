// When a new UDID is enrolled, update fastlane/devices.txt in the GitHub repo
// and fire a repository_dispatch event so the self-hosted Mac runner kicks off
// a fresh ad hoc build automatically.

const GITHUB_PAT   = process.env.GITHUB_PAT
const GITHUB_OWNER = process.env.GITHUB_OWNER
const GITHUB_REPO  = process.env.GITHUB_REPO
const DEVICES_PATH = 'fastlane/devices.txt'

function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'rush-driver-beta/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function triggerBuildForNewUdid(udid, deviceName, product) {
  if (!GITHUB_PAT || !GITHUB_OWNER || !GITHUB_REPO) {
    console.warn('[github-trigger] GITHUB_PAT / GITHUB_OWNER / GITHUB_REPO not set — skipping auto-build')
    return
  }

  const base = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`

  // Fetch the current devices.txt so we can append and PUT it back
  const getRes = await fetch(`${base}/contents/${DEVICES_PATH}`, { headers: ghHeaders() })
  if (!getRes.ok) {
    console.error(`[github-trigger] Could not read devices.txt (HTTP ${getRes.status})`)
    return
  }
  const fileData = await getRes.json()
  const current = Buffer.from(fileData.content, 'base64').toString('utf8')

  if (!current.includes(udid)) {
    const label = `${deviceName} (${product})`.replace(/[^\w\s().,-]/g, '').trim().slice(0, 50)
    const updated = current.trimEnd() + `\n${udid}\t${label}\n`

    const putRes = await fetch(`${base}/contents/${DEVICES_PATH}`, {
      method: 'PUT',
      headers: ghHeaders(),
      body: JSON.stringify({
        message: `chore: register device ${label}`,
        content: Buffer.from(updated).toString('base64'),
        sha: fileData.sha,
      }),
    })

    if (!putRes.ok) {
      const body = await putRes.text()
      console.error(`[github-trigger] devices.txt update failed (${putRes.status}): ${body}`)
      return
    }
    console.log(`[github-trigger] Added ${udid} (${label}) to devices.txt`)
  }

  // Fire the build whether the UDID was new or not — re-enrollment should still
  // produce a fresh IPA in case a prior build failed.
  const dispatchRes = await fetch(`${base}/dispatches`, {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify({
      event_type: 'build-ios',
      client_payload: { udid, device: `${deviceName} (${product})` },
    }),
  })

  if (dispatchRes.status === 204) {
    console.log(`[github-trigger] Build dispatch sent (${udid})`)
  } else {
    const body = await dispatchRes.text()
    console.error(`[github-trigger] Dispatch failed (${dispatchRes.status}): ${body}`)
  }
}

module.exports = { triggerBuildForNewUdid }
