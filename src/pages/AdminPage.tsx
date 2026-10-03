import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import Container from '../components/ui/Container'
import Button from '../components/ui/Button'
import ReclubLogo from '../components/ui/ReclubLogo'
import { bookingCourts, loadBookingCourts, saveBookingCourts, hourSlots, getDayOptions, formatFullDate, isSlotPast, type BookingCourt, type DayOption } from '../data/booking'
import {
  addBooking,
  updateBooking,
  updateCustomerBookingsByReference,
  removeBooking,
  addBlockedSlot,
  removeBlockedSlot,
  getBookingAt,
  getBlockAt,
  getBookings,
  loadAdminStore,
  findOverlappingBooking,
  findOverlappingBlock,
  genReference,
  useBookingStoreVersion,
  type StoredBooking,
} from '../data/store'
import { sports } from '../data/sports'
import { isAdminUnlocked, signInAdmin } from '../data/adminAuth'
import PasswordInput from '../components/ui/PasswordInput'
import GalleryAdmin from '../components/admin/GalleryAdmin'
import PaymentHistory from '../components/admin/PaymentHistory'
import { downloadScheduleImage } from '../components/admin/scheduleImage'
import { loadGalleryImages } from '../data/galleryImages'
import { getPaymentQrCode, loadPaymentQrCode, savePaymentQrCode } from '../data/paymentQr'
import { isSupabaseConfigured, requireSupabase } from '../data/supabase'

interface Range {
  courtId: string
  startHour: number
  endHour: number // exclusive
}

function resizePaymentQr(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(image.naturalWidth * scale)
      canvas.height = Math.round(image.naturalHeight * scale)
      const context = canvas.getContext('2d')
      if (!context) {
        URL.revokeObjectURL(objectUrl)
        reject(new Error('Could not process this image.'))
        return
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(objectUrl)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Could not read this image.'))
    }
    image.src = objectUrl
  })
}

type AdminSectionId = 'bookings' | 'payments' | 'payment-history' | 'courts' | 'payment-qr' | 'gallery'

const adminSections: { id: AdminSectionId; label: string }[] = [
  { id: 'bookings', label: 'Bookings calendar' },
  { id: 'payments', label: 'Payment review' },
  { id: 'payment-history', label: 'Payment history' },
  { id: 'courts', label: 'Courts & pricing' },
  { id: 'payment-qr', label: 'Payment QR setup' },
  { id: 'gallery', label: 'Gallery photos' },
]

export default function AdminPage() {
  const [access, setAccess] = useState<'checking' | 'locked' | 'unlocked'>('checking')

  useEffect(() => {
    let active = true
    isAdminUnlocked()
      .then((unlocked) => {
        if (active) setAccess(unlocked ? 'unlocked' : 'locked')
      })
      .catch(() => {
        if (active) setAccess('locked')
      })
    return () => {
      active = false
    }
  }, [])

  if (access === 'checking') {
    return <Container className="flex min-h-[68vh] items-center justify-center py-16 text-sm text-ink/60">Checking staff access…</Container>
  }
  if (access === 'locked') return <AdminLogin onUnlock={() => setAccess('unlocked')} />

  return <AdminDashboard />
}

function AdminLogin({ onUnlock }: { onUnlock: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      await signInAdmin(email, password)
      onUnlock()
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Unable to sign in. Try again.')
    }
  }

  return (
    <Container className="flex min-h-[68vh] items-center justify-center py-16">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-card border border-ink/10 bg-sand p-7 shadow-xl shadow-ink/10 sm:p-9"
      >
        <h1 className="font-display text-lg font-semibold text-ink">Staff access</h1>
        <p className="mt-1 text-sm text-ink/60">Sign in with your authorized staff account.</p>
        <input
          type="email"
          required
          autoFocus
          autoComplete="username"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setError('')
          }}
          placeholder="Email address"
          className="mt-5 w-full rounded-xl border border-ink/15 bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15"
        />
        <PasswordInput
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
            setError('')
          }}
          placeholder="Password"
          wrapperClassName="mt-5"
        />
        {error && <p role="alert" className="mt-2 text-xs font-medium text-tide">{error}</p>}
        <Button type="submit" variant="primary" className="mt-5 w-full">
          Login
        </Button>
      </form>
    </Container>
  )
}

