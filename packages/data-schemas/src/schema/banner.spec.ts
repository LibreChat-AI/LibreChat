import { model, models } from 'mongoose';
import bannerSchema from './banner';

const Banner = models.BannerVariantSpec ?? model('BannerVariantSpec', bannerSchema);

const baseBanner = { bannerId: 'banner-1', message: 'Scheduled maintenance tonight' };

describe('bannerSchema variant', () => {
  it('is optional', () => {
    const banner = new Banner(baseBanner);
    expect(banner.validateSync()).toBeUndefined();
    expect(banner.toObject().variant).toBeUndefined();
  });

  it.each(['info', 'success', 'warning', 'error', 'neutral'])('accepts %s', (variant) => {
    expect(new Banner({ ...baseBanner, variant }).validateSync()).toBeUndefined();
  });

  it('rejects an unknown variant', () => {
    const error = new Banner({ ...baseBanner, variant: 'purple' }).validateSync();
    expect(error?.errors.variant).toBeDefined();
  });
});
