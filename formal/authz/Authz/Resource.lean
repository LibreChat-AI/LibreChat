import Authz.SharedLink

/-!
# Resource gate

`decideResource` is `canAccessResource`: sign-in, then the capability bypass, then ID resolution,
then one ACL check under the viewer's tenant. The capability result and the resolved ID are inputs;
how they are computed is outside the model. The request's tenant context is assumed to equal the
viewer's tenant, which `tenantContextMiddleware` guarantees for signed-in requests.
-/

namespace Authz

def userScope (v : Viewer) : Scope :=
  match v.tenant with
  | some t => .scoped t
  | none => .unfiltered

def decideResource (w : World) (viewer : Option Viewer) (hasCapability : Bool)
    (resolved : Option Nat) (rt : ResourceType) (need : Bits) : Outcome :=
  match viewer with
  | none => .unauthenticated
  | some v =>
    if hasCapability then .allow
    else
      match resolved with
      | none => .notFound
      | some r =>
        if checkPermission (userScope v) w.groups w.acl v.id (some v.role) rt r need then .allow
        else .forbidden

/-- The resource gate never allows an anonymous request. -/
theorem resource_allow_is_authenticated {w : World} {viewer : Option Viewer} {cap : Bool}
    {resolved : Option Nat} {rt : ResourceType} {need : Bits}
    (h : decideResource w viewer cap resolved rt need = .allow) : viewer.isSome = true := by
  cases viewer with
  | none => simp [decideResource] at h
  | some v => rfl

/-- Without the capability bypass, an allow is backed by a matching row in the viewer's scope. -/
theorem resource_allow_without_capability_has_grant {w : World} {v : Viewer}
    {resolved : Option Nat} {rt : ResourceType} {need : Bits}
    (h : decideResource w (some v) false resolved rt need = .allow) :
    ∃ r, resolved = some r ∧ ∃ e ∈ w.acl,
      e.resourceType = rt ∧ e.resource = r ∧ covers e.bits need = true ∧
        (userScope v).sees e.tenant = true ∧
        e.principal ∈ principals (userScope v) w.groups v.id (some v.role) := by
  cases resolved with
  | none => simp [decideResource] at h
  | some r =>
    refine ⟨r, rfl, ?_⟩
    have hc : checkPermission (userScope v) w.groups w.acl v.id (some v.role) rt r need = true := by
      cases hg : checkPermission (userScope v) w.groups w.acl v.id (some v.role) rt r need <;>
        simp [decideResource, hg] at h ⊢
    simp only [checkPermission, Bool.and_eq_true] at hc
    obtain ⟨e, he, happ, hcov⟩ := hasPermission_iff.mp hc.2
    obtain ⟨hsees, hmem, hrt, hr⟩ := applies_iff.mp happ
    exact ⟨e, he, hrt, hr, hcov, hsees, hmem⟩

/-- A tenanted viewer with no row of their own tenant is denied. -/
theorem resource_cross_tenant_denied {w : World} {v : Viewer} {t : TenantId} {r : Nat}
    {rt : ResourceType} {need : Bits} (hv : v.tenant = some t)
    (hrows : ∀ e ∈ w.acl, e.resourceType = rt → e.resource = r → e.tenant ≠ some t) :
    decideResource w (some v) false (some r) rt need ≠ .allow := by
  intro h
  obtain ⟨r', hr', e, he, hrt, hr, _, hsees, _⟩ := resource_allow_without_capability_has_grant h
  cases hr'
  have : e.tenant = some t := by simpa [userScope, hv, Scope.sees] using hsees
  exact hrows e he hrt hr this

/-- Other tenants' rows never change the decision for a tenanted viewer. -/
theorem resource_ignores_foreign_rows {w : World} {v : Viewer} {t : TenantId} {cap : Bool}
    {resolved : Option Nat} {rt : ResourceType} {need : Bits} (hv : v.tenant = some t) :
    decideResource w (some v) cap resolved rt need =
      decideResource { w with acl := w.acl.filter fun e => e.tenant == some t } (some v) cap
        resolved rt need := by
  cases resolved <;>
    simp [decideResource, checkPermission, userScope, hv, ← foreign_rows_irrelevant]

/-- With no row for the resource, the gate denies. -/
theorem resource_without_rows_denied {w : World} {v : Viewer} {r : Nat} {rt : ResourceType}
    {need : Bits} (h : ∀ e ∈ w.acl, ¬ (e.resourceType = rt ∧ e.resource = r)) :
    decideResource w (some v) false (some r) rt need ≠ .allow := by
  simp [decideResource, checkPermission, no_matching_row_denies h]

end Authz
