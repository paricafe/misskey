# Frontend performance implementation and acceptance

All four planned optimizations passed local acceptance on 2026-11-06. The largest measured improvement is the cost of a long timeline: after scrolling 500 loaded notes, median JavaScript heap usage fell from 45.59 MiB to 9.61 MiB, and mounted note articles fell from 500 to 8.

Baseline: `pari-dev` commit `9b8e742302e83ff37fc33282dbf471d9211bcd20`. Target: the frontend change accompanying this report. [measurements.json](measurements.json) contains exact byte counts, six runtime samples, six functional test results, the production manifest hash and a fingerprint of the changed frontend files.

During acceptance, the branch advanced to `b1ca204d39a20b01d2b3a054c96c3ee851a7fdaa` through an independent backend commit. Its committed frontend tree is identical to the baseline (`7678af9c95538377ffce7a4369ce1ff38b357e37`). That backend commit was preserved; the frontend changes in this report were validated independently on top of it.

## Implemented changes

1. **Virtual timelines.** Both ordinary and streaming timelines use a dynamic-height list. ResizeObserver measurements, prefix offsets and a binary search select the visible rows plus 600 px of overscan. Height changes and inserts preserve the reading anchor. A focused row remains mounted with sparse spacers; rows between it and the viewport are released. Deck columns track their own scroll containers. Streaming pagination uses a keyed observer sentinel and retains the manual load button. The previous whole-list TransitionGroup was removed.
2. **Hidden content and effects.** Content-warning bodies mount only when expanded. Sparkle effects run only while intersecting the viewport in a visible document. Deactivation and unmount disconnect observers, remove listeners and clear particle timers.
3. **Loading boundaries.** Main/sub boot code loads dynamically alongside icon CSS. The route table no longer eagerly imports the home timeline. Production chunks group shared boot, note reading and posting interactions by static dependencies. Image animation detection and resizing load when compression needs them. Authenticated boot preloads posting and emoji components before controls mount; the warm popup path remains synchronous within the user gesture.
4. **Optional startup work.** The shell mounts and removes its splash before idle initialization of emoji refresh, telemetry and plugins. Emoji refresh updates the reactive cache without blocking boot. Note bodies wait for plugin registration before applying note filters. Plugin startup isolates failures with allSettled; scripts exceeding five seconds are aborted and their handlers removed while successful plugins remain available.

Timeline data owns the retained note state. Unmounting a virtual row releases its component tree while preserving its canonical note, capture subscriptions, content expansion, translation refs and poll result selection. This allows reaction and translation requests to finish after the row disappears. Removing the paginator record or destroying its owner disposes the retained captures. Component-specific child callbacks are excluded from retention.

The paginator still retains loaded note data. Virtualization bounds mounted rows and their effects; it does not claim constant memory for an indefinitely growing history.

## Production JavaScript

| Required JavaScript closure | Baseline | Optimized | Change |
| --- | ---: | ---: | ---: |
| Complete visitor welcome page, gzip | 338.58 KiB | 319.08 KiB | -5.76% |
| Authenticated timeline and ready composer/picker, gzip | 327.07 KiB | 309.11 KiB | -5.49% |
| Visitor required JavaScript files | 66 | 16 | -50 files |
| Authenticated required JavaScript files | 61 | 13 | -48 files |

Both comparison builds used `NODE_ENV=production`, the same installed dependencies and the same ja-JP locale inliner. The baseline source was read from the commit above, with its original Vue/i18n chunk groups; the target used the final working tree and chunk configuration. New implementation files are unreachable from the baseline source. No development-mode samples are included.

For each scenario, the measurement walks the manifest's static imports from the roots recorded in measurements.json, deduplicates JavaScript filenames and sums each localized file's raw, gzip and Brotli size. The visitor roots include `pages/welcome.vue`; the authenticated roots include `pages/timeline.vue`, the post form and the emoji picker. Optional dynamic widgets, CSS, fonts, images and HTTP overhead are outside this JavaScript total. File counts describe this required closure, not observed whole-page HTTP requests. No LCP or startup latency improvement is claimed.

All 22 JavaScript files in the union of the target closures were byte-compared against the full multilingual production build served during functional validation. There were zero mismatches.