function AdminDashboard() {
  const storeVersion = useBookingStoreVersion() // re-render on any booking/block change
  const [adminStoreError, setAdminStoreError] = useState('')
  const [adminStoreLoading, setAdminStoreLoading] = useState(isSupabaseConfigured)
  const [activeSection, setActiveSection] = useState<AdminSectionId>('bookings')
  const reservedGroups = useMemo(() => {
    const groups = new Map<string, StoredBooking[]>()
    getBookings()
      .filter(
        (booking) =>
          booking.source === 'customer' &&
          (booking.status === 'reserved' || booking.status === 'pending'),
      )
      .forEach((booking) => {
        const group = groups.get(booking.reference) ?? []
        group.push(booking)
        groups.set(booking.reference, group)
      })
    return [...groups.entries()].map(([reference, bookings]) => ({ reference, bookings }))
  }, [storeVersion])
  const [weekOffset, setWeekOffset] = useState(0)
  const days = useMemo(() => getDayOptions(7, weekOffset * 7), [weekOffset])
  const [activeDay, setActiveDay] = useState<DayOption>(days[0])
  const activeDayData = days.find((d) => d.iso === activeDay.iso) ?? days[0]

  // One range per court, so staff can pick several courts for the same booking.
  const [selections, setSelections] = useState<Range[]>([])
  const [assignFormOpen, setAssignFormOpen] = useState(false)
  const [editingBooking, setEditingBooking] = useState<StoredBooking | null>(null)
  const [viewingBlockId, setViewingBlockId] = useState<string | null>(null)
  const [courtDraft, setCourtDraft] = useState<BookingCourt[]>(() => bookingCourts.map((court) => ({ ...court })))
  const [courtSettingsError, setCourtSettingsError] = useState('')
  const [courtSettingsSaved, setCourtSettingsSaved] = useState(false)
  const [selectionError, setSelectionError] = useState('')
  const [savedPaymentQr, setSavedPaymentQr] = useState<string | null>(() => getPaymentQrCode())
  const [paymentQrDraft, setPaymentQrDraft] = useState<string | null>(null)
  const [paymentQrFileName, setPaymentQrFileName] = useState('')
  const [paymentQrError, setPaymentQrError] = useState('')
  const [paymentQrStatus, setPaymentQrStatus] = useState('')
  const [isPreparingPaymentQr, setIsPreparingPaymentQr] = useState(false)
  const [paymentActionError, setPaymentActionError] = useState('')
  const [paymentProofUrls, setPaymentProofUrls] = useState<Record<string, string>>({})
  const [paymentProofErrors, setPaymentProofErrors] = useState<Record<string, string>>({})
  const [downloadingSchedule, setDownloadingSchedule] = useState(false)
  const [scheduleDownloadError, setScheduleDownloadError] = useState('')

  useEffect(() => {
    let active = true
    const loadPaymentProofs = async () => {
      const results: { reference: string; url?: string; error?: string }[] = await Promise.all(reservedGroups.map(async ({ reference, bookings }) => {
        const proof = bookings.find((booking) => booking.paymentScreenshotPath || booking.paymentScreenshotData)
        if (!proof) return { reference }
        if (proof.paymentScreenshotData) return { reference, url: proof.paymentScreenshotData }
        if (!proof.paymentScreenshotPath || !isSupabaseConfigured) return { reference }

        try {
          const { data, error } = await requireSupabase()
            .storage.from('payment-proofs')
            .createSignedUrl(proof.paymentScreenshotPath, 60 * 60)
          if (error) throw error
          return { reference, url: data.signedUrl }
        } catch (error) {
          return {
            reference,
            error: error instanceof Error ? error.message : 'Could not load the payment screenshot.',
          }
        }
      }))
      if (!active) return
      setPaymentProofUrls(Object.fromEntries(results.flatMap((result) => result.url ? [[result.reference, result.url]] : [])))
      setPaymentProofErrors(Object.fromEntries(results.flatMap((result) => result.error ? [[result.reference, result.error]] : [])))
    }
    void loadPaymentProofs()
    return () => {
      active = false
    }
  }, [reservedGroups])

  useEffect(() => {
    if (!isSupabaseConfigured) return
    let active = true
    const refreshBookings = () => {
      void loadAdminStore()
        .then(() => {
          if (active) setAdminStoreError('')
        })
        .catch((error) => {
          if (active) setAdminStoreError(error instanceof Error ? error.message : 'Could not refresh booking data.')
        })
    }
    Promise.all([loadAdminStore(), loadBookingCourts(), loadPaymentQrCode(), loadGalleryImages()])
      .then(() => {
        if (!active) return
        setCourtDraft(bookingCourts.map((court) => ({ ...court })))
        setSavedPaymentQr(getPaymentQrCode())
      })
      .catch((error) => {
        if (active) setAdminStoreError(error instanceof Error ? error.message : 'Could not load shared admin data.')
      })
      .finally(() => {
        if (active) setAdminStoreLoading(false)
      })
    const interval = window.setInterval(refreshBookings, 20_000)
    window.addEventListener('focus', refreshBookings)
    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshBookings)
    }
  }, [])

  async function saveCourtSettings(e: FormEvent) {
    e.preventDefault()
    if (courtDraft.some((court) => !court.name.trim() || !Number.isFinite(court.rate) || court.rate < 0)) {
      setCourtSettingsError('Enter a name and a valid hourly rate for every court.')
      setCourtSettingsSaved(false)
      return
    }
    try {
      await saveBookingCourts(courtDraft)
      setCourtSettingsError('')
      setCourtSettingsSaved(true)
    } catch (error) {
      setCourtSettingsError(error instanceof Error ? error.message : 'Could not save court settings.')
      setCourtSettingsSaved(false)
    }
  }

  async function preparePaymentQr(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    const input = event.currentTarget
    if (!file) return
    setPaymentQrError('')
    setPaymentQrStatus('')
    setPaymentQrDraft(null)
    setPaymentQrFileName('')
    if (!file.type.startsWith('image/')) {
      setPaymentQrError('Choose a PNG, JPG, or WEBP image.')
      input.value = ''
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      setPaymentQrError('The image is too large. Choose a file under 8 MB.')
      input.value = ''
      return
    }

    setIsPreparingPaymentQr(true)
    try {
      setPaymentQrDraft(await resizePaymentQr(file))
      setPaymentQrFileName(file.name)
    } catch (error) {
      setPaymentQrError(error instanceof Error ? error.message : 'Could not process this image.')
      setPaymentQrDraft(null)
      setPaymentQrFileName('')
    } finally {
      setIsPreparingPaymentQr(false)
      input.value = ''
    }
  }

  async function commitPaymentQr() {
    if (!paymentQrDraft) return
    try {
      await savePaymentQrCode(paymentQrDraft)
      setSavedPaymentQr(getPaymentQrCode())
      setPaymentQrDraft(null)
      setPaymentQrStatus('Payment QR code saved.')
      setPaymentQrError('')
    } catch (error) {
      setPaymentQrError(error instanceof Error ? error.message : 'Could not save the QR code.')
      setPaymentQrStatus('')
    }
  }

  async function removePaymentQr() {
    try {
      await savePaymentQrCode(null)
      setSavedPaymentQr(null)
      setPaymentQrDraft(null)
      setPaymentQrFileName('')
      setPaymentQrStatus('Payment QR code removed.')
      setPaymentQrError('')
    } catch (error) {
      setPaymentQrError(error instanceof Error ? error.message : 'Could not remove the QR code.')
      setPaymentQrStatus('')
    }
  }

  async function approvePayment(reference: string) {
    setPaymentActionError('')
    try {
      await updateCustomerBookingsByReference(reference, 'confirmed')
    } catch (error) {
      setPaymentActionError(error instanceof Error ? error.message : 'Could not approve this payment.')
    }
  }

  async function rejectPayment(reference: string) {
    setPaymentActionError('')
    try {
      await updateCustomerBookingsByReference(reference, 'rejected')
    } catch (error) {
      setPaymentActionError(error instanceof Error ? error.message : 'Could not reject this payment.')
    }
  }

  async function downloadSchedule() {
    setScheduleDownloadError('')
    setDownloadingSchedule(true)
    try {
      await downloadScheduleImage(activeDayData.iso)
    } catch (error) {
      setScheduleDownloadError(error instanceof Error ? error.message : 'Could not download the schedule image.')
    } finally {
      setDownloadingSchedule(false)
    }
  }

  function switchDay(d: DayOption) {
    setActiveDay(d)
    setSelections([])
    setAssignFormOpen(false)
  }

  function navigateTo(section: AdminSectionId) {
    setActiveSection(section)
    setSelections([])
    setAssignFormOpen(false)
  }

  function clickCell(courtId: string, hour: number) {
    if (adminStoreLoading) return
    const dayIso = activeDayData.iso
    if (isSlotPast(dayIso, hour)) return

    const booking = getBookingAt(dayIso, courtId, hour)
    if (booking) {
      setEditingBooking(booking)
      setSelections([])
      return
    }

    const block = getBlockAt(dayIso, courtId, hour)
    if (block) {
      setViewingBlockId(block.id)
      setSelections([])
      return
    }

    // Free slot: build/extend a selection range the same way the public
    // calendar does, so staff can drag out a multi-hour block or booking.
    setAssignFormOpen(false)
    setSelections((prev) => {
      const existing = prev.find((item) => item.courtId === courtId)
      if (!existing) return [...prev, { courtId, startHour: hour, endHour: hour + 1 }]
      const replaceWith = (next: Range | null) =>
        next ? prev.map((item) => (item === existing ? next : item)) : prev.filter((item) => item !== existing)

      if (hour >= existing.startHour && hour < existing.endHour) {
        if (hour === existing.startHour && hour === existing.endHour - 1) return replaceWith(null)
        if (hour === existing.startHour) return replaceWith({ ...existing, startHour: hour + 1 })
        if (hour === existing.endHour - 1) return replaceWith({ ...existing, endHour: hour })
        return replaceWith({ ...existing, startHour: hour, endHour: hour + 1 })
      }
      if (hour === existing.endHour) return replaceWith({ ...existing, endHour: hour + 1 })
      if (hour === existing.startHour - 1) return replaceWith({ ...existing, startHour: hour })
      return replaceWith({ ...existing, startHour: hour, endHour: hour + 1 })
    })
  }

  async function blockSelection(reason: string) {
    if (selections.length === 0) return
    setSelectionError('')
    const remaining = [...selections]
    try {
      for (const item of selections) {
        await addBlockedSlot({
          courtId: item.courtId,
          dayIso: activeDayData.iso,
          startHour: item.startHour,
          endHour: item.endHour,
          reason: reason.trim() || undefined,
        })
        remaining.shift()
      }
      setSelections([])
    } catch (error) {
      setSelections(remaining)
      setSelectionError(error instanceof Error ? error.message : 'Could not block this time.')
    }
  }

  async function assignReclubSelection() {
    if (selections.length === 0) return
    const clash = selections.some((item) =>
      findOverlappingBooking(activeDayData.iso, item.courtId, item.startHour, item.endHour) ||
      findOverlappingBlock(activeDayData.iso, item.courtId, item.startHour, item.endHour),
    )
    if (clash) {
      setSelectionError('One of the selected times is no longer available. Refresh the schedule and try again.')
      return
    }

    setSelectionError('')
    const reference = selections.length > 1 ? genReference() : undefined
    const remaining = [...selections]
    try {
      for (const item of selections) {
        const court = bookingCourts.find((c) => c.id === item.courtId)
        await addBooking({
          courtId: item.courtId,
          courtName: court?.name ?? item.courtId,
          dayIso: activeDayData.iso,
          startHour: item.startHour,
          endHour: item.endHour,
          rate: court?.rate ?? 0,
          name: 'Reclub',
          mobile: '',
          notes: 'Assigned from Reclub',
          source: 'reclub',
          status: 'confirmed',
          reference,
        })
        remaining.shift()
      }
      setSelections([])
    } catch (error) {
      setSelections(remaining)
      setSelectionError(error instanceof Error ? error.message : 'Could not assign this Reclub booking.')
    }
  }

  const orderedSelections = [...selections].sort(
    (a, b) =>
      bookingCourts.findIndex((c) => c.id === a.courtId) - bookingCourts.findIndex((c) => c.id === b.courtId),
  )

  return (
    <Container className="py-8 sm:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-court">Staff workspace</p>
          <h1 className="mt-1 font-display text-2xl font-semibold text-ink sm:text-3xl">Admin dashboard</h1>
          <p className="mt-2 max-w-2xl text-sm text-ink/60">Manage bookings, payment reviews, and court settings.</p>
        </div>
      </div>

      {adminStoreLoading && <p role="status" className="mt-4 text-sm text-ink/60">Loading shared booking data…</p>}
      {adminStoreError && <p role="alert" className="mt-4 rounded-xl bg-tide/10 px-4 py-3 text-sm text-tide">Could not load Supabase data: {adminStoreError}</p>}

      <div className="mt-7 grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="h-fit min-w-0 rounded-card border border-ink/10 bg-sand p-3 shadow-xl shadow-ink/5 sm:p-4 lg:sticky lg:top-24">
          <p className="px-3 py-2 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-ink/45">Navigation</p>
          <nav aria-label="Admin sections" className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
            {adminSections.map((section) => {
              const active = activeSection === section.id
              return (
                <button
                  key={section.id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => navigateTo(section.id)}
                  className={`flex min-h-11 min-w-max items-center justify-between gap-3 rounded-xl px-4 py-2.5 text-left text-sm font-semibold transition-colors lg:w-full ${
                    active
                      ? 'bg-court text-white'
                      : 'text-ink/65 hover:bg-sand-dim hover:text-ink'
                  }`}
                >
                  {section.label}
                  {section.id === 'payments' && reservedGroups.length > 0 && (
                    <span className={`rounded-full px-2 py-0.5 text-xs ${active ? 'bg-white/20 text-white' : 'bg-citrus text-ink'}`}>
                      {reservedGroups.length}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>
        </aside>

        <main className="min-w-0">
      {activeSection === 'courts' && (
      <>
      <form onSubmit={saveCourtSettings} className="rounded-card border border-ink/10 bg-sand p-5 shadow-xl shadow-ink/5 sm:p-6">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="font-display text-base font-semibold text-ink">Court names & rates</h2>
            <p className="mt-1 text-sm text-ink/60">Saved to the shared schedule and used across all devices.</p>
          </div>
          <Button type="submit" variant="primary" className="mt-3 self-start sm:mt-0">Save changes</Button>
        </div>
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {courtDraft.map((court) => (
            <div key={court.id} className="grid grid-cols-[minmax(0,1fr)_120px] items-end gap-3 rounded-xl border border-ink/10 bg-white p-3">
              <Field label={`Court ${court.id} name`}>
                <input
                  required
                  value={court.name}
                  onChange={(e) => {
                    setCourtSettingsSaved(false)
                    setCourtDraft((current) => current.map((item) => item.id === court.id ? { ...item, name: e.target.value } : item))
                  }}
                  className="w-full rounded-xl border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15"
                />
              </Field>
              <Field label="Rate / hour (₱)">
                <input
                  required
                  type="number"
                  min="0"
                  step="1"
                  value={Number.isFinite(court.rate) ? court.rate : ''}
                  onChange={(e) => {
                    setCourtSettingsSaved(false)
                    setCourtDraft((current) => current.map((item) => item.id === court.id ? { ...item, rate: e.target.value === '' ? Number.NaN : Number(e.target.value) } : item))
                  }}
                  className="w-full rounded-xl border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15"
                />
              </Field>
            </div>
          ))}
        </div>
        {courtSettingsError && <p role="alert" className="mt-3 text-sm font-medium text-tide">{courtSettingsError}</p>}
        {courtSettingsSaved && <p role="status" className="mt-3 text-sm font-medium text-court">Court settings saved.</p>}
      </form>
      </>
      )}

      {activeSection === 'payment-qr' && (
      <section className="rounded-card border border-ink/10 bg-sand p-5 shadow-xl shadow-ink/5 sm:p-6">
        <div>
          <h2 className="font-display text-base font-semibold text-ink">Payment QR code</h2>
          <p className="mt-1 text-sm text-ink/60">Upload the GCash or Maya QR shown to customers in the payment step.</p>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_220px]">
          <div>
            <Field label="Upload QR image">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={isPreparingPaymentQr}
                onChange={(event) => void preparePaymentQr(event)}
                className="w-full rounded-xl border border-ink/15 bg-white px-3 py-2 text-sm text-ink transition-colors file:mr-3 file:rounded-full file:border-0 file:bg-citrus file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-ink"
              />
            </Field>
            {paymentQrFileName && <p className="mt-2 text-xs text-ink/50">Selected: {paymentQrFileName}</p>}
            <p className="mt-2 text-xs text-ink/50">PNG, JPG, or WEBP · maximum 8 MB. Saved in this browser.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="button" variant="primary" onClick={commitPaymentQr} disabled={!paymentQrDraft || isPreparingPaymentQr}>
                {isPreparingPaymentQr ? 'Preparing image…' : 'Save QR code'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="!border-ink/15 !bg-white !text-ink hover:!bg-sand-dim"
                onClick={removePaymentQr}
                disabled={!savedPaymentQr && !paymentQrDraft}
              >
                Remove QR code
              </Button>
            </div>
            {paymentQrError && <p role="alert" className="mt-3 text-sm font-medium text-tide">{paymentQrError}</p>}
            {paymentQrStatus && <p role="status" className="mt-3 text-sm font-medium text-court">{paymentQrStatus}</p>}
          </div>

          <div className="flex min-h-48 items-center justify-center rounded-2xl border border-ink/10 bg-white p-3">
            {paymentQrDraft || savedPaymentQr ? (
              <div className="text-center">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/45">
                  {paymentQrDraft ? 'New image preview' : 'Current QR code'}
                </p>
                <img
                  src={paymentQrDraft ?? savedPaymentQr ?? undefined}
                  alt="Payment QR code preview"
                  className="mx-auto max-h-52 max-w-full rounded-xl object-contain"
                />
              </div>
            ) : (
              <p className="text-center text-sm text-ink/45">No payment QR uploaded yet.</p>
            )}
          </div>
        </div>
      </section>
      )}

      {activeSection === 'gallery' && <GalleryAdmin />}

      {activeSection === 'payment-history' && <PaymentHistory />}

      {activeSection === 'payments' && (
      <section className="rounded-card border border-ink/10 bg-sand p-5 shadow-xl shadow-ink/5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold text-ink">Payment verification</h2>
            <p className="mt-1 text-sm text-ink/60">Review the uploaded GCash or Maya payment screenshot before confirming each reservation.</p>
          </div>
          <span className="rounded-full bg-citrus/20 px-3 py-1 text-xs font-semibold text-ink">
            {reservedGroups.length} awaiting review
          </span>
        </div>
        {paymentActionError && <p role="alert" className="mt-4 rounded-xl bg-tide/10 px-4 py-3 text-sm text-tide">{paymentActionError}</p>}

        {reservedGroups.length === 0 ? (
          <p className="mt-5 rounded-xl bg-white px-4 py-5 text-center text-sm text-ink/55">
            No reservations are waiting for payment verification.
          </p>
        ) : (
          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {reservedGroups.map(({ reference, bookings }) => {
              const customer = bookings[0]
              const paymentReference = bookings.find((booking) => booking.paymentReference)?.paymentReference
              const paymentProof = bookings.find((booking) => booking.paymentScreenshotPath || booking.paymentScreenshotData)
              const total = bookings.reduce(
                (sum, booking) => sum + (booking.endHour - booking.startHour) * booking.rate,
                0,
              )
              return (
                <article key={reference} className="rounded-2xl border border-ink/10 bg-white p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-ink">{customer.name}</h3>
                      <p className="mt-1 text-xs text-ink/55">{reference} · {customer.mobile}</p>
                      <p className="mt-1 text-xs font-semibold text-court">
                        {customer.sport ?? 'Sport not specified'} · Reserved
                      </p>
                    </div>
                    <span className="font-display text-base font-semibold text-ink">₱{total.toLocaleString()}</span>
                  </div>
                  <div className="mt-3 space-y-1 text-sm text-ink/65">
                    {bookings.map((booking) => (
                      <p key={booking.id}>
                        {booking.courtName} · {formatFullDate(new Date(`${booking.dayIso}T00:00:00`))} ·{' '}
                        {rangeLabel(booking.startHour, booking.endHour)}
                      </p>
                    ))}
                  </div>
                  <div className="mt-4 rounded-xl border border-ink/10 bg-sand-dim p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/55">Payment screenshot</p>
                    {paymentProofUrls[reference] ? (
                      <a href={paymentProofUrls[reference]} target="_blank" rel="noreferrer" aria-label={`Open payment screenshot for ${reference}`}>
                        <img
                          src={paymentProofUrls[reference]}
                          alt={`Payment screenshot for booking ${reference}`}
                          className="max-h-64 w-full rounded-lg bg-white object-contain"
                        />
                        <span className="mt-2 block text-center text-xs font-semibold text-court">Open full size</span>
                      </a>
                    ) : paymentProofErrors[reference] ? (
                      <p role="alert" className="text-sm text-tide">Could not load screenshot: {paymentProofErrors[reference]}</p>
                    ) : paymentProof ? (
                      <p className="text-sm text-ink/55">Loading screenshot…</p>
                    ) : paymentReference ? (
                      <p className="break-all text-sm text-ink/65">Legacy payment reference: {paymentReference}</p>
                    ) : (
                      <p className="text-sm text-ink/55">No payment screenshot is attached to this older booking.</p>
                    )}
                  </div>
                  <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="primary"
                      className="w-full sm:flex-1"
                      onClick={() => approvePayment(reference)}
                    >
                      Approve and confirm
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="w-full !border-tide/30 !bg-white !text-tide hover:!bg-tide/5 sm:w-auto"
                      onClick={() => rejectPayment(reference)}
                    >
                      Reject
                    </Button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
      )}

      {activeSection === 'bookings' && (
      <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink">Bookings calendar</h2>
          <p className="mt-1 text-sm text-ink/60">Select a slot to create a booking or block time; select an existing entry to manage it.</p>
        </div>
        <Button
          type="button"
          variant="primary"
          className="!min-h-10 !px-5 !py-2"
          onClick={() => void downloadSchedule()}
          disabled={adminStoreLoading || downloadingSchedule}
        >
          {downloadingSchedule ? 'Preparing image…' : 'Download schedule (PNG)'}
        </Button>
      </div>
      {scheduleDownloadError && (
        <p role="alert" className="mb-4 rounded-xl bg-tide/10 px-4 py-3 text-sm text-tide">{scheduleDownloadError}</p>
      )}
      <div className="overflow-hidden rounded-card border border-ink/10 bg-sand shadow-xl shadow-ink/5">
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
                  <span className="font-display text-sm font-semibold sm:text-base">{d.dayNum}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-ink/10 px-4 py-3 text-xs text-ink/70 sm:px-6">
          <span className="text-[0.7rem] font-semibold uppercase tracking-wide text-ink/50">Legend</span>
          <LegendSwatch className="border border-ink/20 bg-sand" label="Available" />
          <LegendSwatch className="bg-citrus" label="Reserved" />
          <LegendSwatch className="bg-tide" label="Booked" />
          <LegendSwatch className="bg-ink/50" label="Blocked" />
          <LegendSwatch className="bg-citrus" label="Selecting" />
          <LegendSwatch className="border border-ink/10 bg-sand-dim" label="Past" />
        </div>

        <p className="px-4 pt-3 text-xs text-ink/50 sm:px-6">Scroll horizontally to see all time slots →</p>
        <div className="overflow-x-auto overscroll-x-contain">
          <div className="min-w-[720px] px-4 py-4 sm:px-6">
            <div
              className="grid gap-1.5"
              style={{ gridTemplateColumns: `120px repeat(${hourSlots.length}, 64px)` }}
            >
              <div />
              {hourSlots.map((h) => (
                <div key={h.hour} className="pb-2 text-center text-[0.7rem] font-medium text-ink/60">
                  {h.label}
                </div>
              ))}

              {bookingCourts.map((court) => (
                <div key={court.id} className="contents">
                  <div className="flex flex-col justify-center py-2 pr-3">
                    <p className="text-sm font-semibold text-ink">{court.name}</p>
                    <p className="text-xs text-ink/55">₱{court.rate}/hr</p>
                  </div>
                  {hourSlots.map((h) => {
                    const dayIso = activeDayData.iso
                    const past = isSlotPast(dayIso, h.hour)
                    const booking = getBookingAt(dayIso, court.id, h.hour)
                    const block = getBlockAt(dayIso, court.id, h.hour)
                    const isSelecting = selections.some(
                      (item) =>
                        item.courtId === court.id &&
                        h.hour >= item.startHour &&
                        h.hour < item.endHour,
                    )

                    let cls =
                      'flex h-11 items-center justify-center rounded-lg border text-[0.65rem] font-semibold transition-all sm:h-12 '
                    let label = ''
                    if (past) {
                      cls += 'cursor-not-allowed border-ink/5 bg-sand-dim text-ink/25'
                    } else if (booking?.status !== 'confirmed' && booking) {
                      cls += 'cursor-pointer border-citrus bg-citrus text-ink'
                      label = 'R'
                    } else if (booking) {
                      cls += 'cursor-pointer border-tide bg-tide text-sand'
                      label = booking.source === 'reclub' ? '' : booking.name.split(' ')[0]
                    } else if (block) {
                      cls += 'cursor-pointer border-ink/50 bg-ink/50 text-sand'
                      label = '⛔'
                    } else if (isSelecting) {
                      cls += 'cursor-pointer border-citrus bg-citrus text-ink'
                      label = '✓'
                    } else {
                      cls += 'cursor-pointer border-ink/10 bg-white text-ink/40 hover:border-court/45 hover:bg-court/5 hover:text-ink'
                    }

                    return (
                      <button
                        key={h.hour}
                        type="button"
                        disabled={past || adminStoreLoading}
                        onClick={() => clickCell(court.id, h.hour)}
                        className={cls}
                        title={
                          booking
                            ? booking.source === 'reclub'
                              ? `Reclub booking · ${rangeLabel(booking.startHour, booking.endHour)}`
                              : `${booking.sport ? `${booking.sport} · ` : ''}${booking.name} · ${booking.mobile} · ${booking.status === 'confirmed' ? 'Confirmed' : 'Reserved'}`
                            : block?.reason || (block ? 'Blocked' : undefined)
                        }
                      >
                        {booking?.source === 'reclub' ? <ReclubLogo className="h-7 w-7" /> : label}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>

        <p className="border-t border-ink/10 px-4 py-3 text-xs text-ink/55 sm:px-6">
          Tap an open slot to select a time range, tap a booked slot (orange) to reschedule or cancel
          it, or tap a blocked slot (dark) to unblock it.
        </p>
      </div>
      </>
      )}

      {activeSection === 'bookings' && selections.length > 0 && !assignFormOpen && (
        <>
        {selectionError && <p role="alert" className="rounded-xl bg-tide/10 px-4 py-3 text-sm text-tide">{selectionError}</p>}
        <SelectionActionBar
          items={orderedSelections.map((item) => ({
            courtName: bookingCourts.find((c) => c.id === item.courtId)?.name ?? item.courtId,
            startHour: item.startHour,
            endHour: item.endHour,
          }))}
          onBlock={blockSelection}
          onAssign={() => setAssignFormOpen(true)}
          onAssignReclub={assignReclubSelection}
          onClear={() => setSelections([])}
        />
        </>
      )}

      {activeSection === 'bookings' && selections.length > 0 && assignFormOpen && (
        <AssignForm
          dayIso={activeDayData.iso}
          dayLabel={formatFullDate(activeDayData.date)}
          selections={orderedSelections}
          onCancel={() => setAssignFormOpen(false)}
          onSaved={() => {
            setAssignFormOpen(false)
            setSelections([])
          }}
        />
      )}

      {editingBooking && (
        <BookingEditModal booking={editingBooking} onClose={() => setEditingBooking(null)} />
      )}

      {viewingBlockId && (
        <BlockModal blockId={viewingBlockId} onClose={() => setViewingBlockId(null)} />
      )}
        </main>
      </div>
    </Container>
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

function rangeLabel(startHour: number, endHour: number) {
  const fmt = (h: number) => `${h % 12 || 12}${h < 12 || h === 24 ? 'AM' : 'PM'}`
  return `${fmt(startHour)}–${fmt(endHour)}`
}

function SelectionActionBar({
  items,
  onBlock,
  onAssign,
  onAssignReclub,
  onClear,
}: {
  items: { courtName: string; startHour: number; endHour: number }[]
  onBlock: (reason: string) => void
  onAssign: () => void
  onAssignReclub: () => void
  onClear: () => void
}) {
  const [reason, setReason] = useState('')

  return (
    <div className="flex flex-col gap-3 rounded-card border border-ink/10 bg-sand-dim p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
      <div>
        {items.map((item) => (
          <p key={item.courtName} className="text-sm font-semibold text-ink">
            {item.courtName} · {rangeLabel(item.startHour, item.endHour)}
          </p>
        ))}
        <p className="text-xs text-ink/55">
          {items.length} {items.length === 1 ? 'court' : 'courts'} ·{' '}
          {items.reduce((sum, item) => sum + (item.endHour - item.startHour), 0)} hour(s) selected
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
          className="w-full rounded-xl border border-ink/15 bg-white px-3 py-2 text-xs text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15 sm:w-40"
        />
        <Button variant="secondary" className="!border-ink/20 !py-2 !text-xs !text-ink" onClick={() => onBlock(reason)}>
          Block this time
        </Button>
        <Button variant="primary" className="!py-2 !text-xs" onClick={onAssign}>
          Assign a booking
        </Button>
        <Button
          variant="secondary"
          className="!border-ink/20 !bg-white !py-2 !text-xs !text-ink hover:!bg-sand"
          onClick={onAssignReclub}
        >
          <ReclubLogo className="h-5 w-5" />
          Assign Reclub
        </Button>
        <button type="button" onClick={onClear} className="text-xs font-medium text-ink/50 hover:text-ink">
          Clear
        </button>
      </div>
    </div>
  )
}

type RepeatMode = 'none' | 'daily' | 'weekly'

interface SlotPair {
  date: string
  sel: Range
}

const MAX_REPEAT_COUNT = 12

function isoFromDate(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function buildOccurrenceDates(startIso: string, mode: RepeatMode, count: number) {
  if (mode === 'none') return [startIso]
  const stepDays = mode === 'weekly' ? 7 : 1
  const base = new Date(`${startIso}T00:00:00`)
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(base)
    d.setDate(d.getDate() + i * stepDays)
    return isoFromDate(d)
  })
}

function shortDateLabel(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function AssignForm({
  dayIso,
  dayLabel,
  selections,
  onCancel,
  onSaved,
}: {
  dayIso: string
  dayLabel: string
  selections: Range[]
  onCancel: () => void
  onSaved: () => void
}) {
  const [sport, setSport] = useState('')
  const [name, setName] = useState('')
  const [mobile, setMobile] = useState('')
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [repeat, setRepeat] = useState<RepeatMode>('none')
  const [repeatCount, setRepeatCount] = useState(4)
  const [conflicts, setConflicts] = useState<SlotPair[] | null>(null)
  const [partialFailure, setPartialFailure] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const weekdayName = new Date(`${dayIso}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long' })
  const occurrenceDates = buildOccurrenceDates(dayIso, repeat, repeatCount)
  const lastDate = occurrenceDates[occurrenceDates.length - 1]

  function resetConflictPrompt() {
    setConflicts(null)
    setError('')
  }

  function courtNameOf(courtId: string) {
    return bookingCourts.find((c) => c.id === courtId)?.name ?? courtId
  }

  function pairLabel(pair: SlotPair) {
    return repeat === 'none'
      ? courtNameOf(pair.sel.courtId)
      : `${courtNameOf(pair.sel.courtId)} ${shortDateLabel(pair.date)}`
  }

  function hasClash({ date, sel }: SlotPair) {
    return !!(
      findOverlappingBooking(date, sel.courtId, sel.startHour, sel.endHour) ||
      findOverlappingBlock(date, sel.courtId, sel.startHour, sel.endHour)
    )
  }

  // Every (date, court) combination in this booking.
  const allPairs: SlotPair[] = occurrenceDates.flatMap((date) => selections.map((sel) => ({ date, sel })))
  const candidatePairs = allPairs.filter((pair) => !isSlotPast(pair.date, pair.sel.startHour))

  async function save(skipConflicts = false) {
    if (!sport) {
      setError('Choose a sport for this booking.')
      return
    }
    if (!name.trim() || !mobile.trim()) {
      setError('Name and mobile number are required.')
      return
    }

    // Past slots can never be booked, so they are always left out of a series.
    if (candidatePairs.length === 0) {
      setError('All of these dates are already in the past.')
      return
    }

    const clashing = candidatePairs.filter(hasClash)
    if (clashing.length > 0 && !skipConflicts) {
      if (repeat === 'none') {
        setError('One of the selected courts was just taken — pick another slot.')
      } else {
        setError('')
        setConflicts(clashing)
      }
      return
    }

    const pairsToBook = candidatePairs.filter((pair) => !clashing.includes(pair))
    if (pairsToBook.length === 0) {
      setConflicts(null)
      setError('Every one of these slots is already taken — pick another slot.')
      return
    }

    setSaving(true)
    setError('')
    setConflicts(null)
    const reference = pairsToBook.length > 1 ? genReference() : undefined
    let savedCount = 0
    try {
      for (const { date, sel } of pairsToBook) {
        await addBooking({
          courtId: sel.courtId,
          courtName: courtNameOf(sel.courtId),
          dayIso: date,
          startHour: sel.startHour,
          endHour: sel.endHour,
          rate: bookingCourts.find((c) => c.id === sel.courtId)?.rate ?? 0,
          sport,
          name: name.trim(),
          mobile: mobile.trim(),
          email: email.trim() || undefined,
          notes: notes.trim() || undefined,
          source: 'admin',
          status: 'confirmed',
          reference,
        })
        savedCount += 1
      }
      onSaved()
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Could not save this booking.'
      if (savedCount > 0) {
        setPartialFailure(true)
        setError(
          `Saved ${savedCount} of ${pairsToBook.length} bookings, then stopped at ${pairLabel(pairsToBook[savedCount])}: ${message} Close this form and check the calendar before trying again.`,
        )
      } else {
        setError(message)
      }
    } finally {
      setSaving(false)
    }
  }

  const inputClass =
    'w-full rounded-xl border border-ink/15 bg-white px-3.5 py-2.5 text-base text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15 sm:text-sm'

  const bookableCount = conflicts ? candidatePairs.length - conflicts.length : 0

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-ink/50 p-4 sm:items-center">
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="assign-booking-title"
      className="my-auto max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-card border border-ink/10 bg-sand p-5 shadow-xl shadow-ink/10 sm:p-8"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_2rem] items-start gap-2">
        <h3 id="assign-booking-title" className="font-display text-lg font-semibold text-ink">Assign a booking</h3>
        <ModalCloseButton onClose={onCancel} />
      </div>
      <p className="mt-1 text-sm font-semibold text-ink/70">
        {dayLabel}
      </p>
      <div className="mt-1 text-sm text-ink/60">
        {selections.map((item) => (
          <p key={item.courtId}>
            {courtNameOf(item.courtId)} · {rangeLabel(item.startHour, item.endHour)}
          </p>
        ))}
      </div>

      <div className="mt-5 flex flex-col gap-4">
        <Field label="Sport">
          <select
            value={sport}
            onChange={(e) => {
              setSport(e.target.value)
              setError('')
            }}
            className={inputClass}
          >
            <option value="">Select a sport</option>
            {sports.map((item) => (
              <option key={item.id} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Full name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Juan Dela Cruz"
            className={inputClass}
          />
        </Field>
        <Field label="Mobile number">
          <input
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            placeholder="09XX XXX XXXX"
            className={inputClass}
          />
        </Field>
        <Field label="Email (optional)">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="juan@email.com"
            className={inputClass}
          />
        </Field>
        <Field label="Notes (optional)">
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Walk-in, paid cash, etc."
            className={inputClass}
          />
        </Field>

        <Field label="Repeat">
          <select
            value={repeat}
            onChange={(e) => {
              setRepeat(e.target.value as RepeatMode)
              resetConflictPrompt()
            }}
            className={inputClass}
          >
            <option value="none">Does not repeat</option>
            <option value="weekly">Weekly (every {weekdayName})</option>
            <option value="daily">Daily</option>
          </select>
        </Field>

        {repeat !== 'none' && (
          <Field label={`Number of ${repeat === 'weekly' ? 'weeks' : 'days'} (including this one)`}>
            <select
              value={repeatCount}
              onChange={(e) => {
                setRepeatCount(Number(e.target.value))
                resetConflictPrompt()
              }}
              className={inputClass}
            >
              {Array.from({ length: MAX_REPEAT_COUNT - 1 }, (_, i) => i + 2).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-ink/55">
              {occurrenceDates.length} bookings · {shortDateLabel(dayIso)} to {shortDateLabel(lastDate)}
            </p>
          </Field>
        )}
      </div>

      {conflicts && (
        <div role="alert" className="mt-4 rounded-xl bg-tide/10 px-4 py-3 text-sm text-tide">
          <p className="font-semibold">
            {conflicts.length} {conflicts.length === 1 ? 'slot is' : 'slots are'} already taken:
          </p>
          <p className="mt-1 text-xs">{conflicts.map(pairLabel).join(' · ')}</p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="primary"
              className="!flex-1 !px-3 !text-xs"
              onClick={() => save(true)}
              disabled={saving || bookableCount <= 0}
            >
              {bookableCount > 0 ? `Skip them, book ${bookableCount}` : 'Nothing left to book'}
            </Button>
            <Button
              variant="secondary"
              className="!flex-1 !px-3 !text-xs !text-ink !border-ink/20"
              onClick={resetConflictPrompt}
              disabled={saving}
            >
              Go back
            </Button>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-xs font-medium text-tide">{error}</p>}

      <div className="mt-6 flex gap-3">
        <Button variant="secondary" className="!flex-1 !text-ink !border-ink/20" onClick={onCancel}>
          {partialFailure ? 'Close' : 'Cancel'}
        </Button>
        <Button
          variant="primary"
          className="!flex-1"
          onClick={() => save()}
          disabled={saving || partialFailure || !!conflicts}
        >
          {saving ? 'Saving…' : allPairs.length === 1 ? 'Save booking' : `Save ${allPairs.length} bookings`}
        </Button>
      </div>
    </div>
    </div>
  )
}

function BookingEditModal({ booking, onClose }: { booking: StoredBooking; onClose: () => void }) {
  const days = useMemo(() => getDayOptions(30, 0), [])
  const [dayIso, setDayIso] = useState(booking.dayIso)
  const [courtId, setCourtId] = useState(booking.courtId)
  const [sport, setSport] = useState(booking.sport ?? '')
  const [startHour, setStartHour] = useState(booking.startHour)
  const [endHour, setEndHour] = useState(booking.endHour)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function saveReschedule() {
    if (endHour <= startHour) {
      setError('End time must be after start time.')
      return
    }
    const clash =
      findOverlappingBooking(dayIso, courtId, startHour, endHour, booking.id) ||
      findOverlappingBlock(dayIso, courtId, startHour, endHour)
    if (clash) {
      setError('That time is already taken — pick another slot.')
      return
    }
    const court = bookingCourts.find((c) => c.id === courtId)
    setSaving(true)
    setError('')
    try {
      await updateBooking(booking.id, {
        dayIso,
        courtId,
        courtName: court?.name ?? courtId,
        startHour,
        endHour,
        rate: court?.rate ?? booking.rate,
        sport: sport || undefined,
      })
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not update this booking.')
    } finally {
      setSaving(false)
    }
  }

  async function cancelBooking() {
    setSaving(true)
    setError('')
    try {
      await removeBooking(booking.id)
      onClose()
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Could not cancel this booking.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-ink/50 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="my-auto max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-card border border-ink/10 bg-sand p-5 shadow-xl shadow-ink/10 sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-semibold text-ink">
            {booking.name} <span className="text-sm font-normal text-ink/50">· {booking.reference}</span>
          </h3>
          <ModalCloseButton onClose={onClose} />
        </div>
        <p className="mt-1 text-sm text-ink/60">
          {booking.mobile}
          {booking.email ? ` · ${booking.email}` : ''}
          {booking.notes ? ` · ${booking.notes}` : ''}
        </p>
        <p className="mt-1 text-xs uppercase tracking-wide text-ink/40">
          {booking.source === 'admin'
            ? 'Added by staff'
            : booking.source === 'reclub'
              ? 'Assigned from Reclub'
              : 'Booked by customer'}
          {booking.sport ? ` · ${booking.sport}` : ''}
        </p>

        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Court">
            <select
              value={courtId}
              onChange={(e) => setCourtId(e.target.value)}
              className="w-full rounded-xl border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15"
            >
              {bookingCourts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          {booking.source !== 'reclub' && (
            <Field label="Sport">
              <select
                value={sport}
                onChange={(e) => setSport(e.target.value)}
                className="w-full rounded-xl border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15"
              >
                <option value="">Not specified</option>
                {sports.map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Status">
            <p className="rounded-xl border border-ink/10 bg-sand-dim px-3 py-2.5 text-sm font-semibold text-ink">
              {booking.status === 'confirmed' ? 'Confirmed' : 'Reserved'}
            </p>
          </Field>
          <Field label="Date">
            <select
              value={dayIso}
              onChange={(e) => setDayIso(e.target.value)}
              className="w-full rounded-xl border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15"
            >
              {days.map((d) => (
                <option key={d.iso} value={d.iso}>
                  {formatFullDate(d.date)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Time">
            <div className="flex items-center gap-1.5">
              <select
                value={startHour}
                onChange={(e) => setStartHour(Number(e.target.value))}
                className="w-full rounded-xl border border-ink/15 bg-white px-2 py-2.5 text-sm text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15"
              >
                {hourSlots.map((h) => (
                  <option key={h.hour} value={h.hour}>
                    {h.label.split('–')[0]}
                  </option>
                ))}
              </select>
              <span className="text-ink/40">–</span>
              <select
                value={endHour}
                onChange={(e) => setEndHour(Number(e.target.value))}
                className="w-full rounded-xl border border-ink/15 bg-white px-2 py-2.5 text-sm text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15"
              >
                {hourSlots.map((h) => (
                  <option key={h.hour + 1} value={h.hour + 1}>
                    {h.label.split('–')[1]}
                  </option>
                ))}
              </select>
            </div>
          </Field>
        </div>

        {error && <p className="mt-3 text-xs font-medium text-tide">{error}</p>}

        <div className="mt-6 flex gap-3">
          <Button variant="secondary" className="!flex-1 !text-tide !border-tide/40" onClick={cancelBooking} disabled={saving}>
            Cancel booking
          </Button>
          <Button variant="primary" className="!flex-1" onClick={saveReschedule} disabled={saving}>
            Save changes
          </Button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 w-full text-center text-xs font-medium text-ink/50 hover:text-ink"
        >
          Close without saving
        </button>
      </div>
    </div>
  )
}

function BlockModal({ blockId, onClose }: { blockId: string; onClose: () => void }) {
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function unblock() {
    setSaving(true)
    setError('')
    try {
      await removeBlockedSlot(blockId)
      onClose()
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Could not unblock this time.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-ink/50 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="my-auto max-h-[calc(100dvh-2rem)] w-full max-w-sm overflow-y-auto rounded-card border border-ink/10 bg-sand p-5 text-center shadow-xl shadow-ink/10 sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-2">
          <span aria-hidden="true" />
          <h3 className="font-display text-lg font-semibold text-ink">Blocked time</h3>
          <ModalCloseButton onClose={onClose} />
        </div>
        <p className="mt-1 text-sm text-ink/60">This slot is closed off from customer bookings.</p>
        {error && <p role="alert" className="mt-3 text-xs font-medium text-tide">{error}</p>}
        <div className="mt-6 flex gap-3">
          <Button variant="secondary" className="!flex-1 !text-ink !border-ink/20" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" className="!flex-1" onClick={unblock} disabled={saving}>
            {saving ? 'Saving…' : 'Unblock'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ModalCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close modal"
      title="Close"
      onClick={onClose}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ink/10 bg-white text-xl leading-none text-ink/60 transition-colors hover:bg-sand-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-court"
    >
      ×
    </button>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-ink/50">{label}</span>
      {children}
    </label>
  )
}
