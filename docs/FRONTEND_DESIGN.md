# DBase — Frontend Design Document

**Status:** v7, single-pass initial design — matching APPLICATION_DESIGN.md's own framing of itself (§2 there): not claiming DESIGN.md's six-pass adversarial rigor, but following its "state the rationale, state the rejected alternative" discipline throughout. See §9 (Revision History) for the full per-version changelog, moved out of this status line starting v6 to keep it from growing unboundedly here. Should still get a fresh-eyes review pass before implementation begins in earnest, the same way APPLICATION_DESIGN.md flags for itself.
**Related docs:** [REQUIREMENTS.md](./REQUIREMENTS.md) (product requirements this client must satisfy), [APPLICATION_DESIGN.md](./APPLICATION_DESIGN.md) (the API this client consumes — §4 there is this document's primary input)
**Scope:** Client application architecture — routing, state management, the API client layer, auth handling, and a page/route inventory mapped to REQUIREMENTS.md §5's capabilities. **Explicitly architecture-only, not visual design** (system-owner decision) — no mockups, no styling decisions beyond the component-library choice in §3, no color/typography system. If visual design is wanted later, it's a separate, dedicated effort (a design tool, not an extension of this document).

---

## 1. Purpose and goals

APPLICATION_DESIGN.md defines the API surface (§4 there) and deliberately excludes the client that consumes it (§1.2: *"No frontend/client design... the API contract a client consumes, not the client itself"*). This document fills that gap: given that API and REQUIREMENTS.md §5's product capabilities, what does the actual client application look like — what pages exist, how is state managed, how does the browser authenticate against `httpOnly` session cookies, and how is the whole thing built and deployed.

### 1.1 Explicit non-goals

- **No visual/UI design.** Owner-confirmed scope: this document covers architecture (routes, state, data flow) only. Screen-level layout, styling, and interaction polish are deferred to whichever design process picks this up next — this document should make that process's job easier (clear page inventory, clear data each page needs) without pre-empting it.
- **No native mobile app.** Owner-confirmed: one responsive web app serves both desktop and mobile browsers — REQUIREMENTS.md §3 doesn't require a native app, and APPLICATION_DESIGN.md §1.2 already excludes a documented third-party API that a separate native client would need.
- **No re-litigating the API contract.** If APPLICATION_DESIGN.md says an endpoint returns a given shape or error code, this document consumes that as given, the same discipline APPLICATION_DESIGN.md itself applies to DESIGN.md (§1.2 there).
- **No CI/CD, hosting-provider, or build-pipeline specifics** beyond stating what needs to be deployed (§7) — same boundary APPLICATION_DESIGN.md draws for the backend (§1.2 there).

---

## 2. Design process

Every decision below states its rationale and, where a real alternative existed, why it was rejected — matching APPLICATION_DESIGN.md §2's own stated discipline (itself matching DESIGN.md's). Four decisions were owner-specified up front and are treated as settled inputs, not re-derived: responsive web only (no native app), Next.js as the framework, architecture-only scope (no visual design), and shadcn/ui + Radix as the component approach. Everything else below is this document's own reasoning, flagged as such.

---

## 3. Technology assumptions

