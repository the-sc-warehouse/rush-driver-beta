require('dotenv').config()
const express = require('express')
const path = require('path')
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const { generateEnrollmentProfile, generateEnrolledProfile } = require('./lib/profiles')
const { registerDevice } = require('./lib/apple-api')
const { parseUDIDPayload } = require('./lib/udid')
const { sendNotification } = require('./lib/notify')

const app = express()

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }))

function signProfile(xmlContent) {
  const certB64 = process.env.SIGN_CERT_B64
  const keyB64  = process.env.SIGN_KEY_B64
  if (!certB64 || !keyB64) throw new Error('SIGN_CERT_B64 / SIGN_KEY_B64 not set')

  const tmp     = os.tmpdir()
  const xmlFile  = path.join(tmp, `profile_${Date.now()}.xml`)
  const certFile = path.join(tmp, `cert_${Date.now()}.pem`)
  const keyFile  = path.join(tmp, `key_${Date.now()}.pem`)

  fs.writeFileSync(xmlFile,  xmlContent)
  fs.writeFileSync(certFile, Buffer.from(certB64, 'base64').toString('utf8'))
  fs.writeFileSync(keyFile,  Buffer.from(keyB64,  'base64').toString('utf8'))

  try {
    return execSync(
      `openssl smime -sign -in "${xmlFile}" -signer "${certFile}" -inkey "${keyFile}" -certfile "${certFile}" -outform DER -nodetach`,
      { encoding: 'buffer', timeout: 10000 }
    )
  } finally {
    [xmlFile, certFile, keyFile].forEach(f => { try { fs.unlinkSync(f) } catch (_) {} })
  }
}

// ─── Enroll: serve enrollment profile (dynamic if signing certs set, else static) ─
app.get('/enroll', (req, res) => {
  res.setHeader('Content-Type', 'application/x-apple-aspen-config')
  res.setHeader('Content-Disposition', 'attachment; filename="RushDriverBeta.mobileconfig"')

  if (process.env.SIGN_CERT_B64 && process.env.SIGN_KEY_B64) {
    const serverUrl = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`
    try {
      const signed = signProfile(generateEnrollmentProfile(serverUrl))
      return res.send(signed)
    } catch (err) {
      console.error('[enroll] dynamic sign failed, falling back to static:', err.message)
    }
  }

  // Fall back to the pre-signed static file (no cert env vars needed)
  res.sendFile(path.join(__dirname, 'public', 'enroll-signed.mobileconfig'))
})

// ─── Callback: Apple POSTs PKCS7-signed device info here ─────────────────────
app.post('/enroll/callback', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  // Respond immediately — iOS only needs a valid signed profile back.
  // All UDID processing happens in the background so the connection isn't held open.
  try {
    const signed = signProfile(generateEnrolledProfile())
    res.setHeader('Content-Type', 'application/x-apple-aspen-config')
    res.send(signed)
    console.log('[callback] sent signed profile response')
  } catch (err) {
    console.error('[callback] sign failed:', err.message)
    const xml = generateEnrolledProfile()
    res.setHeader('Content-Type', 'application/x-apple-aspen-config')
    res.send(xml)
  }

  // Best-effort background: parse UDID, register with Apple, notify, trigger build
  setImmediate(async () => {
    try {
      const device = parseUDIDPayload(req.body)
      const { UDID: udid, DEVICE_NAME: name = 'Unknown', PRODUCT: product = 'Unknown' } = device
      console.log(`[enroll] ${name} (${product}) — ${udid}`)
      try {
        const result = await registerDevice(udid, `${name} - ${product}`)
        if (result.errors) {
          const s = result.errors[0]?.status
          if (s !== '409') console.warn('[apple-api]', JSON.stringify(result.errors))
        } else { console.log(`[apple-api] Registered ${udid}`) }
      } catch (e) { console.error('[apple-api]', e.message) }
      try { await sendNotification(udid, name, product, req.ip) } catch (e) { console.error('[notify]', e.message) }
    } catch (e) { console.error('[enroll parse]', e.message) }
  })
})

// ─── OTA manifest: itms-services:// install points here ──────────────────────
app.get('/manifest.plist', (req, res) => {
  const ipaUrl = process.env.LATEST_IPA_URL
  if (!ipaUrl) return res.status(404).send('No build available yet — check back soon.')

  res.setHeader('Content-Type', 'text/xml')
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key><string>software-package</string>
          <key>url</key><string>${ipaUrl}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>${process.env.BUNDLE_ID || 'com.rushdriver.app'}</string>
        <key>bundle-version</key><string>${process.env.APP_VERSION || '1.0.0'}</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>${process.env.APP_NAME || 'Rush Driver'}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>`)
})

