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

// Retry a fetch-based operation up to `attempts` times with exponential backoff.
async function withRetry(label, fn, attempts = 3) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const delay = 2000 * Math.pow(2, i - 1) // 2s, 4s
      console.warn(`[github-trigger] ${label} — retry ${i}/${attempts - 1} in ${delay}ms`)
      await new Promise(r => setTimeout(r, delay))
    }
    try {
      const result = await fn()
      if (result.ok || result.status === 204) return result
      // Don't retry client errors (4xx) — they won't self-heal
      if (result.status >= 400 && result.status < 500) return result
      lastErr = new Error(`HTTP ${result.status}`)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

async function triggerBuildForNewUdid(udid, deviceName, product) {
  if (!GITHUB_PAT || !GITHUB_OWNER || !GITHUB_REPO) {
    console.warn('[github-trigger] GITHUB_PAT / GITHUB_OWNER / GITHUB_REPO not set — skipping auto-build')
    return
  }

  const base = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`

  // ── 1. Fetch devices.txt ──────────────────────────────────────────────────
  let getRes
  try {
    getRes = await withRetry('read devices.txt', () =>
      fetch(`${base}/contents/${DEVICES_PATH}`, { headers: ghHeaders() })
    )
  } catch (e) {
    console.error(`[github-trigger] Could not read devices.txt after retries: ${e.message}`)
    return
  }

  if (!getRes.ok) {
    console.error(`[github-trigger] Could not read devices.txt (HTTP ${getRes.status})`)
    return
  }

  const fileData = await getRes.json()
  const current = Buffer.from(fileData.content, 'base64').toString('utf8')

  // ── 2. Append UDID if new ─────────────────────────────────────────────────
  if (!current.includes(udid)) {
    const label = `${deviceName} (${product})`.replace(/[^\w\s().,-]/g, '').trim().slice(0, 50)
    const updated = current.trimEnd() + `\n${udid}\t${label}\n`

    let putRes
    try {
      putRes = await withRetry('update devices.txt', () =>
        fetch(`${base}/contents/${DEVICES_PATH}`, {
          method: 'PUT',
          headers: ghHeaders(),
          body: JSON.stringify({
            message: `chore: register device ${label}`,
            content: Buffer.from(updated).toString('base64'),
            sha: fileData.sha,
          }),
        })
      )
    } catch (e) {
      console.error(`[github-trigger] devices.txt update failed after retries: ${e.message}`)
      return
    }

    if (!putRes.ok) {
      const body = await putRes.text()
      console.error(`[github-trigger] devices.txt update failed (${putRes.status}): ${body}`)
      return
    }
    console.log(`[github-trigger] Added ${udid} (${label}) to devices.txt`)
  }

  // ── 3. Fire the build dispatch (with retry) ───────────────────────────────
  // Fires whether the UDID was new or not — re-enrollment retries a failed build.
  let dispatchRes
  try {
    dispatchRes = await withRetry('build dispatch', () =>
      fetch(`${base}/dispatches`, {
        method: 'POST',
        headers: ghHeaders(),
        body: JSON.stringify({
          event_type: 'build-ios',
          client_payload: { udid, device: `${deviceName} (${product})` },
        }),
      })
    )
  } catch (e) {
    console.error(`[github-trigger] Build dispatch failed after retries: ${e.message}`)
    return
  }

  if (dispatchRes.status === 204) {
    console.log(`[github-trigger] Build dispatch sent (${udid})`)
  } else {
    const body = await dispatchRes.text()
    console.error(`[github-trigger] Dispatch failed (${dispatchRes.status}): ${body}`)
  }
}

module.exports = { triggerBuildForNewUdid }
