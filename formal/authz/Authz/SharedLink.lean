import Authz.Model

/-!
# Shared-link gate

`decideView` is `createSharedLinkAccessMiddleware` (`packages/api/src/shared-links/access.ts`).
The share is looked up by its globally unique id under the request's tenant, then system-wide
when that misses, so a link resolves from any tenant and answers 404 only when it is missing or
expired. A public grant then admits every signed-in viewer, whatever their tenant ("Share with
everyone"), and anonymous requests only with `ALLOW_SHARED_LINKS_PUBLIC`. Otherwise the viewer
needs a VIEW grant of their own, checked under the share's tenant; their role counts only when
they belong to the share's tenant.
-/

namespace Authz

/-- HTTP outcomes: 2xx (`next()`), 404, 401 and 403. -/
inductive Outcome where
  | allow | notFound | unauthenticated | forbidden
  deriving DecidableEq, Repr

structure Viewer where
  id : Nat
  tenant : Option TenantId
  role : String
  deriving DecidableEq, Repr

/-- `context` is the request's tenant context (`getTenantId()`), `viewer` is `req.user`. -/
structure Request where
  context : Option TenantId
  viewer : Option Viewer
  deriving DecidableEq, Repr

structure Share where
  resource : Nat
  tenant : Option TenantId
  expired : Bool
  deriving DecidableEq, Repr

/-- The database state a decision reads, and the `ALLOW_SHARED_LINKS_PUBLIC` flag. -/
structure World where
  acl : Acl
  groups : List Group
  allowAnonymous : Bool

/-- ACL reads for a share run under the share's tenant (`runWithTenant`), or as system. -/
def shareScope (s : Share) : Scope :=
  match s.tenant with
  | some t => .scoped t
  | none => .unfiltered

/-- `access.ts` passes the viewer's role only when the share's tenant is the viewer's own, and
`null` otherwise, so a role name never crosses tenants. -/
def viewerRole (s : Share) (v : Viewer) : Option String :=
  if v.tenant = s.tenant then some v.role else none

def publicGranted (w : World) (s : Share) : Bool :=
  hasPermission (shareScope s) w.acl [Principal.pub] "sharedLink" s.resource VIEW

def privateGranted (w : World) (s : Share) (v : Viewer) : Bool :=
  checkPermission (shareScope s) w.groups w.acl v.id (viewerRole s v) "sharedLink" s.resource VIEW

/-- `share` is what the lookup returns; the request's tenant never hides an existing share. -/
def decideView (w : World) (share : Option Share) (r : Request) : Outcome :=
  match share with
  | none => .notFound
  | some s =>
    if s.expired then .notFound
    else if publicGranted w s then
      if w.allowAnonymous then .allow
      else
        match r.viewer with
        | none => .unauthenticated
        | some _ => .allow
    else
      match r.viewer with
      | none => .unauthenticated
      | some v => if privateGranted w s v then .allow else .forbidden

/-- `POST /:shareId/fork` runs `requireJwtAuth` first, which sets the context to the user's
tenant. -/
def decideFork (w : World) (share : Option Share) (viewer : Option Viewer) : Outcome :=
  match viewer with
  | none => .unauthenticated
  | some v => decideView w share ⟨v.tenant, some v⟩

/-- The request's tenant context never changes a decision: the fallback lookup resolves the
share from any tenant, and every ACL read runs under the share's own tenant. -/
theorem context_irrelevant {w : World} {share : Option Share} {c₁ c₂ : Option TenantId}
    {viewer : Option Viewer} : decideView w share ⟨c₁, viewer⟩ = decideView w share ⟨c₂, viewer⟩ :=
  rfl

/-- A missing or expired share answers 404 to everyone. -/
theorem inactive_share_not_found {w : World} {share : Option Share} {r : Request}
    (h : share = none ∨ ∃ s, share = some s ∧ s.expired = true) :
    decideView w share r = .notFound := by
  rcases h with rfl | ⟨s, rfl, he⟩
  · rfl
  · simp [decideView, he]

theorem active_of_allow {w : World} {s : Share} {r : Request}
    (h : decideView w (some s) r = .allow) : s.expired = false := by
  cases he : s.expired
  · rfl
  · simp [decideView, he] at h

/-- An allowed view names an existing, unexpired share. -/
theorem view_allow_requires_active_share {w : World} {share : Option Share} {r : Request}
    (h : decideView w share r = .allow) : ∃ s, share = some s ∧ s.expired = false := by
  cases share with
  | none => simp [decideView] at h
  | some s => exact ⟨s, rfl, active_of_allow h⟩

/-- An anonymous allow needs `ALLOW_SHARED_LINKS_PUBLIC` and a public grant. -/
theorem anonymous_allow_requires_public_flag {w : World} {s : Share} {ctx : Option TenantId}
    (h : decideView w (some s) ⟨ctx, none⟩ = .allow) :
    w.allowAnonymous = true ∧ publicGranted w s = true := by
  have he := active_of_allow h
  cases hp : publicGranted w s <;> cases ha : w.allowAnonymous <;>
    simp [decideView, he, hp, ha] at h ⊢

/-- Without a public grant, an anonymous request is asked to sign in, flag or not. -/
theorem anonymous_private_is_unauthenticated {w : World} {s : Share} {ctx : Option TenantId}
    (he : s.expired = false) (hp : publicGranted w s = false) :
    decideView w (some s) ⟨ctx, none⟩ = .unauthenticated := by
  simp [decideView, he, hp]

/-- With `ALLOW_SHARED_LINKS_PUBLIC` off, every allow is signed in. -/
theorem allow_without_anonymous_flag_is_authenticated {w : World} {share : Option Share}
    {r : Request} (hf : w.allowAnonymous = false) (h : decideView w share r = .allow) :
    r.viewer.isSome = true := by
  obtain ⟨ctx, viewer⟩ := r
  cases viewer with
  | some v => rfl
  | none =>
    obtain ⟨s, rfl, _⟩ := view_allow_requires_active_share h
    have := (anonymous_allow_requires_public_flag h).1
    simp [hf] at this

/-- A public grant admits every signed-in viewer, from any tenant: the "Share with everyone"
contract of the share dialog. -/
theorem public_grant_admits_signed_in_viewer {w : World} {s : Share} {r : Request} {v : Viewer}
    (he : s.expired = false) (hp : publicGranted w s = true) (hv : r.viewer = some v) :
    decideView w (some s) r = .allow := by
  obtain ⟨ctx, viewer⟩ := r
  cases hv
  cases ha : w.allowAnonymous <;> simp [decideView, he, hp, ha]

/-- A viewer's own grant admits them. -/
theorem private_grant_admits_viewer {w : World} {s : Share} {r : Request} {v : Viewer}
    (he : s.expired = false) (hg : privateGranted w s v = true) (hv : r.viewer = some v) :
    decideView w (some s) r = .allow := by
  obtain ⟨ctx, viewer⟩ := r
  cases hv
  cases hp : publicGranted w s <;> cases ha : w.allowAnonymous <;>
    simp [decideView, he, hp, ha, hg]

/-- A viewer outside the share's tenant gets the same answer whatever their role is called. -/
theorem cross_tenant_role_irrelevant {w : World} {s : Share} {ctx : Option TenantId} {v : Viewer}
    (ht : v.tenant ≠ s.tenant) (role : String) :
    decideView w (some s) ⟨ctx, some v⟩ = decideView w (some s) ⟨ctx, some { v with role }⟩ := by
  have : privateGranted w s v = privateGranted w s { v with role } := by
    simp [privateGranted, viewerRole, ht]
  simp [decideView, this]

/-- Allowed without a public grant means a VIEW row in the share's scope for the viewer, for their
role when they belong to the share's tenant, or for an in-scope group listing them. -/
theorem private_allow_has_grant {w : World} {s : Share} {r : Request} {v : Viewer}
    (hv : r.viewer = some v) (hp : publicGranted w s = false)
    (h : decideView w (some s) r = .allow) :
    ∃ e ∈ w.acl,
      e.resourceType = "sharedLink" ∧ e.resource = s.resource ∧ covers e.bits VIEW = true ∧
        (shareScope s).sees e.tenant = true ∧
        (e.principal = .user v.id ∨ (v.tenant = s.tenant ∧ e.principal = .role v.role) ∨
          ∃ g ∈ w.groups,
            e.principal = .group g.id ∧ (shareScope s).sees g.tenant = true ∧
              v.id ∈ g.members) := by
  have he := active_of_allow h
  obtain ⟨ctx, viewer⟩ := r
  cases hv
  have hpriv : privateGranted w s v = true := by
    cases hg : privateGranted w s v <;> simp [decideView, he, hp, hg] at h ⊢
  simp only [privateGranted, checkPermission, Bool.and_eq_true] at hpriv
  obtain ⟨e, hmemacl, happ, hc⟩ := hasPermission_iff.mp hpriv.2
  obtain ⟨hsees, hmem, hrt, hr⟩ := applies_iff.mp happ
  refine ⟨e, hmemacl, hrt, hr, hc, hsees, ?_⟩
  simp only [principals, List.mem_cons, List.mem_append, List.mem_map, List.mem_filter,
    Bool.and_eq_true, List.contains_iff_mem, Option.mem_toList, List.not_mem_nil, or_false]
    at hmem
  rcases hmem with hu | ((⟨r, hr', hrole⟩ | ⟨g, ⟨hg, hgs, hgm⟩, hgp⟩) | hpub)
  · exact Or.inl hu
  · unfold viewerRole at hr'
    by_cases ht : v.tenant = s.tenant
    · simp only [ht, ite_true, Option.some.injEq] at hr'
      subst hr'
      exact Or.inr (Or.inl ⟨ht, hrole.symm⟩)
    · simp [ht] at hr'
  · exact Or.inr (Or.inr ⟨g, hg, hgp.symm, hgs, hgm⟩)
  · exfalso
    have : publicGranted w s = true :=
      hasPermission_iff.mpr ⟨e, hmemacl, applies_iff.mpr ⟨hsees, by simp [hpub], hrt, hr⟩, hc⟩
    simp [hp] at this

/-- On a tenant's share, rows of every other tenant never change a decision. -/
theorem share_ignores_foreign_rows {w : World} {s : Share} {r : Request} {t : TenantId}
    (ht : s.tenant = some t) :
    decideView w (some s) r =
      decideView { w with acl := w.acl.filter fun e => e.tenant == some t } (some s) r := by
  have hpub : publicGranted w s =
      publicGranted { w with acl := w.acl.filter fun e => e.tenant == some t } s := by
    simp only [publicGranted, shareScope, ht]
    exact foreign_rows_irrelevant
  have hpriv : ∀ v, privateGranted w s v =
      privateGranted { w with acl := w.acl.filter fun e => e.tenant == some t } s v := by
    intro v
    simp only [privateGranted, checkPermission, shareScope, ht]
    rw [← foreign_rows_irrelevant]
  obtain ⟨ctx, viewer⟩ := r
  cases viewer <;> simp only [decideView, hpub, hpriv]

/-- Continue allows only a signed-in viewer whose view is allowed under their own tenant. -/
theorem fork_allow_is_authenticated_view {w : World} {share : Option Share}
    {viewer : Option Viewer} (h : decideFork w share viewer = .allow) :
    ∃ v, viewer = some v ∧ decideView w share ⟨v.tenant, some v⟩ = .allow := by
  cases viewer with
  | none => simp [decideFork] at h
  | some v => exact ⟨v, rfl, by simpa [decideFork] using h⟩

/-- With no row for the share, no request is allowed. -/
theorem revoked_share_denies_everyone {w : World} {s : Share} {r : Request}
    (h : ∀ e ∈ w.acl, ¬ (e.resourceType = "sharedLink" ∧ e.resource = s.resource)) :
    decideView w (some s) r ≠ .allow := by
  intro hallow
  have he := active_of_allow hallow
  have hpub : publicGranted w s = false := no_matching_row_denies h
  have hpriv : ∀ v, privateGranted w s v = false := fun v => by
    simp [privateGranted, checkPermission, no_matching_row_denies h]
  obtain ⟨ctx, viewer⟩ := r
  cases viewer with
  | none => simp [decideView, he, hpub] at hallow
  | some v => simp [decideView, he, hpub, hpriv v] at hallow

end Authz
