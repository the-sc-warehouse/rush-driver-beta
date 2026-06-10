require('dotenv').config()
const express = require('express')
const path = require('path')
const { generateEnrollmentProfile, generateEnrolledProfile } = require('./lib/profiles')
const { registerDevice } = require('./lib/apple-api')
const { parseUDIDPayload } = require('./lib/udid')
const { sendNotification } = require('./lib/notify')

const app = express()

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }))

// ─── Enroll: serve pre-signed profile (signed = no 60-min iOS delay) ─────────
app.get('/enroll', (req, res) => {
  res.setHeader('Content-Type', 'application/x-apple-aspen-config')
  res.setHeader('Content-Disposition', 'attachment; filename="RushDriverBeta.mobileconfig"')
  res.sendFile(path.join(__dirname, 'public', 'enroll-signed.mobileconfig'))
})

// ─── Callback: Apple POSTs device info here after profile install ─────────────
app.post('/enroll/callback', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const device = parseUDIDPayload(req.body)
    const { UDID: udid, DEVICE_NAME: name = 'Unknown', PRODUCT: product = 'Unknown' } = device

    console.log(`[enroll] ${name} (${product}) — ${udid}`)

    // Register in Apple Developer — 409 means already registered, that's fine
    const result = await registerDevice(udid, `${name} - ${product}`)
    if (result.errors) {
      const status = result.errors[0]?.status
      if (status !== '409') console.warn('[apple-api]', JSON.stringify(result.errors))
    } else {
      console.log(`[apple-api] Registered ${udid}`)
    }

    await sendNotification(udid, name, product)

    // iOS requires a valid mobileconfig response or it shows an error
    const profile = generateEnrolledProfile()
    res.setHeader('Content-Type', 'application/x-apple-aspen-config')
    res.send(profile)
  } catch (err) {
    console.error('[enroll error]', err.message)
    res.status(500).send('Enrollment failed')
  }
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

// ─── Health check for Render ──────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }))

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
})
