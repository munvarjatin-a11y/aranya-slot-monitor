import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

const BASE_URL = "https://aranyavihaara.karnataka.gov.in";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(HERE, "state.json");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AranyaSlotMonitor/1.0";

const DISTRICT_IDS = new Map([
  ["bengaluru rural", "21"],
  ["bangalore rural", "21"],
  ["chamarajanagar", "27"],
  ["chikkaballapur", "28"],
  ["chikballapur", "28"],
  ["chikkamagaluru", "17"],
  ["chikmagalur", "17"],
  ["dakshina kannada", "24"],
  ["kalaburagi", "4"],
  ["gulbarga", "4"],
  ["kodagu", "25"],
  ["coorg", "25"],
  ["kolar", "19"],
  ["ramanagara", "29"],
  ["ramanagar", "29"],
  ["shivamogga", "15"],
  ["shimoga", "15"],
  ["udupi", "16"],
]);

const DISTRICT_LABELS = new Map([
  ["21", "Bengaluru Rural"],
  ["27", "Chamarajanagar"],
  ["28", "Chikkaballapur"],
  ["17", "Chikkamagaluru"],
  ["24", "Dakshina Kannada"],
  ["4", "Kalaburagi"],
  ["25", "Kodagu"],
  ["19", "Kolar"],
  ["29", "Ramanagara"],
  ["15", "Shivamogga"],
  ["16", "Udupi"],
]);

function parseDotEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function loadEnvFile() {
  try {
    const parsed = parseDotEnv(await fs.readFile(path.join(HERE, ".env"), "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function env(name, fallback = "") {
  return process.env[name] ?? fallback;
}

function envBool(name, fallback = false) {
  const value = env(name);
  if (!value) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function normalize(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    );
}

function stripTags(value) {
  return decodeHtml(String(value).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function splitSetCookie(header) {
  if (!header) return [];
  return header.split(/,(?=\s*[^;,\s]+=)/g).map((cookie) => cookie.trim());
}

function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;

  if (headers instanceof Headers) {
    for (const [key, value] of headers.entries()) out[key] = value;
    return out;
  }

  for (const [key, value] of Object.entries(headers)) {
    out[key] = value;
  }
  return out;
}

function responseHeaders(rawHeaders) {
  const lower = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    lower[key.toLowerCase()] = value;
  }
  return {
    get(name) {
      const value = lower[name.toLowerCase()];
      return Array.isArray(value) ? value.join(", ") : (value ?? null);
    },
    getSetCookie() {
      const value = lower["set-cookie"];
      if (!value) return [];
      return Array.isArray(value) ? value : [value];
    },
  };
}

async function httpFetch(url, options = {}, redirects = 0) {
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const body =
    options.body instanceof URLSearchParams ? options.body.toString() : options.body ?? null;
  const headers = normalizeHeaders(options.headers);
  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-length")) {
    headers["Content-Length"] = Buffer.byteLength(body);
  }

  const timeoutMs = Number.parseInt(env("REQUEST_TIMEOUT_MS", "45000"), 10) || 45000;
  const response = await new Promise((resolve, reject) => {
    const request = (isHttps ? https : http).request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method || "GET",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            url,
            headers: responseHeaders(res.headers),
            async text() {
              return buffer.toString("utf8");
            },
          });
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });

  const location = response.headers.get("location");
  if (
    [301, 302, 303, 307, 308].includes(response.status) &&
    location &&
    redirects < 5
  ) {
    const nextUrl = new URL(location, url).toString();
    const nextOptions =
      response.status === 303
        ? { ...options, method: "GET", body: null }
        : options;
    return httpFetch(nextUrl, nextOptions, redirects + 1);
  }

  return response;
}

async function fetchWithRetries(url, options = {}) {
  const attempts = Number.parseInt(env("REQUEST_RETRIES", "3"), 10) || 3;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await httpFetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(1000 * attempt);
    }
  }
  throw lastError;
}