## Browser measurements

Environment: macOS 27.2 arm64, Node 24.19.0, installed Chrome 156.0.8078.80. The server, PostgreSQL cluster and Redis instance were dedicated local test resources.

The runtime comparison uses the same authenticated account and deterministic 500-note fixture, with varied plain-text heights and old timestamps. Each phase receives all 500 notes in the initial timeline response. It loads the production artifacts, settles, explicitly collects garbage, records an initial sample, scrolls through the history and back to the top, collects garbage again and records the second sample. Three runs per phase alternate `base/head`, `head/base`, `base/head`. Each sample has zero page errors.

| Median after scrolling all 500 notes | Baseline | Optimized | Change |
| --- | ---: | ---: | ---: |
| Mounted note articles | 500 | 8 | -98.40% |
| Attached HTML elements | 19,805 | 592 | -97.01% |
| JavaScript heap after GC | 47,809,000 B / 45.59 MiB | 10,079,404 B / 9.61 MiB | -78.92% |
| CDP DOM node counter | 46,559 | 1,319 | -97.17% |
| CDP JavaScript event listener counter | 15,759 | 523 | -96.68% |

These are controlled JavaScript heap and DOM measurements, not browser process RSS or a device battery/FPS benchmark. The results establish the benefit for this fixture; image/video-heavy feeds and physical handset behavior need their own measurements.

## Regression acceptance

| Check | Result |
| --- | --- |
| Full frontend unit suite | **PASS**, 44 files / 302 tests |
| Frontend typecheck | **PASS** |
| Full multilingual frontend production build | **PASS** |
| Frontend embed build and production service-worker build | **PASS** |
| Changed-file ESLint via shipping check | **PASS** |
| SPDX and locale safety | **PASS** |
| Vue component checklist and whitespace diff | **PASS** |
| Browser functional cases, repeated twice | **PASS**, 6/6; no skips, failures or flaky results |

The browser cases cover:

- **1280 × 900 and 390 × 844 timelines:** paginate to 500 records, with at most 11 and 9 mounted rows respectively in both repetitions; collapsed content stays unmounted; expansion survives scrolling away and back.
- **Late reactions:** hold the reaction response until its row unmounts, then return to the row and verify the resulting count and expanded content.
- **Reading position:** resizing an earlier row preserves the visible anchor within 3 px; opening a note and returning restores the reading position within 5 px.
- **Posting:** open the composer, verify text focus, choose an emoji, upload an image and submit a real note containing one attachment against the isolated backend.
- **Deck:** load 500 notes in each of three columns, scroll only the first, preserve the other columns and keep mounted rows at 19/13/13 in both repetitions.

Unit regressions also cover focused-row retention and release, insert/resize anchors, KeepAlive observer/listener cleanup, canonical note/capture/translation reuse and disposal, hidden effect timers, content-warning mounts, boot-before-idle ordering, synchronous warm picker opening, plugin-filter ordering and a real AiScript startup timeout that cannot register handlers after abort.

The unit runner emitted local `localhost:3000` connection warnings and Vite configuration/deprecation notices; its exit code was zero and all tests passed. Mobile acceptance is a Chrome viewport test. Physical iOS keyboard behavior and production deployment were not exercised.

Useful repository commands, from the repository root:

```sh
rtk proxy ats run -- rtk proxy pnpm --filter frontend test
rtk proxy ats run -- rtk proxy pnpm --filter frontend typecheck
rtk proxy ats run -- rtk proxy pnpm --filter frontend build
rtk proxy ats run -- rtk proxy node scripts/check-shipping.mjs --base HEAD
```

The permanent browser regression is [timeline-performance.spec.ts](../../../packages/frontend/test/e2e/timeline-performance.spec.ts). It resets the test server through the existing test-only API and must run against an isolated test backend. This acceptance used port 61816, one worker, the installed Chrome executable, a 90-second timeout and `--repeat-each=2`; the normal repository Playwright configuration uses its own test port.

Suggested changelog entry, not applied: `Improve long-timeline rendering, pause hidden content effects, reduce startup JavaScript fragmentation and defer optional initialization while preserving note state and plugin filters.`
