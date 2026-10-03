import { useMemo, useState } from 'react'
import { formatFullDate } from '../../data/booking'
import { getBookings, useBookingStoreVersion, type StoredBooking } from '../../data/store'
import { isSupabaseConfigured, requireSupabase } from '../../data/supabase'

type HistoryStatus = 'confirmed' | 'rejected' | 'awaiting'
type StatusFilter = 'all' | HistoryStatus
type SourceFilter = 'all' | 'customer' | 'reclub'

interface PaymentRecord {
  reference: string
  source: 'customer' | 'reclub'
  name: string
  mobile: string
  sport?: string
  status: HistoryStatus
  total: number
  submittedAt: string
  bookings: StoredBooking[]
  proof?: StoredBooking
  paymentReference?: string
}

const statusLabels: Record<HistoryStatus, string> = {
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  awaiting: 'Awaiting review',
}

const statusStyles: Record<HistoryStatus, string> = {
  confirmed: 'bg-court/15 text-court',
  rejected: 'bg-tide/10 text-tide',
  awaiting: 'bg-citrus/25 text-ink',
}

const sourceFilters: { id: SourceFilter; label: string }[] = [
  { id: 'all', label: 'All sources' },
  { id: 'customer', label: 'Customers' },
  { id: 'reclub', label: 'Reclub' },
]

const filters: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'awaiting', label: 'Awaiting' },
]

function rangeLabel(startHour: number, endHour: number) {
  const fmt = (h: number) => `${h % 12 || 12}${h < 12 || h === 24 ? 'AM' : 'PM'}`
  return `${fmt(startHour)}–${fmt(endHour)}`
}

function groupStatus(bookings: StoredBooking[]): HistoryStatus {
  if (bookings.some((booking) => booking.status === 'rejected')) return 'rejected'
  if (bookings.every((booking) => booking.status === 'confirmed')) return 'confirmed'
  return 'awaiting'
}

function formatSubmitted(iso: string) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function peso(amount: number) {
  return `₱${amount.toLocaleString()}`
}

