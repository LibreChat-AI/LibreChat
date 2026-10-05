import { useCallback, useEffect, useState } from 'react';
import Cookies from 'js-cookie';
import { useRecoilState } from 'recoil';
import { useQuery } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import type { FieldPath } from 'react-hook-form';
import useGeolocation from '~/hooks/useGeolocation';
import { SearchableSelect, SearchableMultiSelect } from '~/components/ui';
import LogoutConfirmModal from '~/components/ui/LogoutConfirmModal';
import { LangSelector } from '~/components/Nav/SettingsTabs/General/General';
import {
  OGDialog,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
  Input,
  Label,
  Button,
} from '@librechat/client';
import {
  LogOut,
  User,
  Leaf,
  Smartphone,
  Landmark,
  MapPin,
  Check,
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
} from 'lucide-react';
import { dataService } from 'librechat-data-provider';
import type { IFarmerProfile } from 'librechat-data-provider';
import { useSaveFarmerProfileMutation } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';
import { CropPickerModal } from './CropPickerModal';

// ── Form Types ───────────────────────────────────────────────────────────────

type FarmerProfileForm = {
  farmerName: string;
  age: number;
  gender: string;
  state: string;
  customState: string;
  district: string;
  customDistrict: string;
  blockName: string;
  customBlock: string;
  villageName: string;
  customVillage: string;
  nearestKVK: string;
  customKVK: string;
  phoneNo: string;
  languagePreference: string;
  yearsOfExperience: number;
  primaryCrop: string;
  secondaryCrop: string;
  awarenessOfKCC: string;
  usesAgriApps: string;
  highestEducatedPerson: string;
  numberOfSmartphones: number;
  location?: {
    latitude: number;
    longitude: number;
  };
  landhold: string;
};

// ── Shared controls ──────────────────────────────────────────────────────────

type ChoiceOption = { label: string; value: string };

/** Tappable option cards in place of a dropdown or a radio row. A real radio input sits
 *  inside each card, visually hidden, so arrow-key navigation, form semantics and screen
 *  reader announcements all behave natively while the card carries the styling. */
