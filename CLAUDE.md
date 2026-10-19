# tryconnect — notes for Claude Code

This app runs on **Homeroom**. The platform conventions are the single
source of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.):

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

**Inside Homeroom** (its dev chat, and Homeroom bot's builds), do not
fetch that URL: what applies to your change is already in your
instructions, and the `homeroom` MCP server's
`get_platform_conventions` reads any one section of the conventions
when you need it. The two sections below are for working outside
Homeroom; skip them there.

**Anywhere else** (Claude Code run against this repo locally, or another
harness), fetch it at the start of each session. The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

## Connector permission prompts (outside Homeroom)

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) once you accept the workspace trust dialog.
See `.claude/README.md` for the whole story, including what to do if you
are still being prompted.

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom (its dev
chat, and Homeroom bot's builds) the platform fixes the base commit, and none
of this applies.

## Starter template

The screen this app currently ships — the "Starter template" hero with
the app's thumbnail tile and the plain-English note on how the app gets
built (by asking Homeroom bot) — is placeholder content from the
Homeroom starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the `usernode-starter-notice@1` block in `public/index.html`
  (both sentinel comments and everything between them),
- rewrite `README.md` to describe the actual app.

Keep the `usernode-dev-console@1` forwarder `<script>` when rewriting the
HTML — that block is platform infrastructure, not template content. So is
the bridge `<script>`. The design kit is not placeholder either: build the
real app with it, and fill in "## Design" below.

The screen has a light and a dark look and follows the viewer's Homeroom
theme, switching live when they change it: the theme `<script>` right after
the bridge tag sets a `dark` class on `<html>`. Keep that script, and give
everything you build both looks (the design kit's colour tokens carry both), unless one
fixed look is the point of this app, like a game's own scene; then say so
under "## Design" below. Unless a request asks for one, add
no theme picker: the viewer's Homeroom setting is the control. "The
platform's light/dark theme inside the app frame" in the platform
conventions has the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About tryconnect

Temukan zona dan lokasi terbaik untuk mencari cuan. One list of places
where people can earn extra money, nearest first; each place is tagged
with a ready-made kind of cuan (Makanan, Ojek, Jualan, Jasa). Any member
can add a place, open it, report one they did not add, or remove one they
added. Guests can browse; every write needs an account.

## Design

The app's look: a **fixed dark, luxurious style** ("Buat lebih gelap &amp;
mewah gayanya", rev. 2 of the redesign spec). The darkness is the point of
the app's identity, so it is one fixed look: the app does NOT follow the
viewer's Homeroom light/dark theme — the theme script in `public/index.html`
keeps `dark` on `<html>` permanently, and the tokens in
`styles/tailwind-input.css` hold the same values in `:root` and `.dark`.
Every later change follows this look, and updates it when a request changes
it on purpose.

- **Palette:** deep warm near-black surfaces with one calm gold accent
  (accent 212 175 55; on-accent 24 18 8, near-black brown — never white on
  gold). Ground 18 16 13, surface 26 23 19, raised 38 33 26, line 54 47 37,
  fg 240 234 222 (warm ivory), muted 161 150 133, danger 248 113 113.
  Elevation/motion tokens live beside them: `--accent-ink` 226 191 70 (gold
  text on a gold tint), `--shadow-card`, `--shadow-fab` (dark shadow + gold
  glow), `--shadow-sheet`, `--ease-out`, `--dur-fast` 160 ms,
  `--dur-med` 240 ms.
- **Category colours** (badge text on a raised surface, each kind keeps its
  colour wherever it shows): food 74 222 128, ride 147 180 253, sell 252
  211 77, service 196 181 253. These are the only extra colours; everything
  else is the tokens.
- **Signature element:** the zone card shaped like a location tag — square
  at the top left corner (6px, where it hangs from a pin) and rounded on
  the other three corners (20px), with a line-drawn gold map pin inside a
  faint gold disc (`.pin-wrap`, 12px radius) at its left. The kind of cuan
  is a small coloured badge on the card's meta line.
- **Look details:** hairline card borders (`--line` at 90%), a one-pixel
  top highlight (`inset 0 1px 0 rgba(255,255,255,.04)`), deep soft shadows,
  active chips in a gold tint (accent/14% + accent-ink text), primary
  buttons in gold with a soft gold glow, hover glows only under
  `@media (hover:hover)`, and short fade/slide transitions (160–240 ms,
  `--ease-out`) that `prefers-reduced-motion` turns off.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`.
  Family is the system rounded face (ui-rounded), then system-ui; set in
  `tailwind.config.js` and on `.app` in `public/screens.css`. Display
  headings are heavier and tracked tight: h1 30/36 w800 -0.02em, zone names
  -0.01em, detail name 22/700 -0.02em.
- The app's text is in Indonesian (lang="id"). One word per thing: zona,
  jenis cuan, catatan singkat, Tambah zona, Simpan zona, update, Update
  terbaru, Kirim update, Foto (boleh kosong), Tambah foto, Ganti foto,
  Hapus foto, poin, Poin saya, Laporkan, Dilaporkan, Hapus zona, Daftar,
  Peta, Kamu. Distance
  reads "350 m" or "1,2 km".

## App-specific conventions

- Categories are fixed server-side: `makanan`, `ojek`, `jualan`, `jasa` in
  `server.js`'s `CATEGORIES`. A new category needs its colour token too.
- Coordinates are rounded to 4 decimals (~11 m) before saving, and must
  fall inside Indonesia's rough bounds (`cleanCoords` in server.js).
- Sorting happens in the browser from `GET /api/zones` rows; the server
  never sorts by distance.
- The Peta view draws `sorted()`'s output around `origin` as a schematic
  SVG (flat projection, distance rings, no map service). Under the Ojek
  chip its scale is fixed at 100 m (rings at 50 m and 100 m); otherwise
  the rings step up from 50 m so the farthest zone fits in three.
- The Ojek chip is the one-tap driver-availability menu: it shows only
  ojek zones within 100 m of `origin` (rounded metres, like the card's
  distance), with a count line above the list, and nothing at all when
  the viewer's location is unknown. Other chips ignore the radius.
- `zone_reports`, `point_ledger` and `update_reports` are marked
  `staging:private`; everything else is public.
- Every update sent earns a fixed 10 points (`POINTS_PER_UPDATE` in
  `server.js`), once per zone per member every 24 hours
  (`UPDATE_COOLDOWN_MS`). The balance is `SUM(amount)` over `point_ledger`
  rows where `is_demo` matches the request's demo flag, so demo points
  never mix with real ones.
- The demo seeds four text-only updates by fake authors (fixed
  `demo_key`s); it never seeds points or updates for the viewer.
- The `?demo=1` demo is staging-only: boot seeds eight fake-author zones
  with fixed `demo_key`s, and the viewer's own two zones are written once
  per account on their first `?demo=1` read. Demo rows never appear
  without `?demo=1`.
