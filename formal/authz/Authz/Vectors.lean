import Authz.Bits
import Authz.Resource

/-!
# Test vectors

`lake exe authz_vectors` writes `vectors/*.ndjson`: one JSON line per scenario with the model's
decision in `expected`. The Jest conformance specs seed each scenario into MongoDB, run the real
middleware and compare. The header line holds the tables lines refer to by index (`atoms`,
`groups`, `requests`) and the permission bits and principal types the model knows, which the specs
pin against librechat-data-provider.

Scenarios are every ACL subset of up to two rows from a fixed atom list, plus single-row scenarios
for the negative atoms: rows that must not grant the viewer anything.
-/

namespace Authz

/-- Every sublist of at most two elements, in a fixed order. -/
def subsetsUpTo2 {α : Type} : List α → List (List α)
  | [] => [[]]
  | x :: xs =>
    let rest := subsetsUpTo2 xs
    rest ++ (rest.filter fun s => s.length < 2).map fun s => x :: s

/-! Minimal JSON encoders; every string written is a fixed identifier, so none needs escaping. -/

def q (s : String) : String := "\"" ++ s ++ "\""

def optStr : Option String → String
  | some s => q s
  | none => "null"

def obj (fields : List (String × String)) : String :=
  "{" ++ ",".intercalate (fields.map fun (k, v) => q k ++ ":" ++ v) ++ "}"

def arr (items : List String) : String := "[" ++ ",".intercalate items ++ "]"

/-- Positions of `xs` in `table`; every element of `xs` must occur in `table`. -/
def indexes {α : Type} [BEq α] (table xs : List α) : String :=
  arr (xs.map fun x => toString (table.idxOf x))

def Outcome.name : Outcome → String
  | .allow => "allow" | .notFound => "notFound" | .unauthenticated => "unauthenticated"
  | .forbidden => "forbidden"

def viewerId : Nat := 1
def targetId : Nat := 100
def otherId : Nat := 101
def g1 : Nat := 10
def g2 : Nat := 11
def g3 : Nat := 12
def strangerId : Nat := 2

def userRef (u : Nat) : String := if u = viewerId then "user" else s!"user:{u}"

/-- The `PrincipalType` value for each principal kind. -/
def Principal.typeName : Principal → String
  | .user _ => "user" | .group _ => "group" | .role _ => "role" | .pub => "public"

/-- The principal kinds of the model; `principalTypes_complete` shows the list misses none. -/
def principalTypes : List String := ["user", "group", "role", "public"]

theorem principalTypes_complete (p : Principal) : p.typeName ∈ principalTypes := by
  cases p <;> simp [Principal.typeName, principalTypes]

/-- `permissionBits_are_single_bits` shows these are exactly `SingleBit` from `Bits.lean`. -/
def permissionBits : List (String × Bits) :=
  [("VIEW", VIEW), ("EDIT", EDIT), ("DELETE", DELETE), ("SHARE", SHARE),
    ("VIEW_INSIGHTS", VIEW_INSIGHTS)]

theorem permissionBits_are_single_bits (b : Bits) :
    SingleBit b ↔ b ∈ permissionBits.map (·.2) := by
  unfold SingleBit; revert b; decide

def Principal.json : Principal → String
  | .user u => q (userRef u)
  | .group g => q s!"group:{g}"
  | .role r => q s!"role:{r}"
  | .pub => q "public"

/-- What the specs pin: adding a bit or principal type in TypeScript must fail them. -/
def declarations : List (String × String) :=
  [("permissionBits", obj (permissionBits.map fun (n, b) => (n, toString b.toNat))),
    ("principalTypes", arr (principalTypes.map q))]

def resourceRef (r : Nat) : String :=
  if r = targetId then "target" else if r = otherId then "other" else toString r

def AclEntry.json (e : AclEntry) : String :=
  obj [("principal", e.principal.json), ("resourceType", q e.resourceType),
    ("resource", q (resourceRef e.resource)), ("bits", toString e.bits.toNat),
    ("tenant", optStr e.tenant)]

def viewerJson : Option Viewer → String
  | some v => obj [("tenant", optStr v.tenant), ("role", q v.role)]
  | none => "null"

