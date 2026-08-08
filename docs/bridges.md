# Bridges — how they were built, and what went wrong on the way

Written 2026-08-07, after taking Portland's crossings from flat painted
ribbons to walkable 3D structures. This is a record of the work and of the
mistakes, because the mistakes are the more useful half: two of them looked
completely correct, passed their tests, and were wrong.

The `polish.md` entry that started this said only: *"Bridges are paper. Decks
are single flat ribbons: no thickness, railings, or piers."*

---

## Where it ended up

- Every spanning leg carries a **1.7 m slab** (fascia + soffit), **1.15 m
  barriers**, and **piers**. 1,465 legs, 98 km of span.
- Overpasses are **actually elevated** — 86% of legs sit above grade, from
  `F_ZLEV`/`T_ZLEV`.
- Decks are **walkable in FPV**, with barriers you cannot step through and
  clear space underneath.
- Each span is **its real width** where the city publishes an outline —
  912 of 1,465. The Burnside comes out at 24.0 m against a real ~24 m.
- The **13 named river crossings** carry their actual structural form:
  suspension towers on the St. Johns, the Fremont's tied arch, lift towers on
  the Hawthorne and the Steel, Tilikum's cable stays.
- Piers on those crossings stand **at the ends of the main span and nowhere
  inside it**, instead of marching through the navigation channel every 45 m.

Code: `client/src/render/deck.ts` (the deck line, shared by rendering and
collision), `client/src/render/superstructure.ts` (towers, arches, trusses,
cables), `tools/map-extract/lib/deck-width.ts` (width measurement),
`shared/src/bridges.ts` (the hand-authored form table). Constants and their
reasoning live in `docs/map-derivations.md`.

---

## The three mistakes

### 1. Building the parts before checking they could be lifted

The first pass added slab, barriers and piers, hung off the existing deck
rule: `max(terrain, lerp(bankA, bankB))`. Tests passed. The commit message was
confident. **98.3% of bridges were unchanged.**

That rule only lifts a deck where the ground *dips between the endpoints*. A
river dips, so the Willamette crossings worked and looked convincing. An
overpass does not — both ends are at grade and the 30 m DEM cannot resolve the
road cut beneath it — so the deck tracked the ground and the slab was buried
in the dirt. Measured afterwards:

```
legs getting at least one pier    13 of 1,465   (0.9%)
legs never rising even 0.5 m           1,440    (98.3%)
```

The parts were right. The thing holding them up was not. **A component can be
perfectly correct and still do nothing, and the test that would catch it is
not a test of the component.**

What made it worse: I had verified against a synthetic gorge — the one shape
that already worked. The unit tests were green the entire time.

### 2. Solving a problem that measurement said did not exist

The fix was `F_ZLEV`/`T_ZLEV`, which the extractor already read for
jurisdiction welding and then discarded. Applying it raised a question: two
edges meeting at a node might claim different levels, which would step the
road vertically. 1,002 nodes did that. A 6.5 m cliff mid-street sounded worse
than flat bridges, so levels were resolved **per node, lowest wins** —
continuous by construction.

It shipped. Then a screenshot came back showing the Burnside approach diving
*under* the highway it was supposed to cross.

Lowest-wins drags a viaduct down to grade wherever any street happens to touch
it, putting a dip in the middle of the deck. And the premise was wrong. When
finally measured:

```
nodes where levels disagree                             1,002
  two different roads crossing (correct to leave stepped)  966
  one named road at two levels (a real break)               36
```

96% of "disagreements" were **grade separation working as intended** — which
is the entire point of the field. I had invented a failure mode, designed
around it, and caused a real one. Keeping the source's own values raised
elevated legs from 32% to 86%.

**The lesson is narrow and specific: I could have run that query before
writing the rule.** It took one script and thirty seconds. Instead the cost of
the imagined problem was estimated by intuition, and intuition was wrong by a
factor of 27.

### 3. Nearly building geometry that was not needed

The deck outlines sat unused for several commits because consuming them
appeared to require lifting flat polygons to deck height and triangulating
them — a real modelling job.

It didn't. Slab, barriers, piers and the collision surface all derive from
**one deck line and one width**, so measuring the polygon's width and passing
a number improved every one of them with no new geometry at all.

The single-source structure was built for a different reason — keeping
collision and rendering from drifting apart — and it paid off somewhere
unrelated. **Consolidating a definition makes later work cheaper in ways you
cannot predict at the time.**

---

## Two things worth keeping

**The deck line has exactly one definition.** `deckStations` in `deck.ts` is
consumed by the road ribbon, the slab, the barriers, the piers, the
superstructure, and the FPV collision index. This is not tidiness: if the
collision plane sits a few centimetres off the drawn deck, the player falls
through a bridge they can see, or walks on air beside it. The contract is
pinned by tests — walkable surface on the deck line, barrier above it,
collision width equal to render width.

**Collision needed a concept the building index did not have.** A deck
registered like a building would have put an invisible wall under every
overpass in the city, because a building blocks from the ground up. `Solid`
gained `base` (a floor to the volume) and `platform` (a surface with no volume
at all). Decks are platforms; barriers are real volumes based at deck level.

---

## Where the data ran out

Everything above is derived from GIS except the structural forms, and that
boundary matters.

The city publishes no structural type for its river crossings. The River
Bridges layer carries `NAME` and `PAVED`. The 520-bridge municipal layer types
records by **use** — VEHICLE / PEDESTRIAN / RAILROAD / SIGN / CULVERT — and
only 8 of those 520 carry any structural hint.

So `shared/src/bridges.ts` is **hand-authored**, and says so at the top. Main
spans are close to published figures; rises are eyeballed to read correctly at
game scale rather than surveyed. It is art direction with a factual basis, and
it must not leak into anything needing real numbers.

That table earns its place: without it every crossing is a slab on regular
piers and Portland's most recognisable structures are indistinguishable from
each other. But it is a different *kind* of data from everything else in the
pipeline, with different reliability, and conflating the two would be the
easiest way to quietly corrupt the map's provenance.

---

## Known gaps

- **Piers are placed, not surveyed.** Named crossings put supports at the ends
  of the clear span; everything else uses 45 m spacing. Real pier positions
  are not in any layer we have.
- **The width cap is keyed to road class** (2.4× the road's own width),
  because at an interchange several carriageways share one deck polygon and a
  service alley measured 58 m — 11× its own width. The cost is that a wide
  deck carrying a low-class road gets clipped: Tilikum measures 19.2 m against
  a real 23.7 m.
- **33 ramp stubs are absurdly steep**, worst 6.5 m over 5 m, where the source
  transitions a level across a very short segment. Smoothing the transition
  across neighbouring segments would fix it.
- **Superstructures are generic per form.** A suspension bridge looks like a
  suspension bridge, but the St. Johns' Gothic arches are not modelled as
  such.
- **Bascule and lift spans do not move.**
