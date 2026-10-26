import * as skillExports from './index';

it('exports Skill upload helpers from the source barrel without a package build', () => {
  expect(typeof skillExports.withSkillUploadIntent).toBe('function');
  expect(typeof skillExports.reserveSkillBlob).toBe('function');
  expect(typeof skillExports.createSkillBlobReserver).toBe('function');
  expect(typeof skillExports.createSkillStorageResolver).toBe('function');
  expect(typeof skillExports.createSkillBufferWriter).toBe('function');
});
