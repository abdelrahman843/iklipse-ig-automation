// One-off copy of the data from the old Supabase project into the new one.
//
// The new project already has the schema (supabase db push). This copies rows over the REST
// API with both projects' service-role keys, so no Docker or pg_dump is needed.
//
//   1. Put the four values in migrate.env (see migrate.env.example). Never commit that file.
//   2. node scripts/migrate-data.mjs --dry   -> counts rows in the old project, writes nothing
//   3. node scripts/migrate-data.mjs         -> copies rows + media files (safe to re-run: upserts)
//
// Deliberately NOT copied:
//   send_queue     pending sends would fire again from the new project
//   flow_run       in-flight runs would resume and message people; message.flow_run_id is nulled
//   webhook_event  raw log, no value
//   app_config     holds the OLD functions URL and key; set it fresh in the new project
//   flow_template  seeded by the migrations already

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../migrate.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const OLD = { url: env.OLD_URL?.replace(/\/$/, ""), key: env.OLD_SERVICE_KEY };
const NEW = { url: env.NEW_URL?.replace(/\/$/, ""), key: env.NEW_SERVICE_KEY };
for (const [name, v] of Object.entries({ OLD_URL: OLD.url, OLD_SERVICE_KEY: OLD.key, NEW_URL: NEW.url, NEW_SERVICE_KEY: NEW.key })) {
  if (!v) throw new Error(`migrate.env is missing ${name}`);
}
const DRY = process.argv.includes("--dry");

// Parent tables before children. Value = conflict columns (the primary key).
const TABLES = [
  ["ig_account", "id"],
  ["ig_token", "ig_account_id"],
  ["custom_field", "key"],
  ["tag", "name"],
  ["contact", "id"],
  ["flow", "id"],
  ["node_stat", "flow_id,node_id"],
  ["message", "id"],
  ["contact_note", "id"],
  ["messenger_profile", "id"],
  ["media_asset", "id"],
  ["sequence", "id"],
  ["sequence_step", "id"],
  ["sequence_subscription", "id"],
  ["broadcast", "id"],
  ["saved_reply", "id"],
  ["agent", "id"],
];

const PAGE = 1000;
const BATCH = 500;

function headers(p, extra = {}) {
  const h = { apikey: p.key, "content-type": "application/json", ...extra };
  if (p.key.startsWith("eyJ")) h.authorization = `Bearer ${p.key}`; // legacy JWT keys
  return h;
}

/** Old project URLs baked into JSON (image links in flows, media_asset.public_url) now point at the new one. */
function rehost(row) {
  return JSON.parse(JSON.stringify(row).split(OLD.url).join(NEW.url));
}

async function readAll(table, order) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${OLD.url}/rest/v1/${table}?select=*&order=${order}`, {
      headers: headers(OLD, { range: `${from}-${from + PAGE - 1}`, "range-unit": "items" }),
    });
    if (res.status === 404 || (res.status === 400 && (await res.clone().text()).includes("PGRST205"))) return null;
    if (!res.ok) throw new Error(`read ${table}: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

async function write(table, conflict, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const res = await fetch(`${NEW.url}/rest/v1/${table}?on_conflict=${conflict}`, {
      method: "POST",
      headers: headers(NEW, { prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(rows.slice(i, i + BATCH)),
    });
    if (!res.ok) throw new Error(`write ${table}: ${res.status} ${await res.text()}`);
  }
}

async function copyTables() {
  for (const [table, conflict] of TABLES) {
    const order = conflict.split(",").map((c) => `${c}.asc`).join(",");
    const rows = await readAll(table, order);
    if (rows === null) {
      console.log(`- ${table}: not in old project, skipped`);
      continue;
    }
    let out = rows.map(rehost);
    if (table === "message") out = out.map((r) => ({ ...r, flow_run_id: null }));
    if (!DRY && out.length) await write(table, conflict, out);
    console.log(`${DRY ? "·" : "✓"} ${table}: ${out.length} row${out.length === 1 ? "" : "s"}`);
  }
}

/** Every object path in a bucket, walking folders. */
async function listObjects(bucket, prefix = "") {
  const res = await fetch(`${OLD.url}/storage/v1/object/list/${bucket}`, {
    method: "POST",
    headers: headers(OLD),
    body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
  });
  if (!res.ok) throw new Error(`list ${bucket}/${prefix}: ${res.status} ${await res.text()}`);
  const out = [];
  for (const item of await res.json()) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id === null) out.push(...(await listObjects(bucket, path))); // a folder
    else out.push({ path, type: item.metadata?.mimetype ?? "application/octet-stream" });
  }
  return out;
}

async function copyMedia(bucket = "media") {
  let objects;
  try {
    objects = await listObjects(bucket);
  } catch (err) {
    console.log(`- storage/${bucket}: ${err.message}`);
    return;
  }
  console.log(`${DRY ? "·" : "…"} storage/${bucket}: ${objects.length} file${objects.length === 1 ? "" : "s"}`);
  if (DRY) return;
  let done = 0;
  for (const o of objects) {
    const enc = o.path.split("/").map(encodeURIComponent).join("/");
    const get = await fetch(`${OLD.url}/storage/v1/object/${bucket}/${enc}`, { headers: headers(OLD) });
    if (!get.ok) {
      console.log(`  ! ${o.path}: download ${get.status}`);
      continue;
    }
    const put = await fetch(`${NEW.url}/storage/v1/object/${bucket}/${enc}`, {
      method: "POST",
      headers: { ...headers(NEW), "content-type": o.type, "x-upsert": "true" },
      body: Buffer.from(await get.arrayBuffer()),
    });
    if (!put.ok) console.log(`  ! ${o.path}: upload ${put.status} ${await put.text()}`);
    else done++;
  }
  console.log(`✓ storage/${bucket}: ${done}/${objects.length} copied`);
}

console.log(`${DRY ? "DRY RUN — nothing is written" : "Copying"}\n  from ${OLD.url}\n  to   ${NEW.url}\n`);
await copyTables();
await copyMedia();
console.log("\nDone.");
