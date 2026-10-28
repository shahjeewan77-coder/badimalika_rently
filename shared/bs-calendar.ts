// ──────────────────────────────────────────────────────────────────────────────
// Bikram Sambat (Nepali) ⇄ Gregorian calendar conversion.
//
// Month lengths are NOT derivable from a formula — the BS calendar is lunisolar
// and every year has its own set of month lengths. We therefore ship the
// authoritative month-length table for BS 2000–2090 (the same dataset used by
// the widely-used `nepali-date-converter` library), with the fixed epoch
// BS 2000/01/01 = AD 1943-04-14.
// ──────────────────────────────────────────────────────────────────────────────

export const BS_MONTHS_EN = [
  "Baisakh", "Jestha", "Asar", "Shrawan", "Bhadra", "Aswin",
  "Kartik", "Mangsir", "Poush", "Magh", "Falgun", "Chaitra",
] as const;

export const BS_MONTHS_NP = [
  "बैशाख", "जेठ", "असार", "साउन", "भदौ", "असोज",
  "कार्तिक", "मंसिर", "पुष", "माघ", "फाल्गुन", "चैत",
] as const;

export const WEEKDAYS_EN = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

export const WEEKDAYS_NP = [
  "आइतबार", "सोमबार", "मंगलबार", "बुधबार", "बिहीबार", "शुक्रबार", "शनिबार",
] as const;

const BS_START_YEAR = 2000;
const EPOCH_AD_UTC = Date.UTC(1943, 3, 14); // BS 2000/01/01 = AD 1943-04-14
const MS_PER_DAY = 86_400_000;

// Month lengths for BS 2000..2090 (index 0 = BS 2000). 12 entries per year.
const BS_MONTH_DAYS: number[][] = JSON.parse(
  "[[30,32,31,32,31,30,30,30,29,30,29,31],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,32,31,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[30,32,31,32,31,30,30,30,29,30,29,31],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,32,31,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[31,31,31,32,31,31,29,30,30,29,29,31],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,32,31,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[31,31,31,32,31,31,29,30,30,29,30,30],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,32,31,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[31,31,31,32,31,31,29,30,30,29,30,30],[31,31,32,31,31,31,30,29,30,29,30,30],[31,32,31,32,31,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,30,29,31],[31,31,31,32,31,31,30,29,30,29,30,30],[31,31,32,31,31,31,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,30],[31,32,31,32,31,30,30,30,29,30,29,31],[31,31,31,32,31,31,30,29,30,29,30,30],[31,31,32,31,31,31,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[30,32,31,32,31,30,30,30,29,30,29,31],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,31,32,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[30,32,31,32,31,30,30,30,29,30,29,31],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,32,31,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[30,32,31,32,31,31,29,30,30,29,29,31],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,32,31,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[31,31,31,32,31,31,29,30,30,29,30,30],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,32,31,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[31,31,31,32,31,31,29,30,30,29,30,30],[31,31,32,31,31,31,30,29,30,29,30,30],[31,32,31,32,31,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[31,31,31,32,31,31,30,29,30,29,30,30],[31,31,32,31,31,31,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,30],[31,32,31,32,31,30,30,30,29,30,29,31],[31,31,31,32,31,31,30,29,30,29,30,30],[31,31,32,31,31,31,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,30],[31,32,31,32,31,30,30,30,29,30,29,31],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,31,32,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[30,32,31,32,31,30,30,30,29,30,29,31],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,32,31,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[30,32,31,32,31,31,29,30,29,30,29,31],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,32,31,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[31,31,31,32,31,31,29,30,30,29,29,31],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,32,31,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[31,31,31,32,31,31,29,30,30,29,30,30],[31,31,32,31,31,31,30,29,30,29,30,30],[31,32,31,32,31,30,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[31,31,31,32,31,31,30,29,30,29,30,30],[31,31,32,31,31,31,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,30],[31,32,31,32,31,30,30,30,29,30,29,31],[31,31,31,32,31,31,30,29,30,29,30,30],[31,31,32,31,31,31,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,30],[31,32,31,32,31,30,30,30,29,30,29,31],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,31,31,31,30,29,30,29,30,30],[31,32,31,32,31,30,30,30,29,29,30,31],[30,32,31,32,31,30,30,30,29,30,29,31],[31,31,32,31,31,31,30,29,30,29,30,30],[31,31,32,31,31,31,30,30,29,30,30,30],[30,31,32,32,30,31,30,30,29,30,30,30],[30,32,31,32,31,30,30,30,29,30,30,30],[30,32,31,32,31,30,30,30,29,30,30,30]]",
);

