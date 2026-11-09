# omp 18.18.5 ask form recordings

These five scenarios were recorded on macOS arm64 on 2026-11-09 from the standalone release executable `/tmp/omp-18.18.5-bin/omp-darwin-arm64`, reporting `omp/18.18.5`. The corresponding source is tag `v18.18.5`, commit `1891f380b296aeda26971abd81b89ef3247eea06`. The downloaded executable's SHA-256 is `8696ca418df9f50a637d3c866948676cb97abb2968af16ee8905d37ae1e08237`, matching the [release asset metadata](https://github.com/can1357/oh-my-pi/releases/tag/v18.18.5). The executable was not independently rebuilt from source.

The Node recorder uses its existing isolated profiles, loopback scripted provider and production collab guest. No owner profile, credentials, Electron process or external model provider is used. Every scenario makes two scripted provider requests, records one ask result and exits normally. Scratch profiles are removed after recording.

The standard raw bytes, journal, decoded messages, emitted events, integrity manifest, provider requests and collab transcript follow the [18.15.0 capture format](../18.15.0/README.md). Each `.ask.json` also records staged semantic surfaces and the guest request at that stage, followed by the complete saved session JSONL. The form inputs reproduce the fixture server's controls and values with layout whitespace normalized.

## Scenarios

| Scenario | Captured behavior |
|---|---|
| `ask-fixture-form-tabs` | The fixture server's `fixture form` contains radio and checkbox fieldsets followed by text and select controls outside them. omp groups these into three question tabs plus Review. The recording switches tabs by semantic selection, Page Down, Page Up and both arrows, uses Next, hides Review with Hide, restores it with Alt+H, and submits from Review. |
| `ask-four-fieldsets-tabs` | The same controls with explicit text and select fieldsets produce four question tabs plus Review. It records the same navigation, hide/show and submission sequence. |
| `ask-fixture-form-guest` | The production collab guest answers radio, checkbox toggle, checkbox Next, text and select requests. All five requests finish while the native form remains on its first question tab; native Review or Submit is not required for guest completion. |
| `ask-fixture-colors` | The fixture server's one-fieldset `fixture colors` has no question tabs. It records Hide, semantic Show and native Submit. |
| `ask-tall-form` | Ninety paragraphs and a prefilled single-line field describe the tall native body inside a direct `omp.ask.options` list, with its action bar outside that scroller. The input cursor is zero. It records Hide, Show and native Submit. This is semantic evidence of the scroll-container structure; no browser geometry or wheel behavior is claimed. |

Left and Right change question tabs while a choice is focused. Left in a text input moves its caret instead. The tab recordings address the choice tab before exercising Left.

## Observed wire changes

The visible root remains `omp.editor.ask`, but its `omp.ask.form` is now nested in a list rather than being a direct child. Only the current question tab's fields are described. Review replaces that subtree with `omp.ask.notice` and `omp.ask.answers`. Hide uses the `omp.editor.ask.hidden` root and a Show action. Additional roles are `omp.ask.head` and `omp.ask.questions`; Next and Show use the action ids `next` and `show`. All component kinds already exist in the app's negotiated vocabulary.

These fixtures record the upstream producer. They do not assert that the app's current question matcher, claims or generic controls support those new shapes. The separate compatibility implementation owns that adaptation.

## Recording again

Bundle `record-fixtures.ts` with the [baseline command](../18.15.0/README.md#re-recording), then run:

```sh
OMP_BIN=/tmp/omp-18.18.5-bin/omp-darwin-arm64 VOMP_TSP_FIXTURE_VERSION=18.18.5 VOMP_TSP_FIXTURE_DIR=src/main/omp/tsp/fixtures/18.18.5 node record-tsp.mjs ask-fixture-form-tabs ask-four-fieldsets-tabs ask-fixture-form-guest ask-fixture-colors ask-tall-form
```

Node must execute the recorder. `form-18185-fixtures.test.ts` checks byte/CR/digest integrity, privacy replacements, replay, tab transitions, independent guest completion and the tall-form/prefill facts.
