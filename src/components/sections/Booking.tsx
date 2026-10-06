import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import Container from '../ui/Container'
import SectionHeading from '../ui/SectionHeading'
import Button from '../ui/Button'
import SportIllustration from '../ui/SportIllustration'
import ReclubLogo from '../ui/ReclubLogo'
import {
  bookingCourts,
  loadBookingCourts,
  hourSlots,
  getDayOptions,
  formatFullDate,
  isSlotBooked,
  isSlotPast,
  type DayOption,
  type BookingCourt,
  type HourSlot,
} from '../../data/booking'
import { createCustomerBooking, genReference, getBookingAt, getBlockAt, loadPublicSchedule, useBookingStoreVersion } from '../../data/store'
import { isSupabaseConfigured } from '../../data/supabase'
import { getPaymentQrCode, loadPaymentQrCode } from '../../data/paymentQr'
import { sports } from '../../data/sports'
import qrPlaceholder from '../../assets/payment-qr-placeholder.png'

const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024 // 3 MB

interface Selection {
  courtId: string
  courtName: string
  dayIso: string
  dayLabel: string
  startHour: number
  endHour: number // exclusive
  rate: number
}

type Step = 'calendar' | 'details' | 'payment' | 'confirmed'
type BookingModalView = 'category' | 'schedule'

const sportBookingMarkers: Record<string, string> = {
  PB: '🏓',
  BM: '🏸',
  TK: '🥋',
}