// ─── TestFlight self-serve enrollment ────────────────────────────────────────
const BETA_GROUP_ID = 'e605e879-0324-4dc7-acd7-92497227d840' // Beta Members (external)

function ascJwt() {
  const jwt = require('jsonwebtoken')
  const now = Math.floor(Date.now() / 1000)
  const privateKey = (process.env.ASC_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  if (!privateKey || !process.env.ASC_KEY_ID || !process.env.ASC_ISSUER_ID) throw new Error('ASC creds not set')
  return jwt.sign(
    { iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' },
    privateKey,
    { algorithm: 'ES256', header: { kid: process.env.ASC_KEY_ID, typ: 'JWT' } }
  )
}

app.post('/api/beta/join', express.json(), async (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Valid email required' })
  }
  try {
    const bearer = ascJwt()
    const r = await fetch('https://api.appstoreconnect.apple.com/v1/betaTesters', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          type: 'betaTesters',
          attributes: { email },
          relationships: {
            betaGroups: { data: [{ type: 'betaGroups', id: BETA_GROUP_ID }] }
          }
        }
      })
    })
    const body = await r.json()
    if (r.status === 409) {
      // Already a tester — try to just add them to the group
      const existingId = body.errors?.[0]?.source?.pointer?.includes('email')
        ? null
        : body.errors?.[0]?.id
      console.log(`[beta/join] ${email} already a tester`)
      return res.json({ ok: true, already: true })
    }
    if (!r.ok) {
      console.error('[beta/join] ASC error:', JSON.stringify(body))
      return res.status(502).json({ ok: false, error: 'Failed to add tester' })
    }
    console.log(`[beta/join] Added ${email} to TestFlight`)
    res.json({ ok: true })
  } catch (e) {
    console.error('[beta/join]', e.message)
    res.status(500).json({ ok: false, error: 'Server error' })
  }
})

// ─── Health check for Render ──────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }))

// ─── Poll Apple portal for PROCESSING → ENABLED transitions ──────────────────
async function pollDeviceStatus() {
  const { registerDevice } = require('./lib/apple-api')
  try {
    const token = require('./lib/apple-api').__token?.()
    // Re-use the JWT generator from apple-api
    const jwt = require('jsonwebtoken')
    const now = Math.floor(Date.now() / 1000)
    const privateKey = (process.env.ASC_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    if (!privateKey || !process.env.ASC_KEY_ID || !process.env.ASC_ISSUER_ID) return

    const bearer = jwt.sign(
      { iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' },
      privateKey,
      { algorithm: 'ES256', header: { kid: process.env.ASC_KEY_ID, typ: 'JWT' } }
    )

    const res = await fetch('https://api.appstoreconnect.apple.com/v1/devices?limit=200', {
      headers: { Authorization: `Bearer ${bearer}` }
    })
    if (!res.ok) return

    const { data } = await res.json()
    const nowEnabled = (data || []).filter(d => d.attributes.status === 'ENABLED').map(d => d.attributes.udid)

    // Compare against last known set
    const prev = pollDeviceStatus._processing || new Set()
    const flipped = [...prev].filter(u => nowEnabled.includes(u))

    if (flipped.length > 0) {
      console.log(`[device-poll] ${flipped.length} device(s) now ENABLED:`, flipped)
      const { sendNotification } = require('./lib/notify')
      for (const udid of flipped) {
        await sendNotification(udid, 'Device Activated', 'Now ENABLED — ready for build', null)
        prev.delete(udid)
      }
    }

    // Update tracked set with current PROCESSING devices
    const processing = (data || []).filter(d => d.attributes.status === 'PROCESSING').map(d => d.attributes.udid)
    pollDeviceStatus._processing = new Set(processing)
    if (processing.length > 0) console.log(`[device-poll] ${processing.length} still PROCESSING`)
  } catch (e) {
    console.error('[device-poll] error:', e.message)
  }
}
pollDeviceStatus._processing = new Set()

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`Rush Driver Beta Server on port ${PORT}`)
  console.log(`Enrollment URL: ${process.env.SERVER_URL || `http://localhost:${PORT}`}/enroll`)

  // Ping self every 14 minutes to prevent Render free tier cold starts
  const selfUrl = process.env.SERVER_URL
  if (selfUrl) {
    setInterval(() => {
      fetch(`${selfUrl}/health`).catch(() => {})
    }, 14 * 60 * 1000)
  }

  // Poll Apple device status every 30 minutes
  pollDeviceStatus()
  setInterval(pollDeviceStatus, 30 * 60 * 1000)
})