- **Framework: Next.js, App Router.** Owner-specified framework; App Router (not Pages Router) is this document's own addition — it's the actively-developed router as of Next's current major versions, and its server/client component split maps naturally onto this app's actual data-sensitivity split (§5 below elaborates: most of this app's screens are behind auth and inherently request-time/user-specific, which pushes most components to the client anyway, but a few genuinely static shells — the marketing-free login/register pages — benefit from server rendering).
- **Language: TypeScript**, matching the backend (APPLICATION_DESIGN.md §1.3's stack-unification reasoning applies identically here — request/response shapes can be shared as types between server and client, see §4.3 below).
- **Styling: Tailwind CSS.** Not independently chosen — it's a hard dependency of the owner-specified shadcn/ui, whose components are Tailwind utility classes copied into the project (not an installed component library in the traditional sense — see below).
- **Component approach: shadcn/ui + Radix primitives** (owner-specified). Concretely, this means: Radix provides unstyled, accessible behavior (dialogs, dropdowns, tooltips — all of which this app needs heavily: the sharing dialog, the context menus on files/folders, the admin action confirmations); shadcn/ui provides Tailwind-styled wrappers around those primitives that are copied into the codebase (`src/components/ui/`) rather than installed as an opaque `node_modules` dependency, which matters here specifically because it means every component is locally editable without fighting an upstream library's API — a reasonable fit given this document's architecture-only scope still needs *some* concrete components to build real pages against, even without a visual design pass.
- **Data fetching / server state: TanStack Query (React Query).** Not owner-specified; this document's own choice. Rejected alternative: hand-rolled `fetch` + `useState`/`useEffect` per page. TanStack Query is chosen because this app's data has exactly the shape it's built for — server-owned state (folder contents, permissions, quota) that multiple components need to read, that must be invalidated precisely on specific mutations (REQUIREMENTS.md §5.5's "revocation must be enforced on the very next access attempt" — see §6.3 below for how this maps to cache invalidation), and that benefits from request deduplication (a folder-contents fetch triggered by both a page load and a "just uploaded" refresh shouldn't double-fetch). Also directly solves the pagination story: REQUIREMENTS.md §5.11 requires cursor-based pagination on every unbounded listing (APPLICATION_DESIGN.md §4.1), and TanStack Query's `useInfiniteQuery` is built for exactly the opaque-cursor pattern APPLICATION_DESIGN.md already committed to.
- **Client/UI state: React state + context, no global state library.** Rejected: Redux/Zustand/Jotai. This app has very little state that isn't either server state (→ TanStack Query, above) or genuinely local to one component subtree (a dialog's open/closed state, a multi-select selection set scoped to one folder view) — REQUIREMENTS.md's feature set doesn't describe any cross-cutting client-only state (no offline mode, no complex undo stack) that would justify a global store's overhead. Revisit if that changes.
- **API client: a thin typed wrapper over `fetch`**, not a generated client. See §4.3.
- **Deployment: a separate Next.js process from the Fastify API**, reverse-proxying API calls — see §7 for why, and why this is load-bearing for auth, not just a deployment-topology footnote.

---

## 4. Application structure

### 4.1 Directory layout

```
app/
  (auth)/
    login/page.tsx
    register/page.tsx
    password-reset/
      request/page.tsx
      confirm/page.tsx
  (app)/                        -- authenticated shell, layout enforces session
    layout.tsx                  -- sidebar nav, quota indicator, current-user menu
    folders/[folderId]/page.tsx -- folder browser (root: folders/page.tsx)
    search/page.tsx
    shared-with-me/page.tsx
    favorites/page.tsx
    trash/page.tsx
    settings/
      sessions/page.tsx          -- "manage your devices" (REQUIREMENTS.md §5.1)
      account/page.tsx           -- self-service account deletion (REQUIREMENTS.md §5.1.1)
    admin/
      layout.tsx                 -- admin-role gate, separate from the (app) auth gate
      users/page.tsx               -- includes deactivate/reactivate/delete actions per user row (REQUIREMENTS.md §5.10)
      users/[userId]/page.tsx      -- browse another user's files only, no admin actions here (REQUIREMENTS.md §5.10)
      stats/page.tsx
      activity/page.tsx
      failed-jobs/page.tsx
  s/[token]/page.tsx             -- public share-link landing (unauthenticated, outside (app))
next.config.js                   -- `rewrites()` reverse-proxies /api/v1/* to the Fastify backend, see §7
Dockerfile                       -- standalone-output image, see §7
components/
  ui/                            -- shadcn/ui components, copied in and locally editable
  files/                         -- file/folder list rows, upload dropzone, thumbnail preview
    upload-tray.tsx              -- bottom-right toast tray, §8 item 2
  sharing/                       -- share dialog, permission picker, public-link management
  tags/                          -- tag picker/creator, tag chips on file/folder rows (REQUIREMENTS.md §5.8)
  admin/                         -- admin-only widgets (user table, stats cards)
lib/
  api-client.ts                  -- §4.3
  query-keys.ts                  -- §6.3
  auth.tsx                       -- current-user context/hook, session-expired handling
  uploads.tsx                    -- upload state/chunked-upload driver backing the toast tray, §8 item 2
```

**Route-group rationale:** `(auth)` and `(app)` are Next.js route groups (no URL segment) specifically so the two have independent layouts with independent auth gating — `(auth)`'s layout redirects *away* if already logged in, `(app)`'s layout redirects *to* login if not, and neither shares a parent layout that would force one gating rule to awkwardly cover both cases. `admin/` is nested inside `(app)` (still requires a normal session) but adds its own role check in `admin/layout.tsx`, mirroring the backend's own layering — APPLICATION_DESIGN.md §3.2 treats `admin` as a thin layer calling into other modules with a bypass flag, not a separately-authenticated surface, and the frontend copies that shape rather than inventing a separate admin auth flow.

**Both gates run client-side, which §5's "login/register are server components" claim must be read alongside, not against:** §6.2's `AuthProvider` is the only auth-check mechanism this document defines, and it resolves via a client-side `GET /auth/me` call — there is no server-side session check anywhere in this design (no middleware, no server-component cookie read). So `(auth)`'s "redirects away if already logged in" and `(app)`'s "redirects to login if not" both happen after the client mounts and `AuthProvider` resolves, not before the page renders. Concretely: `/login` and `/register` are server components in the sense that their markup has no user-specific data to server-render (§5's actual point), but the redirect-away check itself is client-side, meaning an already-logged-in user's browser will briefly render the login form before `AuthProvider` resolves and redirects them away — a real, if minor, flash-of-wrong-content this document should not leave implied away. Closing this gap with server-side session checking (Next.js middleware reading the cookie, or a server-side `GET /auth/me` call in each gated layout) is a legitimate alternative not adopted here — rejected because it would require the middleware/server layer to talk to the Fastify backend on every navigation rather than relying on `AuthProvider`'s already-cached client-side result, adding latency to prevent a cosmetic flash rather than a security gap (the actual page data is still gated by the API's own 401s regardless of what the client renders first). Noted here explicitly since it's the kind of inconsistency a reader could otherwise misread as this document not tracking its own auth model.

### 4.2 Page inventory, mapped to REQUIREMENTS.md §5

| Route | REQUIREMENTS.md capability | Primary API calls (APPLICATION_DESIGN.md §4) |
|---|---|---|
| `/login`, `/register` | §5.1 accounts | `POST /auth/login`, `POST /auth/register` |
| `/password-reset/request`, `/confirm` | §5.1 password reset | `POST /auth/password-reset/request`, `/confirm` |
| `/folders/[folderId]` | §5.2, §5.3, §5.11 (browse, create, rename, move, sort, upload, download, delete) | `GET /folders/:id/contents`, `POST /folders`, `PATCH /folders/:id`, `PATCH /files/:id`, `DELETE /folders/:id`, `DELETE /files/:id`, `POST /files` + part/complete/cancel upload-session endpoints (§5.3 below), `GET /files/:id/download` — the upload/download/delete calls were missing from v5's table despite the upload dropzone already being named in §4.1's component tree (`components/files/`), corrected here |
| `/search` | §5.3 name search | `GET /search` |
| `/shared-with-me` | §5.5 | `GET /shared-with-me` |
| `/favorites` | §5.7 | `GET /favorites` |
| `/trash` | §5.4 | `GET /trash`, `POST /trash/:type/:id/restore`, `DELETE /trash/:type/:id` |
| `/settings/sessions` | §5.1 (log out individual devices without affecting others) | `GET /auth/sessions`, `DELETE /auth/sessions/:sessionId` — missing from v1's page inventory even though APPLICATION_DESIGN.md §4.2 built these two endpoints specifically "to power a 'manage your devices' UI"; added here to close that gap |
| `/settings/account` | §5.1.1 self-service account deletion | `DELETE /api/v1/users/me` — the one capability in REQUIREMENTS.md §5 that had a backing endpoint (§4.6) but no route anywhere in v1; a destructive, irreversible action (§5.1.1: "cannot be undone"), so this page requires its own explicit confirmation step, not a context-menu action like the rest of the app's destructive operations (trash) which are reversible |
| `/s/[token]` | §5.5 public share links | `GET /public/share-links/:token` — the one route outside the authenticated shell entirely, since REQUIREMENTS.md §5.5 requires access "without requiring an account" |
| `/admin/users` | §5.10 (list, quota/role change, deactivate/reactivate, delete) | `GET /admin/users`, `PATCH /admin/users/:id/quota`, `PATCH /admin/users/:id/role`, `POST /admin/users/:id/deactivate`, `POST /admin/users/:id/reactivate`, `DELETE /admin/users/:id` — the last of these is distinct from `DELETE /api/v1/users/me` (self-service, `/settings/account` above); v3 added self-service deletion's route but missed this admin-initiated counterpart, closed here. Like `/settings/account`, admin-initiated deletion is irreversible (REQUIREMENTS.md §5.1.1) and needs its own explicit confirmation step, not a bare row-menu action — and per §5.1.1 an admin may optionally supply `replacementOwners` here rather than being forced to the default reassignment policy, which is the one shape difference from the self-service flow. **Action placement, stated explicitly rather than left for the reader to infer:** quota/role/deactivate/reactivate/delete are row-level actions on this list page; `/admin/users/[userId]` below is browse-only and does not duplicate them |
| `/admin/users/[userId]` | §5.10 (admin browsing another user's files — logs `view`) | `GET /admin/users/:id/files` — browse-only, see the action-placement note on `/admin/users` above |
| `/admin/stats` | §5.10 | `GET /admin/stats` |
| `/admin/activity` | §5.10, §5.13 | `GET /admin/activity` |
| `/admin/failed-jobs` | operational (DESIGN.md §3.10) | `GET /admin/failed-jobs` |

Not a distinct route, but present in the `(app)` shell layout on every page: the storage quota indicator (REQUIREMENTS.md §5.6) and the sharing dialog (invoked from a file/folder's context menu, not its own page — REQUIREMENTS.md §5.5's grant/link/revoke actions). **Tags (REQUIREMENTS.md §5.8) follow the same pattern and were missing from v5's inventory entirely** — `POST /api/v1/tags` (create), `POST`/`DELETE /api/v1/items/:type/:id/tags/:tagId` (apply/remove) are invoked from a tag picker on a file/folder's context menu, the same surface as the sharing dialog, not a standalone page; tag chips render inline on file/folder rows in `components/files/`. No dedicated `/tags` route is needed since REQUIREMENTS.md §5.8 describes tags as a per-item label, not a browsable collection with its own listing view.

### 4.3 API client layer

A single `lib/api-client.ts` module wraps `fetch`, and is the *only* place in the frontend that constructs a request to the backend — mirroring APPLICATION_DESIGN.md §3.3's "one shared access-check function" discipline on the backend (there for authorization; here for the same reason APPLICATION_DESIGN.md gives for centralizing anything: a forgotten detail on one call site becomes a systemic gap). Concretely it owns:

- Attaching `credentials: "include"` on every request (required for the `httpOnly` session cookie to be sent — see §7 for why this alone isn't sufficient without the reverse proxy).
- Parsing the `{ error: { code, message } }` envelope (APPLICATION_DESIGN.md §4.1) into a typed `ApiError` the rest of the app can `catch` and branch on `error.code`. REQUIREMENTS.md §5.12 requires distinguishing at minimum `QUOTA_EXCEEDED` from `INSUFFICIENT_PERMISSION` with a specific reason, not a generic toast — both must be handled explicitly, not just the quota half. The `error.code` union type mirrors every code APPLICATION_DESIGN.md §4.1 enumerates, since each maps to a distinct, expected UI state rather than a fallback: `QUOTA_EXCEEDED` (upgrade-quota prompt), `INSUFFICIENT_PERMISSION` (permission-denied message, distinct wording from quota per §5.12), `NAME_COLLISION` (inline rename/move conflict, REQUIREMENTS.md §5.2/§5.3's "never silently overwrite" rule), `PATH_TOO_LONG`/`NAME_TOO_LONG` (the 4096-byte/255-byte limits, REQUIREMENTS.md §5.2), and `CYCLE_DETECTED` (the folder-move-into-itself rejection, REQUIREMENTS.md §5.2). Any `error.code` this union doesn't recognize falls back to the generic toast — the union is the known set, not an exhaustive compile-time guarantee against the backend adding a new code.
- A single 401-handling path: any response with `error.code === "UNAUTHENTICATED"` clears the client-side auth-context user and redirects to `/login` — not duplicated per call site.
- A single 429-handling path: any response with `error.code === "RATE_LIMITED"` (APPLICATION_DESIGN.md §4.7, added after this document's initial error-handling pass — closing that gap here) reads the `Retry-After` header and surfaces a specific "slow down" state rather than a generic failure toast, matching the same error-code-not-just-message discipline already applied to `QUOTA_EXCEEDED` above. This matters most for the write-heavy endpoint class (folder/file create, move, share, tag — 60 req/min/user per APPLICATION_DESIGN.md §4.7's table), which a legitimate bulk action (multi-select move or tag-apply across many items) can plausibly hit. The architectural requirement this document does own: a 429 on one mutation in a batch must not be treated as fatal to the whole batch — the per-mutation `ApiError` with `code === "RATE_LIMITED"` must be catchable independently per call site, same as any other `ApiError`. Exactly how that surfaces visually (a per-item retry indicator, a paused-batch banner, etc.) is UI/interaction design, not this section's call — noted here only so the underlying data/error-handling contract (independently catchable per-mutation errors, `Retry-After` exposed on the typed error) exists for whatever visual-design pass (§1.1) eventually decides the presentation. The client does not implement automatic retry-on-429 itself (no background retry loop) — it surfaces `Retry-After` to the user/UI and leaves the retry decision to whatever triggered the action.
- Request/response types **hand-written to match APPLICATION_DESIGN.md §4's documented shapes**, not generated from an OpenAPI spec. Rejected alternative: generate types from a schema. APPLICATION_DESIGN.md §4.1 explicitly states the API is "not a formally documented/versioned public API" with no OpenAPI/JSON-Schema-as-contract artifact currently produced — generating types would mean standing up that artifact first, which is out of scope here; hand-written types are the pragmatic match for the API's actual current state, revisit if a formal schema is ever produced (REQUIREMENTS.md §8's deferred "documented public API").

---

## 5. Rendering strategy: client components by default

Next.js App Router's headline feature is server components, but this app pushes almost everything to client components, and that's a deliberate reversal worth stating explicitly rather than leaving implicit:

- Every authenticated page's data (folder contents, permissions, quota, trash, activity) is per-user, request-time, and frequently mutated by the same session that's viewing it (rename a file, see it update; revoke a share, see it disappear) — exactly TanStack Query's domain (§3), which needs a client component to run in the browser and hold a live cache. Server-rendering this data would mean re-fetching it again on the client anyway to get TanStack Query's caching/invalidation benefits, so server-rendering it first adds a round-trip without removing one.
- The two genuine exceptions — `/login` and `/register` — **are** server components (or as close to it as the form interactivity allows, client-only for the form itself): no user-specific data to fetch, and correctly benefit from Next's static/server rendering.
- `/s/[token]` (public share links) is a partial exception: the initial "does this token/password check out" resolution could be server-rendered, but the file browsing *within* the shared folder behaves identically to the authenticated file browser (§4.2) and reuses those same client components — server-rendering only the entry point, not the browsing experience within it.

This is flagged as its own section because it's a common Next.js mistake to reach for server components by default and then fight the framework once real-time-ish, session-scoped data shows up — stating the reversal up front avoids that.

---

## 6. Auth and session handling

### 6.1 No client-side token storage

The `httpOnly` cookie (APPLICATION_DESIGN.md §4.1) is, by design, invisible to JavaScript — the frontend never reads, stores, or attaches the session token itself. This is a constraint the frontend must design around, not work around: no `localStorage`/`sessionStorage` token duplication, which would reintroduce exactly the XSS-exposure risk `httpOnly` was chosen to avoid.

**Scope note, since §8 item 2's resumable-upload gap raises the question this section would otherwise leave ambiguous:** the "no client-side storage" rule above is about the session token specifically, not a blanket ban on all client-side persistence. Resuming a multipart upload across a browser refresh (REQUIREMENTS.md §5.3) requires the client to rediscover an in-flight `UPLOAD_SESSIONS` id after a refresh, which nothing in React state alone survives — that id is the one thing this app's frontend does need to persist in `localStorage`. The id alone is sufficient: the server already keys the session by it and carries `target_folder_id`/`target_name` itself (APPLICATION_DESIGN.md §4.3), and every part/complete call re-verifies the destination server-side regardless (REQUIREMENTS.md §5.3's concurrent-mutation guard) — so there's no need to duplicate destination folder/filename in `localStorage` alongside the id. This is not a security-sensitive value the way the session cookie is (it's an opaque session identifier already scoped to the authenticated user server-side, not a credential), so persisting it doesn't reopen the XSS concern the httpOnly cookie exists to avoid. The full resumable-upload UI/progress model is still an open item (§8 item 2) — this note only resolves the narrower "does this contradict §6.1" question, not the UI design itself.

### 6.2 Current-user context

A `lib/auth.ts` React context (`AuthProvider`), populated once at the `(app)` layout's root via `GET /api/v1/auth/me` — **resolved, no longer an open item**: this endpoint didn't exist when this document was first drafted (`GET /api/v1/auth/sessions` returns a user's session list, not a "current user" shape, and nothing else on APPLICATION_DESIGN.md §4.2's table returned the logged-in user's own profile directly), so it was added there specifically to close this gap. `AuthProvider` calls it once on mount; a 401 response means no valid session, which routes to `/login` the same way any other 401 does (§4.3).

### 6.3 Cache invalidation and REQUIREMENTS.md's "no delay window" rule

REQUIREMENTS.md §5.5 and §6 both require revocation (direct share, folder share, public link, account deactivation) to be enforced "on the very next access attempt... no acceptable delay." This is a backend-authoritative guarantee already (APPLICATION_DESIGN.md §3.3's synchronous-fallback access check) — the frontend's job is narrower and different: not to *enforce* it (it can't; the backend already does), but to make sure its own TanStack Query cache doesn't show a stale "still shared" state after the *acting* user's own revoke action, which is a UX correctness issue even though it's not the security-relevant guarantee. Concretely: every mutation in `lib/query-keys.ts` declares which query keys it invalidates (a share revoke invalidates that item's permission list and the affected user's `shared-with-me` query if currently viewed as that user in an admin context; a move invalidates both the source and destination folder-contents queries). This list is maintained by hand alongside each mutation, the same "no forgotten call site" discipline as §4.3 — not derived automatically, since TanStack Query has no way to know which server-side relationships a given mutation affects.

---

## 7. Deployment topology and the reverse-proxy decision

**Owner decision: hosted on a single Ubuntu server, Docker wherever possible; MinIO also runs as a container.** This app and the Fastify backend (APPLICATION_DESIGN.md §8) are two separate Docker images (`web/Dockerfile` here, the root `Dockerfile` for the backend), orchestrated together with MinIO by one `docker-compose.yml` at the repo root. This section previously described the topology as "two processes" in the abstract; it's now the concrete containerized shape, verified by actually building both images and bringing the full stack up together (all three long-running containers, plus a one-shot `minio-init` that creates the app's bucket) — not just designed on paper. APPLICATION_DESIGN.md §8.1 has the backend-side account of the same topology; this section owns the frontend-specific detail.

**Reverse-proxying `/api/v1/*` to the Fastify backend via `next.config.js` `rewrites()`** so the browser only ever talks to one origin — still the mechanism, unchanged from the original decision. This is specifically a `rewrites()` config entry, not a hand-written Route Handler (`app/api/[...path]/route.ts`) that manually forwards the request — a Route Handler would need to explicitly re-forward the `Cookie` header and every other relevant header on both the outbound proxy call and the response, and a forgotten header there would silently reopen the auth gap this section exists to close; `rewrites()` is a transparent edge-level proxy that passes the request through unmodified, including cookies, by construction, matching this section's "load-bearing, not a convenience" framing below.

**A real bug in this mechanism, found only by running the built Docker containers, not by reasoning about the config on paper:** `next.config.js`'s `rewrites()` function is evaluated once at `next build` time to produce Next's routes manifest — it is **not** re-read per-request, or even once per process start, at runtime. The rewrite destination (`BACKEND_URL`, used to route `/api/v1/*` to the backend) was originally read via `process.env.BACKEND_URL` inside `rewrites()` on the assumption that Next re-executes `next.config.js` when the standalone server starts. That assumption was wrong for the specific config keys (`rewrites`, `redirects`, `headers`) that get compiled into a static manifest at build time. Concretely: the frontend container's own environment correctly showed `BACKEND_URL=http://backend:3000` (confirmed via `docker exec ... printenv`), yet every proxied request still failed with `ECONNREFUSED 127.0.0.1:3000` — the value baked in at whatever `next build` was run with (a bare `localhost:3000` default, since the image had been built without `BACKEND_URL` set at build time). **Fix: `BACKEND_URL` is now a Docker build argument** (`web/Dockerfile`'s `ARG BACKEND_URL=http://backend:3000`, set explicitly in `docker-compose.yml`'s `build.args`), not a runtime environment variable — the frontend image is therefore built specific to this compose topology (it always expects the backend reachable at `backend:3000`), which is acceptable since it is always deployed via this same `docker-compose.yml`, never repurposed across differently-shaped deployments. Local (non-Docker) development is unaffected — `next dev` doesn't freeze `rewrites()` into a build-time manifest the same way, so `.env.local`'s `BACKEND_URL` continues to work there exactly as before.

**Why this is load-bearing, not a convenience:** the session cookie is `SameSite=Lax` (APPLICATION_DESIGN.md §4.1). Browsers do send `SameSite=Lax` cookies on top-level cross-site *navigations*, but **not** on cross-site `fetch`/`XHR` calls — which is exactly how this frontend talks to the API. If Next.js and Fastify were deployed on different origins (different ports count — `localhost:3000` and `localhost:3001` are different origins) and the frontend called the API directly, the browser would silently drop the session cookie on every API call, and every authenticated request would 401 regardless of how correctly `credentials: "include"` is set client-side — `credentials: "include"` controls whether the browser *is willing* to send cookies cross-site, not whether `SameSite=Lax` *allows* it to. Reverse-proxying through Next.js's own origin makes every request the browser sees same-origin, sidestepping this entirely without touching the backend's existing cookie design (APPLICATION_DESIGN.md's chosen `SameSite=Lax` over `None` was itself a deliberate, reasonable choice — `None` would work too but requires `Secure` and reopens CSRF questions `Lax` avoids for a same-origin deployment; no reason to force that tradeoff just to solve a topology problem that has a cleaner fix).

**Rejected alternative: `SameSite=None`.** Would work without a reverse proxy, but weakens the existing cookie's CSRF posture for no benefit — the reverse proxy achieves the same functional outcome (frontend can call the API) without that tradeoff, so there's no reason to relax a deliberate backend security decision to solve a frontend deployment-topology problem.

**Rejected alternative: separately-authenticated frontend (its own login talking to Supabase Auth or similar).** Out of scope for the same reason APPLICATION_DESIGN.md §1.3 gives for not using Supabase Auth at all — this app has one custom auth model (USERS/SESSIONS), and the frontend consumes it, it doesn't stand up a second one.

**Cross-document seam worth flagging, not this document's to resolve alone:** APPLICATION_DESIGN.md §4.7's unauthenticated-endpoint rate limiting is keyed on source IP. Once every request is reverse-proxied through the Next.js origin (this section), Fastify sees the proxy's own connection as the request source unless the proxy forwards the real client IP (`X-Forwarded-For` or equivalent) and Fastify is configured to trust and read it — otherwise every user behind this frontend collapses onto one IP for rate-limiting purposes on `/auth/register`, `/auth/login`, and `/auth/password-reset/request`. This is a detail in the seam between this document's proxy topology and APPLICATION_DESIGN.md §4.7's keying design, not fully owned by either document as currently scoped — noted here so it isn't lost.

---

## 8. Open items

Mirroring DESIGN.md §7 / APPLICATION_DESIGN.md §10's pattern of surfacing what's genuinely unresolved rather than glossing over it. Items 1, 2, and 3 below are **resolved, owner-decided**, kept here (not deleted) so the reasoning stays visible rather than silently vanishing once decided — matching how DESIGN.md §7 retains resolved items with a strikethrough/superseded note rather than removing them outright.

1. ~~No "current user" endpoint exists yet~~ — **Resolved.** `GET /api/v1/auth/me` added to APPLICATION_DESIGN.md §4.2; §6.2 above updated accordingly.
2. ~~Multipart upload UI/progress model~~ — **Resolved: a bottom-right toast tray, one entry per in-flight upload, with pause/resume/cancel buttons per entry.** Owner-decided. Implemented in `lib/uploads.tsx` (`UploadProvider`/`useUploads`, chunked upload driver against the multipart endpoints APPLICATION_DESIGN.md §4.3 documents) and `components/files/upload-tray.tsx` (the visual tray), mounted inside `(app)/layout.tsx` so it persists across navigation within the authenticated shell. §6.1's persisted-upload-session-id-in-`localStorage` note is implemented (each task's id is written on session creation) but not yet consumed — rediscovering and offering to resume an in-flight upload after a page refresh is not wired up, only the write side is. Every upload attempted against this scaffold currently surfaces a real error (the multipart endpoints aren't implemented yet, Subcomponent 1) rather than a faked progress bar — same honest-about-what-doesn't-exist-yet pattern as the rest of this scaffold's non-auth pages.
3. ~~Real-time-ish updates~~ — **Resolved: none, for now.** Owner-confirmed — matches REQUIREMENTS.md's non-goals (§3 there, no live-collaboration requirement) and this document's existing default. Revisit only if a concrete requirement for live updates emerges later; not implied by anything else in this document.
4. ~~The visual design pass itself~~ (§1.1) — **Resolved: skipped for now.** Owner-confirmed — continue building on the architecture in this document alone; no dedicated design-tool pass or rough-UI-description pass has been started. Revisit once there's enough of the app built that a visual pass has something concrete to work from.

---

## 9. Revision History

Moved out of the status line (§ top of document) starting v6, per that section's own note, so the changelog doesn't keep growing inline there.

- **v1:** Initial single-pass draft.
- **v2:** Three owner decisions resolved from v1's open items (§8): `GET /api/v1/auth/me` gap resolved (added to APPLICATION_DESIGN.md, §6.2); no real-time/live-update mechanism in scope; visual design pass deliberately deferred.
- **v3:** Closed gaps found reviewing against APPLICATION_DESIGN.md/REQUIREMENTS.md: added `/settings/sessions` (device management, REQUIREMENTS.md §5.1) and `/settings/account` (self-service deletion, §5.1.1) routes that had backing endpoints but no page; added 429/`RATE_LIMITED` handling to the API client (§4.3) for APPLICATION_DESIGN.md §4.7's rate limiting; clarified §6.1's "no client-side storage" rule doesn't block the resumable-upload session id; flagged (unresolved) the rate-limiter IP-keying seam once traffic is reverse-proxied (§7).
- **v4:** Added admin-initiated deactivate/reactivate/delete actions to `/admin/users` (§4.2), symmetric with v3's self-service counterpart; trimmed §6.1's resumable-upload note (session id alone suffices, no need to duplicate destination folder/filename client-side); narrowed §4.3's 429 note to the data contract this document actually owns rather than prescribing bulk-operation UI.
- **v5:** Cosmetic — §4.1 directory-tree alignment; §4.2 states explicitly that `/admin/users`' row-level actions and `/admin/users/[userId]`'s browse-only purpose don't overlap.
- **v6:** Independent fresh-eyes review surfaced five defects the prior five rounds' narrower focus had missed: (1) §4.1 showed the reverse proxy as a hand-written Route Handler while §7 described a `next.config.js` rewrite — a real inconsistency, since only the rewrite approach transparently forwards cookies by construction; corrected §4.1 and expanded §7's rationale. (2) §5's "login/register are server components" claim was never reconciled with §6.2's client-only `AuthProvider` being the sole auth-check mechanism — added a note to §4.1's route-group rationale acknowledging the resulting flash-of-wrong-content and why server-side session checking wasn't adopted to close it. (3) The `/folders/[folderId]` page-inventory row omitted upload, download, and delete API calls despite the upload dropzone already being named in the component tree — added. (4) §4.3's typed `ApiError.code` union only named three example codes, omitting `INSUFFICIENT_PERMISSION` (the other half of REQUIREMENTS.md §5.12's explicit minimum requirement) plus `NAME_COLLISION`/`PATH_TOO_LONG`/`NAME_TOO_LONG`/`CYCLE_DETECTED` — expanded to the full set APPLICATION_DESIGN.md §4.1 enumerates. (5) REQUIREMENTS.md §5.8 (Tags) had no page, component, or API-call coverage anywhere in the document despite full CRUD endpoints existing in APPLICATION_DESIGN.md §4.5 — added a `components/tags/` entry and a note in §4.2 explaining tags live in the same context-menu pattern as sharing, not a standalone route.
- **v7:** Two owner decisions, both implemented and verified against running code, not just documented: (1) §8 item 2's multipart upload UI resolved as a bottom-right toast tray with pause/resume/cancel — implemented (`lib/uploads.tsx`, `components/files/upload-tray.tsx`), wired into `(app)/layout.tsx`. (2) §7 revised from an abstract "two processes" framing to the actual Docker-on-Ubuntu topology (owner decision — backend, frontend, and MinIO each their own container via one `docker-compose.yml`), which surfaced a real bug only found by building and running the containers: `next.config.js`'s `rewrites()` bakes its backend URL in at `next build` time, not runtime, so the originally-documented "set `BACKEND_URL` via the environment" approach silently did nothing in a container — the requesting proxy kept hitting `localhost:3000` despite the container's own environment being correct. Fixed by making it a Docker build argument instead; full account in §7. Also added the storage-quota indicator's actual data source (`GET /users/me/storage`, an owner-decided separate route from `/auth/me`, added to APPLICATION_DESIGN.md) to `(app)/layout.tsx`, closing what had been a TODO placeholder.

---

*This document assumes REQUIREMENTS.md and APPLICATION_DESIGN.md as settled source-of-truth and does not re-derive any product or API decision made there — it only adds the layer of how the client consuming that API is built.*
