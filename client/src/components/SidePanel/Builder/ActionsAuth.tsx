import { useRef, useState, useLayoutEffect } from 'react';
import { motion } from 'framer-motion';
import { useFormContext } from 'react-hook-form';
import { ChevronRight, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import {
  AuthTypeEnum,
  AuthorizationTypeEnum,
  TokenExchangeMethodEnum,
} from 'librechat-data-provider';
import {
  Input,
  Radio,
  Button,
  OGDialog,
  SecretInput,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
  OGDialogTrigger,
} from '@librechat/client';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

interface AuthMethod {
  value: AuthTypeEnum;
  icon: LucideIcon;
  titleKey: TranslationKeys;
  descKey: TranslationKeys;
}

const AUTH_METHODS: AuthMethod[] = [
  {
    value: AuthTypeEnum.None,
    icon: ShieldOff,
    titleKey: 'com_ui_none',
    descKey: 'com_ui_auth_none_desc',
  },
  {
    value: AuthTypeEnum.ServiceHttp,
    icon: KeyRound,
    titleKey: 'com_ui_api_key',
    descKey: 'com_ui_auth_apikey_desc',
  },
  {
    value: AuthTypeEnum.OAuth,
    icon: ShieldCheck,
    titleKey: 'com_ui_oauth',
    descKey: 'com_ui_auth_oauth_desc',
  },
];

export default function ActionsAuth({ disableOAuth }: { disableOAuth?: boolean }) {
  const localize = useLocalize();
  const [openAuthDialog, setOpenAuthDialog] = useState(false);
  const { watch, setValue, trigger } = useFormContext();
  const type = watch('type');
  const current = AUTH_METHODS.find((method) => method.value === type) ?? AUTH_METHODS[0];
  const authOptions = AUTH_METHODS.filter(
    (method) => !(method.value === AuthTypeEnum.OAuth && disableOAuth === true),
  ).map((method) => ({
    value: method.value,
    label: localize(method.titleKey),
    icon: <method.icon className="size-4" aria-hidden={true} />,
  }));

  const handleSave = async () => {
    const result = await trigger(undefined, { shouldFocus: true });
    setValue('saved_auth_fields', result);
    setOpenAuthDialog(!result);
  };

  return (
    <OGDialog open={openAuthDialog} onOpenChange={setOpenAuthDialog}>
      <div className="mb-4">
        <label className="text-text-primary mb-1.5 block font-medium">
          {localize('com_ui_authentication')}
        </label>
        <OGDialogTrigger asChild>
          <button
            type="button"
            className="group border-border-light hover:bg-surface-secondary focus-visible:ring-text-primary rounded-theme-control flex w-full items-center gap-3 border bg-transparent px-3 py-2.5 text-left transition-colors focus:outline-hidden focus-visible:ring-2"
          >
            <current.icon className="text-text-secondary size-5 shrink-0" aria-hidden={true} />
            <span className="min-w-0 flex-1">
              <span className="text-text-primary block text-sm font-medium">
                {localize(current.titleKey)}
              </span>
              <span className="text-text-secondary block truncate text-xs">
                {localize(current.descKey)}
              </span>
            </span>
            <ChevronRight className="text-text-secondary size-4 shrink-0" aria-hidden={true} />
          </button>
        </OGDialogTrigger>
      </div>
      <OGDialogContent className="text-text-primary w-full max-w-lg">
        <OGDialogHeader>
          <OGDialogTitle className="text-lg font-semibold">
            {localize('com_ui_authentication')}
          </OGDialogTitle>
        </OGDialogHeader>
        <div>
          <span id="auth-method-label" className="sr-only">
            {localize('com_ui_authentication_type')}
          </span>
          <Radio
            options={authOptions}
            value={type}
            onChange={(value) => setValue('type', value)}
            fullWidth
            aria-labelledby="auth-method-label"
          />
          <AnimatedAuthFields type={type} />
        </div>
        <div className="flex justify-end">
          <Button variant="default" onClick={handleSave}>
            {localize('com_ui_done')}
          </Button>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}

/**
 * Animates the auth fields' height to their measured content height. Animating to
 * a measured pixel value (instead of `height: 'auto'`) is what lets the
 * ApiKey <-> OAuth swap tween between two different heights — `auto` never changes,
 * so it would jump. The content swaps instantly; only the container height eases.
 */
function AnimatedAuthFields({ type }: { type: AuthTypeEnum }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>(type === AuthTypeEnum.None ? 0 : 'auto');

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) {
      return;
    }
    const measure = () => setHeight(type === AuthTypeEnum.None ? 0 : el.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [type]);

  let fields: ReactNode = null;
  if (type === AuthTypeEnum.ServiceHttp) {
    fields = <ApiKey />;
  } else if (type === AuthTypeEnum.OAuth) {
    fields = <OAuth />;
  }

  return (
    <motion.div
      initial={false}
      animate={{ height, opacity: type === AuthTypeEnum.None ? 0 : 1 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden"
    >
      <div ref={innerRef} className="space-y-4 pt-4">
        {fields}
      </div>
    </motion.div>
  );
}

function Field({
  htmlFor,
  label,
  children,
}: {
  htmlFor: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-text-secondary block text-xs font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function SegmentedField({
  id,
  label,
  value,
  onValueChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; labelKey: TranslationKeys }>;
}) {
  const localize = useLocalize();
  return (
    <div className="space-y-1.5">
      <label id={id} className="text-text-secondary block text-xs font-medium">
        {label}
      </label>
      <Radio
        options={options.map((option) => ({
          value: option.value,
          label: localize(option.labelKey),
        }))}
        value={value}
        onChange={onValueChange}
        fullWidth
        aria-labelledby={id}
      />
    </div>
  );
}

const ApiKey = () => {
  const localize = useLocalize();
  const { register, watch, setValue } = useFormContext();
  const authorization_type = watch('authorization_type');
  const type = watch('type');
  return (
    <>
      <Field htmlFor="auth-api-key" label={localize('com_ui_api_key')}>
        <SecretInput
          id="auth-api-key"
          autoComplete="new-password"
          controlsOnHover
          placeholder="<HIDDEN>"
          {...register('api_key', { required: type === AuthTypeEnum.ServiceHttp })}
        />
      </Field>
      <SegmentedField
        id="auth-type-label"
        label={localize('com_ui_auth_type')}
        value={authorization_type}
        onValueChange={(value) => setValue('authorization_type', value)}
        options={[
          { value: AuthorizationTypeEnum.Basic, labelKey: 'com_ui_basic' },
          { value: AuthorizationTypeEnum.Bearer, labelKey: 'com_ui_bearer' },
          { value: AuthorizationTypeEnum.Custom, labelKey: 'com_ui_custom' },
        ]}
      />
      {authorization_type === AuthorizationTypeEnum.Custom && (
        <Field htmlFor="auth-custom-header" label={localize('com_ui_custom_header_name')}>
          <Input
            id="auth-custom-header"
            placeholder="X-Api-Key"
            {...register('custom_auth_header', {
              required: authorization_type === AuthorizationTypeEnum.Custom,
            })}
          />
        </Field>
      )}
    </>
  );
};

const OAuth = () => {
  const localize = useLocalize();
  const { register, watch, setValue } = useFormContext();
  const token_exchange_method = watch('token_exchange_method');
  const type = watch('type');
  return (
    <>
      <Field htmlFor="auth-client-id" label={localize('com_ui_client_id')}>
        <SecretInput
          id="auth-client-id"
          autoComplete="new-password"
          controlsOnHover
          placeholder="<HIDDEN>"
          {...register('oauth_client_id', { required: false })}
        />
      </Field>
      <Field htmlFor="auth-client-secret" label={localize('com_ui_client_secret')}>
        <SecretInput
          id="auth-client-secret"
          autoComplete="new-password"
          controlsOnHover
          placeholder="<HIDDEN>"
          {...register('oauth_client_secret', { required: false })}
        />
      </Field>
      <Field htmlFor="auth-authorization-url" label={localize('com_ui_auth_url')}>
        <Input
          id="auth-authorization-url"
          {...register('authorization_url', { required: type === AuthTypeEnum.OAuth })}
        />
      </Field>
      <Field htmlFor="auth-token-url" label={localize('com_ui_token_url')}>
        <Input
          id="auth-token-url"
          {...register('client_url', { required: type === AuthTypeEnum.OAuth })}
        />
      </Field>
      <Field htmlFor="auth-scope" label={localize('com_ui_scope')}>
        <Input id="auth-scope" {...register('scope', { required: type === AuthTypeEnum.OAuth })} />
      </Field>
      <SegmentedField
        id="auth-token-exchange-label"
        label={localize('com_ui_token_exchange_method')}
        value={token_exchange_method}
        onValueChange={(value) => setValue('token_exchange_method', value)}
        options={[
          { value: TokenExchangeMethodEnum.DefaultPost, labelKey: 'com_ui_default_post_request' },
          { value: TokenExchangeMethodEnum.BasicAuthHeader, labelKey: 'com_ui_basic_auth_header' },
        ]}
      />
    </>
  );
};