export default function Booking() {
  // Re-render whenever bookings/blocks change anywhere (e.g. staff blocks a slot in Admin).
  useBookingStoreVersion()
  const configuredPaymentQr = getPaymentQrCode()
  const [weekOffset, setWeekOffset] = useState(0)
  const days = useMemo(() => getDayOptions(7, weekOffset * 7), [weekOffset])
  const [activeDay, setActiveDay] = useState<DayOption>(days[0])

  const activeDayData = days.find((d) => d.iso === activeDay.iso) ?? days[0]

  const [selections, setSelections] = useState<Selection[]>([])
  const [selectedSport, setSelectedSport] = useState<string | null>(null)
  const [bookingModalOpen, setBookingModalOpen] = useState(true)
  const [bookingModalView, setBookingModalView] = useState<BookingModalView>('category')
  const [step, setStep] = useState<Step>('calendar')
  const bookingDialog = useRef<HTMLDialogElement>(null)
  const [form, setForm] = useState({ name: '', mobile: '', email: '' })
  const [paymentScreenshot, setPaymentScreenshot] = useState<File | null>(null)
  const [paymentScreenshotPreview, setPaymentScreenshotPreview] = useState('')
  const [paymentScreenshotError, setPaymentScreenshotError] = useState('')
  const [reference, setReference] = useState('')
  const [scheduleLoading, setScheduleLoading] = useState(isSupabaseConfigured)
  const [bookingSaving, setBookingSaving] = useState(false)
  const [bookingError, setBookingError] = useState('')

  useEffect(() => {
    if (!paymentScreenshot) {
      setPaymentScreenshotPreview('')
      return
    }
    const previewUrl = URL.createObjectURL(paymentScreenshot)
    setPaymentScreenshotPreview(previewUrl)
    return () => URL.revokeObjectURL(previewUrl)
  }, [paymentScreenshot])

  useEffect(() => {
    if (!isSupabaseConfigured || days.length === 0) return
    let active = true
    const refreshSchedule = async () => {
      setScheduleLoading(true)
      try {
        await Promise.all([
          loadBookingCourts(),
          loadPaymentQrCode(),
          loadPublicSchedule(days[0].iso, days[days.length - 1].iso),
        ])
        if (active) setBookingError('')
      } catch {
        if (active) setBookingError('Could not load the latest schedule. Refresh the page and try again.')
      } finally {
        if (active) setScheduleLoading(false)
      }
    }
    void refreshSchedule()
    const interval = window.setInterval(refreshSchedule, 20_000)
    window.addEventListener('focus', refreshSchedule)
    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshSchedule)
    }
  }, [days])

  useEffect(() => {
    const dialog = bookingDialog.current
    if (!dialog) return
    if (bookingModalOpen && !dialog.open) dialog.showModal()
    if (!bookingModalOpen && dialog.open) dialog.close()
  }, [bookingModalOpen])

  function switchDay(d: DayOption) {
    setActiveDay(d)
  }

  function chooseSport(sport: string) {
    setSelectedSport(sport)
    setSelections([])
    setBookingModalView('schedule')
  }

  function changeSport() {
    setSelections([])
    setSelectedSport(null)
    setBookingModalView('category')
  }

  function toggleHour(court: (typeof bookingCourts)[number], hour: number) {
    if (scheduleLoading) return
    const dayIso = activeDayData.iso
    const booked = isSlotBooked(dayIso, court.id, hour)
    const past = isSlotPast(dayIso, hour)
    if (booked || past) return

    setSelections((prev) => {
      const existing = prev.find((s) => s.courtId === court.id && s.dayIso === dayIso)

      if (!existing) {
        return [
          ...prev,
          {
            courtId: court.id,
            courtName: court.name,
            dayIso,
            dayLabel: formatFullDate(activeDayData.date),
            startHour: hour,
            endHour: hour + 1,
            rate: court.rate,
          },
        ]
      }

      // clicking inside current range: shrink from whichever edge is closer
      if (hour >= existing.startHour && hour < existing.endHour) {
        if (hour === existing.startHour && hour === existing.endHour - 1) {
          return prev.filter((s) => s !== existing)
        }
        if (hour === existing.startHour) {
          return prev.map((s) => (s === existing ? { ...s, startHour: hour + 1 } : s))
        }
        if (hour === existing.endHour - 1) {
          return prev.map((s) => (s === existing ? { ...s, endHour: hour } : s))
        }
        // clicked mid-range: reset selection to just this hour
        return prev.map((s) => (s === existing ? { ...s, startHour: hour, endHour: hour + 1 } : s))
      }

      // extend forward or backward if adjacent
      if (hour === existing.endHour) {
        return prev.map((s) => (s === existing ? { ...s, endHour: hour + 1 } : s))
      }
      if (hour === existing.startHour - 1) {
        return prev.map((s) => (s === existing ? { ...s, startHour: hour } : s))
      }

      // not adjacent: start a fresh single-hour selection for this court/day
      return prev.map((s) =>
        s === existing ? { ...s, startHour: hour, endHour: hour + 1 } : s,
      )
    })
  }

  function removeSelection(target: Selection) {
    setSelections((prev) =>
      prev.filter((s) => s.courtId !== target.courtId || s.dayIso !== target.dayIso),
    )
  }

  const currentSelections = selections.map((selection) => {
    const court = bookingCourts.find((item) => item.id === selection.courtId)
    return court ? { ...selection, courtName: court.name, rate: court.rate } : selection
  })
  const total = currentSelections.reduce((sum, s) => sum + (s.endHour - s.startHour) * s.rate, 0)
  const totalHours = currentSelections.reduce((sum, s) => sum + (s.endHour - s.startHour), 0)

  function goToDetails() {
    if (selections.length === 0) return
    setStep('details')
  }

  function goToPayment() {
    if (!form.name.trim() || !form.mobile.trim()) return
    setReference(genReference())
    setStep('payment')
  }

  function choosePaymentScreenshot(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    setPaymentScreenshotError('')
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setPaymentScreenshot(null)
      setPaymentScreenshotError('Choose a PNG, JPG, or WEBP screenshot.')
      return
    }

    if (file.size > MAX_SCREENSHOT_BYTES) {
      setPaymentScreenshot(null)
      setPaymentScreenshotError('The screenshot must be 3 MB or smaller. Choose a smaller image.')
      return
    }

    setPaymentScreenshot(file)
  }

  async function confirmBooking() {
    if (!selectedSport || !paymentScreenshot) return
    setBookingSaving(true)
    setBookingError('')
    try {
      const ref = await createCustomerBooking({
        reference,
        name: form.name,
        mobile: form.mobile,
        email: form.email,
        sport: selectedSport,
        paymentScreenshot,
        slots: currentSelections,
      })
      setReference(ref)
      setStep('confirmed')
    } catch (error) {
      setBookingError(error instanceof Error ? error.message : 'Could not submit the booking. Please try again.')
    } finally {
      setBookingSaving(false)
    }
  }

  function startOver() {
    setSelections([])
    setSelectedSport(null)
    setForm({ name: '', mobile: '', email: '' })
    setPaymentScreenshot(null)
    setPaymentScreenshotError('')
    setReference('')
    setStep('calendar')
    setBookingModalView('category')
    setBookingModalOpen(true)
  }

  function closeBookingModal() {
    setBookingModalOpen(false)
  }

  return (
    <section id="booking" className="bg-sand-dim py-16 sm:py-24 lg:py-28">
      <Container className="flex flex-col gap-10">
        <SectionHeading
          title="Book a court."
          lede="Pick a date and time, review your total, then pay by GCash or Maya QR — no account needed."
        />

        {!bookingModalOpen && (
          <Button className="self-start" onClick={() => setBookingModalOpen(true)}>
            Continue booking
          </Button>
        )}

        <dialog
          ref={bookingDialog}
          aria-labelledby={
            bookingModalView === 'category'
              ? 'booking-category-title'
              : step === 'details'
                ? 'booking-details-title'
                : step === 'payment'
                  ? 'booking-payment-title'
                  : step === 'confirmed'
                    ? 'booking-confirmed-title'
                    : 'booking-schedule-title'
          }
          onCancel={(event) => {
            event.preventDefault()
            closeBookingModal()
          }}
          className={`m-auto max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] overflow-y-auto rounded-card border border-ink/10 bg-sand p-0 shadow-2xl backdrop:bg-ink/70 backdrop:backdrop-blur-sm ${
            bookingModalView === 'category'
              ? 'max-w-2xl'
              : step === 'calendar'
                ? 'max-w-[90rem]'
                : step === 'payment'
                  ? 'max-w-3xl'
                  : 'max-w-lg'
          }`}
        >
          {bookingModalView === 'category' && (
            <div className="p-4 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-court">Choose a category</p>
                  <h2 id="booking-category-title" className="mt-2 font-display text-xl font-semibold text-ink sm:text-2xl">
                    What would you like to book?
                  </h2>
                </div>
                <ModalCloseButton onClose={closeBookingModal} />
              </div>
              <p className="mt-2 text-sm text-ink/60">Select a sport to continue to the date and time calendar.</p>

              <div className="mt-5 grid gap-2.5 sm:grid-cols-3">
                {sports.map((sport) => (
                  <button
                    key={sport.id}
                    type="button"
                    onClick={() => chooseSport(sport.name)}
                    className="group flex min-h-36 flex-col items-start justify-between rounded-2xl border border-ink/10 bg-white p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-court/45 hover:shadow-lg hover:shadow-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-court"
                  >
                    <span>
                      <SportIllustration sportId={sport.id} className="mb-4 h-24 w-full rounded-xl" />
                      <span className="font-display text-lg font-semibold text-ink">{sport.name}</span>
                    </span>
                    <span className="mt-5 text-sm font-semibold text-ink transition-colors group-hover:text-court">
                      Choose {sport.name} <span aria-hidden="true">→</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {bookingModalView === 'schedule' && step === 'calendar' && selectedSport && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 px-5 py-4 sm:px-7">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-court">{selectedSport}</p>
                  <h2 id="booking-schedule-title" className="mt-1 font-display text-xl font-semibold text-ink sm:text-2xl">
                    Choose a date and time
                  </h2>
                </div>
                <div className="flex items-center gap-3">
                  <button type="button" onClick={changeSport} className="text-sm font-semibold text-court hover:text-ink">
                    Change category
                  </button>
                  <ModalCloseButton onClose={closeBookingModal} />
                </div>
              </div>
              <div className="grid min-w-0 gap-5 px-3 py-4 sm:px-6 sm:py-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
            <div className="overflow-hidden rounded-card border border-ink/10 bg-sand shadow-xl shadow-ink/5">
              {/* Date strip */}
              <div className="bg-ink px-4 py-5 sm:px-6">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    aria-label="Previous week"
                    onClick={() => setWeekOffset((w) => Math.max(0, w - 1))}
                    disabled={weekOffset === 0}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sand/70 transition-colors hover:text-sand disabled:opacity-30"
                  >
                    ‹
                  </button>
                  <p className="font-display text-sm font-semibold text-sand sm:text-base">
                    {formatFullDate(activeDayData.date)}
                  </p>
                  <button
                    type="button"
                    aria-label="Next week"
                    onClick={() => setWeekOffset((w) => w + 1)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sand/70 transition-colors hover:text-sand"
                  >
                    ›
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-7 gap-1.5 sm:gap-2">
                  {days.map((d) => {
                    const isActive = d.iso === activeDayData.iso
                    return (
                      <button
                        key={d.iso}
                        type="button"
                        onClick={() => switchDay(d)}
                        className={`flex flex-col items-center gap-0.5 rounded-xl border px-1.5 py-2 text-center transition-all ${
                          isActive
                            ? 'border-transparent bg-sand text-ink'
                            : 'border-citrus/40 bg-transparent text-sand hover:border-citrus'
                        }`}
                      >
                        <span className="text-[0.6rem] font-semibold uppercase tracking-wide opacity-70">
                          {d.isToday ? 'Now' : d.weekday}
                        </span>
                        <span className="font-display text-sm font-semibold sm:text-base">
                          {d.dayNum}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Legend */}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-ink/10 px-4 py-3 text-xs text-ink/70 sm:px-6">
                <span className="text-[0.7rem] font-semibold uppercase tracking-wide text-ink/50">
                  Legend
                </span>
                <LegendSwatch className="border border-ink/20 bg-sand" label="Available" />
                <LegendSwatch className="bg-citrus" label="Reserved" />
                <LegendSwatch className="bg-tide" label="Booked (sport emoji)" />
                <LegendSwatch className="bg-ink/50" label="Blocked 🚫" />
                <LegendSwatch className="bg-citrus" label="Selected" />
                <LegendSwatch className="border border-ink/10 bg-sand-dim" label="Past" />
              </div>

              {/* Grid */}
              <p className="px-4 pt-3 text-xs text-ink/50 sm:px-6">
                Hours run from 8:00 AM to 12:00 AM. Tap available times to select a continuous block.
              </p>
              {scheduleLoading && <p role="status" className="px-4 pt-2 text-xs font-medium text-court sm:px-6">Loading the latest availability…</p>}
              {bookingError && <p role="alert" className="px-4 pt-2 text-xs font-medium text-tide sm:px-6">{bookingError}</p>}
              <div className="px-3 py-4 sm:px-4 md:hidden">
                <div className="grid gap-3">
                  {bookingCourts.map((court) => {
                    const selection = selections.find(
                      (s) => s.courtId === court.id && s.dayIso === activeDayData.iso,
                    )
                    return (
                      <section key={court.id} className="rounded-xl border border-ink/10 bg-white/70 p-2.5">
                        <div className="mb-2 flex items-baseline justify-between gap-2 px-0.5">
                          <p className="min-w-0 truncate text-xs font-semibold text-ink">{court.name}</p>
                          <p className="shrink-0 text-[0.65rem] text-ink/55">₱{court.rate}/hr</p>
                        </div>
                        <div className="grid grid-cols-8 gap-1">
                          {hourSlots.map((hour) => (
                            <ScheduleSlotButton
                              key={hour.hour}
                              court={court}
                              hour={hour}
                              dayIso={activeDayData.iso}
                              selection={selection}
                              compact
                              isLoading={scheduleLoading}
                              onToggle={toggleHour}
                            />
                          ))}
                        </div>
                      </section>
                    )
                  })}
                </div>
              </div>
              <div className="hidden min-w-0 px-2 py-4 md:block sm:px-4">
                <div
                  className="grid min-w-0 gap-1"
                  style={{ gridTemplateColumns: `minmax(82px,1.35fr) repeat(${hourSlots.length}, minmax(0,1fr))` }}
                >
                  <div />
                  {hourSlots.map((hour) => (
                    <div key={hour.hour} className="pb-2 text-center font-medium text-ink/60">
                      <TimeRangeLabel hour={hour.hour} compact />
                    </div>
                  ))}

                  {bookingCourts.map((court) => {
                    const selection = selections.find(
                      (s) => s.courtId === court.id && s.dayIso === activeDayData.iso,
                    )
                    return (
                      <div key={court.id} className="contents">
                        <div className="flex min-w-0 flex-col justify-center py-2 pr-1.5">
                          <p className="truncate text-xs font-semibold text-ink">{court.name}</p>
                          <p className="text-[0.65rem] text-ink/55">₱{court.rate}/hr</p>
                        </div>
                        {hourSlots.map((hour) => (
                          <ScheduleSlotButton
                            key={hour.hour}
                            court={court}
                            hour={hour}
                            dayIso={activeDayData.iso}
                            selection={selection}
                            isLoading={scheduleLoading}
                            onToggle={toggleHour}
                          />
                        ))}
                      </div>
                    )
                  })}
                </div>
              </div>

              <p className="border-t border-ink/10 px-4 py-3 text-xs text-ink/55 sm:px-6">
                Tap a slot to select it, tap again to extend or shrink your time range. One
                continuous block per court, per day.
              </p>
            </div>

            <BookingSummaryPanel
              selections={currentSelections}
              total={total}
              totalHours={totalHours}
              onRemove={removeSelection}
              onProceed={goToDetails}
            />
          </div>
            </>
          )}
        {step === 'details' && (
          <div className="relative mx-auto w-full max-w-lg rounded-card border border-ink/10 bg-sand p-6 shadow-xl shadow-ink/5 sm:p-9">
            <ModalCloseButton className="absolute right-4 top-4" onClose={closeBookingModal} />
            <button
              type="button"
              onClick={() => {
                setStep('calendar')
                setBookingModalView('schedule')
                setBookingModalOpen(true)
              }}
              className="mb-5 text-sm font-medium text-ink/60 hover:text-ink"
            >
              ← Back to schedule
            </button>
            <h3 id="booking-details-title" className="font-display text-lg font-semibold text-ink">Your details</h3>
            <p className="mt-1 text-sm text-ink/60">
              So we can confirm your booking and reach you if anything changes.
            </p>

            <div className="mt-6 flex flex-col gap-4">
              <Field label="Full name">
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Juan Dela Cruz"
                  className="w-full rounded-xl border border-ink/15 bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15"
                />
              </Field>
              <Field label="Mobile number">
                <input
                  type="tel"
                  value={form.mobile}
                  onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))}
                  placeholder="09XX XXX XXXX"
                  className="w-full rounded-xl border border-ink/15 bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15"
                />
              </Field>
              <Field label="Email (optional)">
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="juan@email.com"
                  className="w-full rounded-xl border border-ink/15 bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15"
                />
              </Field>
            </div>

            <Button
              variant="primary"
              className="mt-6 w-full"
              onClick={goToPayment}
              disabled={!form.name.trim() || !form.mobile.trim()}
            >
              Continue to payment →
            </Button>
          </div>
        )}

        {step === 'payment' && (
          <div className="relative mx-auto grid w-full max-w-3xl gap-7 rounded-card border border-ink/10 bg-sand p-5 shadow-xl shadow-ink/5 sm:p-9 md:grid-cols-[1fr_1.1fr]">
            <ModalCloseButton className="absolute right-4 top-4 z-10" onClose={closeBookingModal} />
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="w-full max-w-[220px] overflow-hidden rounded-2xl border-2 border-dashed border-citrus/50 bg-white p-2">
                <img src={configuredPaymentQr ?? qrPlaceholder} alt="Scan to pay via GCash or Maya" className="w-full rounded-xl" />
              </div>
              <p className="text-xs text-ink/50">
                {configuredPaymentQr
                  ? 'Scan the uploaded GCash or Maya QR code to pay.'
                  : 'Sample QR shown. Admin can upload the actual code in Courts & pricing.'}
              </p>
            </div>

            <div className="flex flex-col gap-4">
              <button
                type="button"
                onClick={() => setStep('details')}
                className="self-start text-sm font-medium text-ink/60 hover:text-ink"
              >
                ← Back
              </button>
              <div>
                <h3 id="booking-payment-title" className="font-display text-lg font-semibold text-ink">Scan &amp; pay</h3>
                <p className="mt-1 text-sm text-ink/60">
                  {selectedSport} booking · Open GCash or Maya, scan the code, and send the exact amount below.
                </p>
              </div>

              <div className="rounded-xl bg-ink px-4 py-3.5 text-sand">
                <p className="text-xs uppercase tracking-wide text-sand/60">Amount to send</p>
                <p className="font-display text-lg font-semibold text-tide-light">
                  ₱{total.toLocaleString()}
                </p>
              </div>

              <Field label="Booking reference (use this as the payment note)">
                <input
                  readOnly
                  value={reference}
                  className="w-full rounded-xl border border-ink/15 bg-sand-dim px-3.5 py-2.5 text-sm font-semibold text-ink"
                />
              </Field>

              <Field label="Payment screenshot (required)">
                <input
                  type="file"
                  required
                  accept="image/png,image/jpeg,image/webp"
                  onChange={choosePaymentScreenshot}
                  className="w-full rounded-xl border border-ink/15 bg-white px-3.5 py-2.5 text-sm text-ink file:mr-3 file:rounded-lg file:border-0 file:bg-citrus/20 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15"
                />
              </Field>
              <p className="-mt-2 text-xs text-ink/50">
                Upload a clear screenshot of your GCash or Maya payment. PNG, JPG, or WEBP — maximum 3 MB.
              </p>
              {paymentScreenshotError && <p role="alert" className="-mt-2 text-xs font-medium text-tide">{paymentScreenshotError}</p>}
              {paymentScreenshotPreview && (
                <div className="rounded-xl border border-ink/10 bg-white p-2">
                  <img
                    src={paymentScreenshotPreview}
                    alt="Payment screenshot preview"
                    className="mx-auto max-h-56 rounded-lg object-contain"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentScreenshot(null)
                      setPaymentScreenshotError('')
                    }}
                    className="mt-2 w-full text-center text-xs font-semibold text-tide hover:underline"
                  >
                    Remove screenshot
                  </button>
                  <p className="mt-2 break-all text-center text-xs text-ink/55">{paymentScreenshot?.name}</p>
                </div>
              )}

              <Button
                variant="primary"
                className="w-full"
                onClick={confirmBooking}
                disabled={!paymentScreenshot || bookingSaving}
              >
                {bookingSaving ? 'Submitting…' : 'Submit booking for review'}
              </Button>
              {bookingError && <p role="alert" className="text-center text-xs font-medium text-tide">{bookingError}</p>}
              <p className="text-center text-xs text-ink/45">
                Your slot will be reserved while staff verifies your payment screenshot.
              </p>
            </div>
          </div>
        )}

        {step === 'confirmed' && (
          <div className="relative mx-auto flex w-full max-w-lg flex-col items-center gap-4 rounded-card border border-ink/10 bg-sand p-8 text-center shadow-xl shadow-ink/5">
            <ModalCloseButton className="absolute right-4 top-4" onClose={closeBookingModal} />
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-court/15 text-xl text-court">
              ✓
            </span>
            <h3 id="booking-confirmed-title" className="font-display text-lg font-semibold text-ink">Booking received!</h3>
            <p className="text-sm text-ink/65">
              Reference <span className="font-semibold text-ink">{reference}</span> — your slot is
              reserved while staff reviews your payment screenshot.
            </p>

            <div className="w-full rounded-xl bg-sand-dim p-4 text-left text-sm text-ink/75">
              <p className="mb-2 font-semibold text-ink">Category: {selectedSport}</p>
              <p className="mb-2 text-xs">Payment screenshot uploaded for review.</p>
              {selections.map((s) => (
                <div key={`${s.courtId}-${s.dayIso}`} className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-b border-ink/10 py-1.5 last:border-0">
                  <span className="min-w-0 break-words">
                    {s.courtName} · {s.dayLabel}, {s.startHour % 12 || 12}
                    {s.startHour < 12 ? 'AM' : 'PM'}–{s.endHour % 12 || 12}
                    {s.endHour < 12 || s.endHour === 24 ? 'AM' : 'PM'}
                  </span>
                  <span className="font-semibold text-ink">
                    ₱{((s.endHour - s.startHour) * s.rate).toLocaleString()}
                  </span>
                </div>
              ))}
              <div className="flex justify-between pt-2 text-base font-semibold text-ink">
                <span>Total</span>
                <span>₱{total.toLocaleString()}</span>
              </div>
            </div>

            <Button variant="secondary" onClick={startOver} className="!text-ink !border-ink/20">
              Book another slot
            </Button>
          </div>
        )}
        </dialog>
      </Container>
    </section>
  )
}

function TimeRangeLabel({ hour, compact = false }: { hour: number; compact?: boolean }) {
  const startHour = hour % 12 || 12
  const endHour = (hour + 1) % 12 || 12
  const startPeriod = hour < 12 ? 'AM' : 'PM'
  const endPeriod = hour + 1 >= 24 || hour + 1 < 12 ? 'AM' : 'PM'
  const period = startPeriod === endPeriod ? startPeriod : `${startPeriod}/${endPeriod}`

  return (
    <span className={`flex flex-col items-center leading-none ${compact ? 'text-[0.5rem]' : 'text-[0.55rem]'}`}>
      <span>{startHour}-{endHour}</span>
      <span className="mt-0.5 text-[0.45rem]">{period}</span>
    </span>
  )
}

function ModalCloseButton({ onClose, className = '' }: { onClose: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label="Close modal"
      title="Close"
      onClick={onClose}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ink/10 bg-white text-xl leading-none text-ink/60 transition-colors hover:bg-sand-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-court ${className}`}
    >
      ×
    </button>
  )
}

function ScheduleSlotButton({
  court,
  hour,
  dayIso,
  selection,
  compact = false,
  isLoading = false,
  onToggle,
}: {
  court: BookingCourt
  hour: HourSlot
  dayIso: string
  selection?: Selection
  compact?: boolean
  isLoading?: boolean
  onToggle: (court: BookingCourt, hour: number) => void
}) {
  const booking = getBookingAt(dayIso, court.id, hour.hour)
  const block = booking ? undefined : getBlockAt(dayIso, court.id, hour.hour)
  const unavailable = Boolean(booking || block)
  const past = isSlotPast(dayIso, hour.hour)
  const bookedSport = sports.find((sport) => sport.name === booking?.sport)
  const bookedEmoji = bookedSport ? sportBookingMarkers[bookedSport.id] : '\u{1F512}'
  const isSelected =
    !!selection && hour.hour >= selection.startHour && hour.hour < selection.endHour

  let cls = compact
    ? 'flex min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-md border px-0.5 text-[0.55rem] font-semibold leading-none transition-all '
    : 'flex h-9 min-w-0 items-center justify-center rounded-md border text-xs font-semibold transition-all '
  if (isLoading) cls += 'cursor-wait border-ink/5 bg-sand-dim text-ink/25'
  else if (past) cls += 'cursor-not-allowed border-ink/5 bg-sand-dim text-ink/25'
  else if (booking && booking.status !== 'confirmed') cls += 'cursor-not-allowed border-citrus bg-citrus text-ink'
  else if (booking) cls += 'cursor-not-allowed border-tide bg-tide text-sand'
  else if (block) cls += 'cursor-not-allowed border-ink/50 bg-ink/50 text-sand'
  else if (isSelected) cls += 'border-citrus bg-citrus text-ink shadow-sm shadow-citrus/25'
  else cls += 'border-ink/10 bg-white text-ink/35 hover:border-court/45 hover:bg-court/5 hover:text-ink'

  const marker = booking
    ? booking.status === 'confirmed'
      ? bookedEmoji
      : 'R'
    : block
      ? '\u{1F6AB}'
      : isSelected
        ? '\u2713'
        : ''
  const status = booking
    ? booking.source === 'reclub'
      ? 'Reclub booking'
      : booking.status === 'confirmed'
        ? `${booking.sport ?? 'booked'} booked`
        : 'Reserved'
    : block
      ? 'blocked'
    : isLoading
      ? 'loading availability'
      : past
        ? 'past'
        : isSelected
          ? 'selected'
          : 'available'

  return (
    <button
      type="button"
      disabled={isLoading || unavailable || past}
      onClick={() => onToggle(court, hour.hour)}
      className={cls}
      aria-label={`${court.name}, ${hour.label}, ${status}`}
      title={booking ? (booking.source === 'reclub' ? 'Reclub booking' : booking.status === 'confirmed' ? `${booking.sport ?? 'Booked'}` : 'Reserved') : block ? 'Blocked' : undefined}
    >
      {compact && <TimeRangeLabel hour={hour.hour} />}
      <span aria-hidden="true" className={compact ? 'text-[0.75rem]' : undefined}>
        {booking?.source === 'reclub'
          ? <ReclubLogo className={compact ? 'h-3.5 w-3.5' : 'h-5 w-5'} />
          : marker}
      </span>
    </button>
  )
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-3 w-3 rounded-sm ${className}`} />
      {label}
    </span>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-ink/50">{label}</span>
      {children}
    </label>
  )
}

function BookingSummaryPanel({
  selections,
  total,
  totalHours,
  onRemove,
  onProceed,
}: {
  selections: Selection[]
  total: number
  totalHours: number
  onRemove: (s: Selection) => void
  onProceed: () => void
}) {
  return (
    <aside className="flex flex-col overflow-hidden rounded-card border border-ink/10 bg-sand shadow-xl shadow-ink/5 lg:sticky lg:top-4">
      <div className="bg-ink px-5 py-4">
        <h3 className="font-display text-base font-semibold text-sand">Booking Summary</h3>
      </div>

      {selections.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink/50">
          Select a time slot to start your booking.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-ink/10">
          {selections.map((s) => (
            <div key={`${s.courtId}-${s.dayIso}`} className="flex items-start justify-between gap-3 px-5 py-3.5">
              <div>
                <p className="text-sm font-semibold text-ink">{s.courtName}</p>
                <p className="text-xs text-ink/55">
                  {s.dayLabel} · {s.startHour % 12 || 12}
                  {s.startHour < 12 ? 'AM' : 'PM'}–{s.endHour % 12 || 12}
                  {s.endHour < 12 || s.endHour === 24 ? 'AM' : 'PM'} ·{' '}
                  {s.endHour - s.startHour} hr × ₱{s.rate}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-sm font-semibold text-ink">
                  ₱{((s.endHour - s.startHour) * s.rate).toLocaleString()}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(s)}
                  aria-label="Remove"
                  className="text-ink/40 hover:text-tide"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-auto border-t border-ink/10 px-5 py-4">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink/50">Total</span>
          <span className="font-display text-lg font-semibold text-ink">₱{total.toLocaleString()}</span>
        </div>
        <Button
          variant="primary"
          className="w-full"
          onClick={onProceed}
          disabled={selections.length === 0}
        >
          Book {totalHours > 0 ? `${totalHours} hr` : ''} →
        </Button>
      </div>
    </aside>
  )
}
