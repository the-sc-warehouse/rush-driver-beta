async function sendNotification(udid, deviceName, product, ip) {
  const message = `New tester: ${deviceName} (${product})\nUDID: ${udid}`

  // Rush Driver app — sends Telegram Approve/Deny message to admin
  // Requires RUSH_APP_URL and BUILD_NOTIFY_SECRET env vars on this service
  const appUrl    = process.env.RUSH_APP_URL
  const appSecret = process.env.BUILD_NOTIFY_SECRET
  if (appUrl && appSecret) {
    try {
      const res = await fetch(`${appUrl}/api/bot/udid-notify`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${appSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ udid, name: deviceName, product, ip: ip || null }),
      })
      if (!res.ok) console.error('[notify] rush-app returned', res.status)
    } catch (e) {
      console.error('[notify] rush-app failed:', e.message)
    }
  }

  // ntfy.sh — free push notifications, no account needed
  if (process.env.NTFY_TOPIC) {
    try {
      await fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
        method: 'POST',
        headers: { Title: 'Rush Driver — New Beta Tester', Priority: 'high', Tags: 'iphone' },
        body: message
      })
    } catch (e) {
      console.error('[notify] ntfy failed:', e.message)
    }
  }

  // Discord webhook
  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `**Rush Driver Beta — New tester enrolled**\nDevice: ${deviceName} (${product})\nUDID: \`${udid}\``
        })
      })
    } catch (e) {
      console.error('[notify] Discord failed:', e.message)
    }
  }

  console.log(`[notify] ${deviceName} (${product}) — ${udid}`)
}

module.exports = { sendNotification }