def Group.json (g : Group) : String :=
  obj [("id", q (toString g.id)), ("tenant", optStr g.tenant),
    ("members", arr (g.members.map fun m => q (userRef m)))]

/-- `g1` is in the share's tenant, `g2` in another; the viewer is in both. `g3` is in the share's
tenant without the viewer. -/
def groupsFor (τ : Option TenantId) : List Group :=
  [⟨g1, τ, [viewerId]⟩, ⟨g2, some "tenant-b", [viewerId]⟩, ⟨g3, τ, [strangerId]⟩]

/-- Rows that grant the viewer (public, their user, role or groups) and near misses: EDIT only,
another tenant, another resource, another resource type. -/
def shareAtoms (τ : Option TenantId) : List AclEntry :=
  [ ⟨.pub, "sharedLink", targetId, VIEW, τ⟩,
    ⟨.user viewerId, "sharedLink", targetId, VIEW, τ⟩,
    ⟨.role "USER", "sharedLink", targetId, VIEW, τ⟩,
    ⟨.group g1, "sharedLink", targetId, VIEW, τ⟩,
    ⟨.group g2, "sharedLink", targetId, VIEW, τ⟩,
    ⟨.user viewerId, "sharedLink", targetId, EDIT, τ⟩,
    ⟨.user viewerId, "sharedLink", targetId, VIEW, some "tenant-b"⟩,
    ⟨.user viewerId, "sharedLink", otherId, VIEW, τ⟩,
    ⟨.user viewerId, "agent", targetId, VIEW, τ⟩ ]

/-- Rows that grant someone else, sit outside the scope, or carry bit 16 alongside VIEW. -/
def negativeShareAtoms (τ : Option TenantId) : List AclEntry :=
  [ ⟨.user strangerId, "sharedLink", targetId, VIEW, τ⟩,
    ⟨.role "ADMIN", "sharedLink", targetId, VIEW, τ⟩,
    ⟨.group g3, "sharedLink", targetId, VIEW, τ⟩,
    ⟨.user viewerId, "sharedLink", targetId, VIEW ||| VIEW_INSIGHTS, τ⟩ ] ++
  (if τ.isSome then [⟨.user viewerId, "sharedLink", targetId, VIEW, none⟩] else [])

def viewerA : Viewer := ⟨viewerId, some "tenant-a", "USER"⟩
def viewerB : Viewer := ⟨viewerId, some "tenant-b", "USER"⟩
def viewerNone : Viewer := ⟨viewerId, none, "USER"⟩

/-- Every request shape that reaches `canAccessSharedLink`. Bearer requests carry the user's
tenant as context (`tenantContextMiddleware`). Cookie-authenticated file requests
(`optionalShareFileAuth`) set `req.user` without touching the context, which is then empty or
whatever a trusted `X-Tenant-Id` header set before sign-in (`preAuthTenantMiddleware`). -/
def shareRequests : List (String × Request) :=
  [ ("anonymous", ⟨none, none⟩),
    ("anonymous-header-a", ⟨some "tenant-a", none⟩),
    ("bearer-a", ⟨some "tenant-a", some viewerA⟩),
    ("bearer-b", ⟨some "tenant-b", some viewerB⟩),
    ("bearer-untenanted", ⟨none, some viewerNone⟩),
    ("cookie-a", ⟨none, some viewerA⟩),
    ("cookie-b", ⟨none, some viewerB⟩),
    ("cookie-a-header-b", ⟨some "tenant-b", some viewerA⟩) ]

def shareTenants : List (Option TenantId) := [some "tenant-a", none]

def shareAtomTable : List AclEntry :=
  (shareTenants.flatMap shareAtoms ++ shareTenants.flatMap negativeShareAtoms).eraseDups

/-- `g1` appears once per share tenant, so two entries share id 10; each line picks its own. -/
def shareGroupTable : List Group := (shareTenants.flatMap groupsFor).eraseDups

