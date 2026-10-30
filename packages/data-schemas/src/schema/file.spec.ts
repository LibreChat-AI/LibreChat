import { model, models } from 'mongoose';
import fileSchema from './file';

it('persists the PDF page and text counts that price a provider-read PDF', () => {
  const File = models.PdfCountsFile ?? model('PdfCountsFile', fileSchema);
  const doc = new File({ metadata: { pageCount: 40, textChars: 271_780, bogus: 1 } });
  expect(doc.toObject().metadata).toEqual({ pageCount: 40, textChars: 271_780 });
});
