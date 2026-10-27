# Custom endpoints in config profiles

Config profiles (the `__base__` document and role, group and user documents written through
`/api/admin/config`) merge over `librechat.yaml`. `endpoints.custom` merges entry by entry on
`name`: a profile's entry changes the inherited entry of the same name, and a new name adds an
endpoint. Names compare as the runtime serves them, so `ollama` in any case is the `Ollama`
entry.

A profile can also take away what a lower layer defined: hide a whole endpoint, remove one of its
fields, or remove one key of a record map such as `headers`. All three are tombstones that name
the entry by its key.

## Keyed paths

A keyed path names one entry of an array merged by key (`rules.arrayMergeKeys` in
`GET /api/admin/config/meta`, today `endpoints.custom` and `endpoints.azureOpenAI.groups`), then
optionally a path inside it:

```text
endpoints.custom["<name>"]
endpoints.custom["<name>"].<field>
endpoints.custom["<name>"].<record>.<key>
```

`<name>` is a JSON string literal, so any name works: build it with `JSON.stringify(name)`. A name
may hold dots, spaces, quotes or brackets (`endpoints.custom["api.example.com \"v2\""]`). It may be
up to `limits.maxEntryKeyLength` (256) characters and may not start with `$` or `__` or be
`constructor` or `prototype`. The path inside the entry is dotted, so a header name that contains a
dot cannot be addressed. Tombstones are stored in this canonical form.

| Method | Path                                                             | Body / query                                       |
| ------ | ---------------------------------------------------------------- | -------------------------------------------------- |
| POST   | `/api/admin/config/:principalType/:principalId/fields/tombstone` | `{ "fieldPath": "endpoints.custom[\"Name\"]…" }`   |
| DELETE | `/api/admin/config/:principalType/:principalId/fields`           | `?fieldPath=` the URL-encoded keyed path           |
| POST   | `/api/admin/config/:principalType/:principalId/changes`          | `{ "op": "tombstone" \| "unset", "fieldPath": … }` |

A keyed path hides or resets; it never writes. Write an entry whole with an `upsertEntry` change,
or write the `endpoints.custom` array. A keyed path in a PATCH entry, a `set`, or as the collection
of an entry change answers 400 `CONFIG_PATH_INVALID` with reason `keyed_path`. Only a `fieldPath`
is read as keyed: a `segments` target names each key as written, so a segment such as
`custom["Name"]` is a key of that spelling, and a write by it clears none of the entry's
tombstones.

## Hiding an endpoint

`fieldPath: 'endpoints.custom["Name"]'` hides the endpoint for every principal the profile applies
to. The profile's own entry of that name, and any key it stored on it, is removed. Everything that
offers the endpoint goes with it, so the principals are not offered an endpoint they are not
served:

- the model specs that select it (`preset.endpoint`);
- its name in `modelSpecs.addedEndpoints`;
- its name in `endpoints.agents.allowedProviders`.

This holds whether `librechat.yaml` or a lower profile (such as `__base__`) defines the endpoint.
Nothing else goes: when the hidden endpoint selected every spec, the spec list is empty and the
other `addedEndpoints` stay. An empty `addedEndpoints` or `allowedProviders` allows every endpoint,
so a list that names only hidden endpoints stays as it is; those names match no endpoint the
principals are served, so it allows none. With every spec hidden, `modelSpecs.enforce` no longer
applies, as for a `librechat.yaml` with an empty spec list.

A tombstone in the `__base__` profile applies to every principal. Every other profile merges after
`__base__`.

Hiding or removing an endpoint is never refused because the profile's own model specs select it
(`/changes`, PATCH and the single-field routes alike): those specs go with the endpoint. A write of
a spec for an endpoint that is not configured answers 400 `unknown_spec_endpoint`, a spec in the
same batch as the hide included.

Hiding is undone by:

- deleting the tombstone (`DELETE …/fields?fieldPath=endpoints.custom%5B%22Name%22%5D`);
- writing the entry again in the same profile, with `upsertEntry` or a write of the
  `endpoints.custom` array (PUT, which replaces the overrides and keeps every tombstone, does not);
- a higher profile that writes the entry. It gets only what that profile wrote, merged onto nothing,
  so write the complete definition (`baseURL`, `apiKey`, `models` and the rest), as for an endpoint
  that does not exist in `librechat.yaml`.

## Removing inherited values

`fieldPath: 'endpoints.custom["Name"].<field>'` removes a field a lower layer set, and
`'endpoints.custom["Name"].headers.<key>'` removes one key of a record map and keeps its siblings.
This works for `headers`, `addParams` and any other object of the entry:

```json
{ "fieldPath": "endpoints.custom[\"Gateway\"].headers.X-Team" }
```

These tombstones behave as follows:

- The profile's own value at the path is removed with it; an own entry left with nothing but its
  name is removed.
- Writing the entry in the same profile keeps the tombstone. A value the profile writes for the
  same key is used over the tombstone, which keeps hiding the inherited one.