export const BS_MIN_YEAR = BS_START_YEAR;
export const BS_MAX_YEAR = BS_START_YEAR + BS_MONTH_DAYS.length - 1;

export interface BsDate {
  year: number;
  month: number; // 1..12
  day: number; // 1..32
}

function yearDays(year: number): number {
  const row = BS_MONTH_DAYS[year - BS_START_YEAR];
  if (!row) throw new Error(`BS year ${year} out of supported range (${BS_MIN_YEAR}–${BS_MAX_YEAR})`);
  return row.reduce((a, b) => a + b, 0);
}

export function daysInBsMonth(year: number, month: number): number {
  const row = BS_MONTH_DAYS[year - BS_START_YEAR];
  if (!row) throw new Error(`BS year ${year} out of supported range`);
  if (month < 1 || month > 12) throw new Error(`BS month ${month} out of range`);
  return row[month - 1];
}

/** Gregorian Date (its Y/M/D taken as-is) → Bikram Sambat date. */
export function adToBs(date: Date): BsDate {
  const utc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  let days = Math.round((utc - EPOCH_AD_UTC) / MS_PER_DAY);
  if (days < 0) throw new Error("Date is before BS 2000/01/01 (AD 1943-04-14)");
  let year = BS_START_YEAR;
  while (days >= yearDays(year)) {
    days -= yearDays(year);
    year += 1;
  }
  let month = 1;
  while (days >= daysInBsMonth(year, month)) {
    days -= daysInBsMonth(year, month);
    month += 1;
  }
  return { year, month, day: days + 1 };
}

/** Bikram Sambat date → Gregorian Date (UTC midnight of that calendar day). */
export function bsToAd(year: number, month: number, day: number): Date {
  let days = 0;
  for (let y = BS_START_YEAR; y < year; y += 1) days += yearDays(y);
  for (let m = 1; m < month; m += 1) days += daysInBsMonth(year, m);
  days += day - 1;
  return new Date(EPOCH_AD_UTC + days * MS_PER_DAY);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2083-06-23" — the canonical stored form of a BS date. */
export function bsIso(bs: BsDate): string {
  return `${bs.year}-${pad(bs.month)}-${pad(bs.day)}`;
}

/** "Aswin 23, 2083" */
export function bsLong(bs: BsDate): string {
  return `${BS_MONTHS_EN[bs.month - 1]} ${bs.day}, ${bs.year}`;
}

/** "असोज २३, २०८३" */
export function bsNepali(bs: BsDate): string {
  const np = "०१२३४५६७८९";
  const toNp = (s: string) => s.replace(/\d/g, (d) => np[Number(d)]);
  return `${BS_MONTHS_NP[bs.month - 1]} ${toNp(String(bs.day))}, ${toNp(String(bs.year))}`;
}

/** "2083-06-23" → { year, month, day } */
export function parseBsIso(iso: string): BsDate {
  const [y, m, d] = iso.split("-").map(Number);
  return { year: y, month: m, day: d };
}

/** Weekday index (0=Sunday) for a BS date. */
export function bsWeekday(bs: BsDate): number {
  return bsToAd(bs.year, bs.month, bs.day).getUTCDay();
}

/** "YYYY-MM-DD" for a Gregorian Date, in UTC terms. */
export function adIso(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today's date in Nepal (Asia/Kathmandu), as both AD and BS. */
export function kathmanduToday(): { ad: string; bs: BsDate; bsIso: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kathmandu",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = parts.split("-").map(Number);
  const bs = adToBs(new Date(Date.UTC(y, m - 1, d)));
  return { ad: `${y}-${pad(m)}-${pad(d)}`, bs, bsIso: bsIso(bs) };
}

/** Convenience: BS date for an arbitrary Gregorian "YYYY-MM-DD" string. */
export function adIsoToBs(iso: string): BsDate {
  const [y, m, d] = iso.split("-").map(Number);
  return adToBs(new Date(Date.UTC(y, m - 1, d)));
}