function ChoiceCards({
  name,
  options,
  value,
  onChange,
  gridClassName = 'grid-cols-2 sm:grid-cols-3',
}: {
  name: string;
  options: ChoiceOption[];
  value?: string;
  onChange: (value: string) => void;
  /** Column layout for this field; long labels want fewer columns. */
  gridClassName?: string;
}) {
  return (
    <div className={cn('mt-1.5 grid gap-2', gridClassName)}>
      {options.map((option) => {
        const isSelected = value === option.value;
        return (
          <label
            key={option.value}
            className={cn(
              'flex min-h-[46px] cursor-pointer items-center justify-center rounded-xl border px-3 py-2.5',
              'text-center text-sm transition-colors',
              'focus-within:ring-2 focus-within:ring-green-600/40',
              isSelected
                ? 'border-green-600 bg-green-500/10 font-semibold text-green-700 dark:border-green-400 dark:bg-green-400/10 dark:text-green-400'
                : 'border-border-medium bg-transparent text-text-primary hover:bg-surface-hover',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={isSelected}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

/** Minus/plus stepper for small whole-number counts. The number input stays in the middle
 *  rather than being replaced by a read-only display, so it remains the accessible control
 *  and anyone who prefers typing still can; the buttons just save opening a keyboard. */
function CountStepper({
  id,
  value,
  onChange,
  min = 0,
  max = 20,
}: {
  id: string;
  value?: number;
  /** Undefined when the field is cleared, so the `required` rule reports it as missing
   *  rather than a stray NaN falling through to the whole-number rule. */
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
}) {
  const current = Number.isFinite(value) ? (value as number) : min;
  const stepButtonClass =
    'flex size-12 shrink-0 items-center justify-center rounded-xl border border-border-medium bg-transparent text-text-primary transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-600/40 disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div className="mt-1.5 flex items-center gap-2">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        disabled={current <= min}
        onClick={() => onChange(Math.max(min, current - 1))}
        className={stepButtonClass}
      >
        <Minus className="size-4" />
      </button>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={Number.isFinite(value) ? value : ''}
        onChange={(event) =>
          onChange(
            Number.isNaN(event.target.valueAsNumber) ? undefined : event.target.valueAsNumber,
          )
        }
        className="h-12 w-full min-w-0 rounded-xl border border-border-medium bg-transparent text-center text-base font-semibold text-text-primary transition-colors focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
      />
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        disabled={current >= max}
        onClick={() => onChange(Math.min(max, current + 1))}
        className={stepButtonClass}
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

/** Footer actions. Brand green in both themes: the `surface-submit` token resolves to the
 *  pale mint in light mode, where white label text on it falls under the contrast minimum. */
const PRIMARY_ACTION_CLASS = cn(
  'inline-flex h-12 w-full items-center justify-center rounded-full px-6 text-sm font-semibold',
  'bg-green-600 text-white',
  'shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_2px_8px_-2px_rgba(25,135,84,0.5)]',
  'dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_2px_10px_-2px_rgba(117,215,178,0.3)]',
  'transition-[background-color,box-shadow,transform,opacity] duration-200 hover:opacity-90',
  'active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-600/50',
  'sm:w-auto sm:min-w-[9rem]',
);

const SECONDARY_ACTION_CLASS = cn(
  'inline-flex h-12 w-full items-center justify-center rounded-full px-6 text-sm font-medium',
  'border border-border-medium bg-transparent text-text-primary',
  'transition-colors duration-200 hover:bg-surface-hover',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'sm:w-auto sm:min-w-[7rem]',
);

// ── Component ────────────────────────────────────────────────────────────────



function FieldError({ message }: { message?: string }) {
  if (!message) return null;

  return (
    <p className="mt-1 text-xs text-rose-600" role="alert">
      {message}
    </p>
  );
}

function CropSelector({
  crops,
  onClick,
  error,
}: {
  crops: string[];
  onClick: () => void;
  error?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        variant="outline"
        onClick={onClick}
        className="h-10 w-full justify-start font-normal"
      >
        {crops.length
          ? `${crops.length} crop${crops.length === 1 ? '' : 's'} selected`
          : 'Select crops'}
      </Button>
      {crops.length > 0 && (
        <p className="line-clamp-2 text-xs text-text-secondary">{crops.join(', ')}</p>
      )}
      <FieldError message={error} />
    </div>
  );
}

const FarmerProfileModal = ({
  open,
  onOpenChange,
  onComplete,
  onDecline,
}: {
  open: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onComplete: () => void;
  onDecline: () => void;
}) => {
  const localize = useLocalize();
  const { logout } = useAuthContext();
  const [langcode, setLangcode] = useRecoilState(store.lang);
  const [currentSection, setCurrentSection] = useState(0);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    setValue,
    trigger,
    formState: { errors },
  } = useForm<FarmerProfileForm>({ mode: 'onChange' });

  const { isLocating, locationError, getLocation } = useGeolocation({
    onSuccess: (latitude, longitude) => {
      setValue('location.latitude', latitude, { shouldValidate: true });
      setValue('location.longitude', longitude, { shouldValidate: true });
    },
  });

  const [cropPickerField, setCropPickerField] = useState<'primaryCrop' | 'secondaryCrop' | null>(null);

  const selectedState = watch('state');
  const selectedDistrict = watch('district');
  const selectedBlock = watch('blockName');
  const selectedVillage = watch('villageName');
  const selectedPrimaryCrop = watch('primaryCrop');
  const selectedSecondaryCrop = watch('secondaryCrop');

  const selectedPrimaryCropList = selectedPrimaryCrop
    ? selectedPrimaryCrop
        .split(',')
        .map((c: string) => c.trim())
        .filter(Boolean)
    : [];
  const selectedSecondaryCropList = selectedSecondaryCrop
    ? selectedSecondaryCrop
        .split(',')
        .map((c: string) => c.trim())
        .filter(Boolean)
    : [];

  // ↓↓↓ Add the crop-picker derived values here, right after the two lists above ↓↓↓
  const cropPickerSelected =
    cropPickerField === 'primaryCrop'
      ? selectedPrimaryCropList
      : cropPickerField === 'secondaryCrop'
        ? selectedSecondaryCropList
        : [];

  const cropPickerExcluded =
    cropPickerField === 'secondaryCrop' ? selectedPrimaryCropList : [];

  const handleCropPickerApply = (selectedNames: string[]) => {
    if (cropPickerField) {
      setValue(cropPickerField, selectedNames.join(', '), { shouldValidate: true });
    }
  };



  const selectedLanguagePreference = watch('languagePreference');
  const selectedKVK = watch('nearestKVK');
  const otherOption = localize('com_farmer_option_other');

  const changeLang = useCallback(
    (value: string) => {
      let userLang = value;
      if (value === 'auto') {
        userLang = navigator.language || navigator.languages[0];
      }

      requestAnimationFrame(() => {
        document.documentElement.lang = userLang;
      });
      setLangcode(userLang);
      Cookies.set('lang', userLang, { expires: 365 });
      return userLang;
    },
    [setLangcode],
  );

  useEffect(() => {
    if (!selectedLanguagePreference) {
      setValue('languagePreference', langcode, { shouldValidate: true });
    }
  }, [langcode, selectedLanguagePreference, setValue]);

  const handleStateChange = (val: string) => {
    setValue('state', val, { shouldValidate: true });
    if (val !== otherOption) {
      setValue('customState', '', { shouldValidate: false });
    }
    setValue('district', '', { shouldValidate: false });
    setValue('customDistrict', '', { shouldValidate: false });
    setValue('blockName', '', { shouldValidate: false });
    setValue('villageName', '', { shouldValidate: false });
    setValue('nearestKVK', '', { shouldValidate: false });
    setValue('customKVK', '', { shouldValidate: false });
  };

  const handleDistrictChange = (val: string) => {
    setValue('district', val, { shouldValidate: true });
    if (val !== otherOption) {
      setValue('customDistrict', '', { shouldValidate: false });
    }
    setValue('blockName', '', { shouldValidate: false });
    setValue('villageName', '', { shouldValidate: false });
    setValue('nearestKVK', '', { shouldValidate: false });
    setValue('customKVK', '', { shouldValidate: false });
  };

  const handleBlockChange = (val: string) => {
    setValue('blockName', val, { shouldValidate: true });
    setValue('villageName', '', { shouldValidate: false });
  };

  const baseUrl = import.meta.env.VITE_AJRASAKHA_SERVER_URL ?? '';
  console.log('baseUrl', baseUrl);

  const { data: statesList = [] } = useQuery<{ code: number | string; name: string }[]>({
    queryKey: ['states'],
    queryFn: async () => {
      try {
        const data = await dataService.getLocationStates(baseUrl);
        console.log('data is', data);
        return Array.isArray(data) ? data : [];
      } catch (error) {
        console.error('Failed to fetch states', error);
        return [];
      }
    },
    enabled: open,
    staleTime: Infinity,
  });

  console.log('StateList', statesList);

  const stateObj = statesList.find((s) => s.name === selectedState);
  const { data: districtsList = [] } = useQuery<{ code: number | string; name: string }[]>({
    queryKey: ['districts', stateObj?.code, selectedState],
    queryFn: async () => {
      if (stateObj?.code === undefined) {
        return [];
      }
      try {
        const data = await dataService.getLocationDistricts(baseUrl, stateObj.code);
        return Array.isArray(data) ? data : [];
      } catch (error) {
        console.error('Failed to fetch districts', error);
        return [];
      }
    },
    enabled: !!selectedState && selectedState !== otherOption,
    staleTime: Infinity,
  });

  const distObj = districtsList.find((d) => d.name === selectedDistrict);
  const { data: blocksList = [] } = useQuery<{ code: number | string; name: string }[]>({
    queryKey: ['subdistricts', distObj?.code, selectedDistrict],
    queryFn: async () => {
      if (distObj?.code === undefined) {
        return [];
      }
      try {
        const data = await dataService.getLocationBlocks(baseUrl, distObj.code);
        return Array.isArray(data) ? data : [];
      } catch (error) {
        console.error('Failed to fetch subdistricts', error);
        return [];
      }
    },
    enabled: !!selectedDistrict && selectedDistrict !== otherOption,
    staleTime: Infinity,
  });

  const blockObj = blocksList.find((b) => b.name === selectedBlock);
  const { data: villagesList = [] } = useQuery<{ code: number | string; name: string }[]>({
    queryKey: ['villages', blockObj?.code, selectedBlock],
    queryFn: async () => {
      if (blockObj?.code === undefined) {
        return [];
      }
      try {
        const data = await dataService.getLocationVillages(baseUrl, blockObj.code);
        return Array.isArray(data) ? data : [];
      } catch (error) {
        console.error('Failed to fetch villages', error);
        return [];
      }
    },
    enabled: !!selectedBlock && selectedBlock !== otherOption,
    staleTime: Infinity,
  });

  const stateOptions =
    statesList.length > 0 ? [...statesList.map((s) => s.name), otherOption] : [otherOption];

  const districtOptions =
    selectedState && selectedState !== otherOption
      ? [...districtsList.map((d) => d.name), otherOption]
      : [otherOption];

  const blockOptions =
    selectedDistrict && selectedDistrict !== otherOption
      ? [...blocksList.map((b) => b.name), otherOption]
      : [otherOption];

  const villageOptions =
    selectedBlock && selectedBlock !== otherOption
      ? [...villagesList.map((v) => v.name), otherOption]
      : [otherOption];

  const { data: kvksList = [] } = useQuery<{ code: number | string; name: string }[]>({
    queryKey: ['kvks', distObj?.code, selectedDistrict],
    queryFn: async () => {
      if (distObj?.code === undefined) {
        return [];
      }
      try {
        const data = await dataService.getLocationKvks(baseUrl, distObj.code);
        return Array.isArray(data)
          ? data.map((k) => ({
            code: k.kvkId,
            name: k.kvkAddress ? `${k.kvkName}, ${k.kvkAddress}` : k.kvkName,
          }))
          : [];
      } catch (error) {
        console.error('Failed to fetch KVKs', error);
        return [];
      }
    },
    enabled: !!selectedDistrict && selectedDistrict !== otherOption && distObj?.code !== undefined,
    staleTime: Infinity,
  });

  const baseKvkOptions =
    selectedDistrict && selectedDistrict !== otherOption ? kvksList.map((k) => k.name) : [];

  const kvkOptions =
    selectedDistrict && selectedDistrict !== otherOption
      ? [...baseKvkOptions, otherOption]
      : [otherOption];


  const removePrimaryCrop = (cropToRemove: string) => {
    const updated = selectedPrimaryCropList.filter((crop) => crop !== cropToRemove);
    setValue('primaryCrop', updated.join(', '), { shouldValidate: true });
  };

  const removeSecondaryCrop = (cropToRemove: string) => {
    const updated = selectedSecondaryCropList.filter((crop) => crop !== cropToRemove);
    setValue('secondaryCrop', updated.join(', '), { shouldValidate: true });
  };

  const saveMutation = useSaveFarmerProfileMutation({
    onSuccess: () => {
      onComplete();
    },
  });

  // const { data: crops, isLoading, isError, error } = useCropsClient();
  // console.log('Crops', crops);

  const handleOpenChange = (isOpen: boolean) => {
    onOpenChange(isOpen);
  };

  const detectDevice = (): string => {
    const ua = navigator.userAgent;
    if (/android/i.test(ua)) return 'Android';
    if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
    if (/windows/i.test(ua)) return 'Windows';
    if (/macintosh|mac os x/i.test(ua)) return 'MacOS';
    if (/linux/i.test(ua)) return 'Linux';
    return 'Unknown';
  };

  const onSubmit = (data: FarmerProfileForm) => {
    const resolvedState = data.state === otherOption ? data.customState : data.state;
    const resolvedDistrict = data.district === otherOption ? data.customDistrict : data.district;
    const resolvedBlock = data.blockName === otherOption ? data.customBlock : data.blockName;
    const resolvedVillage =
      data.villageName === otherOption ? data.customVillage : data.villageName;
    const resolvedKVK = data.nearestKVK === otherOption ? data.customKVK : data.nearestKVK;
    const primaryCrops = (data.primaryCrop ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const secondaryCrops = (data.secondaryCrop ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    const profile: IFarmerProfile = {
      ...data,
      state: resolvedState,
      district: resolvedDistrict,
      blockName: resolvedBlock,
      villageName: resolvedVillage,
      nearestKVK: resolvedKVK,
      age: Number(data.age),
      yearsOfExperience: Number(data.yearsOfExperience),
      numberOfSmartphones: Number(data.numberOfSmartphones),
      cropsCultivated: Array.from(new Set([...primaryCrops, ...secondaryCrops])),
      awarenessOfKCC: data.awarenessOfKCC === 'yes',
      usesAgriApps: data.usesAgriApps === 'yes',
      landhold: data.landhold ? Number(data.landhold) : undefined,
      platform: detectDevice(),
      location:
        data.location?.latitude && data.location?.longitude
          ? {
            latitude: Number(data.location.latitude),
            longitude: Number(data.location.longitude),
          }
          : undefined,
    };
    saveMutation.mutate(profile);
  };

  const inputClass =
    'mt-1.5 block h-12 w-full rounded-xl border border-border-medium bg-transparent px-3.5 text-base text-text-primary placeholder-text-secondary transition-colors focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600';
  const errorClass = 'mt-1 text-xs text-red-500';
  const sectionTitleClass = 'mb-4 flex items-center gap-3';
  const sectionBadgeClass =
    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border-light bg-surface-tertiary text-text-primary';
  const sectionStepClass = 'text-xs font-medium text-text-tertiary';
  const fieldClass = 'mb-4';
  const requiredMark = (
    <span className="text-red-500" aria-hidden="true">
      {' '}
      *
    </span>
  );
  const decimalRegex = /^\d+(\.\d+)?$/;
  const genderOptions = [
    localize('com_farmer_option_male'),
    localize('com_farmer_option_female'),
    localize('com_farmer_option_other'),
  ];
  const cropsOptions: any = [
    localize('crop_adapathiyan'),
    localize('crop_agathi'),
    localize('crop_ailanthus_or_matti'),
    localize('crop_ajwain_carom_seeds'),
    localize('crop_allspice'),
    localize('crop_almond'),
    localize('crop_aloe_vera'),
    localize('crop_amaranth'),
    localize('crop_amaranthus'),
    localize('crop_amla'),
    localize('crop_anthurium'),
    localize('crop_apple'),
    localize('crop_apricot'),
    localize('crop_arecanut'),
    localize('crop_arhar'),
    localize('crop_arhar_dal_red_gram'),
    localize('crop_aromatic_rice'),
    localize('crop_arrow_root'),
    localize('crop_arum_elephant_foot_yam'),
    localize('crop_arum_lobe'),
    localize('crop_arum_stem'),
    localize('crop_ash_gourd_upper'),
    localize('crop_ash_gourd_lower'),
    localize('crop_ashwagandha'),
    localize('crop_asoka'),
    localize('crop_avocado'),
    localize('crop_babool_indian_gum_arabic_tree'),
    localize('crop_babool_tree'),
    localize('crop_baby_corn_space'),
    localize('crop_babycorn_joined'),
    localize('crop_bajra_pearl_millet'),
    localize('crop_bamboo'),
    localize('crop_banana'),
    localize('crop_banana_stem'),
    localize('crop_barley'),
    localize('crop_barnyard_millet_upper'),
    localize('crop_barnyard_millet_lower'),
    localize('crop_beans'),
    localize('crop_beet_root_space'),
    localize('crop_beetroot_joined'),
    localize('crop_bengal_gram_clean'),
    localize('crop_bengal_gram_chickpea'),
    localize('crop_ber'),
    localize('crop_ber_jujube'),
    localize('crop_berseem'),
    localize('crop_betel_leaf_upper'),
    localize('crop_betel_leaf_lower'),
    localize('crop_betel_vine'),
    localize('crop_bethua_leaves'),
    localize('crop_beto_shak'),
    localize('crop_bird_of_paradise'),
    localize('crop_bitter_gourd_upper'),
    localize('crop_bitter_gourd_lower'),
    localize('crop_black_cumin'),
    localize('crop_black_gram_upper'),
    localize('crop_black_grapes'),
    localize('crop_black_pepper_upper'),
    localize('crop_black_gram_lower'),
    localize('crop_black_pepper_lower'),
    localize('crop_blueberry'),
    localize('crop_bottle_gourd_upper'),
    localize('crop_bottle_gourd_lower'),
    localize('crop_brahmi'),
    localize('crop_brinjal'),
    localize('crop_brinjal_eggplant_bracket'),
    localize('crop_brinjal_eggplant_slash'),
    localize('crop_broad_beans'),
    localize('crop_broccoli_correct'),
    localize('crop_brocolli_typo'),
    localize('crop_brown_top_millet'),
    localize('crop_buckwheat'),
    localize('crop_butter_mahua_tree'),
    localize('crop_cabbage'),
    localize('crop_camboge'),
    localize('crop_capsicum'),
    localize('crop_cardamom'),
    localize('crop_carnation'),
    localize('crop_carom'),
    localize('crop_carrot'),
    localize('crop_cashew'),
    localize('crop_cassava_tapioca'),
    localize('crop_cassia'),
    localize('crop_castor'),
    localize('crop_casuarina'),
    localize('crop_cauliflower'),
    localize('crop_celery'),
    localize('crop_celery_seeds'),
    localize('crop_ceylon_spinach'),
    localize('crop_chadachi'),
    localize('crop_char_magaz'),
    localize('crop_chayote'),
    localize('crop_chengazhinirkizhangu'),
    localize('crop_chethikoduveli'),
    localize('crop_chick_pea_space'),
    localize('crop_chickpea_joined'),
    localize('crop_chickpea_bengal_gram_comma'),
    localize('crop_chikoo'),
    localize('crop_chilli_i'),
    localize('crop_chilly_y'),
    localize('crop_china_aster'),
    localize('crop_chinese_cabbage'),
    localize('crop_chittadalotakam'),
    localize('crop_chittaratha'),
    localize('crop_chow_chow'),
    localize('crop_chrysanthemum'),
    localize('crop_cinnamon'),
    localize('crop_citronella_grass'),
    localize('crop_citrus'),
    localize('crop_clove_singular'),
    localize('crop_cloves_plural'),
    localize('crop_cluster_bean'),
    localize('crop_cocoa'),
    localize('crop_coconut'),
    localize('crop_coffee'),
    localize('crop_coleus'),
    localize('crop_colocacia_c'),
    localize('crop_colocasia_s'),
    localize('crop_congosignal_grass'),
    localize('crop_coriander'),
    localize('crop_coriander_cilantro'),
    localize('crop_coriander_leaves_seeds'),
    localize('crop_cotton'),
    localize('crop_cowpea'),
    localize('crop_crossandra'),
    localize('crop_cucumber'),
    localize('crop_cumin'),
    localize('crop_cumin_seeds'),
    localize('crop_curry_leaves'),
    localize('crop_custard_apple_upper'),
    localize('crop_custard_apple_lower'),
    localize('crop_daincha'),
    localize('crop_danthappala'),
    localize('crop_darjeeling_orange'),
    localize('crop_date'),
    localize('crop_date_palm_upper'),
    localize('crop_date_palm_lower'),
    localize('crop_davana'),
    localize('crop_dill_leaves'),
    localize('crop_dillseed'),
    localize('crop_dragon_fruit'),
    localize('crop_drumstick'),
    localize('crop_drumstick_moringa'),
    localize('crop_elephant_apple'),
    localize('crop_elephant_foot_yam'),
    localize('crop_eucalyptus'),
    localize('crop_fennel'),
    localize('crop_fenugreek'),
    localize('crop_fenugreek_methi'),
    localize('crop_field_pea'),
    localize('crop_fig'),
    localize('crop_finger_millet_upper'),
    localize('crop_finger_millet_lower'),
    localize('crop_firecracker_flower'),
    localize('crop_fodder_cowpea'),
    localize('crop_fodder_maize'),
    localize('crop_fodder_sorghum'),
    localize('crop_foxtail_millet_upper'),
    localize('crop_foxtail_millet_lower'),
    localize('crop_french_bean'),
    localize('crop_gaillardia'),
    localize('crop_galgal_hill_lemon'),
    localize('crop_gamba_grass'),
    localize('crop_garlic'),
    localize('crop_geranium'),
    localize('crop_gerbera'),
    localize('crop_german_turnip'),
    localize('crop_gherkins'),
    localize('crop_ginger'),
    localize('crop_gladiolus'),
    localize('crop_gliricidia'),
    localize('crop_gram'),
    localize('crop_grape_singular'),
    localize('crop_grapes_plural'),
    localize('crop_greater_yam'),
    localize('crop_green_cardamom'),
    localize('crop_green_chilli'),
    localize('crop_green_gram_upper'),
    localize('crop_green_mango'),
    localize('crop_green_papaya'),
    localize('crop_green_peas_plural'),
    localize('crop_green_gram_lower'),
    localize('crop_green_gram_golden_gram'),
    localize('crop_green_pea_singular'),
    localize('crop_greeng_gram_typo'),
    localize('crop_ground_nut_space'),
    localize('crop_groundnut_joined'),
    localize('crop_guava'),
    localize('crop_guinea_grass'),
    localize('crop_gymnema_sugar_destroyer'),
    localize('crop_hedge_lucerne'),
    localize('crop_heliconia'),
    localize('crop_hogplum'),
    localize('crop_holy_basil'),
    localize('crop_honey_plant'),
    localize('crop_hops'),
    localize('crop_horse_gram_space_upper'),
    localize('crop_horse_gram_space_lower'),
    localize('crop_horsegram_joined'),
    localize('crop_hyacinth_bean_clean'),
    localize('crop_hyacinth_bean_or_lablab_bean'),
    localize('crop_hybrid_napier'),
    localize('crop_indian_beech_pongam_tree'),
    localize('crop_indian_beech_tree'),
    localize('crop_indian_blackberry'),
    localize('crop_indian_butter_tree_mahua'),
    localize('crop_indian_gooseberry_upper'),
    localize('crop_indian_gooseberry_amla'),
    localize('crop_indian_jujube_ber'),
    localize('crop_indian_gooseberry_lower'),
    localize('crop_indian_hogweed_spiny_amaranth'),
    localize('crop_indian_mustard'),
    localize('crop_indian_sarsaparilla_mangani_root'),
    localize('crop_indigo'),
    localize('crop_irul'),
    localize('crop_ivy_gourd_upper'),
    localize('crop_ivy_gourd_lower'),
    localize('crop_jack_short'),
    localize('crop_jack_fruit_space_upper'),
    localize('crop_jack_fruit_space_lower'),
    localize('crop_jackfruit_joined'),
    localize('crop_jamun'),
    localize('crop_jamun_fruit'),
    localize('crop_japanese_persimmon'),
    localize('crop_jasmine'),
    localize('crop_jeevakom'),
    localize('crop_jicama'),
    localize('crop_jute_leaves'),
    localize('crop_kacholam'),
    localize('crop_kagzi_lime'),
    localize('crop_kalai_dal'),
    localize('crop_kampakam'),
    localize('crop_kanjiram'),
    localize('crop_karinochi'),
    localize('crop_karonda'),
    localize('crop_kashi_kanagile'),
    localize('crop_kasthurimanjal'),
    localize('crop_kattarvazha'),
    localize('crop_kidney_bean_upper'),
    localize('crop_kidney_bean_lower'),
    localize('crop_kidney_bean_rajama'),
    localize('crop_kinnow_mandarin'),
    localize('crop_kiwifruit'),
    localize('crop_knol_khol'),
    localize('crop_kodo_millet'),
    localize('crop_kokum'),
    localize('crop_koovalam'),
    localize('crop_kurumthotti'),
    localize('crop_kusuma'),
    localize('crop_ladys_finger'),
    localize('crop_large_cardamom'),
    localize('crop_lemon'),
    localize('crop_lemongrass'),
    localize('crop_lentil'),
    localize('crop_lesser_yarm'),
    localize('crop_lettuce'),
    localize('crop_lime_lemon'),
    localize('crop_linseed_clean'),
    localize('crop_linseed_flax'),
    localize('crop_litchi'),
    localize('crop_little_millet_upper'),
    localize('crop_little_millet_lower'),
    localize('crop_long_melon'),
    localize('crop_long_pepper'),
    localize('crop_loquat'),
    localize('crop_lucerne'),
    localize('crop_mahagony_variant'),
    localize('crop_mahogany_standard'),
    localize('crop_maize'),
    localize('crop_malabar_neem'),
    localize('crop_mandarin'),
    localize('crop_mandarin_orange'),
    localize('crop_mangium'),
    localize('crop_mango'),
    localize('crop_mango_ginger'),
    localize('crop_mangosteen'),
    localize('crop_marigold'),
    localize('crop_mash'),
    localize('crop_matar_dal_split_peas'),
    localize('crop_mentha'),
    localize('crop_mesta'),
    localize('crop_millet'),
    localize('crop_moong'),
    localize('crop_moong_dal'),
    localize('crop_moth_bean_upper'),
    localize('crop_moth_bean_lower'),
    localize('crop_mung'),
    localize('crop_mung_bean'),
    localize('crop_mushroom'),
    localize('crop_muskmelon'),
    localize('crop_mustard'),
    localize('crop_musur_dal'),
    localize('crop_napier_grass'),
    localize('crop_neela_amari'),
    localize('crop_neem_clean'),
    localize('crop_neem_ground_type'),
    localize('crop_niger'),
    localize('crop_nilappana'),
    localize('crop_nutmeg'),
    localize('crop_oat_singular'),
    localize('crop_oats_plural'),
    localize('crop_oilpalm'),
    localize('crop_okra'),
    localize('crop_okra_ladys_finger'),
    localize('crop_olive'),
    localize('crop_onion'),
    localize('crop_orange'),
    localize('crop_orange_sweet_orange_mosambi'),
    localize('crop_orchids'),
    localize('crop_paddy'),
    localize('crop_paddy_rice'),
    localize('crop_palmarosa'),
    localize('crop_palmarosa_grass'),
    localize('crop_palmyra_palm'),
    localize('crop_papaya'),
    localize('crop_para_grass'),
    localize('crop_paradise_tree'),
    localize('crop_passion_fruit'),
    localize('crop_patchouli'),
    localize('crop_pathimugham'),
    localize('crop_pea'),
    localize('crop_peach'),
    localize('crop_pear'),
    localize('crop_pearl_millet_upper'),
    localize('crop_pearl_millet_lower'),
    localize('crop_pecan_nut'),
    localize('crop_physic_nut_jatropha'),
    localize('crop_pickling_melon'),
    localize('crop_pigeon_pea_upper'),
    localize('crop_pigeon_pea_lower'),
    localize('crop_pigeon_pea_red_gram'),
    localize('crop_pineapple'),
    localize('crop_plum'),
    localize('crop_pointed_gourd'),
    localize('crop_pomegranate'),
    localize('crop_potato'),
    localize('crop_proso_millet_one_l'),
    localize('crop_proso_millet_two_l_typo'),
    localize('crop_pumpkin'),
    localize('crop_punna'),
    localize('crop_quina'),
    localize('crop_raddish_two_d_typo'),
    localize('crop_radish_one_d_correct'),
    localize('crop_ragi'),
    localize('crop_ramboothan'),
    localize('crop_ramphal'),
    localize('crop_rapeseed_and_mustard'),
    localize('crop_raw_bengal_gram'),
    localize('crop_red_chilli'),
    localize('crop_red_gram_pigeon_pea'),
    localize('crop_red_sandalwood_clean'),
    localize('crop_red_sanders_red_sandalwood'),
    localize('crop_red_gram_lower'),
    localize('crop_rice'),
    localize('crop_rice_paddy'),
    localize('crop_ridge_gourd_upper'),
    localize('crop_ridge_gourd_lower'),
    localize('crop_ripe_papaya'),
    localize('crop_rose'),
    localize('crop_rose_greenhouse'),
    localize('crop_roselle_red_sorrel'),
    localize('crop_rosemary'),
    localize('crop_rosewood'),
    localize('crop_round_gourd'),
    localize('crop_rubber'),
    localize('crop_ryegrass'),
    localize('crop_safed_musli'),
    localize('crop_safflower'),
    localize('crop_sandal'),
    localize('crop_sandalwood'),
    localize('crop_sapodilla_chiku'),
    localize('crop_sapota'),
    localize('crop_sarpagandha_indian_snakeroot'),
    localize('crop_senji'),
    localize('crop_sesame'),
    localize('crop_sesame_gingelly'),
    localize('crop_setaria_grass'),
    localize('crop_shaftal'),
    localize('crop_shah_marich'),
    localize('crop_shevri'),
    localize('crop_snake_gourd_upper'),
    localize('crop_snake_gourd_lower'),
    localize('crop_sorghum'),
    localize('crop_sorghum_fodder'),
    localize('crop_sorghum_rabi_kharif'),
    localize('crop_soyabean_a'),
    localize('crop_soybean_no_a'),
    localize('crop_spinach'),
    localize('crop_sponge_gourd'),
    localize('crop_squash'),
    localize('crop_stevia'),
    localize('crop_strawberry'),
    localize('crop_stylo'),
    localize('crop_subabul'),
    localize('crop_sugarbeet'),
    localize('crop_sugarcane'),
    localize('crop_summer_squash'),
    localize('crop_sun_hemp'),
    localize('crop_sunflower'),
    localize('crop_sweet_cherry'),
    localize('crop_sweet_lemon'),
    localize('crop_sweet_lime'),
    localize('crop_sweet_orange'),
    localize('crop_sweet_pepper'),
    localize('crop_sweet_potato'),
    localize('crop_tamarind'),
    localize('crop_tapioca'),
    localize('crop_tea'),
    localize('crop_teak'),
    localize('crop_thembavu'),
    localize('crop_thippali'),
    localize('crop_thorny_bamboo'),
    localize('crop_thulasi'),
    localize('crop_tobacco'),
    localize('crop_tomato'),
    localize('crop_tree_tomato'),
    localize('crop_tuberose'),
    localize('crop_tulsi_holy_basil'),
    localize('crop_turmeric'),
    localize('crop_turnip'),
    localize('crop_urd'),
    localize('crop_vanilla'),
    localize('crop_vegetable_cowpea'),
    localize('crop_venga'),
    localize('crop_vetiver'),
    localize('crop_vetiver_khus_grass'),
    localize('crop_walnut'),
    localize('crop_wanga'),
    localize('crop_water_melon_space'),
    localize('crop_watermelon_joined'),
    localize('crop_west_indian_cherry'),
    localize('crop_wheat'),
    localize('crop_white_yam'),
    localize('crop_wild_tamarind'),
    localize('crop_wild_date_palm'),
    localize('crop_wild_indigo'),
    localize('crop_wild_jack_or_aini'),
    localize('crop_wood_apple'),
    localize('crop_yam'),
  ];
  const educationOptions = [
    localize('com_farmer_option_under_graduate'),
    localize('com_farmer_option_graduate'),
    localize('com_farmer_option_post_graduate'),
  ];
  const yesLabel = localize('com_ui_yes');
  const noLabel = localize('com_ui_no');
  const yesNoOptions = [
    { label: yesLabel, value: 'yes' },
    { label: noLabel, value: 'no' },
  ];

  const SECTIONS: {
    icon: typeof User;
    title: string;
    fields: FieldPath<FarmerProfileForm>[];
  }[] = [
      {
        icon: User,
        title: localize('com_farmer_profile_demographic_details'),
        fields: [
          'languagePreference',
          'location.latitude',
          'location.longitude',
          'farmerName',
          'age',
          'gender',
          'state',
          'customState',
          'district',
          'customDistrict',
          'blockName',
          'customBlock',
          'villageName',
          'customVillage',
          'nearestKVK',
          'customKVK',
          'phoneNo',
        ],
      },
      {
        icon: Leaf,
        title: localize('com_farmer_profile_agricultural_background'),
        fields: ['yearsOfExperience', 'landhold', 'primaryCrop', 'secondaryCrop'],
      },
      {
        icon: Smartphone,
        title: localize('com_farmer_profile_awareness_section'),
        fields: ['awarenessOfKCC', 'usesAgriApps'],
      },
      {
        icon: Landmark,
        title: localize('com_farmer_profile_socio_economic'),
        fields: ['highestEducatedPerson', 'numberOfSmartphones'],
      },
    ];

  const isLastSection = currentSection === SECTIONS.length - 1;

  const handleNextSection = async () => {
    const isValid = await trigger(SECTIONS[currentSection].fields);
    if (isValid) {
      setCurrentSection((section) => Math.min(section + 1, SECTIONS.length - 1));
    }
  };

  const handlePreviousSection = () => {
    setCurrentSection((section) => Math.max(section - 1, 0));
  };

  return (
    <>
      <OGDialog open={open} onOpenChange={handleOpenChange}>
        <OGDialogContent
          showCloseButton={false}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          className="farmer-modal-shell flex w-11/12 max-w-2xl flex-col overflow-y-hidden p-4 sm:w-3/4 sm:p-6 md:w-2/3 lg:w-1/2"
        >
          <OGDialogHeader>
            <div className="flex w-full flex-row flex-wrap items-center justify-between gap-2">
              <OGDialogTitle className="text-base font-bold text-text-primary sm:text-lg">
                {localize('com_farmer_profile_registration')}
              </OGDialogTitle>
              <button
                type="button"
                onClick={() => setShowLogoutConfirm(true)}
                aria-label={localize('com_nav_log_out')}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border-heavy bg-surface-secondary p-2 text-xs font-semibold text-text-primary transition-all duration-200 hover:border-surface-destructive hover:bg-surface-destructive hover:text-white sm:px-3 sm:py-1.5"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{localize('com_nav_log_out')}</span>
              </button>
            </div>
          </OGDialogHeader>

          <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
            {/* Required: without coordinates the saved profile stays incomplete server-side,
              and the user is asked for their location again on every load. */}
            <input
              type="hidden"
              {...register('location.latitude', {
                required: localize('com_farmer_validation_field_required'),
              })}
            />
            <input
              type="hidden"
              {...register('location.longitude', {
                required: localize('com_farmer_validation_field_required'),
              })}
            />

            {/* ── Notice — pinned above the scrollable area ── */}
            {/* <p className="shrink-0 px-1 pb-3 text-xs font-medium text-red-500 sm:text-sm">
            {localize('com_farmer_profile_fill_all_required')}
          </p> */}

            <div className="flex min-h-0 flex-1 flex-col px-1 py-2">
              {/* ── Progress — compact bar on mobile — pinned, does not scroll with the form ── */}
              <div className="mb-4 shrink-0 sm:hidden">
                {/* The stepper below is too wide for a phone, so the same information is carried
                  by the section's own icon, its position in the run, and a progress bar. */}
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400">
                    {(() => {
                      const SectionIcon = SECTIONS[currentSection].icon;
                      return <SectionIcon className="size-4" aria-hidden="true" />;
                    })()}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-text-tertiary">
                      Section {currentSection + 1} of {SECTIONS.length}
                    </p>
                    <p className="truncate text-sm font-semibold text-text-primary">
                      {SECTIONS[currentSection].title}
                    </p>
                  </div>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary">
                  <div
                    className="h-full rounded-full bg-green-600 transition-all duration-300"
                    style={{ width: `${((currentSection + 1) / SECTIONS.length) * 100}%` }}
                  />
                </div>
              </div>

              {/* ── Progress — detailed stepper on larger screens — pinned, does not scroll with the form ── */}
              <div className="mb-6 hidden shrink-0 items-start sm:flex">
                {SECTIONS.map((section, index) => {
                  const StepIcon = section.icon;
                  const isCompleted = index < currentSection;
                  const isActive = index === currentSection;
                  return (
                    <div key={section.title} className="flex flex-1 items-center last:flex-none">
                      <div className="flex flex-col items-center gap-1.5">
                        <div
                          className={cn(
                            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                            isCompleted
                              ? 'border-green-600 bg-green-600 text-white'
                              : isActive
                                ? 'border-green-600 bg-transparent text-green-600'
                                : 'border-border-light bg-surface-secondary text-text-tertiary',
                          )}
                        >
                          {isCompleted ? (
                            <Check className="h-4 w-4" />
                          ) : (
                            <StepIcon className="h-4 w-4" />
                          )}
                        </div>
                        <span
                          className={cn(
                            'max-w-[6.5rem] text-center text-xs font-medium',
                            isActive ? 'text-text-primary' : 'text-text-tertiary',
                          )}
                        >
                          {section.title}
                        </span>
                      </div>
                      {index < SECTIONS.length - 1 && (
                        <div
                          className={cn(
                            'mx-2 mb-5 h-0.5 flex-1 rounded-full transition-colors',
                            isCompleted ? 'bg-green-600' : 'bg-border-light',
                          )}
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex-1 overflow-y-auto">
                <div className={fieldClass}>
                  <Controller
                    name="languagePreference"
                    control={control}
                    rules={{ required: localize('com_farmer_validation_language_required') }}
                    render={({ field }) => (
                      <LangSelector
                        langcode={(field.value as string) ?? langcode}
                        onChange={(value) => {
                          const resolvedLang = changeLang(value);
                          field.onChange(resolvedLang);
                        }}
                        portal={false}
                        compactOnMobile
                      />
                    )}
                  />
                  {errors.languagePreference && (
                    <p className={errorClass}>{errors.languagePreference.message}</p>
                  )}
                </div>

                {/* ── Section 1: Demographic Details ── */}
                {currentSection === 0 && (
                  <>
                    {/* <div className={sectionTitleClass}>
                <span className={sectionBadgeClass}>
                  <User className="h-4 w-4" />
                </span>
                <div>
                  <p className={sectionStepClass}>Section 1 of 4</p>
                  <h3 className={sectionHeadingTextClass}>
                    {localize('com_farmer_profile_demographic_details')}
                  </h3>
                </div>
              </div> */}

                    <div className={fieldClass}>
                      <Label htmlFor="farmerName">
                        {localize('com_farmer_label_farmer_name')}
                        {requiredMark}
                      </Label>
                      <Input
                        id="farmerName"
                        placeholder={localize('com_farmer_placeholder_full_name')}
                        className={inputClass}
                        {...register('farmerName', {
                          required: localize('com_farmer_validation_farmer_name_required'),
                          validate: (value) =>
                            String(value ?? '').trim().length > 0 ||
                            localize('com_farmer_validation_farmer_name_required'),
                        })}
                      />
                      {errors.farmerName && (
                        <p className={errorClass}>{errors.farmerName.message}</p>
                      )}
                    </div>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className={fieldClass}>
                        <Label htmlFor="age">
                          {localize('com_farmer_label_age')}
                          {requiredMark}
                        </Label>
                        <Input
                          id="age"
                          type="number"
                          placeholder={localize('com_farmer_placeholder_age')}
                          defaultValue={16}
                          min={16}
                          max={100}
                          step={1}
                          className={inputClass}
                          {...register('age', {
                            required: localize('com_farmer_validation_age_required'),
                            valueAsNumber: true,
                            validate: {
                              isInteger: (value) =>
                                Number.isInteger(value) ||
                                localize('com_farmer_validation_age_integer'),
                              inRange: (value) =>
                                (value >= 16 && value <= 100) ||
                                localize('com_farmer_validation_age_range'),
                            },
                          })}
                        />
                        {errors.age && <p className={errorClass}>{errors.age.message}</p>}
                      </div>

                      <div className={fieldClass}>
                        <Label>
                          {localize('com_farmer_label_gender')}
                          {requiredMark}
                        </Label>
                        <Controller
                          name="gender"
                          control={control}
                          rules={{ required: localize('com_farmer_validation_gender_required') }}
                          render={({ field }) => (
                            <ChoiceCards
                              name="gender"
                              options={genderOptions.map((option) => ({
                                label: option,
                                value: option,
                              }))}
                              value={field.value ?? ''}
                              onChange={field.onChange}
                              gridClassName="grid-cols-3"
                            />
                          )}
                        />
                        {errors.gender && <p className={errorClass}>{errors.gender.message}</p>}
                      </div>
                    </div>

                    {/* ── Location ── */}
                    <div className={fieldClass}>
                      <Label>{localize('com_farmer_label_current_location')}</Label>
                      <div className="mb-3 mt-2 rounded-md border border-blue-100 bg-blue-50/50 p-3 dark:border-blue-800 dark:bg-blue-900/10">
                        <div className="flex">
                          <div className="flex-shrink-0">
                            <svg
                              className="h-5 w-5 text-blue-400 dark:text-blue-500"
                              viewBox="0 0 20 20"
                              fill="currentColor"
                            >
                              <path
                                fillRule="evenodd"
                                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                                clipRule="evenodd"
                              />
                            </svg>
                          </div>
                          <div className="ml-3 text-sm text-blue-700 dark:text-blue-400">
                            <p>{localize('com_farmer_helper_location_capture')}</p>
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={getLocation}
                          disabled={isLocating}
                          className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border-heavy bg-surface-secondary px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                        >
                          <MapPin className="h-4 w-4" />
                          {isLocating
                            ? localize('com_farmer_button_locating')
                            : localize('com_farmer_button_get_location')}
                        </button>
                        {watch('location.latitude') && watch('location.longitude') && (
                          <span className="text-sm font-medium text-green-600 dark:text-green-500">
                            {localize('com_farmer_location_captured_success')}
                          </span>
                        )}
                        {locationError && (
                          <span className="text-sm text-red-500">{locationError}</span>
                        )}
                      </div>
                      {errors.location?.latitude && (
                        <p className={errorClass}>{errors.location.latitude.message}</p>
                      )}
                    </div>

                    {/* ── State → District → Block → Village ── */}
                    <div className={fieldClass}>
                      <Label>
                        {localize('com_farmer_label_state')}
                        {requiredMark}
                      </Label>
                      <Controller
                        name="state"
                        control={control}
                        rules={{ required: localize('com_farmer_validation_state_required') }}
                        render={({ field }) => (
                          <SearchableSelect
                            options={stateOptions}
                            value={field.value ?? ''}
                            onChange={handleStateChange}
                            placeholder={localize('com_farmer_placeholder_select_state')}
                          />
                        )}
                      />
                      {errors.state && <p className={errorClass}>{errors.state.message}</p>}
                    </div>

                    {/* Custom state input – shown only when "Other" is selected */}
                    {selectedState === otherOption && (
                      <div className={fieldClass}>
                        <Label htmlFor="customState">
                          {localize('com_farmer_label_custom_state')}
                          {requiredMark}
                        </Label>
                        <Input
                          id="customState"
                          placeholder={localize('com_farmer_placeholder_custom_state')}
                          className={inputClass}
                          {...register('customState', {
                            required: localize('com_farmer_validation_custom_state_required'),
                            // Drops the field from the form when the user switches away from
                            // "Other", so its rule cannot block submission while hidden.
                            shouldUnregister: true,
                          })}
                        />
                        {errors.customState && (
                          <p className={errorClass}>{errors.customState.message}</p>
                        )}
                      </div>
                    )}

                    <div className={fieldClass}>
                      <Label>
                        {localize('com_farmer_label_district')}
                        {requiredMark}
                      </Label>
                      <Controller
                        name="district"
                        control={control}
                        rules={{ required: localize('com_farmer_validation_district_required') }}
                        render={({ field }) => (
                          <SearchableSelect
                            options={districtOptions}
                            value={field.value ?? ''}
                            onChange={handleDistrictChange}
                            placeholder={
                              selectedState
                                ? localize('com_farmer_placeholder_select_district')
                                : localize('com_farmer_placeholder_select_state_first')
                            }
                            disabled={!selectedState}
                          />
                        )}
                      />
                      {errors.district && <p className={errorClass}>{errors.district.message}</p>}
                    </div>

                    {/* Custom district input – shown only when "Other" is selected */}
                    {selectedDistrict === otherOption && (
                      <div className={fieldClass}>
                        <Label htmlFor="customDistrict">
                          {localize('com_farmer_label_custom_district')}
                          {requiredMark}
                        </Label>
                        <Input
                          id="customDistrict"
                          placeholder={localize('com_farmer_placeholder_custom_district')}
                          className={inputClass}
                          {...register('customDistrict', {
                            required: localize('com_farmer_validation_custom_district_required'),
                            // Drops the field from the form when the user switches away from
                            // "Other", so its rule cannot block submission while hidden.
                            shouldUnregister: true,
                          })}
                        />
                        {errors.customDistrict && (
                          <p className={errorClass}>{errors.customDistrict.message}</p>
                        )}
                      </div>
                    )}

                    <div className={fieldClass}>
                      <Label>
                        {localize('com_farmer_label_block_name')}
                        {requiredMark}
                      </Label>
                      <Controller
                        name="blockName"
                        control={control}
                        rules={{ required: localize('com_farmer_validation_block_required') }}
                        render={({ field }) => (
                          <SearchableSelect
                            options={blockOptions}
                            value={field.value ?? ''}
                            onChange={handleBlockChange}
                            placeholder={
                              selectedDistrict
                                ? localize('com_farmer_placeholder_select_block')
                                : localize('com_farmer_placeholder_select_district_first')
                            }
                            disabled={!selectedDistrict}
                          />
                        )}
                      />
                      {errors.blockName && <p className={errorClass}>{errors.blockName.message}</p>}
                    </div>

                    {selectedBlock === otherOption && (
                      <div className={fieldClass}>
                        <Label htmlFor="customBlock">
                          {localize('com_farmer_label_custom_block')}
                          {requiredMark}
                        </Label>
                        <Input
                          id="customBlock"
                          placeholder={localize('com_farmer_placeholder_custom_block')}
                          className={inputClass}
                          {...register('customBlock', {
                            required: localize('com_farmer_validation_custom_block_required'),
                            // Drops the field from the form when the user switches away from
                            // "Other", so its rule cannot block submission while hidden.
                            shouldUnregister: true,
                          })}
                        />
                        {errors.customBlock && (
                          <p className={errorClass}>{errors.customBlock.message}</p>
                        )}
                      </div>
                    )}

                    <div className={fieldClass}>
                      <Label>
                        {localize('com_farmer_label_village_name')}
                        {requiredMark}
                      </Label>
                      <Controller
                        name="villageName"
                        control={control}
                        rules={{ required: localize('com_farmer_validation_village_required') }}
                        render={({ field }) => (
                          <SearchableSelect
                            options={villageOptions}
                            value={field.value ?? ''}
                            onChange={field.onChange}
                            placeholder={
                              selectedBlock
                                ? localize('com_farmer_placeholder_select_village')
                                : localize('com_farmer_placeholder_select_district_first')
                            }
                            disabled={!selectedBlock}
                          />
                        )}
                      />
                      {errors.villageName && (
                        <p className={errorClass}>{errors.villageName.message}</p>
                      )}
                    </div>

                    {selectedBlock === otherOption || selectedVillage === otherOption ? (
                      <div className={fieldClass}>
                        <Label htmlFor="customVillage">
                          {localize('com_farmer_label_custom_village')}
                          {requiredMark}
                        </Label>
                        <Input
                          id="customVillage"
                          placeholder={localize('com_farmer_placeholder_custom_village')}
                          className={inputClass}
                          {...register('customVillage', {
                            required: localize('com_farmer_validation_custom_village_required'),
                            // Drops the field from the form when the user switches away from
                            // "Other", so its rule cannot block submission while hidden.
                            shouldUnregister: true,
                          })}
                        />
                        {errors.customVillage && (
                          <p className={errorClass}>{errors.customVillage.message}</p>
                        )}
                      </div>
                    ) : null}

                    <div className={fieldClass}>
                      <Label>
                        {localize('com_farmer_label_nearest_kvk')}
                        {requiredMark}
                      </Label>

                      <Controller
                        name="nearestKVK"
                        control={control}
                        rules={{ required: localize('com_farmer_validation_nearest_kvk_required') }}
                        render={({ field }) => (
                          <SearchableSelect
                            options={kvkOptions}
                            value={field.value ?? ''}
                            onChange={(val) => {
                              field.onChange(val);
                              if (val !== otherOption) {
                                setValue('customKVK', '', { shouldValidate: false });
                              }
                            }}
                            placeholder={
                              selectedDistrict
                                ? localize('com_farmer_placeholder_select_nearest_kvk')
                                : localize('com_farmer_placeholder_select_district_first')
                            }
                            disabled={!selectedDistrict}
                          />
                        )}
                      />

                      {errors.nearestKVK && (
                        <p className={errorClass}>{errors.nearestKVK.message}</p>
                      )}
                    </div>

                    {selectedKVK === otherOption && (
                      <div className={fieldClass}>
                        <Label htmlFor="customKVK">
                          {localize('com_farmer_label_custom_kvk')}
                          {requiredMark}
                        </Label>
                        <Input
                          id="customKVK"
                          placeholder={localize('com_farmer_placeholder_custom_kvk')}
                          className={inputClass}
                          {...register('customKVK', {
                            required: localize('com_farmer_validation_custom_kvk_required'),
                            // Drops the field from the form when the user switches away from
                            // "Other", so its rule cannot block submission while hidden.
                            shouldUnregister: true,
                          })}
                        />
                        {errors.customKVK && (
                          <p className={errorClass}>{errors.customKVK.message}</p>
                        )}
                      </div>
                    )}

                    <div className={fieldClass}>
                      <Label htmlFor="phoneNo">
                        {localize('com_farmer_label_phone_number')}
                        {requiredMark}
                      </Label>
                      <Input
                        id="phoneNo"
                        type="tel"
                        inputMode="numeric"
                        maxLength={10}
                        placeholder={localize('com_farmer_placeholder_phone_number')}
                        className={inputClass}
                        {...register('phoneNo', {
                          required: localize('com_farmer_validation_phone_required'),
                          pattern: {
                            // 10 digits total, and the first digit must be 6, 7, 8, or 9
                            // (standard Indian mobile number format).
                            value: /^[6-9]\d{9}$/,
                            message: localize('com_farmer_validation_phone_invalid'),
                          },
                        })}
                      />
                      {errors.phoneNo && <p className={errorClass}>{errors.phoneNo.message}</p>}
                    </div>
                  </>
                )}

                {/* ── Section 2: Agricultural Background ── */}
                {currentSection === 1 && (
                  <>
                    {/* <div className={sectionTitleClass}>
                <span className={sectionBadgeClass}>
                  <Leaf className="h-4 w-4" />
                </span>
                <div>
                  <p className={sectionStepClass}>Section 2 of 4</p>
                  <h3 className={sectionHeadingTextClass}>
                    {localize('com_farmer_profile_agricultural_background')}
                  </h3>
                </div>
              </div> */}

                    <div className={fieldClass}>
                      <Label htmlFor="yearsOfExperience">
                        {localize('com_farmer_label_years_experience')}
                        {requiredMark}
                      </Label>
                      <Input
                        id="yearsOfExperience"
                        type="number"
                        placeholder={localize('com_farmer_placeholder_years')}
                        defaultValue={0}
                        min={0}
                        max={70}
                        step={1}
                        className={inputClass}
                        {...register('yearsOfExperience', {
                          required: localize('com_farmer_validation_experience_required'),
                          valueAsNumber: true,
                          validate: {
                            isInteger: (value) =>
                              Number.isInteger(value) ||
                              localize('com_farmer_validation_experience_integer'),
                            inRange: (value) =>
                              (value >= 0 && value <= 70) ||
                              localize('com_farmer_validation_experience_range'),
                          },
                        })}
                      />
                      {errors.yearsOfExperience && (
                        <p className={errorClass}>{errors.yearsOfExperience.message}</p>
                      )}
                    </div>

                    <div className={fieldClass}>
                      <Label htmlFor="landhold">
                        {localize('com_farmer_label_landholding')}
                        {requiredMark}
                      </Label>
                      <Input
                        id="landhold"
                        type="text"
                        inputMode="decimal"
                        placeholder={localize('com_farmer_placeholder_landholding')}
                        className={inputClass}
                        {...register('landhold', {
                          required: localize('com_farmer_validation_landholding_required'),
                          validate: (value) => {
                            const normalized = String(value ?? '').trim();
                            return (
                              decimalRegex.test(normalized) ||
                              localize('com_farmer_validation_landholding_valid')
                            );
                          },
                        })}
                      />
                      {errors.landhold && <p className={errorClass}>{errors.landhold.message}</p>}
                    </div>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className={fieldClass}>
                        <Label htmlFor="primaryCrop">
                          {localize('com_farmer_label_primary_crop')}
                          {requiredMark}
                        </Label>
                        <CropSelector
                          crops={selectedPrimaryCropList}
                          onClick={() => setCropPickerField('primaryCrop')}
                          error={errors.primaryCrop?.message}
                        />
                        <input
                          type="hidden"
                          {...register('primaryCrop', {
                            required: localize('com_farmer_validation_field_required'),
                          })}
                        />
                      </div>
                        <div className={fieldClass}>
                          <Label htmlFor="secondaryCrop">
                            {localize('com_farmer_label_secondary_crop')}
                            {requiredMark}
                          </Label>
                          <CropSelector
                            crops={selectedSecondaryCropList}
                            onClick={() => setCropPickerField('secondaryCrop')}
                            error={errors.secondaryCrop?.message}
                          />
                          <input
                            type="hidden"
                            {...register('secondaryCrop', {
                              required: localize('com_farmer_validation_secondary_crop_required'),
                            })}
                          />
                        </div>
                    </div>
                  </>
                )}

                {/* ── Section 3: Awareness & Digital Adoption ── */}
                {currentSection === 2 && (
                  <>
                    {/* <div className={sectionTitleClass}>
                <span className={sectionBadgeClass}>
                  <Smartphone className="h-4 w-4" />
                </span>
                <div>
                  <p className={sectionStepClass}>Section 3 of 4</p>
                  <h3 className={sectionHeadingTextClass}>
                    {localize('com_farmer_profile_awareness_section')}
                  </h3>
                </div>
              </div> */}

                    <div className={fieldClass}>
                      <Label>
                        {localize('com_farmer_label_awareness_kcc')}
                        {requiredMark}
                      </Label>
                      <Controller
                        name="awarenessOfKCC"
                        control={control}
                        rules={{ required: localize('com_farmer_validation_field_required') }}
                        render={({ field }) => (
                          <ChoiceCards
                            name="awarenessOfKCC"
                            options={yesNoOptions}
                            value={field.value ?? ''}
                            onChange={field.onChange}
                            gridClassName="grid-cols-2"
                          />
                        )}
                      />
                      {errors.awarenessOfKCC && (
                        <p className={errorClass}>{errors.awarenessOfKCC.message}</p>
                      )}
                    </div>

                    <div className={fieldClass}>
                      <Label>
                        {localize('com_farmer_label_usage_agri_apps')}
                        {requiredMark}
                      </Label>
                      <Controller
                        name="usesAgriApps"
                        control={control}
                        rules={{ required: localize('com_farmer_validation_field_required') }}
                        render={({ field }) => (
                          <ChoiceCards
                            name="usesAgriApps"
                            options={yesNoOptions}
                            value={field.value ?? ''}
                            onChange={field.onChange}
                            gridClassName="grid-cols-2"
                          />
                        )}
                      />
                      {errors.usesAgriApps && (
                        <p className={errorClass}>{errors.usesAgriApps.message}</p>
                      )}
                    </div>
                  </>
                )}

                {/* ── Section 4: Socio-Economic Indicator ── */}
                {currentSection === 3 && (
                  <>
                    {/* <div className={sectionTitleClass}>
                <span className={sectionBadgeClass}>
                  <Landmark className="h-4 w-4" />
                </span>
                <div>
                  <p className={sectionStepClass}>Section 4 of 4</p>
                  <h3 className={sectionHeadingTextClass}>
                    {localize('com_farmer_profile_socio_economic')}
                  </h3>
                </div>
              </div> */}

                    <div className={fieldClass}>
                      <Label>
                        {localize('com_farmer_label_highest_educated')}
                        {requiredMark}
                      </Label>
                      <Controller
                        name="highestEducatedPerson"
                        control={control}
                        rules={{ required: localize('com_farmer_validation_field_required') }}
                        render={({ field }) => (
                          <ChoiceCards
                            name="highestEducatedPerson"
                            options={educationOptions.map((option) => ({
                              label: option,
                              value: option,
                            }))}
                            value={field.value ?? ''}
                            onChange={field.onChange}
                            gridClassName="grid-cols-1 sm:grid-cols-3"
                          />
                        )}
                      />
                      {errors.highestEducatedPerson && (
                        <p className={errorClass}>{errors.highestEducatedPerson.message}</p>
                      )}
                    </div>

                    <div className={fieldClass}>
                      <Label htmlFor="numberOfSmartphones">
                        {localize('com_farmer_label_smartphone_count')}
                        {requiredMark}
                      </Label>
                      <Controller
                        name="numberOfSmartphones"
                        control={control}
                        rules={{
                          required: localize('com_farmer_validation_smartphones_required'),
                          validate: {
                            isInteger: (value) =>
                              Number.isInteger(value) ||
                              localize('com_farmer_validation_smartphones_integer'),
                            inRange: (value) =>
                              (value >= 0 && value <= 20) ||
                              localize('com_farmer_validation_smartphones_range'),
                          },
                        }}
                        render={({ field }) => (
                          <CountStepper
                            id="numberOfSmartphones"
                            value={field.value}
                            onChange={field.onChange}
                            min={0}
                            max={20}
                          />
                        )}
                      />
                      {errors.numberOfSmartphones && (
                        <p className={errorClass}>{errors.numberOfSmartphones.message}</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ── Footer ── */}
            <div className="mt-2 flex shrink-0 flex-col-reverse gap-2 border-t border-border-light px-1 pt-4 sm:flex-row sm:justify-between sm:gap-3">
              {currentSection ===
                0 ? // Reset button temporarily disabled — commented out per request.
                // <button
                //   type="button"
                //   onClick={() => reset()}
                //   disabled={saveMutation.isLoading}
                //   className="inline-flex w-full items-center justify-center rounded-lg border border-border-heavy bg-surface-secondary px-6 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                // >
                //   {localize('com_ui_reset')}
                // </button>
                null : (
                  <button
                    type="button"
                    onClick={handlePreviousSection}
                    disabled={saveMutation.isLoading}
                    className={cn(SECONDARY_ACTION_CLASS, 'gap-1.5')}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    {localize('com_ui_back')}
                  </button>
                )}
              {isLastSection ? (
                <button
                  type="submit"
                  disabled={saveMutation.isLoading}
                  className={cn(
                    PRIMARY_ACTION_CLASS,
                    'disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                >
                  {saveMutation.isLoading
                    ? `${localize('com_ui_submit')}...`
                    : localize('com_ui_submit')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleNextSection}
                  className={cn(PRIMARY_ACTION_CLASS, 'gap-1.5')}
                >
                  {localize('com_ui_next')}
                  <ChevronRight className="h-4 w-4" />
                </button>
              )}
            </div>
          </form>
        </OGDialogContent>
      </OGDialog>
      <LogoutConfirmModal
        open={showLogoutConfirm}
        onOpenChange={setShowLogoutConfirm}
        onConfirm={() => logout()}
      />

      <CropPickerModal
        open={cropPickerField !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setCropPickerField(null);
        }}
        selected={cropPickerSelected}
        onSelectionChange={handleCropPickerApply}
        excludeValues={cropPickerExcluded}
        mode="multi"
        title={
          cropPickerField === 'primaryCrop'
            ? localize('com_farmer_label_primary_crop')
            : localize('com_farmer_label_secondary_crop')
        }
      />
    </>
  );
};

export default FarmerProfileModal;
