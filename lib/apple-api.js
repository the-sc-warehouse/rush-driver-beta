const jwt = require('jsonwebtoken')

function generateToken() {
  const now = Math.floor(Date.now() / 1000)
  const privateKey = process.env.ASC_PRIVATE_KEY.replace(/\\n/g, '\n')

  return jwt.sign(
    {
      iss: process.env.ASC_ISSUER_ID,
      iat: now,
      exp: now + 1200,
      aud: 'appstoreconnect-v1'
    },
    privateKey,
    {
      algorithm: 'ES256',
      header: { kid: process.env.ASC_KEY_ID, typ: 'JWT' }
    }
  )
}

async function registerDevice(udid, name) {
  const token = generateToken()

  const res = await fetch('https://api.appstoreconnect.apple.com/v1/devices', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      data: {
        type: 'devices',
        attributes: {
          name: name.slice(0, 50),
          udid,
          platform: 'IOS'
        }
      }
    })
  })

  return res.json()
}

module.exports = { registerDevice }
