import Authz.Model

namespace Authz

/-!
# One row or many?

The code grants when one row holds every required bit (`hasPermission`); the permissions screen
shows the OR of all rows (`effective`). `single_bit_agrees` proves the two agree whenever the
requirement is a single bit, and `multi_bit_gap` shows they can differ for two bits, which is why
`packages/api/src/acl/bits.test.ts` keeps production requirements single-bit. Bit facts are
checked by `decide`, which tries all 32 values, so no extra axioms are needed.
-/

/-- The single-bit permissions in `PermissionBits`. -/
def SingleBit (b : Bits) : Prop :=
  b = VIEW ∨ b = EDIT ∨ b = DELETE ∨ b = SHARE ∨ b = VIEW_INSIGHTS

theorem covers_single_bit {b : Bits} (hb : SingleBit b) (x : Bits) :
    covers x b = true ↔ x &&& b ≠ 0 := by
  rcases hb with rfl | rfl | rfl | rfl | rfl <;> revert x <;> decide

theorem or_and_single_bit {b : Bits} (hb : SingleBit b) (a x : Bits) :
    (a ||| x) &&& b ≠ 0 ↔ a &&& b ≠ 0 ∨ x &&& b ≠ 0 := by
  rcases hb with rfl | rfl | rfl | rfl | rfl <;> revert a x <;> decide

theorem foldl_or_and {b : Bits} (hb : SingleBit b) (l : List AclEntry) (acc : Bits) :
    (l.foldl (fun acc e => acc ||| e.bits) acc) &&& b ≠ 0 ↔
      acc &&& b ≠ 0 ∨ ∃ e ∈ l, e.bits &&& b ≠ 0 := by
  induction l generalizing acc with
  | nil => simp
  | cons e es ih =>
    rw [List.foldl_cons, ih, or_and_single_bit hb]
    constructor
    · rintro ((h | h) | ⟨x, hx, h⟩)
      · exact Or.inl h
      · exact Or.inr ⟨e, List.mem_cons_self, h⟩
      · exact Or.inr ⟨x, List.mem_cons_of_mem _ hx, h⟩
    · rintro (h | ⟨x, hx, h⟩)
      · exact Or.inl (Or.inl h)
      · rcases List.mem_cons.mp hx with rfl | hx
        · exact Or.inl (Or.inr h)
        · exact Or.inr ⟨x, hx, h⟩

/-- For a single-bit requirement, "one row covers it" equals "the OR of rows has it". -/
theorem single_bit_agrees {scope : Scope} {acl : Acl} {ps : List Principal} {rt : ResourceType}
    {r : Nat} {b : Bits} (hb : SingleBit b) :
    hasPermission scope acl ps rt r b = true ↔ effective scope acl ps rt r &&& b ≠ 0 := by
  rw [hasPermission_iff, effective, foldl_or_and hb]
  constructor
  · rintro ⟨e, he, happ, hc⟩
    exact Or.inr ⟨e, List.mem_filter.mpr ⟨he, happ⟩, (covers_single_bit hb _).mp hc⟩
  · rintro (h | ⟨e, he, hc⟩)
    · exact absurd (by simp) h
    · exact ⟨e, (List.mem_filter.mp he).1, (List.mem_filter.mp he).2,
        (covers_single_bit hb _).mpr hc⟩

/-- VIEW from one row and EDIT from another: effective `3`, yet no row covers `3`. -/
theorem multi_bit_gap :
    ∃ (acl : Acl) (ps : List Principal),
      effective .unfiltered acl ps "agent" 1 = 3#5 ∧
        hasPermission .unfiltered acl ps "agent" 1 3#5 = false :=
  ⟨[⟨.user 1, "agent", 1, VIEW, none⟩, ⟨.pub, "agent", 1, EDIT, none⟩], [.user 1, .pub],
    by decide, by decide⟩

end Authz