export default function PaymentHistory() {
  const storeVersion = useBookingStoreVersion()
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [proofUrls, setProofUrls] = useState<Record<string, string>>({})
  const [proofErrors, setProofErrors] = useState<Record<string, string>>({})

  const records = useMemo<PaymentRecord[]>(() => {
    const groups = new Map<string, StoredBooking[]>()
    getBookings()
      .filter((booking) => (booking.source === 'customer' || booking.source === 'reclub') && booking.reference)
      .forEach((booking) => {
        const group = groups.get(booking.reference) ?? []
        group.push(booking)
        groups.set(booking.reference, group)
      })

    return [...groups.entries()]
      .map(([reference, bookings]) => {
        const first = bookings[0]
        const submittedAt = bookings
          .map((booking) => booking.createdAt)
          .filter(Boolean)
          .sort()[0] ?? ''
        return {
          reference,
          source: first.source as 'customer' | 'reclub',
          name: first.name,
          mobile: first.mobile,
          sport: first.sport,
          status: groupStatus(bookings),
          total: bookings.reduce((sum, booking) => sum + (booking.endHour - booking.startHour) * booking.rate, 0),
          submittedAt,
          bookings: [...bookings].sort((a, b) => a.dayIso.localeCompare(b.dayIso) || a.startHour - b.startHour),
          proof: bookings.find((booking) => booking.paymentScreenshotPath || booking.paymentScreenshotData),
          paymentReference: bookings.find((booking) => booking.paymentReference)?.paymentReference,
        }
      })
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeVersion])

  const summary = useMemo(() => {
    const customerConfirmed = records.filter((record) => record.source === 'customer' && record.status === 'confirmed')
    const reclub = records.filter((record) => record.source === 'reclub')
    return {
      customerTotal: customerConfirmed.reduce((sum, record) => sum + record.total, 0),
      customerCount: customerConfirmed.length,
      reclubTotal: reclub.reduce((sum, record) => sum + record.total, 0),
      reclubCount: reclub.length,
      rejectedCount: records.filter((record) => record.status === 'rejected').length,
      awaitingCount: records.filter((record) => record.status === 'awaiting').length,
    }
  }, [records])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const digits = needle.replace(/\D/g, '')
    return records.filter((record) => {
      if (filter !== 'all' && record.status !== filter) return false
      if (sourceFilter !== 'all' && record.source !== sourceFilter) return false
      if (!needle) return true
      return (
        record.name.toLowerCase().includes(needle) ||
        record.reference.toLowerCase().includes(needle) ||
        (digits.length > 0 && record.mobile.replace(/\D/g, '').includes(digits))
      )
    })
  }, [records, filter, sourceFilter, query])

  const visibleTotal = visible.reduce((sum, record) => sum + record.total, 0)

  async function toggle(record: PaymentRecord) {
    const opening = expanded !== record.reference
    setExpanded(opening ? record.reference : null)
    if (!opening || proofUrls[record.reference] || !record.proof) return

    const { paymentScreenshotData, paymentScreenshotPath } = record.proof
    if (paymentScreenshotData) {
      setProofUrls((current) => ({ ...current, [record.reference]: paymentScreenshotData }))
      return
    }
    if (!paymentScreenshotPath || !isSupabaseConfigured) return

    try {
      const { data, error } = await requireSupabase()
        .storage.from('payment-proofs')
        .createSignedUrl(paymentScreenshotPath, 60 * 60)
      if (error) throw error
      setProofUrls((current) => ({ ...current, [record.reference]: data.signedUrl }))
    } catch (error) {
      setProofErrors((current) => ({
        ...current,
        [record.reference]: error instanceof Error ? error.message : 'Could not load the payment screenshot.',
      }))
    }
  }

  return (
    <section className="rounded-card border border-ink/10 bg-sand p-5 shadow-xl shadow-ink/5 sm:p-6">
      <div>
        <h2 className="font-display text-base font-semibold text-ink">Payment history</h2>
        <p className="mt-1 text-sm text-ink/60">
          Customer payments from the booking page and Reclub bookings assigned by staff, newest first.
        </p>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-ink/10 bg-white p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink/50">Customer payments</dt>
          <dd className="mt-1 font-display text-lg font-semibold text-ink">{peso(summary.customerTotal)}</dd>
          <p className="text-xs text-ink/50">{summary.customerCount} confirmed</p>
        </div>
        <div className="rounded-xl border border-ink/10 bg-white p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink/50">Reclub (computed)</dt>
          <dd className="mt-1 font-display text-lg font-semibold text-ink">{peso(summary.reclubTotal)}</dd>
          <p className="text-xs text-ink/50">{summary.reclubCount} booking{summary.reclubCount === 1 ? '' : 's'}</p>
        </div>
        <div className="rounded-xl border border-ink/10 bg-white p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink/50">Rejected</dt>
          <dd className="mt-1 font-display text-lg font-semibold text-tide">{summary.rejectedCount}</dd>
        </div>
        <div className="rounded-xl border border-ink/10 bg-white p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink/50">Awaiting</dt>
          <dd className="mt-1 font-display text-lg font-semibold text-ink">{summary.awaitingCount}</dd>
        </div>
      </dl>

      <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Filter by source">
        {sourceFilters.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={sourceFilter === item.id}
            onClick={() => setSourceFilter(item.id)}
            className={`min-h-9 rounded-full px-4 text-sm font-semibold transition-colors ${
              sourceFilter === item.id ? 'bg-ink text-white' : 'bg-white text-ink/65 hover:bg-sand-dim hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
              className={`min-h-9 rounded-full px-4 text-sm font-semibold transition-colors ${
                filter === item.id ? 'bg-court text-white' : 'bg-white text-ink/65 hover:bg-sand-dim hover:text-ink'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, mobile, or reference"
          aria-label="Search payment history"
          className="w-full rounded-xl border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15 sm:max-w-xs"
        />
      </div>

      {visible.length === 0 ? (
        <p className="mt-5 rounded-xl bg-white px-4 py-5 text-center text-sm text-ink/55">
          {records.length === 0 ? 'No payments or Reclub bookings yet.' : 'No payments match your filters.'}
        </p>
      ) : (
        <>
          <ul className="mt-5 space-y-3">
            {visible.map((record) => {
              const open = expanded === record.reference
              return (
                <li key={record.reference} className="rounded-2xl border border-ink/10 bg-white">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => void toggle(record)}
                    className="flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left sm:p-5"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-semibold text-ink">
                        {record.name}
                        {record.source === 'reclub' && (
                          <span className="rounded-full bg-ink/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-ink/70">
                            Reclub
                          </span>
                        )}
                      </p>
                      <p className="mt-1 break-all text-xs text-ink/55">
                        {record.reference}{record.mobile ? ` · ${record.mobile}` : ''}
                      </p>
                      <p className="mt-1 text-xs text-ink/55">
                        {record.source === 'reclub' ? 'Assigned' : 'Submitted'} {formatSubmitted(record.submittedAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[record.status]}`}>
                        {statusLabels[record.status]}
                      </span>
                      <span className="font-display text-base font-semibold text-ink">{peso(record.total)}</span>
                    </div>
                  </button>

                  {open && (
                    <div className="border-t border-ink/10 p-4 sm:p-5">
                      <p className="text-xs font-semibold text-court">
                        {record.source === 'reclub' ? 'Reclub booking' : record.sport ?? 'Sport not specified'}
                      </p>
                      <div className="mt-2 space-y-1 text-sm text-ink/65">
                        {record.bookings.map((booking) => (
                          <p key={booking.id}>
                            {booking.courtName} · {formatFullDate(new Date(`${booking.dayIso}T00:00:00`))} ·{' '}
                            {rangeLabel(booking.startHour, booking.endHour)} ·{' '}
                            {peso((booking.endHour - booking.startHour) * booking.rate)}
                          </p>
                        ))}
                      </div>

                      {record.source === 'reclub' ? (
                        <div className="mt-4 rounded-xl border border-ink/10 bg-sand-dim p-3 text-sm text-ink/60">
                          <p>No payment screenshot — Reclub bookings are assigned by staff.</p>
                          <p className="mt-1 text-xs text-ink/50">
                            Amount is computed from the court rate at the time of assignment, not an actual payout from Reclub.
                          </p>
                        </div>
                      ) : (
                        <div className="mt-4 rounded-xl border border-ink/10 bg-sand-dim p-3">
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/55">Payment screenshot</p>
                          {proofUrls[record.reference] ? (
                            <a
                              href={proofUrls[record.reference]}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Open payment screenshot for ${record.reference}`}
                            >
                              <img
                                src={proofUrls[record.reference]}
                                alt={`Payment screenshot for booking ${record.reference}`}
                                className="max-h-64 w-full rounded-lg bg-white object-contain"
                              />
                              <span className="mt-2 block text-center text-xs font-semibold text-court">Open full size</span>
                            </a>
                          ) : proofErrors[record.reference] ? (
                            <p role="alert" className="text-sm text-tide">
                              Could not load screenshot: {proofErrors[record.reference]}
                            </p>
                          ) : record.proof ? (
                            <p className="text-sm text-ink/55">Loading screenshot…</p>
                          ) : record.paymentReference ? (
                            <p className="break-all text-sm text-ink/65">Legacy payment reference: {record.paymentReference}</p>
                          ) : (
                            <p className="text-sm text-ink/55">No payment screenshot is attached to this older booking.</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="mt-4 text-right text-sm text-ink/60">
            Showing {visible.length} of {records.length} · {peso(visibleTotal)}
          </p>
        </>
      )}
    </section>
  )
}