class SiteSession {
  constructor() {
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  saveCookies(headers) {
    const getSetCookie = headers.getSetCookie?.bind(headers);
    const cookies = getSetCookie ? getSetCookie() : splitSetCookie(headers.get("set-cookie"));

    for (const cookie of cookies) {
      const firstPart = cookie.split(";")[0];
      const eq = firstPart.indexOf("=");
      if (eq === -1) continue;
      this.cookies.set(firstPart.slice(0, eq), firstPart.slice(eq + 1));
    }
  }

  async fetch(url, options = {}) {
    const headers = new Headers(options.headers ?? {});
    headers.set("User-Agent", headers.get("User-Agent") ?? USER_AGENT);
    headers.set("Accept-Language", headers.get("Accept-Language") ?? "en-IN,en;q=0.9");
    if (this.cookies.size) headers.set("Cookie", this.cookieHeader());

    const response = await fetchWithRetries(url, { ...options, headers });
    this.saveCookies(response.headers);
    return response;
  }
}

async function getHome(session) {
  const response = await session.fetch(`${BASE_URL}/`, {
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`Homepage returned HTTP ${response.status}`);

  const formToken =
    html.match(
      /<form[^>]*action=["'][^"']*\/availability["'][\s\S]*?<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i,
    )?.[1] ??
    html.match(
      /<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i,
    )?.[1];

  if (!formToken) throw new Error("Could not find CSRF token on homepage.");
  return { html, token: formToken };
}

async function postForm(session, pathname, data, { ajax = false } = {}) {
  const headers = {
    Accept: ajax ? "application/json, text/javascript, */*; q=0.01" : "text/html,*/*",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
  };
  if (ajax) headers["X-Requested-With"] = "XMLHttpRequest";

  const response = await session.fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(data),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}`);
  return { response, text };
}

function resolveDistrictId(input) {
  const value = normalize(input);
  if (!value) throw new Error("Set DISTRICT or DISTRICT_ID in .env.");
  if (/^\d+$/.test(value)) return value;

  if (DISTRICT_IDS.has(value)) return DISTRICT_IDS.get(value);
  for (const [name, id] of DISTRICT_IDS.entries()) {
    if (name.includes(value) || value.includes(name)) return id;
  }

  throw new Error(
    `Unknown district "${input}". Use DISTRICT_ID, or one of: ${[
      ...DISTRICT_IDS.keys(),
    ].join(", ")}`,
  );
}

async function getTreks(session, token, districtId) {
  const { text } = await postForm(
    session,
    "/get-treks",
    { _token: token, district_id: districtId },
    { ajax: true },
  );
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("Unexpected get-treks response.");
  return data;
}

async function resolveTrekInput(session, token, districtId, trekInput, label = "") {
  if (/^\d+$/.test(String(trekInput).trim())) {
    return { id: String(trekInput).trim(), name: label || `trek ${trekInput}` };
  }

  const treks = await getTreks(session, token, districtId);
  const wanted = normalize(trekInput);
  const exact = treks.find(
    (trek) => normalize(trek.name) === wanted || normalize(trek.name_kn) === wanted,
  );
  const partial =
    exact ??
    treks.find(
      (trek) =>
        normalize(trek.name).includes(wanted) ||
        normalize(trek.name_kn).includes(wanted) ||
        wanted.includes(normalize(trek.name)),
    );

  if (!partial) {
    throw new Error(
      `Could not find trek "${trekInput}". Available treks: ${treks
        .map((trek) => `${trek.id}:${trek.name}`)
        .join(", ")}`,
    );
  }

  return { id: String(partial.id), name: partial.name || partial.name_kn };
}

async function resolveTrek(session, token, districtId) {
  const trekId = env("TREK_ID");
  if (trekId) return resolveTrekInput(session, token, districtId, trekId, env("TREK_NAME"));

  const trekName = env("TREK_NAME");
  if (!trekName) throw new Error("Set TREK_NAME or TREK_ID in .env.");
  return resolveTrekInput(session, token, districtId, trekName);
}

function parseTargetSpec(spec) {
  const value = spec.trim();
  if (!value) return null;

  if (value.includes("|")) {
    const [districtInput, trekInput, label = ""] = value.split("|").map((part) => part.trim());
    return { districtInput, trekInput, label };
  }

  const [districtInput, trekInput, ...labelParts] = value.split(":").map((part) => part.trim());
  return { districtInput, trekInput, label: labelParts.join(":").trim() };
}

async function resolveTargets(session, token) {
  const rawTargets = env("TREK_TARGETS") || env("MONITORS");
  if (rawTargets) {
    const targets = [];
    for (const rawSpec of rawTargets.split(";")) {
      const spec = parseTargetSpec(rawSpec);
      if (!spec) continue;
      if (!spec.districtInput || !spec.trekInput) {
        throw new Error(
          `Invalid TREK_TARGETS entry "${rawSpec}". Use district:trek:label, for example 17:112:Kudremukha Trek.`,
        );
      }

      const districtId = resolveDistrictId(spec.districtInput);
      const trek = await resolveTrekInput(
        session,
        token,
        districtId,
        spec.trekInput,
        spec.label,
      );
      targets.push({
        districtId,
        districtLabel: DISTRICT_LABELS.get(districtId) ?? spec.districtInput,
        trek,
      });
    }
    if (targets.length) return targets;
  }

  const districtLabel = env("DISTRICT_ID") || env("DISTRICT");
  const districtId = resolveDistrictId(districtLabel);
  const trek = await resolveTrek(session, token, districtId);
  return [
    {
      districtId,
      districtLabel: DISTRICT_LABELS.get(districtId) ?? districtLabel,
      trek,
    },
  ];
}

async function getBlockedDates(session, token, districtId, trekId) {
  const { text } = await postForm(
    session,
    "/get-blocked-dates",
    { _token: token, district_id: districtId, trek_id: trekId },
    { ajax: true },
  );
  const data = JSON.parse(text);
  return new Set(data.blockedDates ?? []);
}

function nextDates(days) {
  const dates = [];
  const today = new Date();
  for (let i = 1; i <= days; i += 1) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dd = String(date.getDate()).padStart(2, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const yyyy = date.getFullYear();
    dates.push(`${dd}-${mm}-${yyyy}`);
  }
  return dates;
}

function dateFromDdMmYyyy(value) {
  const match = String(value).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return null;
  return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
}

function isWeekend(value) {
  const date = dateFromDdMmYyyy(value);
  if (!date) return false;
  const day = date.getDay();
  return day === 0 || day === 6;
}

function targetDates() {
  const explicit = env("TARGET_DATES") || env("TARGET_DATE");
  let dates;
  if (explicit) {
    dates = explicit
      .split(",")
      .map((date) => date.trim())
      .filter(Boolean);
  } else {
    const days = Number.parseInt(env("CHECK_NEXT_DAYS", "15"), 10);
    dates = nextDates(Number.isFinite(days) && days > 0 ? Math.min(days, 15) : 15);
  }

  if (envBool("WEEKENDS_ONLY")) dates = dates.filter(isWeekend);
  return dates;
}

function parseSlots(html) {
  const slots = [];
  const cardRegex =
    /<div[^>]+class=["'][^"']*slot_card[^"']*["'][\s\S]*?(?=<div[^>]+class=["'][^"']*slot_card|<div class=["']col-sm-4|<\/form>)/gi;

  for (const cardMatch of html.matchAll(cardRegex)) {
    const card = cardMatch[0];
    const time = stripTags(
      card.match(/<div[^>]+class=["'][^"']*slot_text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
        "slot",
    );
    const availabilityText = stripTags(
      card.match(
        /<div[^>]+class=["'][^"']*available_text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      )?.[1] ?? "",
    );
    const count = availabilityText.match(/(\d+)\s*\/\s*(\d+)/);
    if (!count) continue;

    slots.push({
      time,
      available: Number.parseInt(count[1], 10),
      capacity: Number.parseInt(count[2], 10),
    });
  }

  if (slots.length) return slots;

  const pageText = stripTags(html);
  for (const count of pageText.matchAll(/(\d+)\s*\/\s*(\d+)/g)) {
    slots.push({
      time: "slot",
      available: Number.parseInt(count[1], 10),
      capacity: Number.parseInt(count[2], 10),
    });
  }
  return slots;
}

async function getAvailability(session, token, districtId, trekId, date) {
  const { response, text } = await postForm(session, "/availability", {
    _token: token,
    district: districtId,
    trek: trekId,
    check_in: date,
  });
  return {
    url: response.url,
    slots: parseSlots(text),
  };
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeState(state) {
  await fs.writeFile(`${STATE_PATH}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(`${STATE_PATH}.tmp`, STATE_PATH);
}

function buildMessage({ districtLabel, trek, date, slots }) {
  const lines = slots
    .filter((slot) => slot.available > 0)
    .map((slot) => `${slot.time}: ${slot.available}/${slot.capacity}`);
  return [
    "Aranya Vihaara slot opened",
    `Trek: ${trek.name}`,
    `District: ${districtLabel}`,
    `Date: ${date}`,
    `Available: ${lines.join(", ")}`,
    `Book: ${BASE_URL}/`,
  ].join("\n");
}

function relevantSlots(slots) {
  const capacityFilter = env("CAPACITY_FILTER")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter(Number.isFinite);

  if (!capacityFilter.length) return slots;
  return slots.filter((slot) => capacityFilter.includes(slot.capacity));
}

async function sendTwilioWhatsApp(message) {
  const accountSid = env("TWILIO_ACCOUNT_SID");
  const authToken = env("TWILIO_AUTH_TOKEN");
  const from = env("TWILIO_WHATSAPP_FROM");
  const to = env("WHATSAPP_TO");
  if (!accountSid || !authToken || !from || !to) return false;

  const body = new URLSearchParams({
    From: from,
    To: to,
  });
  const contentSid = env("TWILIO_CONTENT_SID");
  if (contentSid) {
    body.set("ContentSid", contentSid);
    body.set(
      "ContentVariables",
      env("TWILIO_CONTENT_VARIABLES") || JSON.stringify({ 1: message }),
    );
  } else {
    body.set("Body", message);
  }

  const response = await fetchWithRetries(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`Twilio WhatsApp failed: HTTP ${response.status} ${text}`);
  return true;
}

async function sendCloudWhatsApp(message) {
  const token = env("WHATSAPP_CLOUD_TOKEN");
  const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID");
  const to = env("WHATSAPP_TO");
  if (!token || !phoneNumberId || !to) return false;

  const version = env("WHATSAPP_GRAPH_VERSION", "v20.0");
  const response = await fetchWithRetries(
    `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to.replace(/^whatsapp:/, "").replace(/^\+/, ""),
        type: "text",
        text: { body: message, preview_url: false },
      }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`WhatsApp Cloud API failed: HTTP ${response.status} ${text}`);
  }
  return true;
}

async function sendWebhook(message) {
  const url = env("WHATSAPP_WEBHOOK_URL");
  if (!url) return false;

  const response = await fetchWithRetries(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message, message }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Webhook failed: HTTP ${response.status} ${text}`);
  return true;
}

async function notify(message) {
  if (await sendTwilioWhatsApp(message)) return "twilio";
  if (await sendCloudWhatsApp(message)) return "whatsapp-cloud";
  if (await sendWebhook(message)) return "webhook";

  console.log("No WhatsApp credentials configured. Notification would be:\n");
  console.log(message);
  return "console";
}

function summarize(slots) {
  if (!slots.length) return "no slot counts found";
  return slots.map((slot) => `${slot.time} ${slot.available}/${slot.capacity}`).join("; ");
}

function slotsChanged(previousSlots = [], nextSlots = []) {
  return JSON.stringify(previousSlots) !== JSON.stringify(nextSlots);
}

function saveStateEntry(state, key, nextEntry) {
  const previous = state[key];
  if (
    previous &&
    previous.maxAvailable === nextEntry.maxAvailable &&
    previous.blocked === nextEntry.blocked &&
    slotsChanged(previous.slots, nextEntry.slots) === false
  ) {
    return;
  }

  state[key] = nextEntry;
}

async function runOnce() {
  const dates = targetDates();
  if (!dates.length) {
    console.log("No target dates to check after filters.");
    return 0;
  }

  const session = new SiteSession();
  const { token } = await getHome(session);
  const targets = await resolveTargets(session, token);
  const state = await readState();
  const checkedAt = new Date().toISOString();
  let notifications = 0;

  for (const target of targets) {
    const blockedDates = await getBlockedDates(
      session,
      token,
      target.districtId,
      target.trek.id,
    );

    for (const date of dates) {
      const key = `${target.districtId}:${target.trek.id}:${date}`;
      const previous = state[key];

      if (blockedDates.has(date)) {
        saveStateEntry(state, key, { checkedAt, maxAvailable: 0, blocked: true, slots: [] });
        console.log(`${target.trek.name} ${date}: blocked by site`);
        continue;
      }

      const { slots: allSlots } = await getAvailability(
        session,
        token,
        target.districtId,
        target.trek.id,
        date,
      );
      const slots = relevantSlots(allSlots);
      const maxAvailable = slots.reduce((max, slot) => Math.max(max, slot.available), 0);
      const shouldNotify =
        maxAvailable > 0 &&
        (envBool("ALERT_ON_EVERY_POSITIVE") ||
          previous?.maxAvailable === 0 ||
          (!previous && envBool("ALERT_ON_FIRST_POSITIVE", false)));

      const ignored =
        allSlots.length && slots.length !== allSlots.length
          ? ` (all slots: ${summarize(allSlots)})`
          : "";
      console.log(`${target.trek.name} ${date}: ${summarize(slots)}${ignored}`);

      if (shouldNotify) {
        const message = buildMessage({
          districtLabel: target.districtLabel,
          trek: target.trek,
          date,
          slots,
        });
        const channel = await notify(message);
        notifications += 1;
        console.log(`${target.trek.name} ${date}: notified via ${channel}`);
      }

      saveStateEntry(state, key, {
        checkedAt,
        maxAvailable,
        blocked: false,
        slots,
      });
    }
  }

  await writeState(state);
  return notifications;
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error) {
  const parts = [];
  let current = error;
  while (current) {
    parts.push(current.stack || current.message || String(current));
    current = current.cause;
  }
  return parts.join("\nCaused by: ");
}

async function main() {
  await loadEnvFile();
  if (process.argv.includes("--test-whatsapp")) {
    const channel = await notify(`Aranya monitor test message\n${new Date().toLocaleString()}`);
    console.log(`Test notification sent via ${channel}`);
    return;
  }

  const loop = process.argv.includes("--loop") || envBool("LOOP");
  const intervalSeconds = Math.max(
    60,
    Number.parseInt(env("CHECK_INTERVAL_SECONDS", "300"), 10) || 300,
  );

  do {
    try {
      await runOnce();
    } catch (error) {
      console.error(`Check failed: ${describeError(error)}`);
      process.exitCode = 1;
      if (!loop) break;
    }

    if (loop) {
      console.log(`Sleeping ${intervalSeconds}s...`);
      await delay(intervalSeconds * 1000);
    }
  } while (loop);
}

main();