def shareLine (i : Nat) (τ : Option TenantId) (state : String) (anon : Bool)
    (label : String) (req : Request) (entries : Acl) : String :=
  let w : World := ⟨entries, groupsFor τ, anon⟩
  let share := if state == "missing" then none else some (⟨targetId, τ, state == "expired"⟩ : Share)
  obj [("id", toString i), ("shareTenant", optStr τ), ("shareState", q state),
    ("allowAnonymous", toString anon), ("request", q label),
    ("groups", indexes shareGroupTable (groupsFor τ)),
    ("entries", indexes shareAtomTable entries),
    ("expected", q (decideView w share req).name)]

/-- `allowAnonymous` only changes the outcome for a request with no viewer. -/
def anonFlags (r : Request) : List Bool := if r.viewer.isNone then [false, true] else [false]

/-- Every ACL subset of size ≤ 2 for every active cell, including requests from another tenant
and with another tenant's context, which `context_irrelevant` says must not change the answer.
Expired and missing shares answer 404 before the ACL is read, so a few rows suffice there. Each
negative atom is added alone to every active cell. -/
def shareScenarios : List (Option TenantId × String × Bool × (String × Request) × Acl) :=
  let active := shareTenants.flatMap fun τ => shareRequests.flatMap fun r =>
    (anonFlags r.2).flatMap fun anon =>
      (subsetsUpTo2 (shareAtoms τ)).map fun es => (τ, "active", anon, r, es)
  let expired := shareTenants.flatMap fun τ => shareRequests.flatMap fun r =>
    (anonFlags r.2).flatMap fun anon =>
      [[], (shareAtoms τ).take 1, ((shareAtoms τ).drop 1).take 1].map fun es =>
        (τ, "expired", anon, r, es)
  let missing := shareRequests.map fun r =>
    ((some "tenant-a" : Option TenantId), "missing", false, r, ([] : Acl))
  let negative := shareTenants.flatMap fun τ => shareRequests.flatMap fun r =>
    (anonFlags r.2).flatMap fun anon =>
      (negativeShareAtoms τ).map fun e => (τ, "active", anon, r, [e])
  active ++ expired ++ missing ++ negative

def shareLines : List String :=
  shareScenarios.zipIdx.map fun ((τ, state, anon, (label, req), es), i) =>
    shareLine i τ state anon label req es

def shareHeader (n : Nat) : String :=
  obj ([("schema", "2"), ("kind", q "shared-link"), ("vectors", toString n),
    ("requests", obj (shareRequests.map fun (label, r) =>
      (label, obj [("context", optStr r.context), ("viewer", viewerJson r.viewer)]))),
    ("groups", arr (shareGroupTable.map Group.json)),
    ("atoms", arr (shareAtomTable.map AclEntry.json))] ++ declarations)

