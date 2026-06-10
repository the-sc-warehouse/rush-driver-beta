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

// ─── Enroll: dynamically sign and serve the enrollment profile ────────────────
app.get('/enroll', (req, res) => {
  const serverUrl = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`
  try {
    const xml    = generateEnrollmentProfile(serverUrl)
    const signed = signProfile(xml)
    res.setHeader('Content-Type', 'application/x-apple-aspen-config')
    res.setHeader('Content-Disposition', 'attachment; filename="RushDriverBeta.mobileconfig"')
    res.send(signed)
  } catch (err) {
    console.error('[enroll] sign failed:', err.message)
    res.status(500).send('Profile signing failed — check server logs')
  }
})

// ─── Callback: Apple POSTs PKCS7-signed device info here ─────────────────────
// iOS 16+ requires the response to be encrypted with the device's own certificate.
app.post('/enroll/callback', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const tmp = os.tmpdir()
  const ts  = Date.now()
  const payloadFile   = path.join(tmp, `payload_${ts}.der`)
  const deviceCert    = path.join(tmp, `devcert_${ts}.pem`)
  const profileFile   = path.join(tmp, `profile_${ts}.xml`)
  const signedFile    = path.join(tmp, `signed_${ts}.der`)
  const encryptedFile = path.join(tmp, `enc_${ts}.der`)
  const serverCert    = path.join(tmp, `srvcert_${ts}.pem`)
  const serverKey     = path.join(tmp, `srvkey_${ts}.pem`)
  const cleanup = () => [payloadFile, deviceCert, profileFile, signedFile, encryptedFile, serverCert, serverKey]
    .forEach(f => { try { fs.unlinkSync(f) } catch (_) {} })

  try {
    fs.writeFileSync(payloadFile, req.body)

    // Extract the device's certificate from the signed POST body
    execSync(`openssl pkcs7 -inform DER -in "${payloadFile}" -print_certs -out "${deviceCert}" 2>/dev/null`, { timeout: 5000 })

    // Write server signing cert/key
    fs.writeFileSync(serverCert, Buffer.from(process.env.SIGN_CERT_B64, 'base64').toString())
    fs.writeFileSync(serverKey,  Buffer.from(process.env.SIGN_KEY_B64,  'base64').toString())

    // Generate and sign the response profile
    const profileXml = generateEnrolledProfile()
    fs.writeFileSync(profileFile, profileXml)
    execSync(
      `openssl smime -sign -in "${profileFile}" -signer "${serverCert}" -inkey "${serverKey}" -certfile "${serverCert}" -outform DER -nodetach -out "${signedFile}"`,
      { timeout: 10000 }
    )

    // Encrypt the signed profile with the device's public key
    execSync(
      `openssl smime -encrypt -aes256 -binary -in "${signedFile}" -inform DER -outform DER -out "${encryptedFile}" "${deviceCert}"`,
      { timeout: 10000 }
    )

    const encrypted = fs.readFileSync(encryptedFile)
    cleanup()

    res.setHeader('Content-Type', 'application/x-apple-aspen-config')
    res.send(encrypted)
  } catch (err) {
    console.error('[callback] error:', err.message)
    cleanup()
    // Fallback: signed-only response
    try {
      res.setHeader('Content-Type', 'application/x-apple-aspen-config')
      res.send(signProfile(generateEnrolledProfile()))
    } catch (e) { res.status(500).send('Enrollment failed') }
  }

  // Best-effort background: parse UDID, register device, notify
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
      try { await sendNotification(udid, name, product) } catch (e) { console.error('[notify]', e.message) }
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
