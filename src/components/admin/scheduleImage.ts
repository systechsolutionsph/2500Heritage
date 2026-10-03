import { bookingCourts, hourSlots, isSlotPast } from '../../data/booking'
import { isSlotTaken } from '../../data/store'
import logoFull from '../../assets/logo-full.png'

// Draws the day's court availability as a shareable PNG (green = open,
// beige = booked / reserved / blocked, hatched = already past) and downloads it.

const W = 1200
const SCALE = 2
const PAD = 56
const LABEL_W = 210
const GAP = 4
const ROW_H = 46
const ROW_GAP = 8
const QR_SIZE = 160

const INK = '#17302A'
const MUTED = 'rgba(23, 48, 42, 0.55)'
const CREAM = '#F7F4E8'
const BORDER = '#DDD6C0'
const GREEN = '#2F6B4F'
const UNAVAILABLE = '#E3DDCB'
const PAST = '#EEE9DC'
const PAST_LINE = '#C9C1AE'
const DISPLAY = '"Bricolage Grotesque", "Inter", system-ui, sans-serif'
const BODY = '"Inter", system-ui, sans-serif'

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not load image.'))
    image.src = src
  })
}

function hourLabel(hour: number) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12} ${hour < 12 || hour === 24 ? 'AM' : 'PM'}`
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function pastIndicator(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.fillStyle = PAST
  roundRect(ctx, x, y, w, h, r)
  ctx.fill()

  ctx.save()
  roundRect(ctx, x, y, w, h, r)
  ctx.clip()
  ctx.strokeStyle = PAST_LINE
  ctx.lineWidth = 1
  for (let offset = -h; offset < w; offset += 8) {
    ctx.beginPath()
    ctx.moveTo(x + offset, y + h)
    ctx.lineTo(x + offset + h, y)
    ctx.stroke()
  }
  ctx.restore()
}

function text(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  font: string,
  color: string,
  align: CanvasTextAlign = 'left',
  letterSpacing = '0px',
) {
  ctx.font = font
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = 'alphabetic'
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = letterSpacing
  ctx.fillText(value, x, y)
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px'
}

// The QR code should always point at the real website. Set VITE_SITE_URL
// (e.g. https://www.yoursite.com) so downloads made from localhost still
// carry the live address; otherwise the current address is used.
function publicSiteOrigin() {
  const configured = import.meta.env.VITE_SITE_URL?.trim()
  if (configured) {
    try {
      return new URL(configured.startsWith('http') ? configured : `https://${configured}`).origin
    } catch {
      // Ignore an invalid value and fall back below.
    }
  }
  return window.location.origin
}