- `DELETE …/fields?fieldPath=<same path>` removes that tombstone and restores the inherited value.
- `DELETE …/fields?fieldPath=endpoints.custom["Name"].headers` resets the profile's own headers of
  that entry and the key tombstones under them. A keyed path of the whole entry resets the
  profile's own entry and every keyed tombstone of it, and `fieldPath=endpoints.custom` resets the
  whole list and every keyed tombstone under it.
- A higher profile can supply the value again.

Refused with 400:

- the entry's `name`, which identifies it (reason `merge_key`): hide the whole entry instead;
- `apiKey`, `apiKeyPreview` and the stored destination fingerprint (`SECRET_PATH`): an entry's key
  is entered, kept and removed with the entry;
- an element of one of the entry's arrays, such as `models.default.0` (`inside_array`): a tombstone
  hides a whole array.

A tombstone at a position in the list (`endpoints.custom.0.headers`) is refused too
(`inside_array`). Before keyed paths, POST `/fields/tombstone` stored it, and the merge never
applied it.

Removing a field the endpoint needs (`baseURL`, `models`) is not reported. The runtime does not
serve a custom endpoint without them, so it disappears for those principals.

## Stored keys

A tombstone never sends a key anywhere new:

- Hiding a profile's own entry removes the key it stored. Showing the entry again does not bring the
  key back; enter it again.
- Removing where the profile's own entry sends its stored key (`baseURL`, `provider`, or a
  destination option in `addParams`) answers 400 `CONFIG_SECRET_REENTRY_REQUIRED`, with the
  changed field and `secretPath`, on DELETE, tombstones and `/changes`.
- Removing it from an inherited entry drops the inherited key at merge, and the write lists the
  key in `ignored` with reason `secret_rebinding`.
- An inherited endpoint whose users enter their own keys (`user_provided`, `customUserVars`) keeps
  its destination: the merge sets the removed field back and the write lists it in `ignored`.

## Renaming

A profile renames one of its own entries, with the key stored on it, in either of two ways:

- a `rename` change in `/changes`: `{ "op": "rename", "fieldPath": "endpoints.custom", "from":
  "draft", "to": "final" }`;
- a `renames` hint on PUT or PATCH beside a write of the list that has the entry under its new name
  and not under the old one, without its `apiKey`:

  ```json
  {
    "entries": [{ "fieldPath": "endpoints.custom", "value": [{ "name": "final", "baseURL": "…" }] }],
    "renames": [{ "path": "endpoints.custom", "previousName": "draft", "name": "final" }]
  }
  ```

Either way, the key keeps its stored ciphertext and preview, and the keyed tombstones of the old
name move to the new one. The key stays bound to its destination: a renamed entry that sends it
somewhere else answers 400 `CONFIG_SECRET_REENTRY_REQUIRED`. A key the profile entered for an
endpoint `__base__` defines keeps the destination fingerprint it was entered with.

Entries `librechat.yaml` defines cannot be renamed, and no entry can take their name. A hint that
cannot apply answers 400 `CONFIG_RENAME_INVALID` with `reason`:

| Reason                 | When                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| `inherited_entry`      | either name is a `librechat.yaml` entry                              |
| `source_not_found`     | the profile stores no entry named `previousName`                     |
| `target_exists`        | the profile already stores an entry named `name`                     |
| `target_not_written`   | the write does not write an entry named `name`                       |
| `source_still_written` | the write still writes `previousName`; swap names with `rename` ops  |
| `duplicate_source`     | two hints rename the same entry                                      |
| `duplicate_target`     | two hints rename to the same name                                    |
| `invalid_name`         | a name a keyed path cannot address, or two spellings of one entry    |

Without a hint, a renamed entry is a new entry: it keeps no key, and the tombstones stay on the old
name.

## Azure groups

`endpoints.azureOpenAI.groups` merges by `group` the same way (`features.azureGroupMergeKey`) and
takes the same keyed paths: `endpoints.azureOpenAI.groups["<group>"]` hides an inherited group,
and `endpoints.azureOpenAI.groups["<group>"].<path>` a field inside one. A group's `apiKey` and its
preview are written with the group, never by its key. The Azure clients read what the groups
resolve to, so a hidden group or field takes effect only where the deployment resolves the groups
a profile leaves (`CONFIG_REDERIVE_ENDPOINTS=true`, `features.endpointRederive`): the groups left
are resolved again, and a group that no longer resolves once a field inside it is hidden is not
served; GET of the document and the resolved view list that tombstone in `ignored` with reason
`azure_groups_unresolved`. A higher profile that writes such a group again gets no key from below
it: enter the key with the group. Without the switch, the tombstone is stored and inert, as the
profile's group overrides are, and GET of the document, the resolved view and the `/changes`
response list each of them in `ignored` with reason `endpoint_rederive_off`.

## After upgrading

Before keyed paths, a tombstone such as `endpoints.custom["Name"]` was accepted and stored but had
no effect. Stored ones now hide that entry. Clients send keyed paths only when
`features.keyedTombstones` is true in `GET /api/admin/config/meta`, and endpoint rename hints when
`features.renameHints` is.
