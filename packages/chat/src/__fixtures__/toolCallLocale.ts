/** Translations the tool call card specs assert against. */
export function translate(key: string, values?: Record<string, string | number>): string {
  const subject = values?.[0];
  const translations: Record<string, string> = {
    com_assistants_function_use: `Used ${subject}`,
    com_assistants_completed_function: `Completed ${subject}`,
    com_assistants_completed_action: `Completed action on ${subject}`,
    com_assistants_running_var: `Running ${subject}`,
    com_assistants_running_action: 'Running action',
    com_ui_tool_preparing: `Preparing ${subject}`,
    com_ui_tool_calling: `Calling ${subject}`,
    com_ui_sign_in_to_domain: `Sign in to ${subject}`,
    com_ui_cancelled: 'Cancelled',
    com_ui_requires_auth: 'Requires authentication',
    com_assistants_allow_sites_you_trust: 'Only allow sites you trust',
    com_ui_via_server: `via ${subject}`,
    com_ui_tool_failed: 'failed',
    com_ui_tool_name_set_memory: 'Save Memory',
  };
  return translations[key] ?? key;
}
