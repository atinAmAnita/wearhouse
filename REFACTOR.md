# STOCKFORGE Refactor Plan

Executable to-do list. One section per change. Status: 📋 planned · 🚧 in progress · ✅ done · ⏭️ skipped

**Invariant across all eBay writes:** if eBay fails, local doesn't change. Local ↔ eBay stay in lockstep.

---

## EXECUTION PLAN — grouped batches

Each batch ships independently (can deploy and test before moving to next). Points within a batch marked `(∥)` can run in parallel — no shared files or logic. Points marked `(→)` must run in listed order.

### Batch 1 — Housekeeping ✅ DONE
Safe cleanup. Nothing depends on these but they reduce surface area for later work.
- **Point 7 (∥)** — Delete unused files
- **Point 6 (→ after 7)** — Remove debug endpoints (touches `server.js`)
- **Point 9 (→ after 6)** — Error middleware infrastructure only (add `HttpError` + `ah` + final handler; don't migrate routes yet)

Ship + smoke-test the app still works.

### Batch 2 — Helper foundations (1–2 hrs, 1 deploy)
Three independent new helpers. No behavior change for users yet. Can all be done in one sitting.
- **Point 5 (∥)** — `detectChanges(before, after)` helper
- **Point 2 (∥)** — `withEbayLock` helper + frontend cooldown wrapper
- **Point 8 (∥)** — Trading API call helper + `escapeXml` (refactors 9 existing call sites)

Ship + smoke-test each eBay button still works.

### Batch 3 — Core sync integrity (4–6 hrs, 1 deploy, HIGH RISK)
Sequential — each depends on previous. Most careful commit of the whole refactor.
- **Point 3 (→)** — Snapshot initialization on all 4 creation paths + detection guard
- **Point 1 (→ after 3)** — Apply endpoint rewrite: eBay-first, drift check, atomic rollback

Test matrix: drift conflict, eBay fail, successful apply, CREATE path, SKU_CHANGE. Ship separately from everything else so any regression is easy to bisect.

### Batch 4 — Sync UX (2–3 hrs, 1 deploy)
Requires Batch 3 drift-check to be live. Updates Point 1 flow's admin-facing surface.
- **Point 11 (→)** — Apply All button in Updates tab
- **Point 17 (→)** — 5-button layout + Pull confirmation modal + button cooldown wired in

Ship + verify the 5-button workflow end-to-end with a real eBay test account.

### Batch 5 — Features (any order, parallel shippable)
Four independent features. Each can go out in its own mini-deploy or bundled.
- **Point 13 (∥)** — Sync status column in inventory table
- **Point 14 (∥)** — Low stock warnings (schema + UI)
- **Point 15 (∥)** — Pending updates age indicator + optional Refresh button
- **Point 12 (∥)** — Item specifics (aspect picker UI + XML wiring) — largest of the four

### Batch 6 — Structural cleanup (1 session, 1 deploy)
Only after everything else lands. Moves code around without changing behavior.
- **Point 16 (→)** — Split `server.js` into `lib/` + `routes/`. Do as sub-steps: errors → locks → detectChanges → XML → ebayClient → routes (one commit each, test after each).
- **Route migration (→)** — Convert remaining ~50 endpoints to use `ah()` wrapper + `HttpError` (completes Point 9's migration that started in Batch 1).

---

## DEPENDENCY QUICK-REFERENCE

```
Batch 1: 7 → 6 → 9(infra)
Batch 2: 5 ∥ 2 ∥ 8
Batch 3: 3 → 1               [needs: 5 from Batch 2]
Batch 4: 11 → 17              [needs: 1, 2]
Batch 5: 13 ∥ 14 ∥ 15 ∥ 12    [any time after Batch 3]
Batch 6: 16 → 9(route migration) [needs: everything else done]
```

Total: 6 deploys, each independently shippable + testable.

---

## 1. Apply endpoint — eBay-first, local-second 📋

**Problem:** `/api/updates/:id/apply` updates local DB before trying eBay. If eBay fails, local is dirty and user must click Undo manually.

**Changes (`server.js` ~1939–2060):**
- Reorder for `updateType === 'UPDATE'` with `ebaySync.ebayItemId`:
  1. Fetch current eBay state (new helper `ebayAPI.getCurrentListingState(accountId, ebayItemId)`, 30s cache)
  2. Compare each change's `oldValue` vs eBay's current → drift? return `409 { conflict, drifted:[{field,expected,actual}] }`
  3. Call `reviseItemPrice(...)` — fail → return 500, no local writes
  4. Only on eBay success: `data.updateItem(updates)` + `addHistory(...)` + save snapshot + `dismissPendingUpdate`
- Leave CREATE / DELETE / SKU_CHANGE order as-is (add comment explaining why)
- Accept `{force:true}` in request body to bypass drift check

**Frontend (`app.js` `Updates.apply`):**
- On 409 → modal: "eBay changed. Overwrite / Cancel / Re-queue with fresh values"
- "Overwrite" resends with `force:true`
- "Re-queue" deletes this update, creates new one with corrected `oldValue`

**Test:** apply with drift → 409 · apply matching → 4 local writes · eBay fails → 0 local writes · CREATE → old path

---

## 2. Sync locking — one eBay op per account at a time 📋

**Problem:** `pull`, `push`, `sync-all`, `compare-and-queue`, `publish-all`, `apply` all run independently. Double-click or cron collision → races that corrupt snapshot/status fields.

**Changes (`server.js`):**
- New helper (top of file):
  ```
  const ebayLocks = new Map();
  function withEbayLock(accountId, op, fn) {
      const existing = ebayLocks.get(accountId);
      if (existing && Date.now() - existing.startedAt < 5*60*1000) {
          const e = new Error(`Sync already in progress: ${existing.operation} (${Math.round((Date.now()-existing.startedAt)/1000)}s ago)`);
          e.status = 409; throw e;
      }
      ebayLocks.set(accountId, { operation: op, startedAt: Date.now() });
      return Promise.resolve(fn()).finally(() => ebayLocks.delete(accountId));
  }
  ```
- Wrap these 6 endpoints in `withEbayLock`:
  - `/api/ebay/pull/:accountId` → `'pull'`
  - `/api/ebay/push/:accountId` → `'push'`
  - `/api/ebay/sync-all/:accountId` → `'sync'`
  - `/api/ebay/compare-and-queue/:accountId` → `'compare'`
  - `/api/ebay/publish-all/:accountId` → `'publish-all'`
  - `/api/updates/:id/apply` → `'apply'` (uses `req.body.accountId`)

**Frontend (`app.js`):**
- Every sync button (`pullBtn`, `pushBtn`, `syncBtn`, `compareBtn`, `publishBtn`, Apply btn in Updates): disable on click, re-enable only after server response lands (success OR error)
- Additionally: minimum 2s cooldown between re-enable and next click accepted — even if eBay responds in 500ms, the button stays locked for 2s to prevent rapid-fire
- Implementation: wrap the click handler — `btn.disabled = true; const start = Date.now(); try { await call(); } finally { const elapsed = Date.now()-start; setTimeout(()=>btn.disabled=false, Math.max(0, 2000-elapsed)); }`
- On 409 response → `UI.notify(data.error, 'warning')`, button still follows the 2s cooldown

**Known limitation:** in-memory map = per-serverless-instance. Scale-out can bypass. Acceptable for single-user; if it bites → migrate to Mongo TTL collection (Point 2b).

**Test:** lock-acquire twice → 409 · release → re-acquire works · stale 6min → auto-released · cross-account ops → parallel OK

---

## 3. Snapshot-first change detection + Updates-queue cross-check 📋

**Problem:** Sales detection currently uses a brittle fallback cascade (`snapshot ?? lastSyncedQty ?? currentQty`). When baseline is missing, it falls back to `currentQty`, silently hiding real sales. Also: if admin has a pending qty change queued in Updates AND eBay simultaneously dropped qty from a sale, current code can't tell them apart and one clobbers the other.

**Approach:** Make `ebaySync.snapshot` the single source of truth. Cross-reference pending Updates to distinguish admin-initiated changes from eBay-side changes.

**Changes:**

`database.js`:
- Remove `lastSyncedQty` field (deprecated; snapshot is authoritative). Migration: on read, if snapshot missing but `lastSyncedQty` exists, promote it. Leave field nullable so old docs don't break.

`server.js` — item creation paths: **always** initialize `ebaySync.snapshot`
- `createLocalItemFromEbay` (~line 1329): set `ebaySync: { ebayItemId, snapshot: captureEbaySnapshot(ebayItem), lastSyncTime: new Date(), status: 'synced' }`
- Compare-and-queue CREATE branch (~line 2929): same — set snapshot to eBay values
- `POST /api/inventory` manual add: set `ebaySync: { snapshot: captureLocalSnapshot(newItem), status: 'not_synced' }` (no ebayItemId yet; snapshot records baseline for first push)
- Publish-all / single publish success handler: set snapshot from the just-synced local item

`server.js` — sales detection with admin-change cross-check:
- New helper: `async hasPendingQtyChange(sku)` → boolean. Reads pending Updates, returns true if any has `changes.find(c => c.field === 'quantity')`.
- In Pull (~line 1441) and Sync (~line 1701) sales-detection blocks, replace cascade with:
  ```
  if (!snapshot) {
      // No baseline — take a fresh snapshot, don't guess sales
      updates.ebaySync = { ...fullItem.ebaySync, snapshot: captureEbaySnapshot(ebayItem), lastSyncTime: new Date(), status: 'synced' };
      continue; // skip sale detection this cycle
  }
  const sold = snapshot.quantity - parseInt(ebayItem.quantity);
  if (sold > 0) {
      if (await hasPendingQtyChange(sku)) {
          // Admin has a queued change — record the eBay sale as history but DON'T mutate currentQty
          // The admin's pending Apply will reconcile against fresh eBay state (Point 1's drift check)
          await data.addHistory(sku, { action: 'EBAY_SALE_DEFERRED', qty: -sold, newTotal: fullItem.currentQty, note: `${sold} sold on eBay but admin change pending — deferred` });
      } else {
          // No admin conflict — safe to apply
          updates.currentQty = Math.max(0, fullItem.currentQty - sold);
          await data.addHistory(sku, { action: 'EBAY_SALE', qty: -sold, newTotal: updates.currentQty, note: `${sold} sold on eBay` });
      }
  }
  ```

**Rationale:** Admin edits (queued in Updates) and eBay sales (detected from snapshot diff) are the two legit sources of qty truth. They can conflict. Instead of one silently winning, defer eBay's change when admin has a pending one — Point 1's drift check will then see fresh eBay state at Apply time and ask the user what to do.

**Test:**
- Create item via Compare → snapshot set to eBay values · Pull immediately → no phantom sale
- eBay sells 1, no pending admin change, Pull → local `currentQty -= 1`, `EBAY_SALE` history
- eBay sells 1, admin has pending qty change for same SKU, Pull → `EBAY_SALE_DEFERRED` history, `currentQty` untouched, admin's Apply later hits drift check (Point 1) and shows conflict modal

---

## 5. Centralize change detection 📋

**Problem:** Same "did price or qty change?" logic is duplicated in 4 places with two different output shapes, causing subtle bugs.
- `detectEbayChanges` (`server.js:1307`) emits `{ field, old, new }`
- Compare-and-queue inline (`~line 2879`) emits `{ field, oldValue, newValue }`
- Pull sales-detection (`~line 1611`) uses inline `Math.abs(a-b) > 0.01`
- Smart-sync (`~line 2735`) uses another inline `Math.abs(...)` check

Shape mismatch means pending updates created by Compare have `oldValue/newValue`, while internal change objects have `old/new`. Bugs already exist: field-name checks in Apply assume one shape, Compare produces the other.

**Changes (`server.js`):**

Add single helper on `ebayAPI`:
```
detectChanges(before, after, opts = {}) {
    // before/after: { price, quantity, title?, description? }
    // Returns array of { field, oldValue, newValue } — ONE shape, always
    const changes = [];
    if (before == null) return [{ field: 'all', oldValue: null, newValue: after, reason: 'no_baseline' }];
    const priceEps = opts.priceEpsilon ?? 0.01;
    if (Math.abs((before.price||0) - (after.price||0)) > priceEps)
        changes.push({ field: 'price', oldValue: before.price, newValue: after.price });
    if ((before.quantity|0) !== (after.quantity|0))
        changes.push({ field: 'quantity', oldValue: before.quantity, newValue: after.quantity });
    if (opts.includeTitle && before.title !== after.title)
        changes.push({ field: 'title', oldValue: before.title, newValue: after.title });
    return changes;
}
```

Replace callers:
- `detectEbayChanges` (1307–1326) → delete, replace internal callers with `detectChanges(snapshot, ebayItem)`
- Callers at 1413, 1563 → update to new shape (`old→oldValue`, `new→newValue`)
- Compare-and-queue (~2879) → replace inline `Math.abs` + push with `detectChanges(localItem, ebayItem)`
- Pull sales detection → use `detectChanges` result's quantity drop to compute `sold`
- Smart-sync (~2735) → same

**Normalize pending-update schema:** every place that creates a pending update now passes through `detectChanges` output verbatim. No more hand-rolled `{field, old, new}` objects.

**Test:** grep for `Math.abs.*price|field: 'quantity'.*oldValue` — should only appear inside `detectChanges` · Compare + Apply roundtrip same SKU → no shape-mismatch errors · existing pending updates in DB still apply (legacy shape read-through: normalize on read)

---

## 6. Remove debug endpoints + page ✅

**Problem:** 3 unauthenticated debug endpoints expose raw eBay data and allow mutations. Anyone who knows the URL can call them.
- `GET /api/debug/revise-test/:accountId/:itemId/:price` (`server.js:2337`) — **mutates eBay listings** (changes price). No auth. Was added for debugging.
- `GET /api/debug/offers/:accountId/:sku` (`server.js:2381`) — returns raw eBay Offer data for any SKU.
- `GET /api/debug/ebay-export/:accountId` (`server.js:2391`) — dumps full eBay inventory to Excel.
- `GET /debug` (`server.js:3232`) — serves `public/debug.html` without auth.

**Changes:**
- DELETE `/api/debug/revise-test/:accountId/:itemId/:price` entirely (it mutates — no safe version)
- DELETE `/api/debug/offers/:accountId/:sku` entirely (if needed later, re-add behind admin password)
- MOVE `/api/debug/ebay-export/:accountId` behind the admin-password check used elsewhere (e.g. check `req.query.password === config.adminPassword`)
- MOVE `/debug` page behind same admin gate, OR delete `public/debug.html` entirely if not used
- Delete any matching frontend code in `app.js` / `debug.html` that calls these

**Test:** unauthenticated `curl /api/debug/revise-test/...` → 404 · `curl /api/debug/ebay-export/...` without password → 401 · with password → works · nothing in the main app UI breaks

---

## 7. Delete unused files ✅

**Problem:** Orphan files from earlier iterations that nothing references. Confuses future edits (grep hits the dead file, you edit the wrong one) and bloats deploy uploads.

**Confirmed unused (delete):**
- `public/styles-dev.css` (11 KB) — no HTML file imports it
- `public/index.html` (364 B) — not routed by `server.js`, nothing links to it
- `public/debug.html` (13 KB) — only reachable via `/debug` route being removed in Point 6; delete once Point 6 ships
- `ebay-api.js` at project root (12 KB) — verified with `grep -r "require.*ebay-api"` → zero hits. eBay logic lives inline in `server.js`. Pure orphan.

**Move to `/scripts` (keep but relocate):**
- `migrate-to-mongodb.js` (4 KB) — one-time migration script, done. Move to `scripts/migrate-to-mongodb.js` with a header comment `// Historical: ran once on 2026-02-05 to migrate from JSON to Mongo. Do not re-run.`
- `exchange-token.js` (2 KB) — manual CLI utility, not imported. Move to `scripts/exchange-token.js`.

**Leave alone:**
- `inventory.json`, `.ebay-accounts.json` — fallback data, already gitignored
- `config.example.js` — template, kept for new contributors
- `inventory_backup.xlsx` — gitignored local backup

**Test:** `grep -r "styles-dev" .` → 0 hits · `grep -r "public/index.html" .` → 0 hits · `grep -r "ebay-api"` → 0 hits in source · app loads and eBay sync still works (proves ebay-api.js was truly orphan)

---

## 8. Trading API call helper — deduplicate XML boilerplate 📋

**Problem:** 9 Trading API call sites each repeat the same boilerplate: token refresh, endpoint URL, XML envelope with `RequesterCredentials`, `fetch()` with 6 headers, response parsing, error extraction. Each site is ~30–50 lines. Inconsistencies already exist: some escape `&`/`<` in user input, others don't (XML injection risk); some parse `<Ack>Failure</Ack>` correctly separating Warnings from Errors, others throw on any Failure.

Call sites:
- `reviseItemPrice` (573) · `addFixedPriceItem` (625) · `uploadImage` (710) · `getPurchaseHistory` (780) · `getUserInfo` (877) · second `GetMyeBayBuying` (941) · `getActiveListings` (1019) · `reviseInventoryStatus` (1140) · `/api/debug/revise-test` (2337, dying in Point 6)

**Changes (`server.js` — add on `ebayAPI`):**
```
async tradingApiCall(accountId, callName, innerXml) {
    const account = await this.ensureFreshToken(accountId);
    const token = account.tokens.access_token;
    const endpoint = config.ebay.environment === 'production'
        ? 'https://api.ebay.com/ws/api.dll'
        : 'https://api.sandbox.ebay.com/ws/api.dll';
    const body = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
    ${innerXml}
    <ErrorLanguage>en_US</ErrorLanguage>
    <WarningLevel>High</WarningLevel>
</${callName}Request>`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml',
            'X-EBAY-API-SITEID': '0',
            'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
            'X-EBAY-API-CALL-NAME': callName,
            'X-EBAY-API-IAF-TOKEN': token
        },
        body
    });
    const xmlText = await response.text();
    const ack = xmlText.match(/<Ack>([^<]+)<\/Ack>/)?.[1] || 'Unknown';
    if (ack === 'Failure') {
        // Only real errors (SeverityCode=Error), ignore Warnings
        const errors = [...xmlText.matchAll(/<Errors>([\s\S]*?)<\/Errors>/g)]
            .filter(m => m[1].includes('<SeverityCode>Error</SeverityCode>'))
            .map(m => m[1].match(/<LongMessage>([^<]*)/)?.[1] || m[1].match(/<ShortMessage>([^<]*)/)?.[1]);
        if (errors.length) throw new Error(errors.join('; '));
    }
    return { xmlText, ack };
}

