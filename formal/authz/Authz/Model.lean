/-!
# ACL primitives

The data every decision reads: ACL rows, groups, tenant scopes and permission bits, plus the two
database checks built on them. Each definition mirrors one function in `packages/data-schemas`
(see the README's "Model ↔ code" table). A theorem here is a statement checked by Lean for every
possible input, not a test of selected inputs.
-/

namespace Authz

abbrev TenantId := String

/-- The `resourceType` string stored on ACL rows (`ResourceType` in librechat-data-provider). -/
abbrev ResourceType := String

/-- Who an ACL row grants to (`PrincipalType` in librechat-data-provider). -/
inductive Principal where
  | user (id : Nat)
  | group (id : Nat)
  | role (name : String)
  | pub
  deriving DecidableEq, Repr

/-- `PermissionBits`: five flags packed into a number, as `permBits` stores them. -/
abbrev Bits := BitVec 5
def VIEW : Bits := 1#5
def EDIT : Bits := 2#5
def DELETE : Bits := 4#5
def SHARE : Bits := 8#5
def VIEW_INSIGHTS : Bits := 16#5

/-- One ACL row: `principal` holds `bits` on `resource` of `resourceType`, owned by `tenant`. -/
structure AclEntry where
  principal : Principal
  resourceType : ResourceType
  resource : Nat
  bits : Bits
  tenant : Option TenantId
  deriving DecidableEq, Repr

abbrev Acl := List AclEntry

/-- The tenant filter a query runs under: one tenant, or none (system context, or strict mode
off). -/
inductive Scope where
  | scoped (t : TenantId)
  | unfiltered
  deriving DecidableEq, Repr

def Scope.sees : Scope → Option TenantId → Bool
  | .scoped t, row => row == some t
  | .unfiltered, _ => true

structure Group where
  id : Nat
  tenant : Option TenantId
  members : List Nat
  deriving DecidableEq, Repr

/-- Everyone a user acts as: themself, their role, the in-scope groups listing them, and public. -/
def principals (scope : Scope) (groups : List Group) (userId : Nat) (role : Option String) :
    List Principal :=
  Principal.user userId ::
    (role.toList.map Principal.role
      ++ ((groups.filter fun g => scope.sees g.tenant && g.members.contains userId).map
            fun g => Principal.group g.id)
      ++ [Principal.pub])

/-- A row covers a requirement when it holds every required bit. -/
def covers (granted need : Bits) : Bool := granted &&& need == need

def applies (scope : Scope) (ps : List Principal) (rt : ResourceType) (r : Nat) (e : AclEntry) :
    Bool :=
  scope.sees e.tenant && ps.contains e.principal && e.resourceType == rt && e.resource == r

/-- Some single row the principals hold covers every required bit. -/
def hasPermission (scope : Scope) (acl : Acl) (ps : List Principal) (rt : ResourceType) (r : Nat)
    (need : Bits) : Bool :=
  acl.any fun e => applies scope ps rt r e && covers e.bits need

/-- The OR of the bits of every matching row. -/
def effective (scope : Scope) (acl : Acl) (ps : List Principal) (rt : ResourceType) (r : Nat) :
    Bits :=
  (acl.filter (applies scope ps rt r)).foldl (fun acc e => acc ||| e.bits) 0

/-- `need = 0` never passes; the code rejects it earlier (`PermissionService` throws). -/
def checkPermission (scope : Scope) (groups : List Group) (acl : Acl) (userId : Nat)
    (role : Option String) (rt : ResourceType) (r : Nat) (need : Bits) : Bool :=
  need != 0 && hasPermission scope acl (principals scope groups userId role) rt r need

theorem hasPermission_iff {scope : Scope} {acl : Acl} {ps : List Principal} {rt : ResourceType}
    {r : Nat} {need : Bits} :
    hasPermission scope acl ps rt r need = true ↔
      ∃ e ∈ acl, applies scope ps rt r e = true ∧ covers e.bits need = true := by
  simp [hasPermission, List.any_eq_true]

theorem applies_iff {scope : Scope} {ps : List Principal} {rt : ResourceType} {r : Nat}
    {e : AclEntry} :
    applies scope ps rt r e = true ↔
      scope.sees e.tenant = true ∧ e.principal ∈ ps ∧ e.resourceType = rt ∧ e.resource = r := by
  simp [applies, and_assoc]

/-- Under a tenant scope, every grant comes from a row of that tenant. -/
theorem scoped_grant_is_tenant_row {t : TenantId} {acl : Acl} {ps : List Principal}
    {rt : ResourceType} {r : Nat} {need : Bits} :
    hasPermission (.scoped t) acl ps rt r need = true →
      ∃ e ∈ acl, e.tenant = some t ∧ e.principal ∈ ps ∧ e.resourceType = rt ∧ e.resource = r := by
  rw [hasPermission_iff]
  rintro ⟨e, he, happ, _⟩
  rw [applies_iff] at happ
  refine ⟨e, he, ?_, happ.2.1, happ.2.2.1, happ.2.2.2⟩
  simpa [Scope.sees] using happ.1

/-- Deleting every other tenant's rows never changes a tenant-scoped decision. -/
theorem foreign_rows_irrelevant {t : TenantId} {acl : Acl} {ps : List Principal}
    {rt : ResourceType} {r : Nat} {need : Bits} :
    hasPermission (.scoped t) acl ps rt r need =
      hasPermission (.scoped t) (acl.filter fun e => e.tenant == some t) ps rt r need := by
  rw [Bool.eq_iff_iff, hasPermission_iff, hasPermission_iff]
  constructor
  · rintro ⟨e, he, happ, hc⟩
    refine ⟨e, ?_, happ, hc⟩
    rw [applies_iff] at happ
    simp only [List.mem_filter]
    exact ⟨he, by simpa [Scope.sees] using happ.1⟩
  · rintro ⟨e, he, happ, hc⟩
    exact ⟨e, (List.mem_filter.mp he).1, happ, hc⟩

/-- With no row for the resource, nothing is granted. -/
theorem no_matching_row_denies {scope : Scope} {acl : Acl} {ps : List Principal}
    {rt : ResourceType} {r : Nat} {need : Bits}
    (h : ∀ e ∈ acl, ¬ (e.resourceType = rt ∧ e.resource = r)) :
    hasPermission scope acl ps rt r need = false := by
  rw [Bool.eq_false_iff]
  intro hp
  rw [hasPermission_iff] at hp
  obtain ⟨e, he, happ, _⟩ := hp
  rw [applies_iff] at happ
  exact h e he ⟨happ.2.2.1, happ.2.2.2⟩

end Authz
