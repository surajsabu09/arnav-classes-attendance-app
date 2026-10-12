export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
export const istDate = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);
export const fmtTime = (iso) => iso ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(iso)) : "-";
export const fmtDate = (ymd) => new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(ymd + "T00:00:00Z"));
export const fmtShort = (ymd) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(ymd + "T00:00:00Z"));
export const isSessionOverdue = (date, start, grace = 0) => {
  const today = istDate();
  if (date < today) return true;
  if (date > today || !start) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const currentMinutes = Number(parts.find((part) => part.type === "hour").value) * 60 + Number(parts.find((part) => part.type === "minute").value);
  const [startHour, startMinute] = start.slice(0, 5).split(":").map(Number);
  return currentMinutes > startHour * 60 + startMinute + grace;
};
export const pill = (value) => {
  const status = String(value);
  const key = status.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `<span class="pill ${esc(key)}">${esc(status.replace(/_/g, " "))}</span>`;
};
export const msg = (element, text, kind = "err") => { element.className = "msg " + kind; element.textContent = text; element.classList.remove("hidden"); };
export const cleanErr = (error) => (error && error.message ? error.message : String(error));

export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This device does not support location."));
    navigator.geolocation.getCurrentPosition(resolve, (error) => {
      const message = { 1: "Location permission denied. Allow location for this site in your browser settings.",
                        2: "Could not determine location. Try near a window or turn on precise location.",
                        3: "Location request timed out. Try again." }[error.code] || error.message;
      reject(new Error(message));
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}
