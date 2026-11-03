/** Subset of a TSPI Brain `get_treatment_plan` record that the PDF report renders. */

export interface TspiActor {
  id?: string;
  name?: string | null;
  role?: string | null;
  at?: string | null;
  decision?: string | null;
}

export interface TspiSignal {
  concept?: string | null;
  direction?: string | null;
  source?: string | null;
  evidence_status?: string | null;
}

export interface TspiAxisScore {
  axis_code?: string | null;
  axis_name?: string | null;
  domain_code?: string | null;
  severity?: string | null;
  is_driver?: boolean | null;
  evidence?: string[] | null;
  score?: number | null;
  status?: string | null;
  evidence_status?: string | null;
  confidence_label?: string | null;
}

export interface TspiSymptom {
  name?: string | null;
}

export interface TspiPhenotype {
  phenotype_name_en?: string | null;
  confidence?: number | null;
  status?: string | null;
}

export interface TspiRedFlagScreen {
  screened?: boolean | null;
  red_flags?: Array<string | { name?: string; flag?: string; description?: string }> | null;
  critical_values?: Array<string | { name?: string; value?: string; description?: string }> | null;
  required_action?: string | null;
}

/** A lab result the engine kept but did not use for scoring, and why (`unmapped_labs`). */
export interface TspiUnmappedLab {
  analyte?: string | null;
  value?: number | string | null;
  unit?: string | null;
  flag?: string | null;
  reason?: string | null;
  detail?: string | null;
}

export interface TspiAnalysis {
  signals?: TspiSignal[] | null;
  unmapped_labs?: TspiUnmappedLab[] | null;
  axis_scores?: TspiAxisScore[] | null;
  severity_name?: string | null;
  nine_step_position?: number | null;
  prakati_gap?: string | null;
  phenotype?: {
    symptoms_identified?: TspiSymptom[] | null;
    phenotypes?: TspiPhenotype[] | null;
  } | null;
}

export interface TspiModule {
  module_code?: string | null;
  module_name?: string | null;
  target_axes?: string[] | null;
  dose?: string | null;
  clinical_role?: string | null;
  tier?: string | null;
  phase?: string | null;
  safety?: string | null;
  safety_outcome?: string | null;
  contraindications?: string[] | null;
  evidence_grade?: string | null;
}

export interface TspiNetwork {
  network_code?: string | null;
  name?: string | null;
  primary_axis?: string | null;
  mapping_status?: string | null;
}

export interface TspiSafetyAlert {
  message?: string | null;
  description?: string | null;
  /** The engine's own field for the alert text. */
  reason?: string | null;
  severity?: string | null;
}

export interface TspiEdit {
  action?: string | null;
  target?: string | null;
  module_code?: string | null;
  axis_code?: string | null;
  reason_code?: string | null;
  rationale?: string | null;
}

export interface TspiPlanPayload {
  analysis?: TspiAnalysis | null;
  modules?: TspiModule[] | null;
  monitoring?: Array<{ reassess_every_days?: number[] | null }> | null;
  safety_alerts?: Array<string | TspiSafetyAlert> | null;
  report_markdown?: string | null;
  disclaimer?: string | null;
  pilot_notice?: string | null;
  framework_version?: string | null;
  red_flag_screen?: TspiRedFlagScreen | null;
  networks?: TspiNetwork[] | null;
  nss_detail?: { overall_confidence_label?: string | null } | null;
  edits?: TspiEdit[] | null;
  created_by?: TspiActor | null;
  approved_by?: TspiActor | null;
  /** Patient view: the engine withholds modules and doses until a doctor approves and releases the plan. */
  plan_hidden?: boolean | null;
  plan_hidden_reason?: string | null;
}

export interface TspiPlanRecord {
  id: string;
  case_id?: string | null;
  status?: string | null;
  nss?: number | null;
  severity_level?: number | null;
  deliverable?: boolean | null;
  safety_alerts?: Array<string | TspiSafetyAlert> | null;
  payload: TspiPlanPayload;
}

export type TspiApproval = 'approved' | 'rejected' | 'draft';

export interface TspiViewer {
  role: string;
}

export interface TspiReportFile {
  filename: string;
  buffer: Buffer;
}
