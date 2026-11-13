import { getSubmittedSupportContact, getSupportContactFormValues } from './contact';

describe('MCP support contact form mapping', () => {
  it('prepopulates both configured values', () => {
    expect(
      getSupportContactFormValues({ name: 'Platform Team', email: 'platform@example.com' }),
    ).toEqual({ name: 'Platform Team', email: 'platform@example.com' });
  });

  it('uses empty defaults when contact values are absent', () => {
    expect(getSupportContactFormValues()).toEqual({ name: '', email: '' });
    expect(getSupportContactFormValues({ name: 'Support' })).toEqual({
      name: 'Support',
      email: '',
    });
  });

  it.each([
    [{ name: 'Support Team', email: '' }, { name: 'Support Team' }],
    [{ name: '', email: 'support@example.com' }, { email: 'support@example.com' }],
    [
      { name: ' Support Team ', email: ' support@example.com ' },
      { name: 'Support Team', email: 'support@example.com' },
    ],
  ])('submits independent non-empty values', (values, expected) => {
    expect(getSubmittedSupportContact(values)).toEqual(expected);
  });

  it('omits the contact after both values are cleared', () => {
    expect(getSubmittedSupportContact({ name: '', email: '' })).toBeUndefined();
    expect(getSubmittedSupportContact({ name: '  ', email: '  ' })).toBeUndefined();
  });
});
