# tryconnect

Temukan zona dan lokasi terbaik untuk mencari cuan. tryconnect is one list
of places where people can earn extra money, nearest first. Each place is
tagged with a ready-made kind of cuan (Makanan, Ojek, Jualan or Jasa). Any
member can add a place, open it, report one they did not add, or remove one
they added.

## How it works

- The main screen lists zone cards: name, distance, a short note, the kind
  of cuan and who added it.
- Sorting is nearest-first, which needs your location: the app asks for it
  only when you tap "Pakai lokasi saya". Without it the list falls back to
  newest first.
- Adding a zone opens a sheet: name (60 chars), kind of cuan (chips),
  optional note (140 chars) and your current position as the spot.
- Guests can browse; adding, reporting and removing need an account.

## Running

```sh
npm ci
npm run build   # compiles styles/tailwind.css to public/tailwind.css
npm start       # node server.js
```

On staging, `?demo=1` shows a populated demo around a fixed spot in West
Jakarta, with the viewer's own two zones. Demo rows never appear without
`?demo=1`.
