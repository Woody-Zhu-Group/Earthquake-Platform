export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
export const fmtDateTime = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
export const DAY_MS = 86_400_000;