// XML-escape user input (titles, descriptions, SKUs with weird chars)
escapeXml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
```

**Replace each of the 9 call sites** to use `tradingApiCall(accountId, 'ReviseFixedPriceItem', itemXml)` etc. Each site drops from ~40 lines to ~15 lines (just the inner `<Item>...</Item>` payload + parsing its specific response fields).

**Fix XML escaping consistently:** run every user-supplied string (title, description, SKU, location) through `ebayAPI.escapeXml(...)` before injecting into XML. Currently only `addFixedPriceItem` does a partial escape (only `&` and `<`).

**Multipart exception:** `uploadImage` (line 710) uses `multipart/form-data` not pure XML — it doesn't fit the helper cleanly. Leave it with its own path, but extract the XML envelope construction into a shared helper `buildTradingEnvelope(callName, innerXml, token)` that both code paths use.

**Test:** each Trading API operation still returns correct data · title with `&` or `<` in it no longer breaks the XML · a failure-with-warning response (like the seller-account error we hit earlier) no longer misreports the warning as the error

---

## 9. Error middleware — stop repeating try/catch in every route 🚧 (infra done, route migration pending in Batch 6)

**Problem:** 64 try/catch blocks in `server.js`, 14 of them are the *exact* one-liner `} catch (err) { res.status(500).json({ error: err.message }); }`, rest are trivial variations. Three concrete harms:

1. **Status code inflation** — every error becomes `500 Internal Server Error`, even validation failures, 404s, and 409 conflicts. Client has no way to differentiate "user needs to fix input" from "server crashed." Point 1's drift-detection needs to return `409`, and Point 2's lock-contention needs `409` too — right now those have to be manually wired in every single spot.

2. **Raw error leakage** — `err.message` goes straight to client. Mongo errors, stack traces, eBay token fragments can leak. Example: a failed `reviseItemPrice` call currently surfaces eBay's raw HTML error page text through the UI.

3. **Forgetting `next(err)` in async routes** — Express doesn't catch async rejections automatically. Every route needs the try/catch or errors swallow silently. Easy to miss when adding new endpoints.

**Changes (`server.js`):**

Add async wrapper + error middleware near the top, right after `app = express()`:
```
// Wrap async route handlers to forward errors to Express error middleware
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Centralized HTTP error class
class HttpError extends Error {
    constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
```

Register error handler as the LAST `app.use(...)`, after all routes:
```
app.use((err, req, res, next) => {
    const status = err.status || 500;
    const body = { error: err.message || 'Internal error' };
    if (err.details) body.details = err.details;
    if (status >= 500) console.error(`[${req.method} ${req.path}]`, err);
    res.status(status).json(body);
});
```

Convert routes (~65 endpoints, incremental — do it as each route is touched for other refactors):
- Wrap handler in `ah(async (req, res) => { ... })`
- Delete the trailing `try { ... } catch (err) { res.status(500).json(...) }`
- Replace manual status throws with `throw new HttpError(409, 'Sync in progress', {operation, elapsed})` etc.

Example before:
```
app.post('/api/updates/:id/apply', async (req, res) => {
    try {
        const update = ...;
        if (!update) return res.status(404).json({ error: 'Not found' });
        // work
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
```
After:
```
app.post('/api/updates/:id/apply', ah(async (req, res) => {
    const update = ...;
    if (!update) throw new HttpError(404, 'Pending update not found');
    const result = await doWork();
    res.json(result);
}));
```

**Integrates cleanly with:**
- Point 1: `throw new HttpError(409, 'eBay changed', { drifted })`
- Point 2: `withEbayLock` throws its `409 Sync in progress` error via `HttpError` — middleware handles response

**Don't scope-creep:** don't convert all 65 routes in one PR. Add the middleware + `ah` + `HttpError` in the first commit, then migrate routes opportunistically as Points 1, 2, 6 touch them. Remaining routes get converted in a cleanup pass at the very end.

**Test:** unknown route throws Mongo error → 500 with `"Internal error"` not raw stack · route throws `HttpError(400, 'bad sku')` → client receives `{error: 'bad sku'}` with status 400 · existing routes unchanged in behavior until migrated one-by-one

---

## 10. Multiple photos per listing ⏭️ SKIPPED

**Reason:** User wants to keep single-thumbnail-per-item as-is. Current upload already goes straight to eBay Picture Services (we proxy, don't store) and we only keep the returned URL. No multi-photo UI needed, no schema change needed. Current behavior correct.

~~Original plan preserved below for reference:~~

**Problem:** Schema stores one `imageUrl` string per item. eBay listings support up to 12 photos. Sellers with one-photo listings get lower visibility + lower buyer trust. When we Pull from eBay, we only keep the first `<PictureURL>` and drop the rest.

**Changes:**

`database.js` (~line 42): change field to array, keep back-compat.
```
imageUrls: { type: [String], default: [] }
// Legacy field still read; remove after migration pass
imageUrl: { type: String, default: null }
```

Migration: on next read of any item, if `imageUrl` is set and `imageUrls` is empty → move it to `imageUrls[0]`, null out `imageUrl`. Write back lazily (when item is next updated) — no batch migration script needed.

`server.js`:
- `getActiveListings` XML parser (~line 1080): change `match(/<PictureURL>...)` to `matchAll(/<PictureURL>([^<]+)<\/PictureURL>/g)`, collect all into array. Still upgrade `s-l140` → `s-l500` on each.
- `compare-and-queue` (~line 2941) and `backfill-images` (~line 2824): save entire `imageUrls` array, not just first.
- `addFixedPriceItem` (~line 659): emit multiple `<PictureURL>` tags inside `<PictureDetails>`:
  ```
  ${item.ImageUrls?.length ? `<PictureDetails>${item.ImageUrls.map(u => `<PictureURL>${u}</PictureURL>`).join('')}</PictureDetails>` : ''}
  ```
- `reviseItemPrice` / revise flows: accept optional `imageUrls` param and include `<PictureDetails>` when provided. Leave unchanged when not provided (don't want a qty-only Revise to accidentally wipe photos).
- API response serializer (`formatItem`, `/api/lookup`): return `ImageUrls: item.imageUrls || (item.imageUrl ? [item.imageUrl] : [])` for backward compat with existing frontend code during transition.
- `/api/ebay/upload-image/:accountId` → **append** to `imageUrls`, don't replace. Add new endpoint `DELETE /api/inventory/:sku/image/:index` for removing.

`public/app.js` (Lookup panel, ~line 380):
- Replace single `<img>` with a strip: main image + thumbnails, click thumbnail to switch main
- Keep the "+ Add Photo" button — now appends instead of replaces
- Each photo gets a small `×` overlay to remove it
- Drag-to-reorder (optional, nice-to-have; defer if time-tight) — ordering matters because eBay uses first photo as gallery thumbnail

`public/app.js` inventory table thumbnail (~line 640):
- Still show first image only (no UI change needed): `item.ImageUrls?.[0] || item.ImageUrl`

**Test:**
- Item with legacy single `imageUrl` still shows on Pull → migration promotes to `imageUrls[0]` on next update
- Upload 3 photos → all 3 stored, all 3 sent to eBay on publish
- Pull listing with 5 photos → all 5 stored locally
- Delete photo index 1 → array shrinks, eBay revise omits `<PictureDetails>` so listing unchanged (explicit update only if user clicks sync-photos)
- First photo = gallery thumbnail on eBay (visually verify)

---

## 11. Apply All in Updates tab 📋

**Problem:** Updates tab has "Dismiss All" but no "Apply All." With 20 pending updates queued, user applies them one by one (20 confirmations, 20 wait-for-eBay cycles). Tedious and error-prone — they forget which they applied.

**Scope clarification:** No bulk-price-edit, no inventory-table checkboxes. Just an Apply All button on the Updates tab that runs the existing single-Apply flow in sequence.

**Changes:**

`public/app.html` Updates tab: add button `<button id="applyAllBtn" class="btn btn-success">Apply All</button>` next to "Dismiss All."

`public/app.js` `Updates` module:
- `async applyAll()`:
  - Confirmation prompt: "Apply all N pending updates? Any that fail (conflicts, eBay errors) will stay in the queue."
  - Loop pending updates sequentially: `for (const u of this.allUpdates) { await Updates.apply(u._id); }`
  - Sequentially, not `Promise.all` — Point 2's lock would reject parallel calls anyway, and sequential gives clean progress UI
  - Show progress as it goes: `Applying 7 of 23…`
  - On finish: `applied: 21, conflicts: 1, failed: 1 — see Updates tab`
- Each Apply reuses full single-Apply logic → drift check (Point 1), lock (Point 2), error handling. Nothing new server-side.

`server.js`: no changes needed. Optional nice-to-have: `POST /api/updates/apply-all` that loops server-side — but doing it client-side means each update gets its own roundtrip and user sees real progress. Prefer client-side loop.

**Test:**
- Queue 5 updates, click Apply All → all 5 processed sequentially, summary shows 5 applied
- Queue 5 updates, one has eBay drift → 4 applied, 1 left in queue with conflict icon, summary shows "4 applied, 1 conflict"
- Mid-run: click Apply All, click Dismiss on an item while running → handle gracefully (just skip if not found when its turn comes)

---

## 12. Item specifics — finish wiring through to eBay 📋

**Problem:** Item specifics (Brand, Model, Year, Part Number, etc.) are half-built. They have:
- DB field: `itemSpecifics` ✓ (`database.js:45`)
- Save endpoint: `PUT /api/inventory/:sku/advanced` ✓ (`server.js:2261`)
- Advanced modal UI skeleton ✓ (`app.html:490-493`, empty `#itemSpecificsContainer`)

But they're missing:
- The aspect-picker UI — `#itemSpecificsContainer` is never populated with inputs
- Push to eBay via Trading API — `itemSpecifics` is passed to the old Inventory-API `syncItemToEbay` (4 places) but NOT to the Trading-API `addFixedPriceItem`/`reviseItemPrice` that we actually use now. So saved specifics die in the DB.

**Why it matters:** eBay auto-promotes listings with fully-filled specifics. Auto-parts buyers filter by Year/Make/Model — listings without those get zero impressions. For Xander's auto-parts inventory this is a direct revenue lever.

**Changes:**

`public/app.js` `Advanced` module:
- When category selected → call `API.ebay.getCategoryAspects(accountId, categoryId)` (endpoint exists) → get list of aspects for that category, each with `{name, required, values?: []}` (values present for enum aspects like "Condition" with a fixed list)
- Populate `#itemSpecificsContainer` with one row per aspect:
  - Required aspects highlighted red if empty
  - Enum aspects → `<select>` with the allowed values
  - Free-text aspects → `<input type="text">`
  - Prefill from `item.itemSpecifics[aspect.name]` if present
- Save collects all non-empty fields into `itemSpecifics` object, posts via existing `/api/inventory/:sku/advanced`

`server.js`:
- `addFixedPriceItem` (`~line 625`): emit `<ItemSpecifics>` block from the passed-in specifics:
  ```
  ${item.ItemSpecifics && Object.keys(item.ItemSpecifics).length ? `<ItemSpecifics>${
      Object.entries(item.ItemSpecifics).map(([k,v]) =>
          `<NameValueList><Name>${escapeXml(k)}</Name><Value>${escapeXml(v)}</Value></NameValueList>`
      ).join('')
  }</ItemSpecifics>` : ''}
  ```
- `reviseItemPrice`: accept optional `itemSpecifics` param, emit same block when provided. Don't touch if omitted (same pattern as photos in Point 10's skipped plan — revise only what's explicitly changed).
- `getActiveListings` XML parser: extract any `<ItemSpecifics><NameValueList>` entries into the parsed item, so Pull imports them.
- All publish endpoints (`/api/ebay/publish-all`, `/api/ebay/publish/:sku`): pass `ItemSpecifics: fullItem.itemSpecifics` through to `addFixedPriceItem`.

**Validation gate:** Before publish, if category has required aspects and any are missing → block with `HttpError(400, 'Missing required aspects: Brand, Year')` (uses Point 9's middleware). User gets clear message, no silent bad listings.

**Test:**
- Select auto-parts category (e.g. 33647 "Car Switches & Controls") → aspects panel fills with Year, Make, Model, Part Brand, Part Number
- Save → DB has `itemSpecifics: { Year: "2014", Make: "Ford", ... }`
- Publish → eBay listing has Item Specifics populated (visually verify on eBay.com)
- Pull eBay listing with existing specifics → imported into local `itemSpecifics`
- Try to publish with missing required aspect → blocked with specific error

---

## 13. Sync status column in inventory table 📋

**Problem:** Inventory table shows SKU / Location / Price / Qty / Description / Date / Actions. No visual indicator of which items are synced with eBay, pending, or errored. User has no way to scan the table and spot "which items need attention."

**Changes:**

`public/app.html` table header (~line 165): add `<th>Status</th>` between Qty and Description.

`public/app.js` table row render (~line 640): add status cell with icon + color based on `item.ebaySync`:
- ✓ green — `ebaySync.status === 'synced'` and no pending update for this SKU
- ⏳ yellow — pending update exists (check `pendingSkus` set, loaded once per render)
- ⚠️ red — `ebaySync.status === 'error'` OR snapshot drift detected on last sync
- ○ gray — `!ebaySync.ebayItemId` (never synced, local-only)
- Tooltip on hover: last sync time + status text

Load `pendingSkus` once at render start: `const pendingSkus = new Set((await API.updates.getAll()).updates.map(u => u.sku))`.

Optional filter dropdown: "Show: All / Synced / Pending / Never synced / Errors". Reuses existing `#inventoryFilter` UI pattern.

**Test:** item with no eBay listing → gray circle · item synced 1 min ago → green check · item with queued price change → yellow hourglass · filter "Pending" → only yellow-icon rows

---

## 14. Low-stock warnings 📋

**Problem:** No way to know which items are about to sell out. eBay sales silently drop qty, if user doesn't look they won't restock in time. Missed sales from out-of-stock listings.

**Changes:**

`database.js`: add `lowStockThreshold: { type: Number, default: 1 }` to item schema (per-item override) + global default in `config.js` (`lowStockThreshold: 2`).

`server.js`:
- On any currentQty write, check against threshold. If crossing the line (above→at-or-below), emit a marker in history: `{ action: 'LOW_STOCK_ALERT', qty: currentQty, note: `Below threshold (${threshold})` }`.
- New endpoint `GET /api/inventory/low-stock?threshold=X` returns items where `currentQty <= threshold` (override takes precedence over global).

`public/app.js`:
- In inventory table: highlight rows with `currentQty <= lowStockThreshold` — yellow-tinted row background.
- Add dashboard-style badge on inventory tab button showing count: `Inventory (3 low)`. Updates on load.
- In item Lookup panel: if below threshold, show banner `⚠ Low stock: only 2 left`.

**Test:** item with qty=2, threshold=2 → row highlighted, tab badge shows count · qty drops to 1 after eBay sale → history entry, row highlighted · no sale over threshold → no alert.

---

## 15. Pending-updates expiration 📋

**Problem:** Pending updates never expire. User queues "change price from $100 to $120" and forgets. Two weeks later they apply it — but eBay's current price is $115 (someone changed it on eBay.com). Drift check (Point 1) catches this now, but only at apply time — user is surprised.

**Changes:**

`public/app.js` `Updates.render` (~line 1700):
- Add per-row age indicator: `⏱ 3 days ago` in gray, turn yellow if ≥7 days, red if ≥30 days.
- Add toggle at top of Updates tab: `( ) Show stale only (>7 days)` — filter client-side.
- Red-banner row for >30 days old: `⚠ Queued 45 days ago — eBay state likely drifted. Refresh or dismiss.`

`server.js`: no backend expiration — user decides. Just expose `createdAt` properly in `GET /api/updates` response (already stored by Mongoose timestamps, just needs to be returned).

Optional: "Refresh from eBay" button on a stale update → fetches current eBay state, updates the pending update's `oldValue` + `newValue` deltas, resets age timer. Reuses Point 1's `getCurrentListingState` helper.

**Test:** update 8 days old → yellow timer · 35 days old → red banner · click Refresh → oldValue becomes current eBay value, age resets.

---

## 16. Split monolithic server.js 📋

**Problem:** `server.js` is 3,390 lines with everything: routes, eBay API client, XML builders, auth, Mongo helpers. Grep finds 20 results, you have to read context on each to know which flow you're looking at. Future changes touch unrelated code accidentally.

**Changes:** extract by concern (not all at once — one extraction per commit).

Target structure:
```
server.js                    // bootstrap + middleware + mount routers (~150 lines)
config.js                    // exists, keep
database.js                  // exists, keep
lib/
  ebayClient.js              // ebayAPI object: auth, tokens, tradingApiCall (from Point 8), reviseItemPrice, addFixedPriceItem, uploadImage, getActiveListings, etc.
  ebayXml.js                 // XML builders + escapeXml (from Point 8)
  ebayLocks.js               // withEbayLock (from Point 2)
  errors.js                  // HttpError + ah wrapper (from Point 9)
  detectChanges.js           // from Point 5
routes/
  inventory.js               // /api/inventory/*, /api/lookup/*
  updates.js                 // /api/updates/*
  ebay.js                    // /api/ebay/*
  admin.js                   // /api/admin/*, /admin
  ebayAuth.js                // OAuth callback + reconnect
```

**Migration order:** do these AFTER Points 1, 2, 5, 8, 9 land (extractions are cleanest when the code is already deduplicated).

1. Extract `lib/errors.js` first (simplest, no circular deps)
2. Extract `lib/ebayLocks.js`
3. Extract `lib/detectChanges.js`
4. Extract `lib/ebayXml.js` + `lib/ebayClient.js` together (tightly coupled)
5. Extract route modules last — they depend on all the above

Each extraction = one commit. `server.js` shrinks progressively; each PR is easy to review.

**Test after each:** full sync flow works (pull, compare, push, apply one update) — confirms no import mistakes or circular deps.

---

## LAST. Consolidate eBay buttons — remove Pull + Compare 🔚

---

## 17. Sync button UX — 5-button explicit model 📋

**Decision:** Keep all 5 buttons. Each has a distinct directional meaning with safety rails. Industry standard for seller tools (Shopify, InkFrog, SellerCloud).

**Final layout on eBay tab:**
```
[Pull from eBay (Overwrite)]    — red/warning, rarely used
[Compare with eBay]             — primary color, daily driver
[Push Pending Updates]          — green
[eBay Sync]                     — blue, smart automation
[Publish New Listings]          — purple, separate purpose
```

**Per-button spec:**

**1. Pull from eBay (Overwrite)** — hard eBay-wins sync
- Endpoint: existing `/api/ebay/pull/:accountId` behavior, but gated
- Confirmation modal required: "X pending updates will be LOST. Continue?"
- ABORT if pending updates exist unless user checks "Force (I accept data loss)"
- Button label includes `(Overwrite)` so admin can't mistake it for Compare
- Use case: recovery / reset scenarios only

**2. Compare with eBay** — pulls + queues everything for review
- Endpoint: existing `/api/ebay/compare-and-queue/:accountId`
- eBay wins on conflict, but queues to Updates instead of applying
- No auto-writes to local currentQty/price
- Admin reviews each queued change and applies manually
- Default primary-color button (most common workflow)

**3. Push Pending Updates** — applies Updates queue to eBay
- Reuses Apply All logic from Point 11
- Rename from "Push to eBay" to make it unambiguous
- Shortcut for Updates tab → Apply All, from eBay tab
- Each update goes through Point 1's drift check

**4. eBay Sync** — smart two-way
- Endpoint: existing `/api/ebay/sync-all/:accountId`
- Existing logic already good after Point 3 changes:
  - eBay qty dropped → auto-apply as sale, log `EBAY_SALE`
  - Everything else → queue to Updates
  - Local has pending → skip (admin's Apply handles drift)

**5. Publish New Listings** — unchanged from current
- Creates eBay listings for items with no `ebayItemId`
- Uses `addFixedPriceItem` (Trading API)
- Separate purpose from sync

**Cross-cutting (all 5 buttons):**
- All wrapped in `withEbayLock` (Point 2)
- All respect 2s click cooldown + wait-for-eBay-response before re-enabling
- All fail-fast on 409 "Sync in progress" with clear message
- All show loading state while running

**Frontend changes (`public/app.html`, `public/app.js`):**
- HTML: reorder buttons to match layout above, update labels + colors, add confirmation modal for Pull
- JS: `eBay.pull()` gets confirmation gate + pending-updates check
- JS: rename `eBay.push()` handler messaging to say "Pending updates pushed" / "Nothing to push"

**Test:**
- Pull with no pending → confirm → overwrites local · Pull with 3 pending → modal warns · Force-Pull with 3 pending → proceeds, 3 lost
- Compare → 0 local writes, N queued in Updates
- Push with 5 pending → all 5 applied via Point 1 drift check
- Sync with 1 sale + 1 eBay price edit → sale auto-applied, price queued
- Publish creates listings for SKUs without ebayItemId, skips ones with it
- Double-click any button → second click = 409 from lock

---