export async function downloadScheduleImage(dayIso: string) {
  const date = new Date(`${dayIso}T00:00:00`)
  const courts = bookingCourts
  const cols = hourSlots.length

  try {
    await Promise.all([
      document.fonts.load(`700 40px ${DISPLAY}`),
      document.fonts.load(`600 16px ${BODY}`),
    ])
  } catch {
    // Fall back to system fonts.
  }

  const gridW = W - PAD * 2 - LABEL_W
  const cellW = (gridW - GAP * (cols - 1)) / cols
  const gridH = courts.length * ROW_H + (courts.length - 1) * ROW_GAP

  const dividerTop = PAD + 175
  const sectionTitleY = dividerTop + 46
  const hoursY = sectionTitleY + 50
  const gridTop = hoursY + 16
  const legendY = gridTop + gridH + 44
  const dividerBottom = legendY + 30
  const footerTop = dividerBottom + 32
  const H = footerTop + QR_SIZE + PAD

  const canvas = document.createElement('canvas')
  canvas.width = W * SCALE
  canvas.height = H * SCALE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Your browser could not create the image.')
  ctx.scale(SCALE, SCALE)

  // Background and card
  ctx.fillStyle = '#EDE8D6'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = CREAM
  roundRect(ctx, 16, 16, W - 32, H - 32, 28)
  ctx.fill()
  ctx.strokeStyle = BORDER
  ctx.lineWidth = 2
  ctx.stroke()

  // Header: venue (left), date (right)
  text(ctx, 'VENUE SCHEDULE', PAD, PAD + 14, `600 13px ${BODY}`, MUTED, 'left', '2px')
  text(ctx, '2500 HERITAGE', PAD, PAD + 82, `700 56px ${DISPLAY}`, INK)
  text(ctx, 'Daily court schedule', PAD, PAD + 114, `400 16px ${BODY}`, MUTED)

  const right = W - PAD
  text(ctx, date.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase(), right, PAD + 14, `600 13px ${BODY}`, MUTED, 'right', '2px')
  text(ctx, String(date.getDate()).padStart(2, '0'), right, PAD + 100, `700 92px ${DISPLAY}`, INK, 'right')
  text(ctx, date.toLocaleDateString('en-US', { month: 'long' }).toUpperCase(), right, PAD + 132, `700 20px ${BODY}`, INK, 'right', '3px')
  text(ctx, String(date.getFullYear()), right, PAD + 154, `500 14px ${BODY}`, MUTED, 'right', '2px')

  // Divider + section title
  ctx.strokeStyle = BORDER
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(PAD, dividerTop)
  ctx.lineTo(W - PAD, dividerTop)
  ctx.stroke()

  text(ctx, 'COURT AVAILABILITY', PAD, sectionTitleY, `700 20px ${DISPLAY}`, INK, 'left', '1px')
  const firstHour = hourSlots[0].hour
  const lastHour = hourSlots[hourSlots.length - 1].hour + 1
  text(ctx, `Open ${hourLabel(firstHour)} – ${hourLabel(lastHour)}`, right, sectionTitleY, `500 14px ${BODY}`, MUTED, 'right')

  // Hour headers
  const gridLeft = PAD + LABEL_W
  hourSlots.forEach((slot, index) => {
    const x = gridLeft + index * (cellW + GAP) + cellW / 2
    text(ctx, hourLabel(slot.hour), x, hoursY, `600 12px ${BODY}`, MUTED, 'center')
  })

  // Court rows
  courts.forEach((court, rowIndex) => {
    const y = gridTop + rowIndex * (ROW_H + ROW_GAP)
    const [mainName, subName] = court.name.split(' — ')
    text(ctx, mainName, PAD, y + (subName ? 20 : 28), `700 17px ${BODY}`, INK)
    if (subName) text(ctx, subName, PAD, y + 38, `400 13px ${BODY}`, MUTED)

    hourSlots.forEach((slot, colIndex) => {
      const x = gridLeft + colIndex * (cellW + GAP)
      const past = isSlotPast(dayIso, slot.hour)
      const available = !isSlotTaken(dayIso, court.id, slot.hour) && !past

      if (past) {
        pastIndicator(ctx, x, y, cellW, ROW_H, 6)
      } else {
        ctx.fillStyle = available ? GREEN : UNAVAILABLE
        roundRect(ctx, x, y, cellW, ROW_H, 6)
        ctx.fill()
      }

      if (available) {
        const cx = x + cellW / 2
        const cy = y + ROW_H / 2
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
        ctx.lineWidth = 2.5
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        ctx.moveTo(cx - 7, cy)
        ctx.lineTo(cx - 2, cy + 6)
        ctx.lineTo(cx + 8, cy - 6)
        ctx.stroke()
      }
    })
  })

  // Legend
  ctx.fillStyle = GREEN
  roundRect(ctx, PAD, legendY - 14, 22, 16, 4)
  ctx.fill()
  text(ctx, 'Available', PAD + 32, legendY - 1, `500 14px ${BODY}`, INK)
  ctx.fillStyle = UNAVAILABLE
  roundRect(ctx, PAD + 130, legendY - 14, 22, 16, 4)
  ctx.fill()
  text(ctx, 'Unavailable', PAD + 162, legendY - 1, `500 14px ${BODY}`, INK)
  pastIndicator(ctx, PAD + 300, legendY - 14, 22, 16, 4)
  text(ctx, 'Past', PAD + 332, legendY - 1, `500 14px ${BODY}`, INK)

  ctx.strokeStyle = BORDER
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(PAD, dividerBottom)
  ctx.lineTo(W - PAD, dividerBottom)
  ctx.stroke()

  // Footer: QR + booking link, logo on the right
  const bookingUrl = `${publicSiteOrigin()}/booking`
  let textX = PAD
  try {
    const QRCode = (await import('qrcode')).default
    const qrCanvas = document.createElement('canvas')
    await QRCode.toCanvas(qrCanvas, bookingUrl, {
      width: QR_SIZE,
      margin: 1,
      color: { dark: INK, light: CREAM },
    })
    ctx.drawImage(qrCanvas, PAD, footerTop, QR_SIZE, QR_SIZE)
    textX = PAD + QR_SIZE + 28
  } catch {
    // The image is still useful without the QR code.
  }

  text(ctx, 'SCAN TO CHECK LIVE AVAILABILITY', textX, footerTop + 52, `700 20px ${DISPLAY}`, INK, 'left', '0.5px')
  text(ctx, bookingUrl.replace(/^https?:\/\//, ''), textX, footerTop + 84, `500 15px ${BODY}`, MUTED)
  text(
    ctx,
    `Generated ${new Date().toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
    textX,
    footerTop + 112,
    `400 12px ${BODY}`,
    MUTED,
  )

  try {
    const logo = await loadImage(logoFull)
    const logoH = 64
    const logoW = Math.min(240, (logo.naturalWidth / logo.naturalHeight) * logoH)
    const drawH = (logo.naturalHeight / logo.naturalWidth) * logoW
    ctx.drawImage(logo, right - logoW, footerTop + QR_SIZE - drawH, logoW, drawH)
  } catch {
    text(ctx, '2500 Heritage', right, footerTop + QR_SIZE - 8, `700 22px ${DISPLAY}`, INK, 'right')
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Could not create the schedule image.')

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `2500-heritage-schedule-${dayIso}.png`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