/-- Bits: `1` VIEW, `3` VIEW and EDIT, `15` all four. Rows for the viewer, their role, groups and
public, then near misses: another tenant, another resource type, another resource. -/
def resourceAtoms (rt other : ResourceType) : List AclEntry :=
  let a : Option TenantId := some "tenant-a"
  [ ⟨.user viewerId, rt, targetId, 1#5, a⟩,
    ⟨.user viewerId, rt, targetId, 3#5, a⟩,
    ⟨.user viewerId, rt, targetId, 15#5, a⟩,
    ⟨.role "USER", rt, targetId, 1#5, a⟩,
    ⟨.group g1, rt, targetId, 1#5, a⟩,
    ⟨.group g2, rt, targetId, 15#5, a⟩,
    ⟨.pub, rt, targetId, 1#5, a⟩,
    ⟨.user viewerId, rt, targetId, 15#5, some "tenant-b"⟩,
    ⟨.user viewerId, other, targetId, 15#5, a⟩,
    ⟨.user viewerId, rt, otherId, 15#5, a⟩ ]

/-- Rows that must not grant the viewer: another user, a role or group they lack, bit 16 with VIEW
(`17`, which still covers VIEW), and a row with no tenant. -/
def negativeResourceAtoms (rt : ResourceType) : List AclEntry :=
  let a : Option TenantId := some "tenant-a"
  [ ⟨.user strangerId, rt, targetId, 15#5, a⟩,
    ⟨.role "ADMIN", rt, targetId, 15#5, a⟩,
    ⟨.group g3, rt, targetId, 15#5, a⟩,
    ⟨.user viewerId, rt, targetId, 17#5, a⟩,
    ⟨.user viewerId, rt, targetId, 15#5, none⟩ ]

def agentAtoms : List AclEntry := resourceAtoms "agent" "sharedLink"
def sharedLinkAtoms : List AclEntry := resourceAtoms "sharedLink" "agent"

def resourceAtomTable : List AclEntry :=
  (agentAtoms ++ sharedLinkAtoms ++ negativeResourceAtoms "agent" ++
    negativeResourceAtoms "sharedLink").eraseDups

def resourceGroups : List Group := groupsFor (some "tenant-a")

def resourceLine (i : Nat) (viewer : Option Viewer) (cap resolved : Bool) (rt : ResourceType)
    (need : Bits) (entries : Acl) : String :=
  let w : World := ⟨entries, resourceGroups, false⟩
  let out := decideResource w viewer cap (if resolved then some targetId else none) rt need
  obj [("id", toString i), ("viewer", viewerJson viewer), ("capability", toString cap),
    ("resolved", toString resolved), ("resourceType", q rt),
    ("required", toString need.toNat), ("entries", indexes resourceAtomTable entries),
    ("expected", q out.name)]

/-- The full four-bit grid for `agent`; `sharedLink` checks only that the resource type is passed
through, so VIEW with subsets of size ≤ 1 suffices there. -/
def resourceScenarios :
    List (Option Viewer × Bool × Bool × ResourceType × Bits × Acl) :=
  let va : Option Viewer := some viewerA
  let vn : Option Viewer := some viewerNone
  let types : List ResourceType := ["agent", "sharedLink"]
  let atoms (rt : ResourceType) := if rt = "agent" then agentAtoms else sharedLinkAtoms
  let needs : List Bits := [VIEW, EDIT, DELETE, SHARE]
  let agentRows := needs.flatMap fun need =>
    (subsetsUpTo2 agentAtoms).map fun es => (va, false, true, "agent", need, es)
  let sharedLinkRows := ((subsetsUpTo2 sharedLinkAtoms).filter fun es => es.length < 2).map
    fun es => (va, false, true, "sharedLink", VIEW, es)
  let unfilteredRows := (subsetsUpTo2 agentAtoms).map fun es =>
    (vn, false, true, "agent", VIEW, es)
  let capabilityRows := types.flatMap fun rt => [true, false].map fun resolved =>
    (va, true, resolved, rt, VIEW, ([] : Acl))
  let unresolvedRows := types.map fun rt =>
    (va, false, false, rt, VIEW, ((atoms rt).drop 2).take 1)
  let anonymousRows := types.flatMap fun rt => [true, false].map fun cap =>
    ((none : Option Viewer), cap, true, rt, VIEW, ((atoms rt).drop 2).take 1)
  let negativeRows := (needs.flatMap fun need =>
      (negativeResourceAtoms "agent").map fun e => (va, false, true, "agent", need, [e])) ++
    ((negativeResourceAtoms "sharedLink").map fun e =>
      (va, false, true, "sharedLink", VIEW, [e])) ++
    ((negativeResourceAtoms "agent").map fun e => (vn, false, true, "agent", VIEW, [e]))
  agentRows ++ sharedLinkRows ++ unfilteredRows ++ capabilityRows ++ unresolvedRows ++
    anonymousRows ++ negativeRows

def resourceLines : List String :=
  resourceScenarios.zipIdx.map fun ((v, cap, resolved, rt, need, es), i) =>
    resourceLine i v cap resolved rt need es

def resourceHeader (n : Nat) : String :=
  obj ([("schema", "2"), ("kind", q "resource"), ("vectors", toString n),
    ("groups", arr (resourceGroups.map Group.json)),
    ("atoms", arr (resourceAtomTable.map AclEntry.json))] ++ declarations)

def render (header : Nat → String) (lines : List String) : String :=
  "\n".intercalate (header lines.length :: lines) ++ "\n"

end Authz
