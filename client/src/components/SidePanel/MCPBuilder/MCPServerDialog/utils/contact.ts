import type { SupportContact } from 'librechat-data-provider';

export type SupportContactFormValues = {
  name: string;
  email: string;
};

export function getSupportContactFormValues(contact?: SupportContact): SupportContactFormValues {
  return {
    name: contact?.name ?? '',
    email: contact?.email ?? '',
  };
}

export function getSubmittedSupportContact(
  values: SupportContactFormValues,
): SupportContact | undefined {
  const name = values.name.trim();
  const email = values.email.trim();
  if (!name && !email) {
    return undefined;
  }
  return {
    ...(name && { name }),
    ...(email && { email }),
  };
}
