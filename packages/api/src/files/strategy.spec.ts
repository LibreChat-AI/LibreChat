import { FileContext, FileSources } from 'librechat-data-provider';
import { getFileStrategy } from './strategy';

test('generated video follows generated image storage while document and skill overrides retain their routing', () => {
  const config = {
    fileStrategy: FileSources.local,
    fileStrategies: {
      image: FileSources.s3,
      document: FileSources.azure_blob,
      skills: FileSources.firebase,
    },
  } as const;
  expect(getFileStrategy(config, { context: FileContext.video_generation })).toBe(FileSources.s3);
  expect(getFileStrategy(config, { context: FileContext.image_generation })).toBe(FileSources.s3);
  expect(getFileStrategy(config)).toBe(FileSources.azure_blob);
  expect(getFileStrategy(config, { context: FileContext.skill_file, isImage: true })).toBe(
    FileSources.firebase,
  );
  expect(
    getFileStrategy({ fileStrategy: FileSources.local }, { context: FileContext.video_generation }),
  ).toBe(FileSources.local);
});
