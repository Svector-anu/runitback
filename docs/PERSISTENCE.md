# Persistence, derived data and portable projects

## Where data lives

| Data | Location | Owner |
|---|---|---|
| Project JSON, asset metadata | IndexedDB `runitback` (`projects`, `assets`) | `IdbProjectRepository`, `IdbAssetRepository` |
| Media bytes | OPFS `media-<projectId>/<assetId>` (IndexedDB `blobs` fallback) | `OpfsFileStore` |
| Derived data, keyed by asset id | IndexedDB `runitback-analysis` (key `<assetId>:<size>:<lastModified>`), `runitback-transcripts`, `runitback-visual`, `runitback-faces` | the four `Idb*Store`s |
| Preferences, incl. the persist-storage result | localStorage via `platform/prefs.ts` only | `PrefsStore` |

## Project locks and library metadata writes

The tab that has a project open holds its Web Lock (`platform/project-locks.ts`) for the whole session and autosaves over the stored row. Every other writer of that row goes through `ProjectsService` and must hold the same lock for the duration of its read-modify-write:

- `rename`, `duplicate` (source read) and `delete` call `tryAcquire`; when another tab holds the lock they throw `ProjectLockedError` ("This project is open in another tab") and write nothing. There is no cross-tab message routing: refusing is the simplest design that cannot lose either side's data.
- `rename` additionally writes with `ProjectRepository.saveIfUnchanged(project, expectedUpdatedAt)`, an atomic compare-and-set on `metadata.updatedAt` (one IndexedDB readwrite transaction). A stale copy therefore never overwrites newer edits even where Web Locks are unavailable (`UncontendedProjectLocks`); the failure is `ProjectChangedError` and nothing is written.

## Unreadable projects

`ProjectRepository.listLibrary()` makes one pass over the stored rows and returns `{ projects, unreadable }`; `list()` is its `projects` half. A row that fails `deserializeProject` (corrupt JSON, empty, missing scenes, schema newer than `PROJECT_SCHEMA_VERSION`) becomes an `UnreadableProject { id, reason: "newer-version" | "damaged", detail, name }` (`name` only if the row is still JSON with a string name). The projects page shows these as "Cannot open: ..." cards above the library with:

- Retry: reloads the library (e.g. after updating the app).
- Export raw: downloads the stored JSON text byte for byte (`ProjectRepository.loadRaw`).
- Delete: confirmed, then the normal `ProjectsService.delete` (lock respected, media and derived data removed).

Nothing is deleted or rewritten automatically, and the empty state "No projects yet" only shows when there are neither readable nor unreadable rows.

## Derived data lifecycle

Every store of per-asset derived data is registered in a `DerivedDataRegistry` (`platform/derived-data.ts`; the browser set is built by `browserDerivedData()` in `derived-data-adapters.ts`). A new kind of derived data is only correct once it is registered: it then gets purge, stray collection, export and import for free.

`ProjectsService` (engine) depends on the `DerivedDataPurger` interface and deletes derived data only when the asset's bytes are gone **and no other project still stores them** (duplicated projects share asset ids):

- `delete(projectIds)`: bytes removed, then unreferenced assets are purged.
- `finalizeClose` (called by `AppServices.closeNow` after the final save): drops ids that only undo history kept alive from the saved `assetIds` (history ends with the session), then `sweepOrphans` deletes the bytes and purges derived data.
- `removeAssets` in the editor never purges: the removal is one undoable step and the bytes stay until close.
- `purgeStrayDerived()` runs when the projects page opens. It deletes derived data whose asset has no stored bytes in any project (failed purges, Understand jobs that finished after their media was removed). It checks `AssetRepository.listAllIds()`, not readable projects, so a project written by a newer app version cannot cause data loss.

Purge failures never fail project deletion; they are logged and the stray sweep finishes the job.

Not covered: global style profiles (`runitback-style`) are per user, not per asset.

## Durable storage

`StoragePersistence` (`platform/file-store.ts`) calls `navigator.storage.persist()` once, after the first successful autosave or bundle import. The outcome (`granted` / `denied` / `unsupported`) is stored under the `storage-persist` pref. A refusal produces one toast on the projects page (with the quota estimate); it is never repeated. The projects toolbar shows usage and quota.

## `.runitback` bundles

A zip (32-bit, no encryption) with fixed entry names; anything else is rejected:

```
manifest.json                      format, bundleVersion, schemaVersion, createdWith, entry sizes + sha256, asset infos
project.json                       the project, schema version in `version`
media/<assetId>                    original bytes, stored (not compressed)
derived/<kind>/<assetId>.json      analysis | transcript | visual | faces (deflated JSON)
```

Embeddings are included when they are at most 4 MiB, or always when "Include the visual search index" is ticked.

Export hashes each media file in one streaming pass (SHA-256 + CRC-32, no whole-file buffering) and builds the output as a `Blob` of references to the stored files. Import verifies structure, sizes and every SHA-256 before storing a byte, then writes media (zero-copy slices of the file), derived data, and the project row last; any failure removes what was stored.

Import always creates a NEW project: every id (project, scene, track, element, effect, mask, keyframe, asset) gets a fresh value (`remapProjectIds`), derived records are re-keyed to the new asset ids, and the result is checked for residual old ids and new invariant violations.

Typed failures (`BundleError.code`): `not-a-bundle`, `truncated`, `malformed`, `unsafe-path`, `too-large`, `newer-version`, `unsupported`, `missing-entry`, `checksum-mismatch`.

Limits: no Zip64, so a bundle (and its media) must be under 4 GiB; at most 20,000 entries, 5,000 assets; `project.json` 64 MiB. Entries declared larger than their limit, or that inflate past their declared size, are refused. No zip library is used: the format needs random access over a `Blob` (so media is never read into memory), which `CompressionStream` / `DecompressionStream` plus about 250 lines cover without a new dependency.
