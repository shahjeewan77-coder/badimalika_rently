// Client-side date helpers. All dashboard dates are shown in Bikram Sambat.
import { adIsoToBs, bsLong, bsNepali, bsWeekday, kathmanduToday, WEEKDAYS_EN, WEEKDAYS_NP } from "@shared/bs-calendar";

export function bsDisplay(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return bsLong(adIsoToBs(iso));
  } catch {
    return iso;
  }
}

export function bsDisplayNp(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return bsNepali(adIsoToBs(iso));
  } catch {
    return iso;
  }
}

export function bsWeekdayName(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return WEEKDAYS_EN[bsWeekday(adIsoToBs(iso))];
  } catch {
    return "";
  }
}

export function bsWeekdayNameNp(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return WEEKDAYS_NP[bsWeekday(adIsoToBs(iso))];
  } catch {
    return "";
  }
}

export function todayBs(): { ad: string; bsIso: string; long: string; nepali: string; weekday: string } {
  const t = kathmanduToday();
  return {
    ad: t.ad,
    bsIso: t.bsIso,
    long: bsLong(t.bs),
    nepali: bsNepali(t.bs),
    weekday: WEEKDAYS_EN[bsWeekday(t.bs)],
  };
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}
