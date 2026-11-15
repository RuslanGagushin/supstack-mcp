/* Moment-style date formatting, as Supstack's web/src/js/core/dates.js (English only). Templates use it. */
export function formatMoment(d, fmt) {
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  const month = (style) => new Intl.DateTimeFormat("en-US", { month: style }).format(d);
  const wd = (style) => new Intl.DateTimeFormat("en-US", { weekday: style }).format(d);
  const week = (() => { const t0 = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t0.getUTCDay() || 7; t0.setUTCDate(t0.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(t0.getUTCFullYear(), 0, 1)); return Math.ceil(((t0.getTime() - y0.getTime()) / 86400000 + 1) / 7); })();
  const ord = (n) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
  const tokens = {
    YYYY: () => d.getFullYear(), YY: () => pad(d.getFullYear() % 100), Q: () => Math.floor(d.getMonth() / 3) + 1,
    MMMM: () => month("long"), MMM: () => month("short").replace(/\.$/, ""), MM: () => pad(d.getMonth() + 1), M: () => d.getMonth() + 1,
    DDDD: () => pad(Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400000), 3), DD: () => pad(d.getDate()), Do: () => ord(d.getDate()), D: () => d.getDate(),
    dddd: () => wd("long"), ddd: () => wd("short"), dd: () => wd("narrow"), d: () => d.getDay(), E: () => d.getDay() || 7,
    WW: () => pad(week), W: () => week, ww: () => pad(week), w: () => week, gggg: () => d.getFullYear(), GGGG: () => d.getFullYear(),
    HH: () => pad(d.getHours()), H: () => d.getHours(), hh: () => pad(d.getHours() % 12 || 12), h: () => d.getHours() % 12 || 12,
    mm: () => pad(d.getMinutes()), m: () => d.getMinutes(), ss: () => pad(d.getSeconds()), s: () => d.getSeconds(),
    A: () => (d.getHours() < 12 ? "AM" : "PM"), a: () => (d.getHours() < 12 ? "am" : "pm"), X: () => Math.floor(d / 1000), x: () => +d,
  };
  const re = /\[([^\]]*)\]|YYYY|YY|Q|MMMM|MMM|MM|M|DDDD|DD|Do|D|dddd|ddd|dd|d|E|WW|W|ww|w|gggg|GGGG|HH|H|hh|h|mm|m|ss|s|A|a|X|x/g;
  return fmt.replace(re, (m, lit) => (lit !== undefined ? lit : String(tokens[m]())));
}
