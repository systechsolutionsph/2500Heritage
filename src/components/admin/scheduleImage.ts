import { bookingCourts, hourSlots, isSlotPast } from '../../data/booking'
import { getBlockAt, getBookingAt } from '../../data/store'
import { sports } from '../../data/sports'
import logoFull from '../../assets/logo-full.png'

// Draws the day's court availability as a shareable PNG (green = open,
// booked = sport emoji, hatched = already past) and downloads it.

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
const AVAILABLE = '#DCCDA5'
const AVAILABLE_LINE = '#B8A878'
const PAST = '#E4E5E3'
const PAST_EDGE = '#C4C7C4'
const PAST_LINE = '#A3A6A3'
// Booked cells use the same markers as the public booking page.
// No customer names are drawn.
const SPORT_EMOJI: Record<string, string> = {
  PB: '\u{1F3D3}', // 🏓
  BM: '\u{1F3F8}', // 🏸
  TK: '\u{1F94B}', // 🥋
}
const LOCK_EMOJI = '\u{1F512}' // 🔒
const BLOCK_EMOJI = '\u{1F6AB}' // 🚫
const BOOKED = '#A13B49'
const RESERVED = '#D3A53A'
const BLOCKED = '#111111'
const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif'
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

function drawReclubLogo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const scale = size / 40
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(scale, scale)
  ctx.fillStyle = '#FFE34D'
  roundRect(ctx, 0, 0, 40, 40, 10)
  ctx.fill()
  ctx.strokeStyle = '#4055C8'
  ctx.lineWidth = 4
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.stroke(new Path2D('M13 30V10h8.5a6 6 0 0 1 0 12H13m7 0 8 8'))
  ctx.restore()
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

  ctx.strokeStyle = PAST_EDGE
  ctx.lineWidth = 1
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r)
  ctx.stroke()
}

function availableIndicator(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.fillStyle = AVAILABLE
  roundRect(ctx, x, y, w, h, r)
  ctx.fill()
  ctx.strokeStyle = AVAILABLE_LINE
  ctx.lineWidth = 1
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r)
  ctx.stroke()
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
  const usedLegend = new Set<string>()
  courts.forEach((court, rowIndex) => {
    const y = gridTop + rowIndex * (ROW_H + ROW_GAP)
    const [mainName, subName] = court.name.split(' — ')
    text(ctx, mainName, PAD, y + (subName ? 20 : 28), `700 17px ${BODY}`, INK)
    if (subName) text(ctx, subName, PAD, y + 38, `400 13px ${BODY}`, MUTED)

    hourSlots.forEach((slot, colIndex) => {
      const x = gridLeft + colIndex * (cellW + GAP)
      const past = isSlotPast(dayIso, slot.hour)
      const booking = getBookingAt(dayIso, court.id, slot.hour)
      const block = booking ? undefined : getBlockAt(dayIso, court.id, slot.hour)

      if (booking || block) {
        const sportId = sports.find((sport) => sport.name === booking?.sport)?.id
        const reserved = Boolean(booking && booking.status !== 'confirmed')
        let fill = BOOKED
        if (block) fill = BLOCKED
        else if (reserved) fill = RESERVED

        let legendKey = 'booked'
        if (block) legendKey = 'blocked'
        else if (booking?.source === 'reclub') legendKey = 'reclub'
        else if (reserved) legendKey = 'reserved'
        else if (sportId) legendKey = `sport:${sportId}`
        usedLegend.add(legendKey)

        ctx.save()
        if (past) ctx.globalAlpha = 0.6
        ctx.fillStyle = fill
        roundRect(ctx, x, y, cellW, ROW_H, 6)
        ctx.fill()

        if (booking?.source === 'reclub' && !reserved) {
          drawReclubLogo(ctx, x + cellW / 2 - 12, y + ROW_H / 2 - 12, 24)
        } else {
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          if (reserved) {
            ctx.font = `700 18px ${BODY}`
            ctx.fillStyle = INK
            ctx.fillText('R', x + cellW / 2, y + ROW_H / 2 + 1)
          } else {
            ctx.font = `22px ${EMOJI_FONT}`
            ctx.fillStyle = '#FFFFFF'
            const marker = block ? BLOCK_EMOJI : sportId ? SPORT_EMOJI[sportId] ?? LOCK_EMOJI : LOCK_EMOJI
            ctx.fillText(marker, x + cellW / 2, y + ROW_H / 2 + 1)
          }
        }
        ctx.restore()
      } else if (past) {
        usedLegend.add('past')
        pastIndicator(ctx, x, y, cellW, ROW_H, 6)
      } else {
        availableIndicator(ctx, x, y, cellW, ROW_H, 6)
      }
    })
  })

  // Legend: only the entries that actually appear on this day
  const legendItems: { key: string; label: string; color?: string; marker?: string; hatched?: boolean; logo?: boolean; available?: boolean }[] = [
    { key: 'available', label: 'Available', available: true },
    ...sports
      .filter((sport) => usedLegend.has(`sport:${sport.id}`))
      .map((sport) => ({
        key: `sport:${sport.id}`,
        label: `${sport.name} booked`,
        color: BOOKED,
        marker: SPORT_EMOJI[sport.id] ?? LOCK_EMOJI,
      })),
    ...(usedLegend.has('reserved') ? [{ key: 'reserved', label: 'Reserved', color: RESERVED, marker: 'R' }] : []),
    ...(usedLegend.has('reclub') ? [{ key: 'reclub', label: 'Reclub', logo: true }] : []),
    ...(usedLegend.has('booked') ? [{ key: 'booked', label: 'Booked', color: BOOKED, marker: LOCK_EMOJI }] : []),
    ...(usedLegend.has('blocked') ? [{ key: 'blocked', label: 'Blocked', color: BLOCKED, marker: BLOCK_EMOJI }] : []),
    { key: 'past', label: 'Past', hatched: true },
  ]
  let legendX = PAD
  legendItems.forEach((item) => {
    const swatchW = item.marker || item.logo ? 28 : 22
    if (item.available) {
      availableIndicator(ctx, legendX, legendY - 16, swatchW, 20, 4)
    } else if (item.hatched) {
      pastIndicator(ctx, legendX, legendY - 16, swatchW, 20, 4)
    } else if (item.logo) {
      drawReclubLogo(ctx, legendX + 4, legendY - 16, 20)
    } else {
      ctx.fillStyle = item.color ?? AVAILABLE
      roundRect(ctx, legendX, legendY - 16, swatchW, 20, 4)
      ctx.fill()
      if (item.marker) {
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const isLetter = item.marker === 'R'
        ctx.font = isLetter ? `700 13px ${BODY}` : `14px ${EMOJI_FONT}`
        ctx.fillStyle = isLetter ? INK : '#FFFFFF'
        ctx.fillText(item.marker, legendX + swatchW / 2, legendY - 5)
        ctx.textBaseline = 'alphabetic'
      }
    }
    text(ctx, item.label, legendX + swatchW + 10, legendY - 1, `500 14px ${BODY}`, INK)
    ctx.font = `500 14px ${BODY}`
    legendX += swatchW + 10 + ctx.measureText(item.label).width + 24
  })

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
    `Generated ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
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
